import { LoanStatus, MemberLoanAccountStatus } from '../../common/enums/loan.enums';
import { RepaymentStatus } from '../../common/enums/repayment.enums';
import { WorkflowEntityType, WorkflowStepAction } from '../../common/enums/workflow.enums';
import { WorkflowApprovedEvent } from '../../platform/workflow-engine/events/workflow-engine.events';
import {
  clearAllExceptChainConfigs,
  createRepaymentsTestContext,
  raiseApproveVerifyAndDisburseLoan,
  recordAndApproveRepayment,
  repaymentApproveActor,
  repaymentReviewActor,
  resetBranchFixture,
  RepaymentsTestContext,
  teardownRepaymentsTestContext,
} from './test-support/repayments-test-context';

describe('RepaymentsService', () => {
  let ctx: RepaymentsTestContext;

  beforeAll(async () => {
    ctx = await createRepaymentsTestContext();
  }, 60_000);

  beforeEach(async () => {
    await resetBranchFixture(ctx);
  });

  afterEach(async () => {
    await clearAllExceptChainConfigs(ctx);
  });

  afterAll(async () => {
    await teardownRepaymentsTestContext(ctx);
  });

  describe('recording', () => {
    it('creates the RepaymentRecord immediately and gates approval via the workflow — no balance effect until approved', async () => {
      const { memberLoanAccountIds } = await raiseApproveVerifyAndDisburseLoan(ctx);
      const accountId = memberLoanAccountIds[0]!;
      const accountBefore = await ctx.memberLoanAccountModel.findById(accountId).exec();
      const balanceBefore = accountBefore!.outstandingBalanceKobo;

      const { record, workflowRequest } = await ctx.repaymentsService.recordRepayment(
        {
          memberLoanAccountId: accountId,
          branchBankAccountId: ctx.branchBankAccountId,
          channel: 'BANK_TRANSFER' as never,
          transactionReference: `TXN-${Date.now()}`,
          amountKobo: 50_000,
          paymentDate: new Date().toISOString(),
        },
        ctx.INITIATOR_ID,
      );

      expect(record.status).toBe(RepaymentStatus.PENDING);
      expect(record.appliedToBalance).toBe(false);
      const persisted = await ctx.repaymentRecordModel.findById(record._id).exec();
      expect(persisted).not.toBeNull();
      expect(workflowRequest.entityId).toBe(record._id.toString());

      const accountAfter = await ctx.memberLoanAccountModel.findById(accountId).exec();
      expect(accountAfter!.outstandingBalanceKobo).toBe(balanceBefore);
    });

    it('rejects a duplicate (branchBankAccountId, transactionReference) at the DB level', async () => {
      const { memberLoanAccountIds } = await raiseApproveVerifyAndDisburseLoan(ctx);
      const accountId = memberLoanAccountIds[0]!;
      const reference = `TXN-DUP-${Date.now()}`;

      await ctx.repaymentsService.recordRepayment(
        {
          memberLoanAccountId: accountId,
          branchBankAccountId: ctx.branchBankAccountId,
          channel: 'BANK_TRANSFER' as never,
          transactionReference: reference,
          amountKobo: 10_000,
          paymentDate: new Date().toISOString(),
        },
        ctx.INITIATOR_ID,
      );

      await expect(
        ctx.repaymentsService.recordRepayment(
          {
            memberLoanAccountId: accountId,
            branchBankAccountId: ctx.branchBankAccountId,
            channel: 'BANK_TRANSFER' as never,
            transactionReference: reference,
            amountKobo: 20_000,
            paymentDate: new Date().toISOString(),
          },
          ctx.INITIATOR_ID,
        ),
      ).rejects.toThrow(/already exists/);
    });
  });

  describe('approval and balance application', () => {
    it('decrements outstandingBalanceKobo exactly once even if workflow.approved fires twice', async () => {
      const { memberLoanAccountIds } = await raiseApproveVerifyAndDisburseLoan(ctx);
      const accountId = memberLoanAccountIds[0]!;
      const accountBefore = await ctx.memberLoanAccountModel.findById(accountId).exec();
      const balanceBefore = accountBefore!.outstandingBalanceKobo!;

      const { record, workflowRequest } = await ctx.repaymentsService.recordRepayment(
        {
          memberLoanAccountId: accountId,
          branchBankAccountId: ctx.branchBankAccountId,
          channel: 'BANK_TRANSFER' as never,
          transactionReference: `TXN-${Date.now()}`,
          amountKobo: 50_000,
          paymentDate: new Date().toISOString(),
        },
        ctx.INITIATOR_ID,
      );

      const postRepaymentSpy = jest.spyOn(ctx.stubLedgerPostingPort, 'postRepayment');

      const approvedEvent: WorkflowApprovedEvent = {
        workflowRequestId: workflowRequest._id.toString(),
        entityType: WorkflowEntityType.REPAYMENT_RECORD,
        entityId: record._id.toString(),
        action: 'RECORD',
        branchId: ctx.branchId,
        payload: { repaymentId: record._id.toString() },
        initiatedBy: ctx.INITIATOR_ID,
        approvedBy: ctx.INITIATOR_ID,
      };

      // Simulate the real workflow.approved firing (via act()) AND a
      // duplicate re-fire of the same event, directly — proving the
      // idempotency guard, not just "we only call it once in practice".
      await ctx.repaymentsService.handleWorkflowApproved(approvedEvent);
      await ctx.repaymentsService.handleWorkflowApproved(approvedEvent);

      const accountAfter = await ctx.memberLoanAccountModel.findById(accountId).exec();
      expect(accountAfter!.outstandingBalanceKobo).toBe(balanceBefore - 50_000);
      expect(postRepaymentSpy).toHaveBeenCalledTimes(1);
      // No session arg — Phase 10 moved this call to after the enclosing
      // transaction commits (see PHASE_10_NOTES.md, the nested-transaction
      // deadlock fix).
      expect(postRepaymentSpy).toHaveBeenCalledWith({
        repaymentRecordId: record._id.toString(),
        amountKobo: 50_000,
        branchId: ctx.branchId,
      });
    });

    it('rejects recordRepayment outright when the amount exceeds the account\'s current outstanding balance', async () => {
      const { memberLoanAccountIds } = await raiseApproveVerifyAndDisburseLoan(ctx, {
        memberPrincipalKobo: 30_000,
      });
      const accountId = memberLoanAccountIds[0]!;
      const account = await ctx.memberLoanAccountModel.findById(accountId).exec();
      const outstanding = account!.outstandingBalanceKobo!;

      await expect(
        ctx.repaymentsService.recordRepayment(
          {
            memberLoanAccountId: accountId,
            branchBankAccountId: ctx.branchBankAccountId,
            channel: 'BANK_TRANSFER' as never,
            transactionReference: `TXN-${Date.now()}`,
            amountKobo: outstanding + 5_000,
            paymentDate: new Date().toISOString(),
          },
          ctx.INITIATOR_ID,
        ),
      ).rejects.toThrow(/cannot be greater than outstanding balance|can't be greater than outstanding balance/i);

      // Never even reached RepaymentRecord creation — no balance effect,
      // nothing pending review.
      const accountAfter = await ctx.memberLoanAccountModel.findById(accountId).exec();
      expect(accountAfter!.outstandingBalanceKobo).toBe(outstanding);
    });

    /**
     * `recordRepayment`'s own up-front rejection (see the test above) only
     * ever compares against the balance AT RECORD TIME — it can't see a
     * second repayment recorded moments later against the same still-ACTIVE
     * account. `applyToBalance`'s Math.min cap is what actually closes that
     * race: both repayments individually pass the record-time check, but
     * approving the first already exhausts the balance before the second is
     * approved, so the second gets capped to 0 and its excess flagged as
     * overpaymentAmountKobo rather than pushing the balance negative.
     */
    it('caps the decrement at 0 and records overpaymentAmountKobo when two pending repayments together exceed the balance', async () => {
      const { memberLoanAccountIds } = await raiseApproveVerifyAndDisburseLoan(ctx, {
        memberPrincipalKobo: 30_000,
      });
      const accountId = memberLoanAccountIds[0]!;
      const account = await ctx.memberLoanAccountModel.findById(accountId).exec();
      const outstanding = account!.outstandingBalanceKobo!;
      const overpayBy = 5_000;

      // Both recorded while the account is still ACTIVE — neither one alone
      // exceeds `outstanding` at record time.
      const { record: recordA, workflowRequest: workflowA } = await ctx.repaymentsService.recordRepayment(
        {
          memberLoanAccountId: accountId,
          branchBankAccountId: ctx.branchBankAccountId,
          channel: 'BANK_TRANSFER' as never,
          transactionReference: `TXN-A-${Date.now()}`,
          amountKobo: outstanding,
          paymentDate: new Date().toISOString(),
        },
        ctx.INITIATOR_ID,
      );
      const { record: recordB, workflowRequest: workflowB } = await ctx.repaymentsService.recordRepayment(
        {
          memberLoanAccountId: accountId,
          branchBankAccountId: ctx.branchBankAccountId,
          channel: 'BANK_TRANSFER' as never,
          transactionReference: `TXN-B-${Date.now()}`,
          amountKobo: overpayBy,
          paymentDate: new Date().toISOString(),
        },
        ctx.INITIATOR_ID,
      );

      for (const workflowRequest of [workflowA, workflowB]) {
        await ctx.workflowEngineService.act({
          workflowRequestId: workflowRequest._id.toString(),
          actor: repaymentReviewActor(ctx),
          action: WorkflowStepAction.APPROVED,
        });
        await ctx.workflowEngineService.act({
          workflowRequestId: workflowRequest._id.toString(),
          actor: repaymentApproveActor(ctx),
          action: WorkflowStepAction.APPROVED,
        });
      }

      const approvedB = await ctx.repaymentRecordModel.findById(recordB._id).exec();
      expect(approvedB!.overpaymentAmountKobo).toBe(overpayBy);
      const accountAfter = await ctx.memberLoanAccountModel.findById(accountId).exec();
      expect(accountAfter!.outstandingBalanceKobo).toBe(0);
      // Sanity: A itself had no overpayment — it exactly exhausted the balance.
      const approvedA = await ctx.repaymentRecordModel.findById(recordA._id).exec();
      expect(approvedA!.overpaymentAmountKobo).toBeNull();
    });

    it('closes the MemberLoanAccount once the balance reaches exactly 0', async () => {
      const { memberLoanAccountIds } = await raiseApproveVerifyAndDisburseLoan(ctx);
      const accountId = memberLoanAccountIds[0]!;
      const account = await ctx.memberLoanAccountModel.findById(accountId).exec();
      const outstanding = account!.outstandingBalanceKobo!;

      await recordAndApproveRepayment(ctx, accountId, outstanding);

      const accountAfter = await ctx.memberLoanAccountModel.findById(accountId).exec();
      expect(accountAfter!.outstandingBalanceKobo).toBe(0);
      expect(accountAfter!.status).toBe(MemberLoanAccountStatus.CLOSED);
    });

    it('closes the parent Loan (LoanStatus.CLOSED) once every one of its MemberLoanAccounts is CLOSED', async () => {
      // A group needs at least 3 proposed members (GroupsService's own
      // rule) — so "every account settled" here means paying off all 3.
      const { memberLoanAccountIds, loanId } = await raiseApproveVerifyAndDisburseLoan(ctx, { n: 3 });

      for (const accountId of memberLoanAccountIds) {
        const account = await ctx.memberLoanAccountModel.findById(accountId).exec();
        await recordAndApproveRepayment(ctx, accountId, account!.outstandingBalanceKobo!);
      }

      const loanAfter = await ctx.loanModel.findById(loanId).exec();
      expect(loanAfter!.status).toBe(LoanStatus.CLOSED);
    });

    it('leaves a multi-member Loan DISBURSED (not CLOSED) while at least one of its MemberLoanAccounts is still open', async () => {
      const { memberLoanAccountIds, loanId } = await raiseApproveVerifyAndDisburseLoan(ctx, { n: 3 });
      const accountId = memberLoanAccountIds[0]!;
      const account = await ctx.memberLoanAccountModel.findById(accountId).exec();
      const outstanding = account!.outstandingBalanceKobo!;

      // Only the first of the 3 members' accounts is paid off.
      await recordAndApproveRepayment(ctx, accountId, outstanding);

      expect((await ctx.memberLoanAccountModel.findById(accountId).exec())!.status).toBe(
        MemberLoanAccountStatus.CLOSED,
      );
      const loanAfter = await ctx.loanModel.findById(loanId).exec();
      expect(loanAfter!.status).toBe(LoanStatus.DISBURSED);
    });

    it('reopens a CLOSED Loan back to DISBURSED once a dispute reopens its last-closed MemberLoanAccount', async () => {
      const { memberLoanAccountIds, loanId } = await raiseApproveVerifyAndDisburseLoan(ctx, { n: 3 });

      let lastApproved: Awaited<ReturnType<typeof recordAndApproveRepayment>> | undefined;
      for (const accountId of memberLoanAccountIds) {
        const account = await ctx.memberLoanAccountModel.findById(accountId).exec();
        lastApproved = await recordAndApproveRepayment(ctx, accountId, account!.outstandingBalanceKobo!);
      }
      expect((await ctx.loanModel.findById(loanId).exec())!.status).toBe(LoanStatus.CLOSED);

      await ctx.repaymentsService.raiseDispute(
        lastApproved!._id.toString(),
        ctx.INITIATOR_ID,
        'reopen loan test',
      );

      const loanAfter = await ctx.loanModel.findById(loanId).exec();
      expect(loanAfter!.status).toBe(LoanStatus.DISBURSED);
    });

    it('rejects the record on workflow rejection with no balance effect', async () => {
      const { memberLoanAccountIds } = await raiseApproveVerifyAndDisburseLoan(ctx);
      const accountId = memberLoanAccountIds[0]!;
      const accountBefore = await ctx.memberLoanAccountModel.findById(accountId).exec();
      const balanceBefore = accountBefore!.outstandingBalanceKobo;

      const { record, workflowRequest } = await ctx.repaymentsService.recordRepayment(
        {
          memberLoanAccountId: accountId,
          branchBankAccountId: ctx.branchBankAccountId,
          channel: 'BANK_TRANSFER' as never,
          transactionReference: `TXN-${Date.now()}`,
          amountKobo: 10_000,
          paymentDate: new Date().toISOString(),
        },
        ctx.INITIATOR_ID,
      );

      await ctx.workflowEngineService.act({
        workflowRequestId: workflowRequest._id.toString(),
        actor: repaymentReviewActor(ctx),
        action: WorkflowStepAction.APPROVED,
      });
      await ctx.workflowEngineService.act({
        workflowRequestId: workflowRequest._id.toString(),
        actor: repaymentApproveActor(ctx),
        action: WorkflowStepAction.REJECTED,
        comment: 'not accepted',
      });

      const rejected = await ctx.repaymentRecordModel.findById(record._id).exec();
      expect(rejected!.status).toBe(RepaymentStatus.REJECTED);
      expect(rejected!.appliedToBalance).toBe(false);

      const accountAfter = await ctx.memberLoanAccountModel.findById(accountId).exec();
      expect(accountAfter!.outstandingBalanceKobo).toBe(balanceBefore);
    });
  });

  describe('disputes', () => {
    it('raising a dispute from PENDING changes status with no balance effect (there was none to reverse)', async () => {
      const { memberLoanAccountIds } = await raiseApproveVerifyAndDisburseLoan(ctx);
      const accountId = memberLoanAccountIds[0]!;
      const accountBefore = await ctx.memberLoanAccountModel.findById(accountId).exec();
      const balanceBefore = accountBefore!.outstandingBalanceKobo;

      const { record } = await ctx.repaymentsService.recordRepayment(
        {
          memberLoanAccountId: accountId,
          branchBankAccountId: ctx.branchBankAccountId,
          channel: 'BANK_TRANSFER' as never,
          transactionReference: `TXN-${Date.now()}`,
          amountKobo: 10_000,
          paymentDate: new Date().toISOString(),
        },
        ctx.INITIATOR_ID,
      );

      const disputed = await ctx.repaymentsService.raiseDispute(
        record._id.toString(),
        ctx.INITIATOR_ID,
        'Customer says this was never paid',
      );

      expect(disputed.status).toBe(RepaymentStatus.UNDER_DISPUTE);
      expect(disputed.disputeDetails?.reason).toContain('never paid');

      const accountAfter = await ctx.memberLoanAccountModel.findById(accountId).exec();
      expect(accountAfter!.outstandingBalanceKobo).toBe(balanceBefore);
    });

    // *** PHASE 11 CROSS-PHASE RETROFIT REGRESSION TEST — see PHASE_11_NOTES.md.
    // Phase 9's raiseDispute never called NotificationPort when it was built;
    // this confirms the Phase 11 retrofit actually wired the call in. ***
    it('raising a dispute calls NotificationPort.sendRepaymentDisputeRaised with the correct recordedBy/raisedBy/reason payload', async () => {
      const { memberLoanAccountIds } = await raiseApproveVerifyAndDisburseLoan(ctx);
      const accountId = memberLoanAccountIds[0]!;
      const { record } = await ctx.repaymentsService.recordRepayment(
        {
          memberLoanAccountId: accountId,
          branchBankAccountId: ctx.branchBankAccountId,
          channel: 'BANK_TRANSFER' as never,
          transactionReference: `TXN-${Date.now()}`,
          amountKobo: 10_000,
          paymentDate: new Date().toISOString(),
        },
        ctx.INITIATOR_ID,
      );
      const disputeSpy = jest.spyOn(ctx.pendingNotificationLogPort, 'sendRepaymentDisputeRaised');

      await ctx.repaymentsService.raiseDispute(
        record._id.toString(),
        ctx.APPROVER_ID,
        'Customer says amount is wrong',
      );

      expect(disputeSpy).toHaveBeenCalledTimes(1);
      expect(disputeSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          repaymentRecordId: record._id.toString(),
          recordedBy: ctx.INITIATOR_ID,
          raisedBy: ctx.APPROVER_ID,
          reason: 'Customer says amount is wrong',
        }),
      );
    });

    it('raising a dispute against an APPROVED record reverses the balance atomically, exactly once even under a double-raise', async () => {
      const { memberLoanAccountIds } = await raiseApproveVerifyAndDisburseLoan(ctx);
      const accountId = memberLoanAccountIds[0]!;
      const accountBefore = await ctx.memberLoanAccountModel.findById(accountId).exec();
      const balanceBefore = accountBefore!.outstandingBalanceKobo!;

      const approved = await recordAndApproveRepayment(ctx, accountId, 40_000);
      const afterApproval = await ctx.memberLoanAccountModel.findById(accountId).exec();
      expect(afterApproval!.outstandingBalanceKobo).toBe(balanceBefore - 40_000);

      // Double-raise: two concurrent calls, only one should actually reverse.
      await Promise.all([
        ctx.repaymentsService.raiseDispute(approved._id.toString(), ctx.INITIATOR_ID, 'dispute A'),
        ctx.repaymentsService.raiseDispute(approved._id.toString(), ctx.INITIATOR_ID, 'dispute B'),
      ]);

      const afterDispute = await ctx.memberLoanAccountModel.findById(accountId).exec();
      expect(afterDispute!.outstandingBalanceKobo).toBe(balanceBefore);

      const disputedRecord = await ctx.repaymentRecordModel.findById(approved._id).exec();
      expect(disputedRecord!.status).toBe(RepaymentStatus.UNDER_DISPUTE);
      expect(disputedRecord!.appliedToBalance).toBe(false);
    });

    it('a dispute that reverses a CLOSED account reopens it to ACTIVE', async () => {
      const { memberLoanAccountIds } = await raiseApproveVerifyAndDisburseLoan(ctx);
      const accountId = memberLoanAccountIds[0]!;
      const account = await ctx.memberLoanAccountModel.findById(accountId).exec();
      const outstanding = account!.outstandingBalanceKobo!;

      const approved = await recordAndApproveRepayment(ctx, accountId, outstanding);
      const closedAccount = await ctx.memberLoanAccountModel.findById(accountId).exec();
      expect(closedAccount!.status).toBe(MemberLoanAccountStatus.CLOSED);

      await ctx.repaymentsService.raiseDispute(
        approved._id.toString(),
        ctx.INITIATOR_ID,
        'reopen test',
      );

      const reopenedAccount = await ctx.memberLoanAccountModel.findById(accountId).exec();
      expect(reopenedAccount!.status).toBe(MemberLoanAccountStatus.ACTIVE);
      expect(reopenedAccount!.outstandingBalanceKobo).toBe(outstanding);
    });

    it('resolveDispute("APPROVED") re-applies the balance effect via the same idempotent method', async () => {
      const { memberLoanAccountIds } = await raiseApproveVerifyAndDisburseLoan(ctx);
      const accountId = memberLoanAccountIds[0]!;
      const accountBefore = await ctx.memberLoanAccountModel.findById(accountId).exec();
      const balanceBefore = accountBefore!.outstandingBalanceKobo!;

      const approved = await recordAndApproveRepayment(ctx, accountId, 25_000);
      await ctx.repaymentsService.raiseDispute(
        approved._id.toString(),
        ctx.INITIATOR_ID,
        'checking',
      );

      const resolved = await ctx.repaymentsService.resolveDispute(
        approved._id.toString(),
        ctx.ADMIN_ID,
        'APPROVED',
        'Confirmed payment was legitimate',
      );

      expect(resolved.status).toBe(RepaymentStatus.APPROVED);
      expect(resolved.appliedToBalance).toBe(true);
      const accountAfter = await ctx.memberLoanAccountModel.findById(accountId).exec();
      expect(accountAfter!.outstandingBalanceKobo).toBe(balanceBefore - 25_000);

      const auditEntry = await ctx.auditLogModel
        .findOne({ action: 'REPAYMENT_DISPUTE_RESOLVED', entityId: approved._id.toString() })
        .exec();
      expect(auditEntry).not.toBeNull();
    });

    it('resolveDispute("REJECTED") leaves the balance reversed', async () => {
      const { memberLoanAccountIds } = await raiseApproveVerifyAndDisburseLoan(ctx);
      const accountId = memberLoanAccountIds[0]!;
      const accountBefore = await ctx.memberLoanAccountModel.findById(accountId).exec();
      const balanceBefore = accountBefore!.outstandingBalanceKobo;

      const approved = await recordAndApproveRepayment(ctx, accountId, 25_000);
      await ctx.repaymentsService.raiseDispute(
        approved._id.toString(),
        ctx.INITIATOR_ID,
        'checking',
      );

      const resolved = await ctx.repaymentsService.resolveDispute(
        approved._id.toString(),
        ctx.ADMIN_ID,
        'REJECTED',
        'Confirmed this was a duplicate/fraudulent claim',
      );

      expect(resolved.status).toBe(RepaymentStatus.REJECTED);
      expect(resolved.appliedToBalance).toBe(false);
      const accountAfter = await ctx.memberLoanAccountModel.findById(accountId).exec();
      expect(accountAfter!.outstandingBalanceKobo).toBe(balanceBefore);
    });

    it('findStaleDisputes surfaces only disputes raised before the cutoff', async () => {
      const { memberLoanAccountIds } = await raiseApproveVerifyAndDisburseLoan(ctx);
      const accountId = memberLoanAccountIds[0]!;
      const approved = await recordAndApproveRepayment(ctx, accountId, 5_000);
      const disputed = await ctx.repaymentsService.raiseDispute(
        approved._id.toString(),
        ctx.INITIATOR_ID,
        'old dispute',
      );

      // Backdate raisedAt to simulate an old, forgotten dispute.
      await ctx.repaymentRecordModel
        .updateOne(
          { _id: disputed._id },
          { $set: { 'disputeDetails.raisedAt': new Date(Date.now() - 10 * 24 * 60 * 60 * 1000) } },
        )
        .exec();

      const stale = await ctx.repaymentsService.findStaleDisputes(7);
      expect(stale.some((r) => r._id.toString() === disputed._id.toString())).toBe(true);

      const notStale = await ctx.repaymentsService.findStaleDisputes(30);
      expect(notStale.some((r) => r._id.toString() === disputed._id.toString())).toBe(false);
    });
  });
});

import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { WorkflowEntityType } from '../../common/enums/workflow.enums';
import { NotificationCategory, NotificationTrigger } from '../../common/enums/notification.enums';
import { NotificationPort } from '../loans/interfaces/notification-port.interface';
// Cross-module raw model injection, purely to resolve `branchId`/`raisedBy`
// for `sendVerificationEscalation`'s involved-parties resolution — same
// established pattern as elsewhere (see e.g. FeePaymentsService's Customer
// injection, PHASE_10_NOTES.md).
import { Loan, LoanDocument } from '../loans/schemas/loan.schema';
import { WorkflowEngineService } from '../../platform/workflow-engine/workflow-engine.service';
import { BranchesService } from '../branches/branches.service';
import { StaffService } from '../identity/staff.service';
import { CustomerRecipientResolver } from './recipient-resolution/customer-recipient.resolver';
import { InvolvedPartiesResolver } from './recipient-resolution/involved-parties.resolver';
import { BranchOperationalRecipientsResolver } from './recipient-resolution/branch-operational-recipients.resolver';
import { NotificationService } from './notification.service';

/**
 * Real `NotificationPort` implementation — a thin adapter, per the brief:
 * resolves the right recipient(s) via the resolvers, then calls
 * `NotificationService.dispatch`. No template rendering or queue logic
 * lives here. See NotificationPort's own doc comment for the customer-
 * facing vs. staff-facing split.
 */
@Injectable()
export class RealNotificationPort implements NotificationPort {
  constructor(
    @InjectModel(Loan.name) private readonly loanModel: Model<LoanDocument>,
    private readonly customerRecipientResolver: CustomerRecipientResolver,
    private readonly involvedPartiesResolver: InvolvedPartiesResolver,
    private readonly workflowEngineService: WorkflowEngineService,
    private readonly notificationService: NotificationService,
    private readonly branchOperationalRecipientsResolver: BranchOperationalRecipientsResolver,
    private readonly branchesService: BranchesService,
    private readonly staffService: StaffService,
  ) {}

  async sendLoanRaisedNotification(
    customerId: string,
    memberAmountKobo: number,
    raisedAt: Date,
  ): Promise<void> {
    const recipient = await this.customerRecipientResolver.resolve(customerId);
    await this.notificationService.dispatch(
      NotificationTrigger.LOAN_RAISED,
      customerId,
      recipient,
      {
        memberAmountKobo,
        raisedAt,
      },
    );
  }

  async sendLoanApprovedNotification(customerId: string, approvedAt: Date): Promise<void> {
    const recipient = await this.customerRecipientResolver.resolve(customerId);
    await this.notificationService.dispatch(
      NotificationTrigger.LOAN_APPROVED,
      customerId,
      recipient,
      { approvedAt },
    );
  }

  async sendVerificationEscalation(
    loanId: string,
    customerId: string,
    reason: string,
  ): Promise<void> {
    const loan = await this.loanModel.findById(loanId).exec();
    if (!loan) {
      return; // defensive — a loan being escalated always exists by this point.
    }
    const history = await this.workflowEngineService.getHistory(WorkflowEntityType.LOAN, loanId);
    const relatedWorkflowRequestId = history[0]?._id.toString();

    const staffIds = await this.involvedPartiesResolver.resolveInvolvedParties({
      branchId: loan.branchId.toString(),
      initiatedBy: loan.raisedBy.toString(),
      relatedWorkflowRequestId,
    });
    await this.dispatchToStaff(NotificationTrigger.VERIFICATION_ESCALATED, loanId, staffIds, {
      loanId,
      customerId,
      reason,
    });
  }

  async sendDisbursementCompleted(
    customerId: string,
    amountKobo: number,
    channel: string,
  ): Promise<void> {
    const recipient = await this.customerRecipientResolver.resolve(customerId);
    await this.notificationService.dispatch(
      NotificationTrigger.DISBURSEMENT_COMPLETED,
      customerId,
      recipient,
      { amountKobo, channel },
    );
  }

  async sendPenaltyCharged(customerId: string, amountKobo: number, context: string): Promise<void> {
    const recipient = await this.customerRecipientResolver.resolve(customerId);
    await this.notificationService.dispatch(
      NotificationTrigger.PENALTY_CHARGED,
      customerId,
      recipient,
      {
        amountKobo,
        context,
      },
    );
  }

  async sendRepaymentDisputeRaised(params: {
    repaymentRecordId: string;
    branchId: string;
    recordedBy: string;
    raisedBy: string;
    reason: string;
    relatedWorkflowRequestId: string;
  }): Promise<void> {
    const staffIds = await this.involvedPartiesResolver.resolveInvolvedParties({
      branchId: params.branchId,
      initiatedBy: params.recordedBy,
      // Defensive — in practice a RepaymentRecord always has a
      // REPAYMENT_RECORD workflow history entry (the established two-step
      // chain, see PHASE_9_NOTES.md); an empty string here would otherwise
      // be treated as a real (and non-existent) WorkflowRequest id.
      relatedWorkflowRequestId: params.relatedWorkflowRequestId || undefined,
    });
    await this.dispatchToStaff(
      NotificationTrigger.REPAYMENT_DISPUTED,
      params.repaymentRecordId,
      staffIds,
      {
        repaymentRecordId: params.repaymentRecordId,
        raisedBy: params.raisedBy,
        reason: params.reason,
      },
    );
  }

  async sendLoanConsentCode(customerId: string, code: string, expiresAt: Date): Promise<void> {
    const recipient = await this.customerRecipientResolver.resolve(customerId);
    await this.notificationService.dispatch(
      NotificationTrigger.LOAN_CONSENT_CODE,
      customerId,
      recipient,
      { code, expiresAt },
    );
  }

  /**
   * See NotificationPort.sendRepaymentSubmittedForReview's own doc comment —
   * "whoever acts next" here is the branch's current manager (the
   * REPAYMENT_RECORD chain's review step), resolved the same way
   * BranchOperationalEventListenersService.handleFundingRecorded resolves
   * its own manager-tier recipient.
   */
  async sendRepaymentSubmittedForReview(params: {
    repaymentRecordId: string;
    branchId: string;
    recordedBy: string;
    amountKobo: number;
  }): Promise<void> {
    const [managers, branch, recordedByStaff] = await Promise.all([
      this.branchOperationalRecipientsResolver.resolveManager(params.branchId),
      this.branchesService.findById(params.branchId).catch(() => null),
      this.staffService.findById(params.recordedBy).catch(() => null),
    ]);
    if (managers.length === 0) {
      return; // A branch's manager slot can legitimately sit empty — logged upstream by resolveManager's own callers elsewhere, nothing more to do here.
    }
    const branchName = branch?.name ?? 'a branch';
    const recordedByName = recordedByStaff
      ? `${recordedByStaff.firstName} ${recordedByStaff.lastName}`.trim()
      : 'a marketer';
    await Promise.all(
      managers.map((manager) =>
        this.notificationService.dispatch(
          NotificationTrigger.REPAYMENT_RECORD_SUBMITTED,
          params.repaymentRecordId,
          { kind: 'STAFF', id: manager._id.toString(), email: manager.email, phone: manager.phoneNumber },
          { branchName, recordedByName, amountKobo: params.amountKobo },
          { category: NotificationCategory.BRANCH_MANAGER, branchId: params.branchId },
        ),
      ),
    );
  }

  /** One dispatch call per resolved staff recipient — never one combined job for all of them. */
  private async dispatchToStaff(
    type: NotificationTrigger,
    sourceEntityId: string,
    staffIds: string[],
    payload: Record<string, unknown>,
  ): Promise<void> {
    await Promise.all(
      staffIds.map(async (staffId) => {
        const staff = await this.involvedPartiesResolver.resolveStaffRecipient(staffId);
        await this.notificationService.dispatch(type, sourceEntityId, staff, payload);
      }),
    );
  }
}

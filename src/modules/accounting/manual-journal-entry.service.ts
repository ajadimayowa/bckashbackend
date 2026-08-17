import { Injectable, OnModuleInit } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';

import { JournalSourceEvent } from '../../common/enums/accounting.enums';
import { WorkflowEntityType } from '../../common/enums/workflow.enums';
import { AuditService } from '../../platform/audit/audit.service';
import { approveCapability } from '../../platform/rbac/constants/capabilities';
import {
  WORKFLOW_APPROVED_EVENT,
  WorkflowApprovedEvent,
} from '../../platform/workflow-engine/events/workflow-engine.events';
import { WorkflowRequestDocument } from '../../platform/workflow-engine/schemas/workflow-request.schema';
import { WorkflowEngineService } from '../../platform/workflow-engine/workflow-engine.service';
import { AccountingService } from './accounting.service';
import { assertJournalLinesBalanced } from './journal-balance.util';
import { JournalEntry, JournalEntryDocument } from './schemas/journal-entry.schema';

const MANUAL_ENTRY_ACTION = 'PROPOSE';

interface ManualEntryLinePayload {
  accountId: string;
  debitKobo?: number;
  creditKobo?: number;
}

interface ManualEntryPayload {
  branchId: string;
  date: string;
  lines: ManualEntryLinePayload[];
  description: string | null;
}

/**
 * The "basic accounting operations accessible to all users" surface the
 * brief describes — distinct from `LedgerPostingService`'s automated
 * postings, which no human directly triggers. See PHASE_10_NOTES.md for the
 * confirmed boundary:
 *   - reading the ledger (AccountingService's read surface) and *proposing*
 *     a manual entry (this service) need only `ModuleName.ACCOUNTING`
 *     module access — see `AccountingController`'s `@RequireModule`;
 *   - a proposal is routed through the workflow engine, single-step
 *     Admin/SuperAdmin approval — a free-form manual entry is exactly the
 *     kind of unstructured, error/fraud-prone action worth a second set of
 *     eyes, unlike the automated postings, which are already gated by
 *     upstream approvals in Phases 8/9.
 */
@Injectable()
export class ManualJournalEntryService implements OnModuleInit {
  constructor(
    @InjectModel(JournalEntry.name) private readonly journalEntryModel: Model<JournalEntryDocument>,
    private readonly workflowEngineService: WorkflowEngineService,
    private readonly accountingService: AccountingService,
    private readonly auditService: AuditService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.workflowEngineService.registerChainConfig({
      entityType: WorkflowEntityType.MANUAL_JOURNAL_ENTRY,
      action: MANUAL_ENTRY_ACTION,
      restartOnReturn: true,
      steps: [
        {
          order: 0,
          requiredCapability: approveCapability(WorkflowEntityType.MANUAL_JOURNAL_ENTRY),
        },
      ],
    });
  }

  async proposeEntry(
    input: {
      branchId: string;
      date: string;
      lines: ManualEntryLinePayload[];
      description?: string;
    },
    initiatedBy: string,
  ): Promise<WorkflowRequestDocument> {
    // Validated up front — same "don't create a doomed-to-fail request"
    // principle as Phase 6's minimum-3-members check.
    assertJournalLinesBalanced(input.lines);
    for (const line of input.lines) {
      await this.accountingService.findAccountByIdOrThrow(line.accountId);
    }

    const payload: ManualEntryPayload = {
      branchId: input.branchId,
      date: input.date,
      lines: input.lines,
      description: input.description ?? null,
    };

    return this.workflowEngineService.initiate({
      entityType: WorkflowEntityType.MANUAL_JOURNAL_ENTRY,
      action: MANUAL_ENTRY_ACTION,
      payload: payload as unknown as Record<string, unknown>,
      initiatedBy,
      branchId: input.branchId,
    });
  }

  /**
   * No idempotency concern here (unlike LedgerPostingService's automated
   * postings) — a manual entry is a one-shot human action, not a retryable
   * system call, so `sourceRef` is simply derived from the WorkflowRequest's
   * own id (already unique per proposal). Still protected by the same
   * unique index as every other JournalEntry, as a defensive backstop.
   */
  @OnEvent(WORKFLOW_APPROVED_EVENT)
  async handleWorkflowApproved(event: WorkflowApprovedEvent): Promise<void> {
    if (
      (event.entityType as WorkflowEntityType) !== WorkflowEntityType.MANUAL_JOURNAL_ENTRY ||
      event.action !== MANUAL_ENTRY_ACTION
    ) {
      return;
    }
    const payload = event.payload as unknown as ManualEntryPayload;

    const created = await this.journalEntryModel.create({
      sourceEntityType: JournalSourceEvent.MANUAL_ADJUSTMENT,
      sourceEntityId: new Types.ObjectId(event.workflowRequestId),
      sourceRef: `MANUAL:${event.workflowRequestId}`,
      branchId: new Types.ObjectId(payload.branchId),
      date: new Date(payload.date),
      lines: payload.lines.map((line) => ({
        accountId: new Types.ObjectId(line.accountId),
        debitKobo: line.debitKobo ?? null,
        creditKobo: line.creditKobo ?? null,
      })),
      createdBy: new Types.ObjectId(event.initiatedBy),
      postedBySystem: false,
      postedAt: new Date(),
    });

    await this.auditService.record({
      actorId: event.initiatedBy,
      action: 'MANUAL_JOURNAL_ENTRY_POSTED',
      entityType: 'JOURNAL_ENTRY',
      entityId: created._id.toString(),
      after: { branchId: payload.branchId, lines: payload.lines, description: payload.description },
      metadata: { workflowRequestId: event.workflowRequestId },
    });
  }
}

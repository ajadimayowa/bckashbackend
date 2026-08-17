import { EventEmitterModule } from '@nestjs/event-emitter';
import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { Model, Types } from 'mongoose';

import { WorkflowEntityType, WorkflowStepAction } from '../../../common/enums/workflow.enums';
import { InMemoryMongo } from '../../../test-utils/in-memory-mongo';
import { AuditModule } from '../../../platform/audit/audit.module';
import { AuditLog, AuditLogDocument } from '../../../platform/audit/schemas/audit-log.schema';
import { approveCapability } from '../../../platform/rbac/constants/capabilities';
import { ActingStaff } from '../../../platform/workflow-engine/interfaces/workflow-engine.interfaces';
import {
  WorkflowChainConfig,
  WorkflowChainConfigSchema,
} from '../../../platform/workflow-engine/schemas/workflow-chain-config.schema';
import {
  WorkflowRequest,
  WorkflowRequestDocument,
  WorkflowRequestSchema,
} from '../../../platform/workflow-engine/schemas/workflow-request.schema';
import { WorkflowEngineService } from '../../../platform/workflow-engine/workflow-engine.service';
import { AccountingService } from '../accounting.service';
import { LedgerPostingService } from '../ledger-posting.service';
import { ManualJournalEntryService } from '../manual-journal-entry.service';
import {
  AccountMapping,
  AccountMappingDocument,
  AccountMappingSchema,
} from '../schemas/account-mapping.schema';
import { Account, AccountDocument, AccountSchema } from '../schemas/account.schema';
import {
  JournalEntry,
  JournalEntryDocument,
  JournalEntrySchema,
} from '../schemas/journal-entry.schema';

/**
 * Accounting is self-contained (no dependency on loans/customers/branches
 * real documents — `JournalEntry.branchId` is just a plain ObjectId
 * reference, never existence-checked by this module), so this fixture is
 * far lighter than Phase 8/9's — no need to create real Branch/Customer/
 * Loan documents to exercise any of it.
 */
export interface AccountingTestContext {
  moduleRef: TestingModule;
  mongo: InMemoryMongo;

  accountingService: AccountingService;
  ledgerPostingService: LedgerPostingService;
  manualJournalEntryService: ManualJournalEntryService;
  workflowEngineService: WorkflowEngineService;

  accountModel: Model<AccountDocument>;
  accountMappingModel: Model<AccountMappingDocument>;
  journalEntryModel: Model<JournalEntryDocument>;
  workflowRequestModel: Model<WorkflowRequestDocument>;
  auditLogModel: Model<AuditLogDocument>;

  ADMIN_ID: string;
  MAKER_ID: string;
  branchId: string;
}

export async function createAccountingTestContext(): Promise<AccountingTestContext> {
  const mongo = new InMemoryMongo();
  await mongo.start();

  const moduleRef = await Test.createTestingModule({
    imports: [
      MongooseModule.forRoot(mongo.getUri()),
      MongooseModule.forFeature([
        { name: Account.name, schema: AccountSchema },
        { name: AccountMapping.name, schema: AccountMappingSchema },
        { name: JournalEntry.name, schema: JournalEntrySchema },
        { name: WorkflowChainConfig.name, schema: WorkflowChainConfigSchema },
        { name: WorkflowRequest.name, schema: WorkflowRequestSchema },
      ]),
      AuditModule,
      EventEmitterModule.forRoot(),
    ],
    providers: [
      AccountingService,
      LedgerPostingService,
      ManualJournalEntryService,
      WorkflowEngineService,
    ],
  }).compile();

  const ctx: AccountingTestContext = {
    moduleRef,
    mongo,
    accountingService: moduleRef.get(AccountingService),
    ledgerPostingService: moduleRef.get(LedgerPostingService),
    manualJournalEntryService: moduleRef.get(ManualJournalEntryService),
    workflowEngineService: moduleRef.get(WorkflowEngineService),
    accountModel: moduleRef.get(getModelToken(Account.name)),
    accountMappingModel: moduleRef.get(getModelToken(AccountMapping.name)),
    journalEntryModel: moduleRef.get(getModelToken(JournalEntry.name)),
    workflowRequestModel: moduleRef.get(getModelToken(WorkflowRequest.name)),
    auditLogModel: moduleRef.get(getModelToken(AuditLog.name)),
    ADMIN_ID: new Types.ObjectId().toString(),
    MAKER_ID: new Types.ObjectId().toString(),
    branchId: new Types.ObjectId().toString(),
  };

  await moduleRef.init(); // runs AccountingService.onModuleInit (seed) + ManualJournalEntryService.onModuleInit (chain registration)
  return ctx;
}

export async function teardownAccountingTestContext(ctx: AccountingTestContext): Promise<void> {
  await ctx.moduleRef.close();
  await ctx.mongo.stop();
}

/** Clears everything except the seeded chart of accounts/mappings/chain config — re-seeding on every test would defeat "seeded once at module init" tests. */
export async function clearJournalEntriesAndWorkflowState(
  ctx: AccountingTestContext,
): Promise<void> {
  await ctx.journalEntryModel.deleteMany({}).exec();
  await ctx.workflowRequestModel.deleteMany({}).exec();
}

export function approveManualEntryActor(ctx: AccountingTestContext): ActingStaff {
  return {
    staffId: ctx.ADMIN_ID,
    capabilities: [approveCapability(WorkflowEntityType.MANUAL_JOURNAL_ENTRY)],
  };
}

export async function approveWorkflowRequest(
  ctx: AccountingTestContext,
  workflowRequestId: string,
  actor: ActingStaff,
): Promise<void> {
  await ctx.workflowEngineService.act({
    workflowRequestId,
    actor,
    action: WorkflowStepAction.APPROVED,
  });
}

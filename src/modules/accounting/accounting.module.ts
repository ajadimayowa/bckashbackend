import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { WorkflowEngineModule } from '../../platform/workflow-engine/workflow-engine.module';
import { IdentityModule } from '../identity/identity.module';
import { AccountingConfigController } from './accounting-config.controller';
import { AccountingService } from './accounting.service';
import { LedgerController } from './ledger.controller';
import { LedgerPostingService } from './ledger-posting.service';
import { ManualJournalEntryService } from './manual-journal-entry.service';
import { AccountMapping, AccountMappingSchema } from './schemas/account-mapping.schema';
import { Account, AccountSchema } from './schemas/account.schema';
import { JournalEntry, JournalEntrySchema } from './schemas/journal-entry.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Account.name, schema: AccountSchema },
      { name: AccountMapping.name, schema: AccountMappingSchema },
      { name: JournalEntry.name, schema: JournalEntrySchema },
    ]),
    WorkflowEngineModule,
    IdentityModule,
  ],
  controllers: [AccountingConfigController, LedgerController],
  providers: [AccountingService, LedgerPostingService, ManualJournalEntryService],
  // LedgerPostingService is exported under its own name — LoansModule binds
  // LEDGER_POSTING_PORT to it via `useExisting` (see loans.module.ts) rather
  // than this module knowing about the port token itself, keeping
  // AccountingModule from needing to import anything from `modules/loans`.
  exports: [AccountingService, LedgerPostingService, ManualJournalEntryService],
})
export class AccountingModule {}

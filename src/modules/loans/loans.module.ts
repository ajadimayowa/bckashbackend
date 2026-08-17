import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { RekognitionIntegrationModule } from '../../platform/integrations/rekognition/rekognition.module';
import { WorkflowEngineModule } from '../../platform/workflow-engine/workflow-engine.module';
// LoansModule imports full modules for every dependency (GroupsService,
// LoanProductsService/FeeDefinitionsService, CustomerService,
// BranchFundBalanceService) rather than raw schemas — unlike GroupsModule's
// own cross-module reads, LoansService/LoanVerificationService never query
// another module's collection directly, only through its exported service.
import { BranchesModule } from '../branches/branches.module';
import { CustomersModule } from '../customers/customers.module';
import { GroupsModule } from '../groups/groups.module';
import { IdentityModule } from '../identity/identity.module';
import { LoanProductsModule } from '../loan-products/loan-products.module';
// PendingNotificationLog belongs to the (not-yet-built) notifications
// module — see that schema's own doc comment for why it's registered here
// rather than via a NotificationsModule that doesn't exist yet.
import {
  PendingNotificationLog,
  PendingNotificationLogSchema,
} from '../notifications/schemas/pending-notification-log.schema';
import { StubBankTransferPort } from './bank-transfer/stub-bank-transfer.port';
import { FeePaymentsController } from './fee-payments.controller';
import { FeePaymentsService } from './fee-payments.service';
import { BANK_TRANSFER_PORT } from './interfaces/bank-transfer-port.interface';
import { LEDGER_POSTING_PORT } from './interfaces/ledger-posting-port.interface';
import { NOTIFICATION_PORT } from './interfaces/notification-port.interface';
import { StubLedgerPostingPort } from './ledger/stub-ledger-posting.port';
import { LoanVerificationController } from './loan-verification.controller';
import { LoanVerificationService } from './loan-verification.service';
import { LoansController } from './loans.controller';
import { LoansService } from './loans.service';
import { PendingNotificationLogPort } from './notifications/pending-notification-log.port';
import {
  DisbursementVerification,
  DisbursementVerificationSchema,
} from './schemas/disbursement-verification.schema';
import { FeePayment, FeePaymentSchema } from './schemas/fee-payment.schema';
import { MemberLoanAccount, MemberLoanAccountSchema } from './schemas/member-loan-account.schema';
import { Loan, LoanSchema } from './schemas/loan.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Loan.name, schema: LoanSchema },
      { name: MemberLoanAccount.name, schema: MemberLoanAccountSchema },
      { name: DisbursementVerification.name, schema: DisbursementVerificationSchema },
      { name: FeePayment.name, schema: FeePaymentSchema },
      { name: PendingNotificationLog.name, schema: PendingNotificationLogSchema },
    ]),
    WorkflowEngineModule,
    RekognitionIntegrationModule,
    GroupsModule,
    LoanProductsModule,
    CustomersModule,
    BranchesModule,
    IdentityModule,
  ],
  controllers: [LoansController, LoanVerificationController, FeePaymentsController],
  providers: [
    LoansService,
    LoanVerificationService,
    FeePaymentsService,
    // *** TEMPORARY — see PHASE_8_NOTES.md and each port's own doc comment.
    // Phase 10 (Accounting) must rebind LEDGER_POSTING_PORT; Phase 11
    // (Notifications) must rebind NOTIFICATION_PORT and drain the
    // PendingNotificationLog backlog it leaves behind. BANK_TRANSFER_PORT
    // has no assigned rebinding phase yet — no provider has been chosen. ***
    { provide: LEDGER_POSTING_PORT, useClass: StubLedgerPostingPort },
    { provide: NOTIFICATION_PORT, useClass: PendingNotificationLogPort },
    { provide: BANK_TRANSFER_PORT, useClass: StubBankTransferPort },
  ],
  // LEDGER_POSTING_PORT/NOTIFICATION_PORT exported (not BANK_TRANSFER_PORT,
  // which no other module needs) so Phase 9's RepaymentsModule can reuse the
  // exact same bound singleton rather than registering a second, separately
  // rebound instance of the same conceptual port. See PHASE_9_NOTES.md.
  exports: [
    LoansService,
    LoanVerificationService,
    FeePaymentsService,
    LEDGER_POSTING_PORT,
    NOTIFICATION_PORT,
  ],
})
export class LoansModule {}

import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { RekognitionIntegrationModule } from '../../platform/integrations/rekognition/rekognition.module';
import { S3IntegrationModule } from '../../platform/integrations/s3/s3.module';
import { WorkflowEngineModule } from '../../platform/workflow-engine/workflow-engine.module';
// LoansModule imports full modules for every dependency (GroupsService,
// LoanProductsService/FeeDefinitionsService, CustomerService,
// BranchFundBalanceService) rather than raw schemas — unlike GroupsModule's
// own cross-module reads, LoansService/LoanVerificationService never query
// another module's collection directly, only through its exported service.
import { AccountingModule } from '../accounting/accounting.module';
import { LedgerPostingService } from '../accounting/ledger-posting.service';
import { BranchesModule } from '../branches/branches.module';
import { CustomersModule } from '../customers/customers.module';
// Raw schema only — see fee-payments.service.ts's comment; needed to
// resolve a customer's branchId for LedgerPostingPort.postFeeCollection.
import { Customer, CustomerSchema } from '../customers/schemas/customer.schema';
import { GroupsModule } from '../groups/groups.module';
import { IdentityModule } from '../identity/identity.module';
import { LoanProductsModule } from '../loan-products/loan-products.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { RealNotificationPort } from '../notifications/real-notification.port';
import { StubBankTransferPort } from './bank-transfer/stub-bank-transfer.port';
import { FeePaymentsController } from './fee-payments.controller';
import { FeePaymentsService } from './fee-payments.service';
import { BANK_TRANSFER_PORT } from './interfaces/bank-transfer-port.interface';
import { LEDGER_POSTING_PORT } from './interfaces/ledger-posting-port.interface';
import { NOTIFICATION_PORT } from './interfaces/notification-port.interface';
import { LoanConsentService } from './loan-consent.service';
import { LoanVerificationController } from './loan-verification.controller';
import { LoanVerificationService } from './loan-verification.service';
import { LoansController } from './loans.controller';
import { LoansService } from './loans.service';
import {
  DisbursementVerification,
  DisbursementVerificationSchema,
} from './schemas/disbursement-verification.schema';
import { FeePayment, FeePaymentSchema } from './schemas/fee-payment.schema';
import {
  LoanConsentChallenge,
  LoanConsentChallengeSchema,
} from './schemas/loan-consent-challenge.schema';
import { MemberLoanAccount, MemberLoanAccountSchema } from './schemas/member-loan-account.schema';
import { Loan, LoanSchema } from './schemas/loan.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Loan.name, schema: LoanSchema },
      { name: MemberLoanAccount.name, schema: MemberLoanAccountSchema },
      { name: DisbursementVerification.name, schema: DisbursementVerificationSchema },
      { name: FeePayment.name, schema: FeePaymentSchema },
      { name: Customer.name, schema: CustomerSchema },
      { name: LoanConsentChallenge.name, schema: LoanConsentChallengeSchema },
    ]),
    WorkflowEngineModule,
    RekognitionIntegrationModule,
    S3IntegrationModule,
    GroupsModule,
    LoanProductsModule,
    CustomersModule,
    BranchesModule,
    IdentityModule,
    // Phase 10 — the real LEDGER_POSTING_PORT implementation. No cycle:
    // AccountingModule has no dependency on modules/loans at all.
    AccountingModule,
    // Phase 11 — the real NOTIFICATION_PORT implementation. Same "no cycle"
    // shape: NotificationsModule depends on modules/loans only for the raw
    // Loan schema (read-only), not LoansModule itself.
    NotificationsModule,
  ],
  controllers: [LoansController, LoanVerificationController, FeePaymentsController],
  providers: [
    LoansService,
    LoanVerificationService,
    FeePaymentsService,
    LoanConsentService,
    // *** LEDGER_POSTING_PORT rebound to the real implementation in Phase 10
    // — see PHASE_10_NOTES.md. NOTIFICATION_PORT rebound to the real
    // implementation in Phase 11 — see PHASE_11_NOTES.md for confirmation
    // every Phase 8/9 stub call site now resolves to a real dispatch, and
    // for the backlog-drain admin endpoint. PendingNotificationLogPort
    // (the old stub) remains only for tests that don't need real dispatch.
    // BANK_TRANSFER_PORT has no assigned rebinding phase yet. ***
    { provide: LEDGER_POSTING_PORT, useExisting: LedgerPostingService },
    { provide: NOTIFICATION_PORT, useExisting: RealNotificationPort },
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

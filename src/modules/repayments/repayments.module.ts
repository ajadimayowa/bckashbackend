import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { WorkflowEngineModule } from '../../platform/workflow-engine/workflow-engine.module';
import { S3IntegrationModule } from '../../platform/integrations/s3/s3.module';
// Cross-module raw schema registration only — see repayments.service.ts's
// comment. BranchBankAccount (existence checks), MemberLoanAccount/Loan
// (direct reads/writes) are all owned by other modules.
import {
  BranchBankAccount,
  BranchBankAccountSchema,
} from '../branches/schemas/branch-bank-account.schema';
import { IdentityModule } from '../identity/identity.module';
// LoansModule (not just LoanProductsModule) is imported so this module can
// reuse the exact same LEDGER_POSTING_PORT/NOTIFICATION_PORT bound singleton
// Phase 8 already wired up, rather than registering a second, separately
// rebound instance of the same conceptual port — see loans.module.ts's
// export comment and PHASE_9_NOTES.md.
import { LoansModule } from '../loans/loans.module';
import {
  MemberLoanAccount,
  MemberLoanAccountSchema,
} from '../loans/schemas/member-loan-account.schema';
import { Loan, LoanSchema } from '../loans/schemas/loan.schema';
import { LoanProductsModule } from '../loan-products/loan-products.module';
import { EarlyLiquidationController } from './early-liquidation.controller';
import { EarlyLiquidationService } from './early-liquidation.service';
import { PenaltySweepProcessor } from './penalty-sweep.processor';
import { PENALTY_SWEEP_QUEUE } from './penalty-sweep.queue';
import { PenaltySweepService } from './penalty-sweep.service';
import { RepaymentsController } from './repayments.controller';
import { RepaymentsService } from './repayments.service';
import {
  EarlyLiquidationRequest,
  EarlyLiquidationRequestSchema,
} from './schemas/early-liquidation-request.schema';
import {
  LiquidationDelayCharge,
  LiquidationDelayChargeSchema,
} from './schemas/liquidation-delay-charge.schema';
import { PenaltyCharge, PenaltyChargeSchema } from './schemas/penalty-charge.schema';
import { RepaymentRecord, RepaymentRecordSchema } from './schemas/repayment-record.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: RepaymentRecord.name, schema: RepaymentRecordSchema },
      { name: PenaltyCharge.name, schema: PenaltyChargeSchema },
      { name: EarlyLiquidationRequest.name, schema: EarlyLiquidationRequestSchema },
      { name: LiquidationDelayCharge.name, schema: LiquidationDelayChargeSchema },
      { name: MemberLoanAccount.name, schema: MemberLoanAccountSchema },
      { name: Loan.name, schema: LoanSchema },
      { name: BranchBankAccount.name, schema: BranchBankAccountSchema },
    ]),
    BullModule.registerQueue({ name: PENALTY_SWEEP_QUEUE }),
    WorkflowEngineModule,
    S3IntegrationModule,
    LoansModule,
    LoanProductsModule,
    IdentityModule,
  ],
  controllers: [RepaymentsController, EarlyLiquidationController],
  providers: [
    RepaymentsService,
    EarlyLiquidationService,
    PenaltySweepService,
    PenaltySweepProcessor,
  ],
  exports: [RepaymentsService, EarlyLiquidationService, PenaltySweepService],
})
export class RepaymentsModule {}

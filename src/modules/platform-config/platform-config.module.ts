import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { WorkflowEngineModule } from '../../platform/workflow-engine/workflow-engine.module';
import { IdentityModule } from '../identity/identity.module';
import { BranchRulesConfigurationController } from './branch-rules-configuration.controller';
import { BranchRulesConfigurationService } from './branch-rules-configuration.service';
import { LoanConfigurationController } from './loan-configuration.controller';
import { LoanConfigurationService } from './loan-configuration.service';
import { RepaymentPenaltyConfigurationController } from './repayment-penalty-configuration.controller';
import { RepaymentPenaltyConfigurationService } from './repayment-penalty-configuration.service';
import { BranchRulesConfiguration, BranchRulesConfigurationSchema } from './schemas/branch-rules-configuration.schema';
import { LoanConfiguration, LoanConfigurationSchema } from './schemas/loan-configuration.schema';
import {
  RepaymentPenaltyConfiguration,
  RepaymentPenaltyConfigurationSchema,
} from './schemas/repayment-penalty-configuration.schema';

/**
 * Settings > Loan Configuration / Repayment & Penalties / Branch Rules — three
 * near-identical versioned singleton config entities (see
 * VersionedConfigServiceBase's own doc comment), grouped into one module the
 * same way loan-products.module.ts groups LoanProduct + FeeDefinition.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: LoanConfiguration.name, schema: LoanConfigurationSchema },
      { name: RepaymentPenaltyConfiguration.name, schema: RepaymentPenaltyConfigurationSchema },
      { name: BranchRulesConfiguration.name, schema: BranchRulesConfigurationSchema },
    ]),
    WorkflowEngineModule,
    IdentityModule,
  ],
  controllers: [
    LoanConfigurationController,
    RepaymentPenaltyConfigurationController,
    BranchRulesConfigurationController,
  ],
  providers: [LoanConfigurationService, RepaymentPenaltyConfigurationService, BranchRulesConfigurationService],
  exports: [LoanConfigurationService, RepaymentPenaltyConfigurationService, BranchRulesConfigurationService],
})
export class PlatformConfigModule {}

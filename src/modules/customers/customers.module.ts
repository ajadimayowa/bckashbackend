import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { BvnIntegrationModule } from '../../platform/integrations/bvn/bvn.module';
import { S3IntegrationModule } from '../../platform/integrations/s3/s3.module';
import { WorkflowEngineModule } from '../../platform/workflow-engine/workflow-engine.module';
import { IdentityModule } from '../identity/identity.module';
// Cross-module schema registration only — see customer.service.ts's comment
// and PHASE_3_NOTES.md/PHASE_5_NOTES.md ("cross-module existence checks").
import { Branch, BranchSchema } from '../branches/schemas/branch.schema';
import { CustomerController } from './customer.controller';
import { CustomerService } from './customer.service';
import { Customer, CustomerSchema } from './schemas/customer.schema';
import { KycRecord, KycRecordSchema } from './schemas/kyc-record.schema';
import { PendingBvnConsent, PendingBvnConsentSchema } from './schemas/pending-bvn-consent.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Customer.name, schema: CustomerSchema },
      { name: KycRecord.name, schema: KycRecordSchema },
      { name: PendingBvnConsent.name, schema: PendingBvnConsentSchema },
      { name: Branch.name, schema: BranchSchema },
    ]),
    BvnIntegrationModule,
    S3IntegrationModule,
    WorkflowEngineModule,
    IdentityModule,
  ],
  controllers: [CustomerController],
  providers: [CustomerService],
  exports: [CustomerService],
})
export class CustomersModule {}

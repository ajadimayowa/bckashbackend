import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { BvnIntegrationModule } from '../../platform/integrations/bvn/bvn.module';
import { S3IntegrationModule } from '../../platform/integrations/s3/s3.module';
import { WorkflowEngineModule } from '../../platform/workflow-engine/workflow-engine.module';
import { IdentityModule } from '../identity/identity.module';
// Cross-module schema registration only — see customer.service.ts's comment
// and PHASE_3_NOTES.md/PHASE_5_NOTES.md ("cross-module existence checks").
import { Branch, BranchSchema } from '../branches/schemas/branch.schema';
import { GroupMembership, GroupMembershipSchema } from '../groups/schemas/group-membership.schema';
import { Group, GroupSchema } from '../groups/schemas/group.schema';
import { Staff, StaffSchema } from '../identity/schemas/staff.schema';
import { CustomerController } from './customer.controller';
import { CustomerService } from './customer.service';
import { BvnVerificationPreview, BvnVerificationPreviewSchema } from './schemas/bvn-verification-preview.schema';
import { Customer, CustomerSchema } from './schemas/customer.schema';
import { KycRecord, KycRecordSchema } from './schemas/kyc-record.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Customer.name, schema: CustomerSchema },
      { name: KycRecord.name, schema: KycRecordSchema },
      { name: BvnVerificationPreview.name, schema: BvnVerificationPreviewSchema },
      { name: Branch.name, schema: BranchSchema },
      { name: Staff.name, schema: StaffSchema },
      { name: Group.name, schema: GroupSchema },
      { name: GroupMembership.name, schema: GroupMembershipSchema },
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

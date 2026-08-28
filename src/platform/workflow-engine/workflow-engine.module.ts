import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { AuditModule } from '../audit/audit.module';
// Cross-module raw-model injection (read-only), same pattern used pervasively
// elsewhere (BranchesService/CustomerService/staff.service.ts, ...) —
// WorkflowRequestsController's own bulk staff-name lookup (see its doc
// comment) for `initiatedBy`/`actedBy` needs Staff's name fields without
// importing IdentityModule itself (IdentityModule already imports this
// module, so the reverse import would be circular).
import { Staff, StaffSchema } from '../../modules/identity/schemas/staff.schema';
import {
  WorkflowChainConfig,
  WorkflowChainConfigSchema,
} from './schemas/workflow-chain-config.schema';
import { WorkflowRequest, WorkflowRequestSchema } from './schemas/workflow-request.schema';
import { WorkflowEngineService } from './workflow-engine.service';
import { WorkflowRequestsController } from './workflow-requests.controller';

/**
 * `WorkflowEngineService` itself has no dependency on RbacModule or any
 * domain module by design — see PHASE_2_NOTES.md. `WorkflowRequestsController`
 * (the generic approve/reject/return HTTP surface every domain module's
 * `initiate()` call feeds into) does use `JwtAuthGuard`/`StaffContextGuard`,
 * same as it uses on every other controller in the app — those are
 * dependency-free guard classes (JwtAuthGuard needs no module import at all,
 * see OrganisationModule's identical setup; StaffContextGuard comes from the
 * globally-registered RbacModule) — importing `IdentityModule` here isn't
 * needed and was deliberately avoided (`IdentityModule` itself imports this
 * module, so importing it back would be circular).
 * `EventEmitter2` comes from `EventEmitterModule.forRoot()` registered
 * globally in AppModule, not re-imported here.
 */
@Module({
  imports: [
    AuditModule,
    MongooseModule.forFeature([
      { name: WorkflowChainConfig.name, schema: WorkflowChainConfigSchema },
      { name: WorkflowRequest.name, schema: WorkflowRequestSchema },
      { name: Staff.name, schema: StaffSchema },
    ]),
  ],
  controllers: [WorkflowRequestsController],
  providers: [WorkflowEngineService],
  exports: [WorkflowEngineService],
})
export class WorkflowEngineModule {}

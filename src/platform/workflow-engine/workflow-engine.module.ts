import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { AuditModule } from '../audit/audit.module';
import {
  WorkflowChainConfig,
  WorkflowChainConfigSchema,
} from './schemas/workflow-chain-config.schema';
import { WorkflowRequest, WorkflowRequestSchema } from './schemas/workflow-request.schema';
import { WorkflowEngineService } from './workflow-engine.service';

/**
 * No dependency on RbacModule or any domain module by design — see
 * PHASE_2_NOTES.md. `EventEmitter2` comes from `EventEmitterModule.forRoot()`
 * registered globally in AppModule, not re-imported here.
 */
@Module({
  imports: [
    AuditModule,
    MongooseModule.forFeature([
      { name: WorkflowChainConfig.name, schema: WorkflowChainConfigSchema },
      { name: WorkflowRequest.name, schema: WorkflowRequestSchema },
    ]),
  ],
  providers: [WorkflowEngineService],
  exports: [WorkflowEngineService],
})
export class WorkflowEngineModule {}

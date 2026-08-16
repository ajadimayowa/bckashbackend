import { Global, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { AuditService } from './audit.service';
import { AuditLog, AuditLogSchema } from './schemas/audit-log.schema';

// Global as of Phase 3 — every domain module writes to the audit trail, so
// importing AuditModule everywhere by hand would be pure boilerplate.
@Global()
@Module({
  imports: [MongooseModule.forFeature([{ name: AuditLog.name, schema: AuditLogSchema }])],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}

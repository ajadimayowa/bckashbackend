import { Global, Module } from '@nestjs/common';

import { EncryptionService } from './encryption.service';

// Global — every module that touches PII (customers' BVN/NIN today, HR
// salary data later) needs this without importing it by hand each time,
// same reasoning as AuditModule/RbacModule (see PHASE_3_NOTES.md).
@Global()
@Module({
  providers: [EncryptionService],
  exports: [EncryptionService],
})
export class EncryptionModule {}

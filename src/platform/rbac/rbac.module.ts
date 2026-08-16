import { Global, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { CapabilityGuard } from './guards/capability.guard';
import { ModuleAccessGuard } from './guards/module-access.guard';
import { StaffContextGuard } from './guards/staff-context.guard';
import { RbacController } from './rbac.controller';
import { RbacService } from './rbac.service';
import { RoleCapabilities, RoleCapabilitiesSchema } from './schemas/role-capabilities.schema';
import { StaffModuleAccess, StaffModuleAccessSchema } from './schemas/staff-module-access.schema';

// Global as of Phase 3 — every domain module needs these guards on its
// controllers, so importing RbacModule everywhere by hand would be pure
// boilerplate. (Not global in Phase 2, since nothing consumed it yet.)
@Global()
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: RoleCapabilities.name, schema: RoleCapabilitiesSchema },
      { name: StaffModuleAccess.name, schema: StaffModuleAccessSchema },
    ]),
  ],
  controllers: [RbacController],
  providers: [RbacService, StaffContextGuard, CapabilityGuard, ModuleAccessGuard],
  exports: [RbacService, StaffContextGuard, CapabilityGuard, ModuleAccessGuard],
})
export class RbacModule {}

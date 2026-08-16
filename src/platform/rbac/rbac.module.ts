import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { CapabilityGuard } from './guards/capability.guard';
import { ModuleAccessGuard } from './guards/module-access.guard';
import { StaffContextGuard } from './guards/staff-context.guard';
import { RbacController } from './rbac.controller';
import { RbacService } from './rbac.service';
import { RoleCapabilities, RoleCapabilitiesSchema } from './schemas/role-capabilities.schema';
import { StaffModuleAccess, StaffModuleAccessSchema } from './schemas/staff-module-access.schema';

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

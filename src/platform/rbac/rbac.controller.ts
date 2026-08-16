import { Body, Controller, Get, Param, ParseEnumPipe, Put, UseGuards } from '@nestjs/common';

import { StaffRole } from '../../common/enums/identity.enums';
import { RBAC_MANAGE_CAPABILITY } from './constants/capabilities';
import { RequireCapability } from './decorators/require-capability.decorator';
import { UpdateRoleCapabilitiesDto } from './dto/update-role-capabilities.dto';
import { UpdateStaffModuleAccessDto } from './dto/update-staff-module-access.dto';
import { CapabilityGuard } from './guards/capability.guard';
import { StaffContextGuard } from './guards/staff-context.guard';
import { RbacService } from './rbac.service';
import { RoleCapabilities } from './schemas/role-capabilities.schema';
import { StaffModuleAccess } from './schemas/staff-module-access.schema';

/**
 * Admin surface for editing the capability matrix / per-staff module access
 * without a redeploy. Every mutating route requires `rbac:manage` — by design
 * only SUPERADMIN holds that in the default seed (see default-role-capabilities.ts).
 *
 * `@UseGuards(StaffContextGuard, CapabilityGuard)` expects `request.user` to
 * already be populated by an upstream JWT auth guard — that guard is Phase 3's
 * (identity module) responsibility, not registered here.
 */
@Controller('rbac')
@UseGuards(StaffContextGuard, CapabilityGuard)
export class RbacController {
  constructor(private readonly rbacService: RbacService) {}

  @Get('role-capabilities')
  @RequireCapability(RBAC_MANAGE_CAPABILITY)
  listRoleCapabilities(): Promise<RoleCapabilities[]> {
    return this.rbacService.listRoleCapabilities();
  }

  @Put('role-capabilities/:role')
  @RequireCapability(RBAC_MANAGE_CAPABILITY)
  updateRoleCapabilities(
    @Param('role', new ParseEnumPipe(StaffRole)) role: StaffRole,
    @Body() dto: UpdateRoleCapabilitiesDto,
  ): Promise<RoleCapabilities> {
    return this.rbacService.setCapabilitiesForRole(role, dto.capabilities);
  }

  @Put('staff-module-access/:staffId')
  @RequireCapability(RBAC_MANAGE_CAPABILITY)
  updateStaffModuleAccess(
    @Param('staffId') staffId: string,
    @Body() dto: UpdateStaffModuleAccessDto,
  ): Promise<StaffModuleAccess> {
    return this.rbacService.setModulesForStaff(staffId, dto.modules);
  }
}

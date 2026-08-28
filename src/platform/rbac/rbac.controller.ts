import { Body, Controller, Delete, Get, Param, ParseEnumPipe, Post, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { StaffRole } from '../../common/enums/identity.enums';
import { JwtAuthGuard } from '../../modules/identity/guards/jwt-auth.guard';
import { RBAC_MANAGE_CAPABILITY } from './constants/capabilities';
import { RequireCapability } from './decorators/require-capability.decorator';
import { AddRoleCapabilityDto } from './dto/add-role-capability.dto';
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
 * `JwtAuthGuard` added here (was previously missing — a real, previously-
 * flagged gap: `StaffContextGuard` expects `request.user` already populated,
 * which never happened without an auth guard running first, so every route
 * here 401'd unconditionally regardless of a valid token). Found and fixed
 * while wiring up Swagger documentation for this controller — leaving it
 * broken while documenting `@ApiBearerAuth` on it would have been
 * misleading. Failed closed the whole time (not a security hole), just
 * unusable.
 */
@ApiTags('rbac')
@ApiBearerAuth('access-token')
@Controller('rbac')
@UseGuards(JwtAuthGuard, StaffContextGuard, CapabilityGuard)
export class RbacController {
  constructor(private readonly rbacService: RbacService) {}

  @Get('role-capabilities')
  @RequireCapability(RBAC_MANAGE_CAPABILITY)
  @ApiOperation({
    summary: 'List the default capability set for every role',
    description:
      'SuperAdmin only. Returns every RoleCapabilities document currently seeded/edited.',
  })
  listRoleCapabilities(): Promise<RoleCapabilities[]> {
    return this.rbacService.listRoleCapabilities();
  }

  @Put('role-capabilities/:role')
  @RequireCapability(RBAC_MANAGE_CAPABILITY)
  @ApiOperation({
    summary: "Replace a role's capability set",
    description:
      'SuperAdmin only. Overwrites the full capability list for the given role — omit a capability to revoke it, not just to add new ones.',
  })
  updateRoleCapabilities(
    @Param('role', new ParseEnumPipe(StaffRole)) role: StaffRole,
    @Body() dto: UpdateRoleCapabilitiesDto,
  ): Promise<RoleCapabilities> {
    return this.rbacService.setCapabilitiesForRole(role, dto.capabilities);
  }

  @Post('role-capabilities/:role/capabilities')
  @RequireCapability(RBAC_MANAGE_CAPABILITY)
  @ApiOperation({
    summary: "Grant a role one additional capability",
    description:
      'SuperAdmin only. Incremental complement to PUT role-capabilities/:role (which replaces ' +
      'the whole list — easy to accidentally revoke everything else with a stale client-side ' +
      'copy). Idempotent: granting a capability the role already has is a no-op, never a ' +
      'duplicate entry. E.g. `{ "capability": "workflow:initiate:STAFF" }` to let a role ' +
      'initiate staff onboarding (see constants/capabilities.ts for the exact strings a ' +
      'workflow chain actually checks).',
  })
  addRoleCapability(
    @Param('role', new ParseEnumPipe(StaffRole)) role: StaffRole,
    @Body() dto: AddRoleCapabilityDto,
  ): Promise<RoleCapabilities> {
    return this.rbacService.addCapabilityToRole(role, dto.capability);
  }

  @Delete('role-capabilities/:role/capabilities/:capability')
  @RequireCapability(RBAC_MANAGE_CAPABILITY)
  @ApiOperation({
    summary: "Revoke one capability from a role",
    description: 'SuperAdmin only. Symmetric with the grant endpoint above — idempotent either way.',
  })
  removeRoleCapability(
    @Param('role', new ParseEnumPipe(StaffRole)) role: StaffRole,
    @Param('capability') capability: string,
  ): Promise<RoleCapabilities> {
    return this.rbacService.removeCapabilityFromRole(role, capability);
  }

  @Put('staff-module-access/:staffId')
  @RequireCapability(RBAC_MANAGE_CAPABILITY)
  @ApiOperation({
    summary: "Replace one staff member's module access",
    description:
      'SuperAdmin only. Module access (LOANS/ACCOUNTING/HR) is a separate dimension from role/capability — this is the only way to grant or revoke it for a given staff member.',
  })
  updateStaffModuleAccess(
    @Param('staffId') staffId: string,
    @Body() dto: UpdateStaffModuleAccessDto,
  ): Promise<StaffModuleAccess> {
    return this.rbacService.setModulesForStaff(staffId, dto.modules);
  }
}

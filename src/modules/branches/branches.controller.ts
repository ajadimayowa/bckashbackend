import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';

import { JwtAuthGuard } from '../identity/guards/jwt-auth.guard';
import { ORG_MANAGE_CAPABILITY } from '../../platform/rbac/constants/capabilities';
import { CurrentStaffContext } from '../../platform/rbac/decorators/current-staff-context.decorator';
import { RequireCapability } from '../../platform/rbac/decorators/require-capability.decorator';
import { CapabilityGuard } from '../../platform/rbac/guards/capability.guard';
import { StaffContextGuard } from '../../platform/rbac/guards/staff-context.guard';
import type { ResolvedStaffContext } from '../../platform/rbac/interfaces/staff-context.interface';
import { BranchManagerAssignmentService } from './branch-manager-assignment.service';
import { BranchesService } from './branches.service';
import { AssignManagerDto } from './dto/assign-manager.dto';
import { CreateBranchDto } from './dto/create-branch.dto';
import { UpdateBranchDto } from './dto/update-branch.dto';
import { Branch } from './schemas/branch.schema';
import { BranchManagerAssignment } from './schemas/branch-manager-assignment.schema';

@Controller('branches')
@UseGuards(JwtAuthGuard, StaffContextGuard, CapabilityGuard)
@RequireCapability(ORG_MANAGE_CAPABILITY)
export class BranchesController {
  constructor(
    private readonly branchesService: BranchesService,
    private readonly branchManagerAssignmentService: BranchManagerAssignmentService,
  ) {}

  @Post()
  create(@Body() dto: CreateBranchDto): Promise<Branch> {
    return this.branchesService.create(dto);
  }

  @Get()
  findAll(): Promise<Branch[]> {
    return this.branchesService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string): Promise<Branch> {
    return this.branchesService.findById(id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateBranchDto): Promise<Branch> {
    return this.branchesService.update(id, dto);
  }

  @Post(':id/manager')
  assignManager(
    @Param('id') branchId: string,
    @Body() dto: AssignManagerDto,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<BranchManagerAssignment> {
    return this.branchManagerAssignmentService.assignManager(branchId, dto.staffId, actor.staffId);
  }

  @Get(':id/manager')
  getCurrentManager(@Param('id') branchId: string): Promise<BranchManagerAssignment | null> {
    return this.branchManagerAssignmentService.getCurrentManager(branchId);
  }

  @Get(':id/manager-history')
  getManagerHistory(@Param('id') branchId: string): Promise<BranchManagerAssignment[]> {
    return this.branchManagerAssignmentService.getHistory(branchId);
  }
}

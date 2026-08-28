import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { WorkflowEntityType } from '../../common/enums/workflow.enums';
import { approveCapability } from '../../platform/rbac/constants/capabilities';
import { CurrentStaffContext } from '../../platform/rbac/decorators/current-staff-context.decorator';
import { RequireCapability } from '../../platform/rbac/decorators/require-capability.decorator';
import { CapabilityGuard } from '../../platform/rbac/guards/capability.guard';
import { StaffContextGuard } from '../../platform/rbac/guards/staff-context.guard';
import type { ResolvedStaffContext } from '../../platform/rbac/interfaces/staff-context.interface';
import { JwtAuthGuard } from '../identity/guards/jwt-auth.guard';
import { BranchRequestsService } from './branch-requests.service';
import { CreateBranchRequestDto } from './dto/create-branch-request.dto';
import { ResolveBranchRequestDto } from './dto/resolve-branch-request.dto';
import { BranchRequest } from './schemas/branch-request.schema';

// Same tier that approves/deletes a branch — the natural gate for resolving
// a manager's request to head office too.
const RESOLVE_BRANCH_REQUEST = approveCapability(WorkflowEntityType.BRANCH);

@ApiTags('branch-requests')
@ApiBearerAuth('access-token')
@Controller('branch-requests')
@UseGuards(JwtAuthGuard, StaffContextGuard, CapabilityGuard)
export class BranchRequestsController {
  constructor(private readonly branchRequestsService: BranchRequestsService) {}

  @Post()
  @ApiOperation({
    summary: 'Raise a request to head office',
    description: 'Manager only, always about their own branch — no capability gate, enforced server-side.',
  })
  create(
    @Body() dto: CreateBranchRequestDto,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<BranchRequest> {
    return this.branchRequestsService.create(dto, actor);
  }

  @Get()
  @ApiOperation({
    summary: 'List requests to head office',
    description: 'Admin/SuperAdmin/Approver see all (optionally filtered by branchId); a Manager sees only their own branch.',
  })
  findAll(
    @Query('branchId') branchId: string | undefined,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<BranchRequest[]> {
    return this.branchRequestsService.findAll(branchId, actor);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a request by id' })
  findOne(@Param('id') id: string): Promise<BranchRequest> {
    return this.branchRequestsService.findById(id);
  }

  @Post(':id/resolve')
  @RequireCapability(RESOLVE_BRANCH_REQUEST)
  @ApiOperation({ summary: 'Resolve a request' })
  resolve(
    @Param('id') id: string,
    @Body() dto: ResolveBranchRequestDto,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<BranchRequest> {
    return this.branchRequestsService.resolve(id, actor.staffId, dto.note);
  }
}

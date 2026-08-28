import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { ModuleName } from '../../common/enums/identity.enums';
import { HR_LEAVE_TYPES_MANAGE_CAPABILITY } from '../../platform/rbac/constants/capabilities';
import { RequireCapability } from '../../platform/rbac/decorators/require-capability.decorator';
import { RequireModule } from '../../platform/rbac/decorators/require-module.decorator';
import { CapabilityGuard } from '../../platform/rbac/guards/capability.guard';
import { ModuleAccessGuard } from '../../platform/rbac/guards/module-access.guard';
import { StaffContextGuard } from '../../platform/rbac/guards/staff-context.guard';
import { JwtAuthGuard } from '../identity/guards/jwt-auth.guard';
import { CreateLeaveTypeDto } from './dto/create-leave-type.dto';
import { UpdateLeaveTypeDto } from './dto/update-leave-type.dto';
import { LeaveTypeService } from './leave-type.service';
import { LeaveType } from './schemas/leave-type.schema';

/**
 * LeaveType CRUD — Admin-gated, deliberately not workflow-mediated. See
 * `HR_LEAVE_TYPES_MANAGE_CAPABILITY`'s own doc comment and PHASE_12_NOTES.md
 * for the flagged assumption.
 */
@ApiTags('hr-leave-types')
@ApiBearerAuth('access-token')
@Controller('hr/leave-types')
@UseGuards(JwtAuthGuard, StaffContextGuard, ModuleAccessGuard, CapabilityGuard)
@RequireModule(ModuleName.HR)
@RequireCapability(HR_LEAVE_TYPES_MANAGE_CAPABILITY)
export class LeaveTypeController {
  constructor(private readonly leaveTypeService: LeaveTypeService) {}

  @Post()
  @ApiOperation({
    summary: 'Create a leave type',
    description: 'e.g. Annual, Sick, Casual, Maternity/Paternity, Unpaid.',
  })
  create(@Body() dto: CreateLeaveTypeDto): Promise<LeaveType> {
    return this.leaveTypeService.create(dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a leave type' })
  update(@Param('id') id: string, @Body() dto: UpdateLeaveTypeDto): Promise<LeaveType> {
    return this.leaveTypeService.update(id, dto);
  }

  @Get()
  @ApiOperation({ summary: 'List leave types', description: 'Optionally active-only.' })
  findAll(@Query('activeOnly') activeOnly?: string): Promise<LeaveType[]> {
    return this.leaveTypeService.findAll(activeOnly === 'true');
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a leave type by id' })
  findOne(@Param('id') id: string): Promise<LeaveType> {
    return this.leaveTypeService.findByIdOrThrow(id);
  }
}

import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';

import { ORG_MANAGE_CAPABILITY } from '../../platform/rbac/constants/capabilities';
import { RequireCapability } from '../../platform/rbac/decorators/require-capability.decorator';
import { CapabilityGuard } from '../../platform/rbac/guards/capability.guard';
import { StaffContextGuard } from '../../platform/rbac/guards/staff-context.guard';
import { DepartmentsService } from './departments.service';
import { CreateDepartmentDto } from './dto/create-department.dto';
import { UpdateDepartmentDto } from './dto/update-department.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { Department } from './schemas/department.schema';

/**
 * Plain Admin/SuperAdmin CRUD — deliberately not workflow-mediated. See
 * PHASE_3_NOTES.md for why (low-risk, easily reversible, no maker-checker
 * value for renaming a department).
 */
@Controller('departments')
@UseGuards(JwtAuthGuard, StaffContextGuard, CapabilityGuard)
@RequireCapability(ORG_MANAGE_CAPABILITY)
export class DepartmentsController {
  constructor(private readonly departmentsService: DepartmentsService) {}

  @Post()
  create(@Body() dto: CreateDepartmentDto): Promise<Department> {
    return this.departmentsService.create(dto);
  }

  @Get()
  findAll(): Promise<Department[]> {
    return this.departmentsService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string): Promise<Department> {
    return this.departmentsService.findById(id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateDepartmentDto): Promise<Department> {
    return this.departmentsService.update(id, dto);
  }
}

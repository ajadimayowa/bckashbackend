import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { ORG_MANAGE_CAPABILITY } from '../../platform/rbac/constants/capabilities';
import { RequireCapability } from '../../platform/rbac/decorators/require-capability.decorator';
import { CapabilityGuard } from '../../platform/rbac/guards/capability.guard';
import { StaffContextGuard } from '../../platform/rbac/guards/staff-context.guard';
import { DepartmentsService } from './departments.service';
import { CreateDepartmentDto } from './dto/create-department.dto';
import { DepartmentResponseDto } from './dto/department-response.dto';
import { UpdateDepartmentDto } from './dto/update-department.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { DepartmentDocument } from './schemas/department.schema';

/**
 * Plain Admin/SuperAdmin CRUD — deliberately not workflow-mediated. See
 * PHASE_3_NOTES.md for why (low-risk, easily reversible, no maker-checker
 * value for renaming a department).
 */
@ApiTags('departments')
@ApiBearerAuth('access-token')
@Controller('departments')
@UseGuards(JwtAuthGuard, StaffContextGuard, CapabilityGuard)
@RequireCapability(ORG_MANAGE_CAPABILITY)
export class DepartmentsController {
  constructor(private readonly departmentsService: DepartmentsService) {}

  private async toResponse(department: DepartmentDocument): Promise<DepartmentResponseDto> {
    const staffCount = await this.departmentsService.countStaff(department._id.toString());
    return DepartmentResponseDto.fromDocument(department, staffCount);
  }

  @Post()
  @ApiOperation({ summary: 'Create a department' })
  async create(@Body() dto: CreateDepartmentDto): Promise<DepartmentResponseDto> {
    const department = await this.departmentsService.create(dto);
    return this.toResponse(department);
  }

  @Get()
  @ApiOperation({ summary: 'List every department', description: 'Each department includes a real, aggregated staffCount.' })
  async findAll(): Promise<DepartmentResponseDto[]> {
    const departments = await this.departmentsService.findAll();
    const staffCounts = await this.departmentsService.countStaffByDepartment(
      departments.map((department) => department._id.toString()),
    );
    return departments.map((department) =>
      DepartmentResponseDto.fromDocument(department, staffCounts.get(department._id.toString()) ?? 0),
    );
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a department by id' })
  async findOne(@Param('id') id: string): Promise<DepartmentResponseDto> {
    const department = await this.departmentsService.findById(id);
    return this.toResponse(department);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a department' })
  async update(@Param('id') id: string, @Body() dto: UpdateDepartmentDto): Promise<DepartmentResponseDto> {
    const department = await this.departmentsService.update(id, dto);
    return this.toResponse(department);
  }

  @Delete(':id')
  @ApiOperation({
    summary: 'Hard-delete a department',
    description: 'Only while nothing (staff, units) still references it.',
  })
  async remove(@Param('id') id: string): Promise<{ deleted: true }> {
    await this.departmentsService.remove(id);
    return { deleted: true };
  }
}

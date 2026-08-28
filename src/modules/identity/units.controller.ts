import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { ORG_MANAGE_CAPABILITY } from '../../platform/rbac/constants/capabilities';
import { RequireCapability } from '../../platform/rbac/decorators/require-capability.decorator';
import { CapabilityGuard } from '../../platform/rbac/guards/capability.guard';
import { StaffContextGuard } from '../../platform/rbac/guards/staff-context.guard';
import { DepartmentsService } from './departments.service';
import { CreateUnitDto } from './dto/create-unit.dto';
import { UnitResponseDto } from './dto/unit-response.dto';
import { UpdateUnitDto } from './dto/update-unit.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { UnitDocument } from './schemas/unit.schema';
import { UnitsService } from './units.service';

@ApiTags('units')
@ApiBearerAuth('access-token')
@Controller('units')
@UseGuards(JwtAuthGuard, StaffContextGuard, CapabilityGuard)
@RequireCapability(ORG_MANAGE_CAPABILITY)
export class UnitsController {
  constructor(
    private readonly unitsService: UnitsService,
    private readonly departmentsService: DepartmentsService,
  ) {}

  /** Single-unit responses — one extra departmentsService lookup, negligible. */
  private async toResponse(unit: UnitDocument): Promise<UnitResponseDto> {
    const [department, staffCount] = await Promise.all([
      this.departmentsService.findById(unit.departmentId.toString()).catch(() => null),
      this.unitsService.countStaffByUnit([unit._id.toString()]).then((counts) => counts.get(unit._id.toString()) ?? 0),
    ]);
    return UnitResponseDto.fromDocument(unit, department?.name ?? '', staffCount);
  }

  /**
   * List responses — one batched departmentsService lookup for every unit's
   * departmentName, and one batched staffCount aggregation, not one query
   * each per unit.
   */
  private async toResponseList(units: UnitDocument[]): Promise<UnitResponseDto[]> {
    const departmentIds = [...new Set(units.map((unit) => unit.departmentId.toString()))];
    const [departments, staffCounts] = await Promise.all([
      this.departmentsService.findByIds(departmentIds),
      this.unitsService.countStaffByUnit(units.map((unit) => unit._id.toString())),
    ]);
    const nameById = new Map(departments.map((d) => [d._id.toString(), d.name]));
    return units.map((unit) =>
      UnitResponseDto.fromDocument(
        unit,
        nameById.get(unit.departmentId.toString()) ?? '',
        staffCounts.get(unit._id.toString()) ?? 0,
      ),
    );
  }

  @Post()
  @ApiOperation({
    summary: 'Create a unit',
    description: 'A unit belongs to exactly one department.',
  })
  async create(@Body() dto: CreateUnitDto): Promise<UnitResponseDto> {
    const unit = await this.unitsService.create(dto);
    return this.toResponse(unit);
  }

  @Get()
  @ApiOperation({
    summary: 'List units',
    description:
      'Optionally filter to one department. Each unit includes both departmentId and the ' +
      "resolved departmentName, not just the bare id.",
  })
  async findAll(@Query('departmentId') departmentId?: string): Promise<UnitResponseDto[]> {
    const units = await this.unitsService.findAll(departmentId);
    return this.toResponseList(units);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get a unit by id',
    description: 'Includes both departmentId and the resolved departmentName.',
  })
  async findOne(@Param('id') id: string): Promise<UnitResponseDto> {
    const unit = await this.unitsService.findById(id);
    return this.toResponse(unit);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a unit' })
  async update(@Param('id') id: string, @Body() dto: UpdateUnitDto): Promise<UnitResponseDto> {
    const unit = await this.unitsService.update(id, dto);
    return this.toResponse(unit);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Hard-delete a unit', description: 'Only while no Staff record still references it.' })
  async remove(@Param('id') id: string): Promise<{ deleted: true }> {
    await this.unitsService.remove(id);
    return { deleted: true };
  }
}

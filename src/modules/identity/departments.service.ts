import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { CreateDepartmentDto } from './dto/create-department.dto';
import { UpdateDepartmentDto } from './dto/update-department.dto';
import { Department, DepartmentDocument } from './schemas/department.schema';
import { Staff, StaffDocument } from './schemas/staff.schema';
import { Unit, UnitDocument } from './schemas/unit.schema';

@Injectable()
export class DepartmentsService {
  constructor(
    @InjectModel(Department.name) private readonly departmentModel: Model<DepartmentDocument>,
    // Same module, no new wiring needed — just for staffCount/remove's own reference checks below.
    @InjectModel(Staff.name) private readonly staffModel: Model<StaffDocument>,
    @InjectModel(Unit.name) private readonly unitModel: Model<UnitDocument>,
  ) {}

  async create(dto: CreateDepartmentDto): Promise<DepartmentDocument> {
    return this.departmentModel.create({ name: dto.name, active: true });
  }

  async findAll(): Promise<DepartmentDocument[]> {
    return this.departmentModel.find().sort({ name: 1 }).exec();
  }

  async findById(id: string): Promise<DepartmentDocument> {
    const department = await this.departmentModel.findById(id).exec();
    if (!department) {
      throw new NotFoundException(`Department ${id} not found`);
    }
    return department;
  }

  /**
   * Batch lookup by id — used by UnitsController to resolve every unit's
   * departmentName in one query rather than one per unit (same "batch
   * lookup, silently skip a stale id" shape as StaffService.findByIds).
   */
  async findByIds(ids: string[]): Promise<DepartmentDocument[]> {
    if (ids.length === 0) {
      return [];
    }
    return this.departmentModel.find({ _id: { $in: ids } }).exec();
  }

  async update(id: string, dto: UpdateDepartmentDto): Promise<DepartmentDocument> {
    const department = await this.departmentModel
      .findByIdAndUpdate(id, { $set: dto }, { new: true })
      .exec();
    if (!department) {
      throw new NotFoundException(`Department ${id} not found`);
    }
    return department;
  }

  /**
   * Hard delete — only while nothing still references it (no Staff, no
   * Unit), same reference-safety principle as BranchesService.deleteBranch.
   * `$expr`+`$toString` on the unit check for the same reason
   * countStaff/countStaffByDepartment use it below — defensive against a
   * Unit whose own `departmentId` predates UnitsService.create's
   * explicit-cast fix.
   */
  async remove(id: string): Promise<void> {
    const department = await this.findById(id);
    const [staffCount, unitCount] = await Promise.all([
      this.countStaff(id),
      this.unitModel.countDocuments({ $expr: { $eq: [{ $toString: '$departmentId' }, id] } }).exec(),
    ]);
    if (staffCount > 0 || unitCount > 0) {
      throw new ConflictException(
        `Department ${id} still has records referencing it (staff: ${staffCount}, units: ${unitCount}) — it cannot be deleted while any exist`,
      );
    }
    await this.departmentModel.deleteOne({ _id: department._id }).exec();
  }

  /** Used by UnitsService/StaffService to validate a departmentId reference before trusting it. */
  async assertExists(id: string): Promise<void> {
    const exists = await this.departmentModel.exists({ _id: id });
    if (!exists) {
      throw new BadRequestException(`Department ${id} does not exist`);
    }
  }

  /**
   * Every Staff record currently pointing at this department — regardless
   * of status, matching StaffService.getPerformanceSummary's own "just
   * count what's there" convention. `$expr`+`$toString` rather than a plain
   * ObjectId-cast filter — defensive against a Staff record whose
   * `departmentId` predates StaffService.handleWorkflowApproved/createDirect's
   * explicit-cast fix (stored as a bare string, not an ObjectId), so this
   * stays accurate with no data migration required.
   */
  async countStaff(departmentId: string): Promise<number> {
    return this.staffModel
      .countDocuments({ $expr: { $eq: [{ $toString: '$departmentId' }, departmentId] } })
      .exec();
  }

  /**
   * Batched — one aggregation instead of one countDocuments per department
   * (used by DepartmentsController.findAll, mirrors UnitsController's own
   * batched departmentName resolution). A department with zero staff simply
   * has no entry in the returned map — callers default to 0. Same
   * `$toString` defensiveness as countStaff's own doc comment.
   */
  async countStaffByDepartment(departmentIds: string[]): Promise<Map<string, number>> {
    if (departmentIds.length === 0) {
      return new Map();
    }
    const results = await this.staffModel
      .aggregate<{ _id: string; count: number }>([
        { $match: { $expr: { $in: [{ $toString: '$departmentId' }, departmentIds] } } },
        { $group: { _id: { $toString: '$departmentId' }, count: { $sum: 1 } } },
      ])
      .exec();
    return new Map(results.map((row) => [row._id, row.count]));
  }
}

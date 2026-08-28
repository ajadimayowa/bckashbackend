import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';

import { DepartmentsService } from './departments.service';
import { CreateUnitDto } from './dto/create-unit.dto';
import { UpdateUnitDto } from './dto/update-unit.dto';
import { Staff, StaffDocument } from './schemas/staff.schema';
import { Unit, UnitDocument } from './schemas/unit.schema';

@Injectable()
export class UnitsService {
  constructor(
    @InjectModel(Unit.name) private readonly unitModel: Model<UnitDocument>,
    // Same module, no new wiring needed — just for staffCount below.
    @InjectModel(Staff.name) private readonly staffModel: Model<StaffDocument>,
    private readonly departmentsService: DepartmentsService,
  ) {}

  async create(dto: CreateUnitDto): Promise<UnitDocument> {
    // Unit.departmentId must reference an existing department — validated here,
    // not just left to the DB reference (which Mongoose doesn't enforce anyway).
    await this.departmentsService.assertExists(dto.departmentId);

    // Explicit Types.ObjectId cast — a plain string does not reliably cast
    // against a Types.ObjectId-typed schema path in this project's Mongoose
    // setup, including on .create() (see staff.service.ts's own comment on
    // the same bug class, found while building this file's own staffCount
    // methods).
    return this.unitModel.create({
      departmentId: new Types.ObjectId(dto.departmentId),
      name: dto.name,
      active: true,
    });
  }

  async findAll(departmentId?: string): Promise<UnitDocument[]> {
    const filter = departmentId ? { departmentId: new Types.ObjectId(departmentId) } : {};
    return this.unitModel.find(filter).sort({ name: 1 }).exec();
  }

  async findById(id: string): Promise<UnitDocument> {
    const unit = await this.unitModel.findById(id).exec();
    if (!unit) {
      throw new NotFoundException(`Unit ${id} not found`);
    }
    return unit;
  }

  async update(id: string, dto: UpdateUnitDto): Promise<UnitDocument> {
    if (dto.departmentId) {
      await this.departmentsService.assertExists(dto.departmentId);
    }

    // Same explicit-cast reasoning as create() above — $set bypasses the
    // schema's own cast the same way .create()'s top-level fields do.
    const update: Record<string, unknown> = { ...dto };
    if (dto.departmentId) {
      update.departmentId = new Types.ObjectId(dto.departmentId);
    }

    const unit = await this.unitModel.findByIdAndUpdate(id, { $set: update }, { new: true }).exec();
    if (!unit) {
      throw new NotFoundException(`Unit ${id} not found`);
    }
    return unit;
  }

  /** Hard delete — only while no Staff record still references it. */
  async remove(id: string): Promise<void> {
    const unit = await this.findById(id);
    const staffCount = (await this.countStaffByUnit([id])).get(id) ?? 0;
    if (staffCount > 0) {
      throw new ConflictException(
        `Unit ${id} still has ${staffCount} staff record(s) referencing it — it cannot be deleted while any exist`,
      );
    }
    await this.unitModel.deleteOne({ _id: unit._id }).exec();
  }

  /** Used by StaffService to validate a unitId reference and that it belongs to the claimed department. */
  async assertBelongsToDepartment(unitId: string, departmentId: string): Promise<void> {
    const unit = await this.unitModel.findById(unitId).exec();
    if (!unit) {
      throw new BadRequestException(`Unit ${unitId} does not exist`);
    }
    if (unit.departmentId.toString() !== departmentId) {
      throw new BadRequestException(`Unit ${unitId} does not belong to department ${departmentId}`);
    }
  }

  /**
   * Batched — one aggregation instead of one countDocuments per unit, same
   * "map, default to 0 for anything absent" shape as
   * DepartmentsService.countStaffByDepartment. Matches via `$toString` on
   * both sides rather than a plain `$in` of ObjectIds — defensive against
   * any Staff record whose `unitId` was written before the explicit-cast
   * fix in StaffService.handleWorkflowApproved/createDirect (stored as a
   * bare string, not an ObjectId) still being counted correctly, with no
   * data migration required.
   */
  async countStaffByUnit(unitIds: string[]): Promise<Map<string, number>> {
    if (unitIds.length === 0) {
      return new Map();
    }
    const results = await this.staffModel
      .aggregate<{ _id: string; count: number }>([
        { $match: { $expr: { $in: [{ $toString: '$unitId' }, unitIds] } } },
        { $group: { _id: { $toString: '$unitId' }, count: { $sum: 1 } } },
      ])
      .exec();
    return new Map(results.map((row) => [row._id, row.count]));
  }
}

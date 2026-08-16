import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { DepartmentsService } from './departments.service';
import { CreateUnitDto } from './dto/create-unit.dto';
import { UpdateUnitDto } from './dto/update-unit.dto';
import { Unit, UnitDocument } from './schemas/unit.schema';

@Injectable()
export class UnitsService {
  constructor(
    @InjectModel(Unit.name) private readonly unitModel: Model<UnitDocument>,
    private readonly departmentsService: DepartmentsService,
  ) {}

  async create(dto: CreateUnitDto): Promise<UnitDocument> {
    // Unit.departmentId must reference an existing department — validated here,
    // not just left to the DB reference (which Mongoose doesn't enforce anyway).
    await this.departmentsService.assertExists(dto.departmentId);

    return this.unitModel.create({ departmentId: dto.departmentId, name: dto.name, active: true });
  }

  async findAll(departmentId?: string): Promise<UnitDocument[]> {
    const filter = departmentId ? { departmentId } : {};
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

    const unit = await this.unitModel.findByIdAndUpdate(id, { $set: dto }, { new: true }).exec();
    if (!unit) {
      throw new NotFoundException(`Unit ${id} not found`);
    }
    return unit;
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
}

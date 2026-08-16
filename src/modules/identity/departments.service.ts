import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { CreateDepartmentDto } from './dto/create-department.dto';
import { UpdateDepartmentDto } from './dto/update-department.dto';
import { Department, DepartmentDocument } from './schemas/department.schema';

@Injectable()
export class DepartmentsService {
  constructor(
    @InjectModel(Department.name) private readonly departmentModel: Model<DepartmentDocument>,
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

  async update(id: string, dto: UpdateDepartmentDto): Promise<DepartmentDocument> {
    const department = await this.departmentModel
      .findByIdAndUpdate(id, { $set: dto }, { new: true })
      .exec();
    if (!department) {
      throw new NotFoundException(`Department ${id} not found`);
    }
    return department;
  }

  /** Used by UnitsService/StaffService to validate a departmentId reference before trusting it. */
  async assertExists(id: string): Promise<void> {
    const exists = await this.departmentModel.exists({ _id: id });
    if (!exists) {
      throw new BadRequestException(`Department ${id} does not exist`);
    }
  }
}

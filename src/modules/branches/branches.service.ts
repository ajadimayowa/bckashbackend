import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { CreateBranchDto } from './dto/create-branch.dto';
import { UpdateBranchDto } from './dto/update-branch.dto';
import { Branch, BranchDocument } from './schemas/branch.schema';

@Injectable()
export class BranchesService {
  constructor(@InjectModel(Branch.name) private readonly branchModel: Model<BranchDocument>) {}

  async create(dto: CreateBranchDto): Promise<BranchDocument> {
    return this.branchModel.create({
      name: dto.name,
      code: dto.code,
      address: dto.address ?? null,
      active: true,
    });
  }

  async findAll(): Promise<BranchDocument[]> {
    return this.branchModel.find().sort({ name: 1 }).exec();
  }

  async findById(id: string): Promise<BranchDocument> {
    const branch = await this.branchModel.findById(id).exec();
    if (!branch) {
      throw new NotFoundException(`Branch ${id} not found`);
    }
    return branch;
  }

  async update(id: string, dto: UpdateBranchDto): Promise<BranchDocument> {
    const branch = await this.branchModel
      .findByIdAndUpdate(id, { $set: dto }, { new: true })
      .exec();
    if (!branch) {
      throw new NotFoundException(`Branch ${id} not found`);
    }
    return branch;
  }

  /** Used by StaffService to validate a branchId reference before trusting it. */
  async assertExists(id: string): Promise<void> {
    const exists = await this.branchModel.exists({ _id: id });
    if (!exists) {
      throw new BadRequestException(`Branch ${id} does not exist`);
    }
  }
}

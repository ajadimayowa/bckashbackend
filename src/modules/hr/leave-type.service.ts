import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { LeaveType, LeaveTypeDocument } from './schemas/leave-type.schema';

export interface CreateLeaveTypeInput {
  name: string;
  defaultAnnualAllocationDays: number;
  paid: boolean;
}

export interface UpdateLeaveTypeInput {
  name?: string;
  defaultAnnualAllocationDays?: number;
  paid?: boolean;
  active?: boolean;
}

/**
 * Admin-gated CRUD, deliberately not workflow-mediated — see
 * LeaveType's own doc comment and PHASE_12_NOTES.md.
 */
@Injectable()
export class LeaveTypeService {
  constructor(
    @InjectModel(LeaveType.name) private readonly leaveTypeModel: Model<LeaveTypeDocument>,
  ) {}

  async create(input: CreateLeaveTypeInput): Promise<LeaveTypeDocument> {
    const existing = await this.leaveTypeModel.findOne({ name: input.name }).exec();
    if (existing) {
      throw new BadRequestException(`A leave type named "${input.name}" already exists`);
    }
    return this.leaveTypeModel.create({ ...input, active: true });
  }

  async update(id: string, input: UpdateLeaveTypeInput): Promise<LeaveTypeDocument> {
    const updated = await this.leaveTypeModel
      .findByIdAndUpdate(id, { $set: input }, { new: true })
      .exec();
    if (!updated) {
      throw new NotFoundException(`LeaveType ${id} not found`);
    }
    return updated;
  }

  async findAll(activeOnly = false): Promise<LeaveTypeDocument[]> {
    return this.leaveTypeModel.find(activeOnly ? { active: true } : {}).exec();
  }

  async findByIdOrThrow(id: string): Promise<LeaveTypeDocument> {
    const leaveType = await this.leaveTypeModel.findById(id).exec();
    if (!leaveType) {
      throw new NotFoundException(`LeaveType ${id} not found`);
    }
    return leaveType;
  }
}

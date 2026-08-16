import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { CreateBranchDto } from './dto/create-branch.dto';
import { BRANCH_CREATED_EVENT, BranchCreatedEvent } from './events/branch.events';
import { UpdateBranchDto } from './dto/update-branch.dto';
import { Branch, BranchDocument } from './schemas/branch.schema';

@Injectable()
export class BranchesService {
  constructor(
    @InjectModel(Branch.name) private readonly branchModel: Model<BranchDocument>,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async create(dto: CreateBranchDto): Promise<BranchDocument> {
    const branch = await this.branchModel.create({
      name: dto.name,
      code: dto.code,
      address: dto.address ?? null,
      active: true,
    });

    // Phase 4 hook: BranchFundBalanceService listens for this and initializes
    // a zero balance document — added here (a one-line emit) rather than
    // retrofitting this service to know about balances directly. See
    // PHASE_4_NOTES.md.
    const event: BranchCreatedEvent = { branchId: branch._id.toString() };
    await this.eventEmitter.emitAsync(BRANCH_CREATED_EVENT, event);

    return branch;
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

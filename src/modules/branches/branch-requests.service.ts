import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';

import { BranchRequestStatus } from '../../common/enums/branch.enums';
import { StaffRole } from '../../common/enums/identity.enums';
import { AuditService } from '../../platform/audit/audit.service';
import { CreateBranchRequestDto } from './dto/create-branch-request.dto';
import {
  BranchRequestRaisedEvent,
  BranchRequestResolvedEvent,
  BRANCH_REQUEST_RAISED_EVENT,
  BRANCH_REQUEST_RESOLVED_EVENT,
} from './events/branch.events';
import { BranchRequest, BranchRequestDocument } from './schemas/branch-request.schema';

/**
 * A branch manager's free-form request to head office — see BranchRequest's
 * own doc comment. No RBAC capability of its own (there's no natural fit in
 * the existing capability matrix for "any Manager, about their own branch")
 * — gated in-service instead, same "the real gate is server-side" reasoning
 * already used by BranchFundingService.verifyFunding's own current-manager
 * check.
 */
@Injectable()
export class BranchRequestsService {
  constructor(
    @InjectModel(BranchRequest.name) private readonly requestModel: Model<BranchRequestDocument>,
    private readonly auditService: AuditService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async create(
    dto: CreateBranchRequestDto,
    viewer: { staffId: string; role: StaffRole; branchId?: string },
  ): Promise<BranchRequestDocument> {
    if (viewer.role !== StaffRole.MANAGER || !viewer.branchId) {
      throw new ForbiddenException('Only a branch manager may raise a request to head office');
    }

    const created = await this.requestModel.create({
      branchId: viewer.branchId,
      raisedBy: viewer.staffId,
      subject: dto.subject,
      message: dto.message,
      status: BranchRequestStatus.OPEN,
    });

    await this.auditService.record({
      actorId: viewer.staffId,
      action: 'BRANCH_REQUEST_RAISED',
      entityType: 'BRANCH_REQUEST',
      entityId: created._id.toString(),
      after: { subject: dto.subject },
      metadata: { branchId: viewer.branchId },
    });

    this.eventEmitter.emit(BRANCH_REQUEST_RAISED_EVENT, {
      requestId: created._id.toString(),
      branchId: viewer.branchId,
      raisedBy: viewer.staffId,
      subject: dto.subject,
    } satisfies BranchRequestRaisedEvent);

    return created;
  }

  /**
   * Row-scoped like BranchFundingService.findAll: ADMIN/SUPERADMIN/APPROVER
   * see every request (optionally narrowed by `branchId`); a Manager only
   * ever sees their own branch's.
   */
  async findAll(
    branchId: string | undefined,
    viewer: { staffId: string; role: StaffRole; branchId?: string },
  ): Promise<BranchRequestDocument[]> {
    const isAdminTier =
      viewer.role === StaffRole.ADMIN ||
      viewer.role === StaffRole.SUPERADMIN ||
      viewer.role === StaffRole.APPROVER;

    const filter: Record<string, unknown> = {};
    if (isAdminTier) {
      if (branchId) filter.branchId = new Types.ObjectId(branchId);
    } else {
      if (!viewer.branchId) return [];
      filter.branchId = new Types.ObjectId(viewer.branchId);
    }

    return this.requestModel.find(filter).sort({ createdAt: -1 }).exec();
  }

  async findById(id: string): Promise<BranchRequestDocument> {
    const request = await this.requestModel.findById(id).exec();
    if (!request) {
      throw new NotFoundException(`BranchRequest ${id} not found`);
    }
    return request;
  }

  async resolve(id: string, actorId: string, note: string): Promise<BranchRequestDocument> {
    const request = await this.findById(id);
    if (request.status !== BranchRequestStatus.OPEN) {
      throw new ConflictException(`BranchRequest ${id} is already ${request.status}`);
    }

    const updated = await this.requestModel
      .findOneAndUpdate(
        { _id: id, status: BranchRequestStatus.OPEN },
        {
          $set: {
            status: BranchRequestStatus.RESOLVED,
            resolvedBy: actorId,
            resolvedAt: new Date(),
            resolutionNote: note,
          },
        },
        { new: true },
      )
      .exec();
    if (!updated) {
      throw new ConflictException(`BranchRequest ${id} was concurrently modified — retry`);
    }

    await this.auditService.record({
      actorId,
      action: 'BRANCH_REQUEST_RESOLVED',
      entityType: 'BRANCH_REQUEST',
      entityId: id,
      after: { note },
      metadata: { branchId: request.branchId.toString() },
    });

    this.eventEmitter.emit(BRANCH_REQUEST_RESOLVED_EVENT, {
      requestId: id,
      branchId: request.branchId.toString(),
      raisedBy: request.raisedBy.toString(),
      resolvedBy: actorId,
      subject: request.subject,
      note,
    } satisfies BranchRequestResolvedEvent);

    return updated;
  }
}

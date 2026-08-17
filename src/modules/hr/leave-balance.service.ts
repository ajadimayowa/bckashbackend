import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, Types } from 'mongoose';

import { LeaveApplication, LeaveApplicationDocument } from './schemas/leave-application.schema';
import { LeaveBalance, LeaveBalanceDocument } from './schemas/leave-balance.schema';
import { LeaveType, LeaveTypeDocument } from './schemas/leave-type.schema';

export interface LeaveBalanceSummary {
  staffId: string;
  leaveTypeId: string;
  year: number;
  allocatedDays: number;
  usedDays: number;
  remainingDays: number;
}

/**
 * Owns `LeaveBalance.usedDays` — the only writer, via the idempotent
 * `applyUsage`/`reverseUsage` pair below. Nothing else in this module
 * increments/decrements it directly.
 */
@Injectable()
export class LeaveBalanceService {
  constructor(
    @InjectModel(LeaveBalance.name) private readonly leaveBalanceModel: Model<LeaveBalanceDocument>,
    @InjectModel(LeaveType.name) private readonly leaveTypeModel: Model<LeaveTypeDocument>,
    @InjectModel(LeaveApplication.name)
    private readonly leaveApplicationModel: Model<LeaveApplicationDocument>,
    @InjectConnection() private readonly connection: Connection,
  ) {}

  /**
   * Lazily creates the (staffId, leaveTypeId, year) row on first lookup,
   * defaulted from `LeaveType.defaultAnnualAllocationDays` — relies on the
   * schema's own unique index as the race-condition guard (an upsert via
   * `$setOnInsert`, same "insert, and let the unique index be the final
   * word on a concurrent double-create" idiom used elsewhere in this
   * system), so two concurrent lookups for a brand-new row never create
   * two.
   */
  async getOrCreateBalance(
    staffId: string,
    leaveTypeId: string,
    year: number,
  ): Promise<LeaveBalanceDocument> {
    // Explicit ObjectId casts throughout this file — a raw string in a
    // Mongoose filter for a non-`_id` ObjectId field does not reliably
    // auto-cast in this project's setup (a real bug found and fixed in
    // Phase 11 — see PHASE_11_NOTES.md); `findById`/`_id` filters are the
    // one exception, safe everywhere else in this codebase.
    const staffObjectId = new Types.ObjectId(staffId);
    const leaveTypeObjectId = new Types.ObjectId(leaveTypeId);

    const existing = await this.leaveBalanceModel
      .findOne({ staffId: staffObjectId, leaveTypeId: leaveTypeObjectId, year })
      .exec();
    if (existing) {
      return existing;
    }

    const leaveType = await this.leaveTypeModel.findById(leaveTypeId).exec();
    if (!leaveType) {
      throw new NotFoundException(`LeaveType ${leaveTypeId} not found`);
    }

    const created = await this.leaveBalanceModel
      .findOneAndUpdate(
        { staffId: staffObjectId, leaveTypeId: leaveTypeObjectId, year },
        {
          $setOnInsert: {
            staffId: new Types.ObjectId(staffId),
            leaveTypeId: new Types.ObjectId(leaveTypeId),
            year,
            allocatedDays: leaveType.defaultAnnualAllocationDays,
            usedDays: 0,
          },
        },
        { upsert: true, new: true },
      )
      .exec();
    if (!created) {
      throw new Error(
        `Failed to get-or-create LeaveBalance for staff ${staffId}, type ${leaveTypeId}, year ${year}`,
      );
    }
    return created;
  }

  async getSummary(
    staffId: string,
    leaveTypeId: string,
    year: number,
  ): Promise<LeaveBalanceSummary> {
    const balance = await this.getOrCreateBalance(staffId, leaveTypeId, year);
    return {
      staffId,
      leaveTypeId,
      year,
      allocatedDays: balance.allocatedDays,
      usedDays: balance.usedDays,
      remainingDays: balance.allocatedDays - balance.usedDays,
    };
  }

  async getAllSummariesForStaff(staffId: string, year: number): Promise<LeaveBalanceSummary[]> {
    const leaveTypes = await this.leaveTypeModel.find({ active: true }).exec();
    return Promise.all(
      leaveTypes.map((leaveType) => this.getSummary(staffId, leaveType._id.toString(), year)),
    );
  }

  /**
   * Idempotent, atomic, transactional — same shape as
   * `RepaymentsService.applyToBalance` (Phase 9): guard on
   * `LeaveApplication.balanceApplied` (flip false->true) and increment
   * `LeaveBalance.usedDays` in the same transaction, so a duplicate
   * `workflow.approved` fire is a silent no-op, never a double-count.
   * Returns `true` if this call actually applied it, `false` if it was
   * already applied (idempotent no-op).
   */
  async applyUsage(applicationId: string): Promise<boolean> {
    const session = await this.connection.startSession();
    let applied = false;
    try {
      await session.withTransaction(async () => {
        const application = await this.leaveApplicationModel
          .findOneAndUpdate(
            { _id: applicationId, balanceApplied: false },
            { $set: { balanceApplied: true } },
            { session, new: true },
          )
          .exec();
        if (!application) {
          return; // already applied — idempotent no-op.
        }

        const year = application.startDate.getUTCFullYear();
        await this.leaveBalanceModel
          .findOneAndUpdate(
            { staffId: application.staffId, leaveTypeId: application.leaveTypeId, year },
            { $inc: { usedDays: application.numberOfDays } },
            { session, upsert: false },
          )
          .exec();
        // getOrCreateBalance (outside the transaction, at applyForLeave time)
        // guarantees the row already exists by the time an application can
        // ever reach APPROVED, so `upsert: false` here is deliberate — a
        // missing row at this point would be a genuine data-integrity bug,
        // not a normal case to silently paper over with an upsert.
        applied = true;
      });
    } finally {
      await session.endSession();
    }
    return applied;
  }

  /** Symmetric reversal — same idempotent-guard shape, see cancelApplication's own doc comment. */
  async reverseUsage(applicationId: string): Promise<boolean> {
    const session = await this.connection.startSession();
    let reversed = false;
    try {
      await session.withTransaction(async () => {
        const application = await this.leaveApplicationModel
          .findOneAndUpdate(
            { _id: applicationId, balanceApplied: true },
            { $set: { balanceApplied: false } },
            { session, new: true },
          )
          .exec();
        if (!application) {
          return; // not currently applied — idempotent no-op.
        }

        const year = application.startDate.getUTCFullYear();
        await this.leaveBalanceModel
          .findOneAndUpdate(
            { staffId: application.staffId, leaveTypeId: application.leaveTypeId, year },
            { $inc: { usedDays: -application.numberOfDays } },
            { session },
          )
          .exec();
        reversed = true;
      });
    } finally {
      await session.endSession();
    }
    return reversed;
  }
}

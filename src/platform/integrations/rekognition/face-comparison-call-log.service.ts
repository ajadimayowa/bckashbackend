import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';

import {
  FaceComparisonCallLog,
  FaceComparisonCallLogDocument,
} from './schemas/face-comparison-call-log.schema';

export interface RecordFaceComparisonCallInput {
  calledBy?: string | null;
  loanId?: string | null;
  memberLoanAccountId?: string | null;
  customerId?: string | null;
  sourceImageKey: string;
  isMatch: boolean;
  similarityPercent: number;
  matchThreshold: number;
  errorMessage?: string | null;
}

@Injectable()
export class FaceComparisonCallLogService {
  constructor(
    @InjectModel(FaceComparisonCallLog.name)
    private readonly callLogModel: Model<FaceComparisonCallLogDocument>,
  ) {}

  async record(input: RecordFaceComparisonCallInput): Promise<FaceComparisonCallLogDocument> {
    return this.callLogModel.create({
      calledBy: input.calledBy ?? null,
      loanId: input.loanId ? new Types.ObjectId(input.loanId) : null,
      memberLoanAccountId: input.memberLoanAccountId
        ? new Types.ObjectId(input.memberLoanAccountId)
        : null,
      customerId: input.customerId ? new Types.ObjectId(input.customerId) : null,
      sourceImageKey: input.sourceImageKey,
      isMatch: input.isMatch,
      similarityPercent: input.similarityPercent,
      matchThreshold: input.matchThreshold,
      calledAt: new Date(),
      errorMessage: input.errorMessage ?? null,
    });
  }

  async findForLoan(loanId: string): Promise<FaceComparisonCallLogDocument[]> {
    return this.callLogModel
      .find({ loanId: new Types.ObjectId(loanId) })
      .sort({ calledAt: -1 })
      .exec();
  }
}

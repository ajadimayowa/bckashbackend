import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { EncryptionService } from '../../encryption/encryption.service';
import { BvnCallEntityType, BvnCallStep } from './enums/bvn-call-log.enums';
import { BvnCallLog, BvnCallLogDocument } from './schemas/bvn-call-log.schema';

export interface RecordBvnCallInput {
  step: BvnCallStep;
  bvn?: string | null;
  success: boolean;
  providerStatusCode?: number | null;
  calledBy?: string | null;
  calledForEntityType?: BvnCallEntityType | null;
  calledForEntityId?: string | null;
  errorMessage?: string | null;
}

@Injectable()
export class BvnCallLogService {
  constructor(
    @InjectModel(BvnCallLog.name) private readonly callLogModel: Model<BvnCallLogDocument>,
    private readonly encryptionService: EncryptionService,
  ) {}

  async record(input: RecordBvnCallInput): Promise<BvnCallLogDocument> {
    return this.callLogModel.create({
      step: input.step,
      bvn: input.bvn ? this.encryptionService.encrypt(input.bvn) : null,
      success: input.success,
      providerStatusCode: input.providerStatusCode ?? null,
      calledAt: new Date(),
      calledBy: input.calledBy ?? null,
      calledForEntityType: input.calledForEntityType ?? null,
      calledForEntityId: input.calledForEntityId ?? null,
      errorMessage: input.errorMessage ?? null,
    });
  }

  async findForEntity(
    entityType: BvnCallEntityType,
    entityId: string,
  ): Promise<BvnCallLogDocument[]> {
    return this.callLogModel
      .find({ calledForEntityType: entityType, calledForEntityId: entityId })
      .sort({ calledAt: -1 })
      .exec();
  }
}

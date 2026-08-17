import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { SmsCallLog, SmsCallLogDocument } from './schemas/sms-call-log.schema';

@Injectable()
export class SmsCallLogService {
  constructor(
    @InjectModel(SmsCallLog.name) private readonly smsCallLogModel: Model<SmsCallLogDocument>,
  ) {}

  async record(entry: {
    toPhoneNumber: string;
    success: boolean;
    providerStatusCode: number | null;
    providerMessageId: string | null;
    errorMessage: string | null;
  }): Promise<void> {
    await this.smsCallLogModel.create({ ...entry, calledAt: new Date() });
  }
}

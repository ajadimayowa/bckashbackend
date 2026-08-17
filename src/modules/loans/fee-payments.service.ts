import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';

import {
  FeeAppliesTo,
  FeeCalcType,
  FeePercentageBasis,
  FeeTiming,
} from '../../common/enums/loan-product.enums';
import { FeePaymentStatus } from '../../common/enums/loan.enums';
import { AuditService } from '../../platform/audit/audit.service';
import { calculateFeeAmount } from '../loan-products/calculations';
import { FeeDefinitionDocument } from '../loan-products/schemas/fee-definition.schema';
import { FeePayment, FeePaymentDocument } from './schemas/fee-payment.schema';

export interface OutstandingPreLoanFee {
  feeDefinitionId: string;
  feeName: string;
  appliesTo: FeeAppliesTo;
  /**
   * null when the fee can't be pre-computed without a live loan context (a
   * PERCENTAGE fee whose `percentageOf` isn't PRINCIPAL — OUTSTANDING/
   * OVERDUE_AMOUNT don't exist yet at application-raise time). The fee is
   * still surfaced as outstanding either way; only the amount is best-effort.
   */
  amountKobo: number | null;
}

/**
 * *** MINIMAL VERSION — SEE PHASE_8_NOTES.md ***
 * `recordPayment` is a direct, non-workflow-mediated write (see FeePayment's
 * own doc comment for why) — it upserts, so recording the same
 * (customerId, productId, feeDefinitionId) twice just overwrites, matching a
 * real front-desk correction ("actually it was waived, not paid").
 * `getOutstandingPreLoanFees` is read-only and never blocks anything — see
 * LoansService.raiseApplication, which surfaces but does not gate on this.
 */
@Injectable()
export class FeePaymentsService {
  constructor(
    @InjectModel(FeePayment.name) private readonly feePaymentModel: Model<FeePaymentDocument>,
    private readonly auditService: AuditService,
  ) {}

  async recordPayment(
    customerId: string,
    productId: string,
    feeDefinitionId: string,
    amountKobo: number,
    status: FeePaymentStatus.PAID | FeePaymentStatus.WAIVED,
    recordedBy: string,
  ): Promise<FeePaymentDocument> {
    const now = new Date();
    const updated = await this.feePaymentModel
      .findOneAndUpdate(
        {
          customerId: new Types.ObjectId(customerId),
          productId: new Types.ObjectId(productId),
          feeDefinitionId: new Types.ObjectId(feeDefinitionId),
        },
        {
          $set: {
            amountKobo,
            status,
            recordedBy: new Types.ObjectId(recordedBy),
            recordedAt: now,
          },
        },
        { new: true, upsert: true },
      )
      .exec();

    await this.auditService.record({
      actorId: recordedBy,
      action: 'FEE_PAYMENT_RECORDED',
      entityType: 'FEE_PAYMENT',
      entityId: updated._id.toString(),
      after: { customerId, productId, feeDefinitionId, amountKobo, status },
    });

    return updated;
  }

  /**
   * For every PRE_LOAN fee attached to `product`, reports it as outstanding
   * for `customerId` unless a FeePayment already exists with status PAID or
   * WAIVED. `requestedAmountKobo` is used as the PRINCIPAL basis for a
   * PERCENTAGE fee, when applicable — see OutstandingPreLoanFee's doc comment
   * for the cases where an amount genuinely can't be pre-computed.
   */
  async getOutstandingPreLoanFees(
    customerId: string,
    productId: string,
    feeDefinitions: FeeDefinitionDocument[],
    requestedAmountKobo: number,
  ): Promise<OutstandingPreLoanFee[]> {
    const preLoanFees = feeDefinitions.filter((fee) => fee.timing === FeeTiming.PRE_LOAN);
    if (preLoanFees.length === 0) {
      return [];
    }

    const paidOrWaived = await this.feePaymentModel
      .find({
        customerId: new Types.ObjectId(customerId),
        productId: new Types.ObjectId(productId),
        feeDefinitionId: { $in: preLoanFees.map((fee) => fee._id) },
        status: { $in: [FeePaymentStatus.PAID, FeePaymentStatus.WAIVED] },
      })
      .exec();
    const settledFeeIds = new Set(
      paidOrWaived.map((payment) => payment.feeDefinitionId.toString()),
    );

    const outstanding: OutstandingPreLoanFee[] = [];
    for (const fee of preLoanFees) {
      const feeId = fee._id.toString();
      if (settledFeeIds.has(feeId)) {
        continue;
      }

      const canComputeNow =
        fee.calcType === FeeCalcType.FIXED || fee.percentageOf === FeePercentageBasis.PRINCIPAL;
      const amountKobo = canComputeNow
        ? calculateFeeAmount(fee, { principal: requestedAmountKobo })
        : null;

      outstanding.push({
        feeDefinitionId: feeId,
        feeName: fee.name,
        appliesTo: fee.appliesTo,
        amountKobo,
      });
    }

    return outstanding;
  }
}

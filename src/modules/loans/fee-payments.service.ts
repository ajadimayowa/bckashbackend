import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';

import {
  FeeAppliesTo,
  FeeCalcType,
  FeePercentageBasis,
  FeeTiming,
  ProductStatus,
} from '../../common/enums/loan-product.enums';
import { FeePaymentStatus } from '../../common/enums/loan.enums';
import { AuditService } from '../../platform/audit/audit.service';
import { calculateFeeAmount } from '../loan-products/calculations';
import { FeeDefinitionsService } from '../loan-products/fee-definitions.service';
import { LoanProductsService } from '../loan-products/loan-products.service';
import { FeeDefinitionDocument } from '../loan-products/schemas/fee-definition.schema';
// Cross-module raw schema registration only — same pattern as elsewhere in
// this codebase (see e.g. RepaymentsService's own comment). Needed only to
// resolve a customer's branchId for the ledger posting below.
import { Customer, CustomerDocument } from '../customers/schemas/customer.schema';
import { LEDGER_POSTING_PORT, LedgerPostingPort } from './interfaces/ledger-posting-port.interface';
import { FeePayment, FeePaymentDocument } from './schemas/fee-payment.schema';

/** One fee payment record enriched with the fee/product names it references — the flat shape CustomerDetail.tsx's "Fees & Payments" tab reads. */
export interface CustomerFeePaymentItem {
  id: string;
  productId: string;
  productName: string | null;
  feeDefinitionId: string;
  feeName: string | null;
  amountKobo: number;
  status: FeePaymentStatus;
  recordedBy: string | null;
  recordedAt: Date | null;
  accountPaidTo: string | null;
  paymentReference: string | null;
  createdAt: Date;
}

/**
 * One PRE_LOAN fee a customer could conceivably owe — every active
 * LoanProduct's PRE_LOAN fees, cross-referenced against whatever's already
 * been recorded for this customer. `feePaymentId`/`status: PENDING` when
 * nothing has been recorded yet (no FeePayment document exists until
 * `recordPayment` is actually called — see FeePayment's own doc comment).
 * The "Fees & Payments" tab's full list, not just the history of what's
 * already settled.
 */
export interface AvailableFeeItem {
  productId: string;
  productName: string;
  feeDefinitionId: string;
  feeName: string;
  /** null only for a PERCENTAGE fee not based on PRINCIPAL — genuinely can't be pre-computed outside of an actual loan application. */
  amountKobo: number | null;
  status: FeePaymentStatus;
  feePaymentId: string | null;
  recordedBy: string | null;
  recordedAt: Date | null;
  accountPaidTo: string | null;
  paymentReference: string | null;
}

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
    @InjectModel(Customer.name) private readonly customerModel: Model<CustomerDocument>,
    private readonly auditService: AuditService,
    private readonly feeDefinitionsService: FeeDefinitionsService,
    private readonly loanProductsService: LoanProductsService,
    @Inject(LEDGER_POSTING_PORT) private readonly ledgerPostingPort: LedgerPostingPort,
  ) {}

  /**
   * Posts to the ledger (`LedgerPostingPort.postFeeCollection`) only for
   * PAID — a WAIVED fee never moved any money, so there's nothing to
   * post. Added in Phase 10 — see PHASE_10_NOTES.md: this call site never
   * existed before, a genuine Phase 8 gap rather than a stub sitting unused.
   */
  async recordPayment(
    customerId: string,
    productId: string,
    feeDefinitionId: string,
    amountKobo: number,
    status: FeePaymentStatus.PAID | FeePaymentStatus.WAIVED,
    recordedBy: string,
    accountPaidTo?: string,
    paymentReference?: string,
  ): Promise<FeePaymentDocument> {
    const customer = await this.customerModel.findById(customerId).exec();
    if (!customer) {
      throw new NotFoundException(`Customer ${customerId} not found`);
    }

    const now = new Date();
    // Only meaningful for an actual PAID transaction — a WAIVED fee never
    // moved any money, so any accountPaidTo/paymentReference sent alongside
    // one is dropped rather than persisted as though money changed hands.
    const isPaid = status === FeePaymentStatus.PAID;
    const updated = await this.feePaymentModel
      .findOneAndUpdate(
        {
          customerId: new Types.ObjectId(customerId),
          productId: new Types.ObjectId(productId),
          feeDefinitionId: new Types.ObjectId(feeDefinitionId),
        },
        {
          $set: {
            branchId: customer.branchId,
            amountKobo,
            status,
            recordedBy: new Types.ObjectId(recordedBy),
            recordedAt: now,
            accountPaidTo: isPaid ? (accountPaidTo?.trim() || null) : null,
            paymentReference: isPaid ? (paymentReference?.trim() || null) : null,
          },
        },
        { new: true, upsert: true },
      )
      .exec();

    if (status === FeePaymentStatus.PAID) {
      await this.ledgerPostingPort.postFeeCollection({
        feePaymentId: updated._id.toString(),
        amountKobo,
        branchId: customer.branchId.toString(),
      });
    }

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

  /**
   * A customer's full fee payment history, newest first — enriched with the
   * fee/product names those records reference (batched, no N+1). Read-only;
   * no capability gate at the controller (same "reads are open" convention
   * as Groups/LoanProducts — see fee-payments.controller.ts's own comment).
   */
  async listForCustomer(customerId: string): Promise<CustomerFeePaymentItem[]> {
    const payments = await this.feePaymentModel
      .find({ customerId: new Types.ObjectId(customerId) })
      .sort({ createdAt: -1 })
      .exec();
    if (payments.length === 0) {
      return [];
    }

    const feeDefinitionIds = [...new Set(payments.map((p) => p.feeDefinitionId.toString()))];
    const productIds = [...new Set(payments.map((p) => p.productId.toString()))];

    const [feeDefinitions, products] = await Promise.all([
      Promise.all(feeDefinitionIds.map((id) => this.feeDefinitionsService.findByIdOrThrow(id).catch(() => null))),
      Promise.all(productIds.map((id) => this.loanProductsService.findByIdOrThrow(id).catch(() => null))),
    ]);
    const feeNameById = new Map(
      feeDefinitions
        .filter((fee): fee is NonNullable<typeof fee> => fee !== null)
        .map((fee) => [fee._id.toString(), fee.name]),
    );
    const productNameById = new Map(
      products
        .filter((product): product is NonNullable<typeof product> => product !== null)
        .map((product) => [product._id.toString(), product.name]),
    );

    return payments.map((payment) => ({
      id: payment._id.toString(),
      productId: payment.productId.toString(),
      productName: productNameById.get(payment.productId.toString()) ?? null,
      feeDefinitionId: payment.feeDefinitionId.toString(),
      feeName: feeNameById.get(payment.feeDefinitionId.toString()) ?? null,
      amountKobo: payment.amountKobo,
      status: payment.status,
      recordedBy: payment.recordedBy ? payment.recordedBy.toString() : null,
      recordedAt: payment.recordedAt,
      accountPaidTo: payment.accountPaidTo,
      paymentReference: payment.paymentReference,
      createdAt: payment.createdAt,
    }));
  }

  /**
   * Every PRE_LOAN fee attached to any active LoanProduct — the "Fees &
   * Payments" tab's full list, not just what's already been recorded (see
   * AvailableFeeItem's own doc comment). The same (productId,
   * feeDefinitionId) fee can appear once per product it's attached to,
   * since a FeePayment obligation is tracked per-product, not fee-alone.
   */
  async listAvailableFeesForCustomer(customerId: string): Promise<AvailableFeeItem[]> {
    const customer = await this.customerModel.findById(customerId).exec();
    if (!customer) {
      throw new NotFoundException(`Customer ${customerId} not found`);
    }

    const products = await this.loanProductsService.findAll({ status: ProductStatus.ACTIVE });
    if (products.length === 0) {
      return [];
    }

    const feeIds = [...new Set(products.flatMap((product) => product.feeIds.map((id) => id.toString())))];
    const feeDefinitions = await Promise.all(
      feeIds.map((id) => this.feeDefinitionsService.findByIdOrThrow(id).catch(() => null)),
    );
    const feeById = new Map(
      feeDefinitions
        .filter((fee): fee is NonNullable<typeof fee> => fee !== null && fee.active && fee.timing === FeeTiming.PRE_LOAN)
        .map((fee) => [fee._id.toString(), fee]),
    );

    const pairs: { product: (typeof products)[number]; fee: FeeDefinitionDocument }[] = [];
    for (const product of products) {
      for (const feeIdObj of product.feeIds) {
        const fee = feeById.get(feeIdObj.toString());
        if (fee) {
          pairs.push({ product, fee });
        }
      }
    }
    if (pairs.length === 0) {
      return [];
    }

    const existingPayments = await this.feePaymentModel
      .find({ customerId: new Types.ObjectId(customerId) })
      .exec();
    const paymentByKey = new Map(
      existingPayments.map((payment) => [
        `${payment.productId.toString()}:${payment.feeDefinitionId.toString()}`,
        payment,
      ]),
    );

    return pairs.map(({ product, fee }) => {
      const payment = paymentByKey.get(`${product._id.toString()}:${fee._id.toString()}`);
      const precomputedAmount = fee.calcType === FeeCalcType.FIXED ? fee.value : null;
      return {
        productId: product._id.toString(),
        productName: product.name,
        feeDefinitionId: fee._id.toString(),
        feeName: fee.name,
        amountKobo: payment ? payment.amountKobo : precomputedAmount,
        status: payment?.status ?? FeePaymentStatus.PENDING,
        feePaymentId: payment ? payment._id.toString() : null,
        recordedBy: payment?.recordedBy ? payment.recordedBy.toString() : null,
        recordedAt: payment?.recordedAt ?? null,
        accountPaidTo: payment?.accountPaidTo ?? null,
        paymentReference: payment?.paymentReference ?? null,
      };
    });
  }
}

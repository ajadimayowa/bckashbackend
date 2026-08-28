import { InterestType, ProductStatus } from '../../../common/enums/loan-product.enums';
import { WorkflowStepConfig } from '../../../platform/workflow-engine/schemas/workflow-chain-config.schema';
import { LoanProductDocument, PenaltyRule } from '../schemas/loan-product.schema';

/**
 * Explicit `_id` -> `id` mapping, same defense-in-depth pattern as
 * CustomerResponseDto/StaffResponseDto — without this, LoanProductsController's
 * `findAll`/`findOne` were returning the raw Mongoose document (`_id`, plain
 * ObjectId `feeIds`), which the frontend's `LoanProduct` type never accounted
 * for (it expects `id: string`). That silent mismatch was the root cause of
 * three reported bugs at once: tenure not auto-populating on product select
 * (the `<option value={product.id}>` was rendering `value={undefined}`),
 * "Propose Deactivation" 500ing with `CastError: ... "undefined" ... "_id"`
 * (same `product.id` being `undefined` reaching `PATCH /loan-products/undefined`),
 * and every fee checkbox toggling together on the product form (see
 * FeeDefinitionResponseDto's identical comment for that one).
 */
export class LoanProductResponseDto {
  id!: string;
  name!: string;
  interestRate!: number;
  interestType!: InterestType;
  tenureOptions!: number[];
  minGroupSize!: number;
  repaymentPeriodDays!: number;
  feeIds!: string[];
  approvalChainSteps!: WorkflowStepConfig[];
  penaltyRule!: PenaltyRule;
  status!: ProductStatus;
  createdBy!: string;
  createdAt!: Date;
  updatedAt!: Date;

  static fromDocument(doc: LoanProductDocument): LoanProductResponseDto {
    const dto = new LoanProductResponseDto();
    dto.id = doc._id.toString();
    dto.name = doc.name;
    dto.interestRate = doc.interestRate;
    dto.interestType = doc.interestType;
    dto.tenureOptions = doc.tenureOptions;
    dto.minGroupSize = doc.minGroupSize;
    dto.repaymentPeriodDays = doc.repaymentPeriodDays;
    dto.feeIds = doc.feeIds.map((id) => id.toString());
    dto.approvalChainSteps = doc.approvalChainSteps;
    dto.penaltyRule = doc.penaltyRule;
    dto.status = doc.status;
    dto.createdBy = doc.createdBy.toString();
    dto.createdAt = doc.createdAt;
    dto.updatedAt = doc.updatedAt;
    return dto;
  }
}

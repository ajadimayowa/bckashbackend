import {
  FeeAppliesTo,
  FeeCalcType,
  FeeCategory,
  FeePercentageBasis,
  FeeTiming,
  PenaltyFrequency,
} from '../../../common/enums/loan-product.enums';
import { FeeDefinitionDocument } from '../schemas/fee-definition.schema';

/**
 * Explicit `_id` -> `id` mapping — see LoanProductResponseDto's identical
 * comment. Without this, FeeDefinitionsController's `findAll`/`findOne`
 * returned the raw Mongoose document (`_id`, not `id`), which the frontend's
 * `FeeDefinition` type never accounted for. Every fee's `fee.id` therefore
 * evaluated to the same `undefined`, so LoanProductsCrud's per-fee checkbox
 * `checked={formik.values.feeIds.includes(fee.id)}` matched (and toggled)
 * every checkbox at once.
 */
export class FeeDefinitionResponseDto {
  id!: string;
  name!: string;
  category!: FeeCategory;
  timing!: FeeTiming;
  calcType!: FeeCalcType;
  value!: number;
  percentageOf!: FeePercentageBasis | null;
  appliesTo!: FeeAppliesTo;
  frequency!: PenaltyFrequency;
  recurrenceIntervalDays!: number | null;
  maxRecurrences!: number | null;
  productIds!: string[];
  active!: boolean;
  createdBy!: string;
  createdAt!: Date;
  updatedAt!: Date;

  static fromDocument(doc: FeeDefinitionDocument): FeeDefinitionResponseDto {
    const dto = new FeeDefinitionResponseDto();
    dto.id = doc._id.toString();
    dto.name = doc.name;
    dto.category = doc.category;
    dto.timing = doc.timing;
    dto.calcType = doc.calcType;
    dto.value = doc.value;
    dto.percentageOf = doc.percentageOf;
    dto.appliesTo = doc.appliesTo;
    dto.frequency = doc.frequency;
    dto.recurrenceIntervalDays = doc.recurrenceIntervalDays;
    dto.maxRecurrences = doc.maxRecurrences;
    dto.productIds = doc.productIds.map((id) => id.toString());
    dto.active = doc.active;
    dto.createdBy = doc.createdBy.toString();
    dto.createdAt = doc.createdAt;
    dto.updatedAt = doc.updatedAt;
    return dto;
  }
}

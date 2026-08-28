import { WorkflowStatus } from '../../../common/enums/workflow.enums';
import { WorkflowRequestDocument } from '../schemas/workflow-request.schema';
import { WorkflowStepSummaryDto } from './workflow-request-summary.dto';

/**
 * `WorkflowRequestSummaryDto` deliberately excludes `payloadHistory` (see its
 * own doc comment — a truly generic response can't know which fields in an
 * arbitrary domain payload are sensitive, e.g. staff onboarding's payload
 * carries a bcrypt `passwordHash`). This detail variant exists for the one
 * legitimate case that needs the payload anyway: a reviewer deciding whether
 * to approve/reject genuinely needs to see what's being proposed. Fetched by
 * request id, not by entity — a pending CREATE has no entity to fetch by yet.
 * Otherwise a superset of the summary shape (`steps` included) so a detail
 * page never has to make a second call just to show who acted at each step.
 */
export class WorkflowRequestDetailDto {
  id!: string;
  entityType!: string;
  entityId!: string | null;
  action!: string;
  status!: WorkflowStatus;
  currentStepIndex!: number;
  initiatedBy!: string;
  /** Resolved via WorkflowRequestsController's own bulk staff-name lookup — null if that staff record no longer exists. */
  initiatedByName!: string | null;
  branchId!: string | null;
  /** The latest submitted version — what would take effect if approved right now. */
  payload!: Record<string, unknown>;
  createdAt!: Date;
  /** Who acted (approved/rejected/returned) at each step, and their comment. */
  steps!: WorkflowStepSummaryDto[];

  /** `namesById` — staffId -> "First Last", same bulk lookup as WorkflowRequestSummaryDto.fromDocument. */
  static fromDocument(
    doc: WorkflowRequestDocument,
    namesById: Map<string, string> = new Map(),
  ): WorkflowRequestDetailDto {
    const dto = new WorkflowRequestDetailDto();
    dto.id = doc._id.toString();
    dto.entityType = doc.entityType;
    dto.entityId = doc.entityId;
    dto.action = doc.action;
    dto.status = doc.status;
    dto.currentStepIndex = doc.currentStepIndex;
    dto.initiatedBy = doc.initiatedBy;
    dto.initiatedByName = namesById.get(doc.initiatedBy) ?? null;
    dto.branchId = doc.branchId;
    dto.payload = doc.payloadHistory[doc.payloadHistory.length - 1]?.payload ?? {};
    dto.createdAt = doc.createdAt;
    dto.steps = doc.steps.map((step) => ({
      order: step.order,
      requiredCapability: step.requiredCapability,
      actedBy: step.actedBy,
      actedByName: step.actedBy ? (namesById.get(step.actedBy) ?? null) : null,
      action: step.action,
      comment: step.comment,
      actedAt: step.actedAt,
    }));
    return dto;
  }
}

import { WorkflowStatus, WorkflowStepAction } from '../../../common/enums/workflow.enums';
import { WorkflowRequestDocument } from '../schemas/workflow-request.schema';

/**
 * Deliberately just the step's own outcome fields — no payload attached (see
 * this file's own doc comment on why payload stays out of the summary DTO).
 * Exists so a caller can show "who approved/rejected this, and when/why"
 * (e.g. a Rejected tab's `comment`) without a second round-trip to the
 * detail endpoint.
 */
export class WorkflowStepSummaryDto {
  order!: number;
  requiredCapability!: string;
  actedBy!: string | null;
  /** Resolved via WorkflowRequestsController's own bulk staff-name lookup — null for a step nobody has acted on yet, or a staff record that no longer exists. */
  actedByName!: string | null;
  action!: WorkflowStepAction | null;
  comment!: string | null;
  actedAt!: Date | null;
}

/**
 * A safe-to-return shape for "I just initiated/acted on a WorkflowRequest"
 * responses — deliberately excludes `payloadHistory`. Domain payloads can
 * carry sensitive data in transit to approval (e.g. staff onboarding's
 * bcrypt `passwordHash` — see identity/staff.service.ts), and nothing about
 * a generic engine response should be trusted to know which fields in an
 * arbitrary domain payload are sensitive. Controllers that specifically need
 * to show payload contents to a reviewer should fetch and shape that
 * themselves, deliberately, rather than getting it by default here.
 */
export class WorkflowRequestSummaryDto {
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
  createdAt!: Date;
  steps!: WorkflowStepSummaryDto[];

  /** `namesById` — staffId -> "First Last", built once per request by the controller (see its own doc comment) rather than N+1 looked up per document. */
  static fromDocument(
    doc: WorkflowRequestDocument,
    namesById: Map<string, string> = new Map(),
  ): WorkflowRequestSummaryDto {
    const dto = new WorkflowRequestSummaryDto();
    dto.id = doc._id.toString();
    dto.entityType = doc.entityType;
    dto.entityId = doc.entityId;
    dto.action = doc.action;
    dto.status = doc.status;
    dto.currentStepIndex = doc.currentStepIndex;
    dto.initiatedBy = doc.initiatedBy;
    dto.initiatedByName = namesById.get(doc.initiatedBy) ?? null;
    dto.branchId = doc.branchId;
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

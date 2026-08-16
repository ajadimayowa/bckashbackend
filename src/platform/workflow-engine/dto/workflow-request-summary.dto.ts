import { WorkflowStatus } from '../../../common/enums/workflow.enums';
import { WorkflowRequestDocument } from '../schemas/workflow-request.schema';

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
  branchId!: string | null;
  createdAt!: Date;

  static fromDocument(doc: WorkflowRequestDocument): WorkflowRequestSummaryDto {
    const dto = new WorkflowRequestSummaryDto();
    dto.id = doc._id.toString();
    dto.entityType = doc.entityType;
    dto.entityId = doc.entityId;
    dto.action = doc.action;
    dto.status = doc.status;
    dto.currentStepIndex = doc.currentStepIndex;
    dto.initiatedBy = doc.initiatedBy;
    dto.branchId = doc.branchId;
    dto.createdAt = doc.createdAt;
    return dto;
  }
}

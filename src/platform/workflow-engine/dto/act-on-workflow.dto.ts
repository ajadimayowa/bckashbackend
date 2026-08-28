import { IsEnum, IsNotEmpty, IsString, MaxLength, ValidateIf } from 'class-validator';

import { WorkflowStepAction } from '../../../common/enums/workflow.enums';

/**
 * POST /workflow-requests/:id/act — a comment is required when RETURNING a
 * request to its maker, and (so there's always a recorded reason a maker can
 * see) when REJECTING one outright — enforced again, more precisely, by
 * WorkflowEngineService.act.
 */
export class ActOnWorkflowDto {
  @IsEnum(WorkflowStepAction)
  action!: WorkflowStepAction;

  @ValidateIf(
    (dto: ActOnWorkflowDto) =>
      dto.action === WorkflowStepAction.RETURNED ||
      dto.action === WorkflowStepAction.REJECTED ||
      dto.comment !== undefined,
  )
  @IsString()
  @IsNotEmpty({ message: 'A comment is required when rejecting or returning a request' })
  @MaxLength(2000)
  comment?: string;
}

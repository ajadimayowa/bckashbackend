import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { WorkflowEntityType } from '../../common/enums/workflow.enums';
import { AuditService } from '../../platform/audit/audit.service';
import { WORKFLOW_APPROVED_EVENT, WorkflowApprovedEvent } from '../../platform/workflow-engine/events/workflow-engine.events';
import { WorkflowEngineService } from '../../platform/workflow-engine/workflow-engine.service';
import { CreateRepaymentPenaltyConfigurationDto } from './dto/create-repayment-penalty-configuration.dto';
import {
  RepaymentPenaltyConfiguration,
  RepaymentPenaltyConfigurationDocument,
} from './schemas/repayment-penalty-configuration.schema';
import { VersionedConfigServiceBase } from './versioned-config.service.base';

@Injectable()
export class RepaymentPenaltyConfigurationService extends VersionedConfigServiceBase<
  RepaymentPenaltyConfiguration,
  RepaymentPenaltyConfigurationDocument,
  CreateRepaymentPenaltyConfigurationDto
> {
  protected readonly entityType = WorkflowEntityType.REPAYMENT_PENALTY_CONFIG;
  protected readonly auditActionPrefix = 'REPAYMENT_PENALTY_CONFIG';

  constructor(
    @InjectModel(RepaymentPenaltyConfiguration.name) model: Model<RepaymentPenaltyConfigurationDocument>,
    workflowEngineService: WorkflowEngineService,
    auditService: AuditService,
  ) {
    super(model, workflowEngineService, auditService);
  }

  protected mapPayloadToDoc(payload: CreateRepaymentPenaltyConfigurationDto): Record<string, unknown> {
    return {
      penaltyRate: payload.penaltyRate,
      penaltyGracePeriodDays: payload.penaltyGracePeriodDays,
      maxPenaltyCap: payload.maxPenaltyCap,
      autoPenalty: payload.autoPenalty,
      repaymentFrequency: payload.repaymentFrequency,
    };
  }

  @OnEvent(WORKFLOW_APPROVED_EVENT)
  async handleWorkflowApproved(event: WorkflowApprovedEvent): Promise<void> {
    await this.handleApproved(event);
  }
}

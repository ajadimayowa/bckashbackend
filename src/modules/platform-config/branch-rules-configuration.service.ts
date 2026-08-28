import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { WorkflowEntityType } from '../../common/enums/workflow.enums';
import { AuditService } from '../../platform/audit/audit.service';
import { WORKFLOW_APPROVED_EVENT, WorkflowApprovedEvent } from '../../platform/workflow-engine/events/workflow-engine.events';
import { WorkflowEngineService } from '../../platform/workflow-engine/workflow-engine.service';
import { CreateBranchRulesConfigurationDto } from './dto/create-branch-rules-configuration.dto';
import { BranchRulesConfiguration, BranchRulesConfigurationDocument } from './schemas/branch-rules-configuration.schema';
import { VersionedConfigServiceBase } from './versioned-config.service.base';

@Injectable()
export class BranchRulesConfigurationService extends VersionedConfigServiceBase<
  BranchRulesConfiguration,
  BranchRulesConfigurationDocument,
  CreateBranchRulesConfigurationDto
> {
  protected readonly entityType = WorkflowEntityType.BRANCH_RULES_CONFIG;
  protected readonly auditActionPrefix = 'BRANCH_RULES_CONFIG';

  constructor(
    @InjectModel(BranchRulesConfiguration.name) model: Model<BranchRulesConfigurationDocument>,
    workflowEngineService: WorkflowEngineService,
    auditService: AuditService,
  ) {
    super(model, workflowEngineService, auditService);
  }

  protected mapPayloadToDoc(payload: CreateBranchRulesConfigurationDto): Record<string, unknown> {
    return {
      maxActiveBranches: payload.maxActiveBranches,
      defaultFundLimitKobo: payload.defaultFundLimitKobo,
      requireManagerApproval: payload.requireManagerApproval,
      autoDisbursementLimitKobo: payload.autoDisbursementLimitKobo,
    };
  }

  @OnEvent(WORKFLOW_APPROVED_EVENT)
  async handleWorkflowApproved(event: WorkflowApprovedEvent): Promise<void> {
    await this.handleApproved(event);
  }
}

import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { WorkflowEntityType } from '../../common/enums/workflow.enums';
import { AuditService } from '../../platform/audit/audit.service';
import { WORKFLOW_APPROVED_EVENT, WorkflowApprovedEvent } from '../../platform/workflow-engine/events/workflow-engine.events';
import { WorkflowEngineService } from '../../platform/workflow-engine/workflow-engine.service';
import { CreateLoanConfigurationDto } from './dto/create-loan-configuration.dto';
import { LoanConfiguration, LoanConfigurationDocument } from './schemas/loan-configuration.schema';
import { VersionedConfigServiceBase } from './versioned-config.service.base';

@Injectable()
export class LoanConfigurationService extends VersionedConfigServiceBase<
  LoanConfiguration,
  LoanConfigurationDocument,
  CreateLoanConfigurationDto
> {
  protected readonly entityType = WorkflowEntityType.LOAN_CONFIG;
  protected readonly auditActionPrefix = 'LOAN_CONFIG';

  constructor(
    @InjectModel(LoanConfiguration.name) model: Model<LoanConfigurationDocument>,
    workflowEngineService: WorkflowEngineService,
    auditService: AuditService,
  ) {
    super(model, workflowEngineService, auditService);
  }

  protected mapPayloadToDoc(payload: CreateLoanConfigurationDto): Record<string, unknown> {
    return {
      interestRate: payload.interestRate,
      maxLoanAmountKobo: payload.maxLoanAmountKobo,
      minLoanAmountKobo: payload.minLoanAmountKobo,
      maxTenureMonths: payload.maxTenureMonths,
      gracePeriodDays: payload.gracePeriodDays,
      maxGroupSize: payload.maxGroupSize,
      minGroupSize: payload.minGroupSize,
    };
  }

  // Declared directly on the concrete class (not inherited from the base) —
  // see VersionedConfigServiceBase's own doc comment for why.
  @OnEvent(WORKFLOW_APPROVED_EVENT)
  async handleWorkflowApproved(event: WorkflowApprovedEvent): Promise<void> {
    await this.handleApproved(event);
  }
}

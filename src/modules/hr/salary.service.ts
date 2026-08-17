import { Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, Types } from 'mongoose';

import { WorkflowEntityType } from '../../common/enums/workflow.enums';
import { EncryptionService } from '../../platform/encryption/encryption.service';
import { approveCapability } from '../../platform/rbac/constants/capabilities';
import {
  WORKFLOW_APPROVED_EVENT,
  WorkflowApprovedEvent,
} from '../../platform/workflow-engine/events/workflow-engine.events';
import { WorkflowEngineService } from '../../platform/workflow-engine/workflow-engine.service';
import { WorkflowRequestDocument } from '../../platform/workflow-engine/schemas/workflow-request.schema';
import { SalaryRecord, SalaryRecordDocument } from './schemas/salary-record.schema';

export interface SalaryAllowance {
  name: string;
  amountKobo: number;
}

export interface DecryptedSalary {
  staffId: string;
  baseSalaryKobo: number;
  allowances: SalaryAllowance[];
  effectiveFrom: Date;
  effectiveTo: Date | null;
  createdBy: string;
  createdAt: Date;
}

const SALARY_PROPOSE_ACTION = 'PROPOSE';

/**
 * Encrypted, history-preserving salary structure — see SalaryRecord's own
 * doc comment for the encryption/history-preservation design, and
 * PHASE_12_NOTES.md for the confirmation this needed (payroll disbursement
 * itself is explicitly out of scope — this is structure/history only).
 */
@Injectable()
export class SalaryService implements OnModuleInit {
  constructor(
    @InjectModel(SalaryRecord.name) private readonly salaryRecordModel: Model<SalaryRecordDocument>,
    @InjectConnection() private readonly connection: Connection,
    private readonly encryptionService: EncryptionService,
    private readonly workflowEngineService: WorkflowEngineService,
  ) {}

  /** Single step — an Admin/SuperAdmin proposes, a *different* Admin/SuperAdmin/Approver approves (per assumption §4). */
  async onModuleInit(): Promise<void> {
    await this.workflowEngineService.registerChainConfig({
      entityType: WorkflowEntityType.SALARY_RECORD,
      action: SALARY_PROPOSE_ACTION,
      restartOnReturn: true,
      steps: [
        { order: 0, requiredCapability: approveCapability(WorkflowEntityType.SALARY_RECORD) },
      ],
    });
  }

  /**
   * Encrypts `baseSalaryKobo`/`allowances` *before* they ever sit in a
   * `WorkflowRequest.payloadHistory` document — same discipline as Phase 3's
   * Staff onboarding hashing a password before persisting the workflow
   * payload (see `StaffService.initiateOnboarding`'s own comment). The
   * `workflow.approved` handler below stores the ciphertext directly,
   * never round-tripping through plaintext again.
   */
  async proposeSalaryChange(
    staffId: string,
    baseSalaryKobo: number,
    allowances: SalaryAllowance[],
    effectiveFrom: Date,
    initiatedBy: string,
    branchId: string | null,
  ): Promise<WorkflowRequestDocument> {
    const baseSalaryKoboEncrypted = this.encryptionService.encrypt(String(baseSalaryKobo));
    const allowancesEncrypted = this.encryptionService.encrypt(JSON.stringify(allowances));

    return this.workflowEngineService.initiate({
      entityType: WorkflowEntityType.SALARY_RECORD,
      action: SALARY_PROPOSE_ACTION,
      payload: {
        staffId,
        baseSalaryKoboEncrypted,
        allowancesEncrypted,
        effectiveFrom: effectiveFrom.toISOString(),
      },
      initiatedBy,
      branchId,
    });
  }

  /**
   * Closes the prior active record (if any) and activates the new one in a
   * single transaction — same "close old, open new" discipline as
   * `BranchManagerAssignmentService.assignManager` / Phase 6's group
   * leadership reassignment.
   */
  @OnEvent(WORKFLOW_APPROVED_EVENT)
  async handleWorkflowApproved(event: WorkflowApprovedEvent): Promise<void> {
    if ((event.entityType as WorkflowEntityType) !== WorkflowEntityType.SALARY_RECORD) {
      return;
    }
    const payload = event.payload as {
      staffId: string;
      baseSalaryKoboEncrypted: string;
      allowancesEncrypted: string;
      effectiveFrom: string;
    };
    const effectiveFrom = new Date(payload.effectiveFrom);
    // Explicit cast — see LeaveBalanceService's own comment on why (Phase 11 bug).
    const staffObjectId = new Types.ObjectId(payload.staffId);

    const session = await this.connection.startSession();
    try {
      await session.withTransaction(async () => {
        const prior = await this.salaryRecordModel
          .findOne({ staffId: staffObjectId, effectiveTo: null })
          .session(session)
          .exec();
        if (prior) {
          await this.salaryRecordModel
            .updateOne({ _id: prior._id }, { $set: { effectiveTo: effectiveFrom } }, { session })
            .exec();
        }

        await this.salaryRecordModel.create(
          [
            {
              staffId: new Types.ObjectId(payload.staffId),
              baseSalaryKoboEncrypted: payload.baseSalaryKoboEncrypted,
              allowancesEncrypted: payload.allowancesEncrypted,
              effectiveFrom,
              effectiveTo: null,
              createdBy: new Types.ObjectId(event.initiatedBy),
              createdAt: new Date(),
            },
          ],
          { session, ordered: true },
        );
      });
    } finally {
      await session.endSession();
    }
  }

  private decrypt(record: SalaryRecordDocument): DecryptedSalary {
    return {
      staffId: record.staffId.toString(),
      baseSalaryKobo: Number(this.encryptionService.decrypt(record.baseSalaryKoboEncrypted)),
      allowances: JSON.parse(
        this.encryptionService.decrypt(record.allowancesEncrypted),
      ) as SalaryAllowance[],
      effectiveFrom: record.effectiveFrom,
      effectiveTo: record.effectiveTo,
      createdBy: record.createdBy.toString(),
      createdAt: record.createdAt,
    };
  }

  async getCurrentSalary(staffId: string): Promise<DecryptedSalary> {
    const record = await this.salaryRecordModel
      .findOne({ staffId: new Types.ObjectId(staffId), effectiveTo: null })
      .exec();
    if (!record) {
      throw new NotFoundException(`No active SalaryRecord found for staff ${staffId}`);
    }
    return this.decrypt(record);
  }

  async getSalaryHistory(staffId: string): Promise<DecryptedSalary[]> {
    const records = await this.salaryRecordModel
      .find({ staffId: new Types.ObjectId(staffId) })
      .sort({ effectiveFrom: -1 })
      .exec();
    return records.map((record) => this.decrypt(record));
  }
}

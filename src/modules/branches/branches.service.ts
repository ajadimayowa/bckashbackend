import { BadRequestException, ConflictException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';

import { LoanStatus } from '../../common/enums/loan.enums';
import { WorkflowEntityType } from '../../common/enums/workflow.enums';
import { AuditService } from '../../platform/audit/audit.service';
import { approveCapability } from '../../platform/rbac/constants/capabilities';
import { WORKFLOW_APPROVED_EVENT, WorkflowApprovedEvent } from '../../platform/workflow-engine/events/workflow-engine.events';
import { WorkflowRequestDocument } from '../../platform/workflow-engine/schemas/workflow-request.schema';
import { WorkflowEngineService } from '../../platform/workflow-engine/workflow-engine.service';
import { Loan, LoanDocument } from '../loans/schemas/loan.schema';
import { Staff, StaffDocument } from '../identity/schemas/staff.schema';
import { Customer, CustomerDocument } from '../customers/schemas/customer.schema';
import { Group, GroupDocument } from '../groups/schemas/group.schema';
import { AuditLogDocument } from '../../platform/audit/schemas/audit-log.schema';
import { CreateBranchDto } from './dto/create-branch.dto';
import { BRANCH_CREATED_EVENT, BranchCreatedEvent } from './events/branch.events';
import { UpdateBranchDto } from './dto/update-branch.dto';
import { BranchBankAccount, BranchBankAccountDocument } from './schemas/branch-bank-account.schema';
import { BranchFundBalance, BranchFundBalanceDocument } from './schemas/branch-fund-balance.schema';
import { Branch, BranchDocument } from './schemas/branch.schema';

const DUPLICATE_KEY_ERROR_CODE = 11000;
const BRANCH_CREATE_ACTION = 'CREATE';

export interface BranchStats {
  branchId: string;
  staffCount: number;
  activeLoansCount: number;
}

interface BranchCreationPayload {
  name: string;
  code: string;
  address: string | null;
}

/**
 * Branch creation is workflow-mediated — Admin/SuperAdmin/Approver propose a
 * new branch, a *different* Admin/SuperAdmin/Approver approves it (single
 * step, same "propose then a different admin-tier person approves" shape as
 * LoanProduct/FeeDefinition — see default-role-capabilities.ts's own BRANCH
 * comment for why Approver initiates this one too, unlike those). No Branch
 * document exists until then — same "doesn't exist until approved" pattern
 * as everything else in this codebase built on the workflow engine.
 * Editing an existing branch (`update`) stays direct/immediate, matching
 * the explicit product decision: only *creation* needs a second approver.
 */
@Injectable()
export class BranchesService implements OnModuleInit {
  constructor(
    @InjectModel(Branch.name) private readonly branchModel: Model<BranchDocument>,
    // Cross-module raw-model injection (read-only) — same pattern as
    // BranchManagerAssignmentService's own Staff read and PHASE_3_NOTES.md's
    // reasoning: registering the schema again here avoids importing
    // IdentityModule/LoansModule wholesale just to read a count.
    @InjectModel(Staff.name) private readonly staffModel: Model<StaffDocument>,
    @InjectModel(Loan.name) private readonly loanModel: Model<LoanDocument>,
    // Same pattern, for deleteBranch's own reference check — see its doc comment.
    @InjectModel(Customer.name) private readonly customerModel: Model<CustomerDocument>,
    @InjectModel(Group.name) private readonly groupModel: Model<GroupDocument>,
    @InjectModel(BranchFundBalance.name) private readonly branchFundBalanceModel: Model<BranchFundBalanceDocument>,
    @InjectModel(BranchBankAccount.name) private readonly branchBankAccountModel: Model<BranchBankAccountDocument>,
    private readonly workflowEngineService: WorkflowEngineService,
    private readonly auditService: AuditService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.workflowEngineService.registerChainConfig({
      entityType: WorkflowEntityType.BRANCH,
      action: BRANCH_CREATE_ACTION,
      restartOnReturn: true,
      steps: [{ order: 0, requiredCapability: approveCapability(WorkflowEntityType.BRANCH) }],
    });
  }

  // ---------------------------------------------------------------------------
  // Creation (workflow-mediated)
  // ---------------------------------------------------------------------------

  async initiateCreation(dto: CreateBranchDto, initiatedBy: string): Promise<WorkflowRequestDocument> {
    // Checked here, not just at approval time — @nestjs/event-emitter
    // catches and only *logs* an exception thrown inside an @OnEvent
    // listener (EventSubscribersLoader.wrapFunctionInTryCatchBlocks), it
    // does not reject the emitAsync() call — so a duplicate caught only in
    // persistBranch (still kept, defensively) would leave `act()` returning
    // a normal APPROVED response while silently creating nothing at all.
    // This pre-check catches the common case (colliding with an
    // already-approved branch) with real, synchronous feedback to the
    // proposer; it can't see a *different* still-pending proposal's code,
    // which persistBranch's own check still guards at approval time.
    // `code`'s schema setter uppercases on save — matched here too, since a
    // raw query filter isn't run through that setter automatically.
    const existing = await this.branchModel.findOne({ code: dto.code.toUpperCase() }).lean().exec();
    if (existing) {
      throw new ConflictException(`A branch with code "${dto.code}" already exists`);
    }

    const payload: BranchCreationPayload = {
      name: dto.name,
      code: dto.code,
      address: dto.address ?? null,
    };

    return this.workflowEngineService.initiate({
      entityType: WorkflowEntityType.BRANCH,
      action: BRANCH_CREATE_ACTION,
      payload: payload as unknown as Record<string, unknown>,
      initiatedBy,
    });
  }

  @OnEvent(WORKFLOW_APPROVED_EVENT)
  async handleWorkflowApproved(event: WorkflowApprovedEvent): Promise<void> {
    if ((event.entityType as WorkflowEntityType) !== WorkflowEntityType.BRANCH || event.action !== BRANCH_CREATE_ACTION) {
      return;
    }

    const payload = event.payload as unknown as BranchCreationPayload;
    const branch = await this.persistBranch(payload);

    await this.workflowEngineService.linkEntity(event.workflowRequestId, branch._id.toString());

    await this.auditService.record({
      actorId: event.approvedBy,
      action: 'BRANCH_CREATED',
      entityType: 'BRANCH',
      entityId: branch._id.toString(),
      after: { name: payload.name, code: payload.code },
      metadata: { workflowRequestId: event.workflowRequestId, proposedBy: event.initiatedBy },
    });
  }

  /**
   * Bypasses the workflow entirely — no controller route exposes this.
   * Exists solely for `seedOrgStructure`, which needs to create the
   * bootstrap "Head Office Branch" before any staff account (let alone a
   * *second* Admin/SuperAdmin/Approver to approve one) exists to run the
   * real maker-checker flow through.
   */
  async createDirect(dto: CreateBranchDto): Promise<BranchDocument> {
    return this.persistBranch({ name: dto.name, code: dto.code, address: dto.address ?? null });
  }

  private async persistBranch(payload: BranchCreationPayload): Promise<BranchDocument> {
    let branch: BranchDocument;
    try {
      branch = await this.branchModel.create({
        name: payload.name,
        code: payload.code,
        address: payload.address,
        active: true,
      });
    } catch (err) {
      // `code` carries a unique index — duck-typed on `err.code`, not
      // `instanceof MongoServerError`, same reasoning as
      // BranchBankAccountsService.rethrowDuplicateKeyAsConflict (mongoose
      // vendors its own copy of the mongodb driver, so `instanceof` isn't
      // reliable here). Via `handleWorkflowApproved`, a duplicate only
      // surfaces once approved — the maker never gets synchronous feedback
      // about it, same tradeoff every other workflow-mediated creation in
      // this codebase accepts.
      if ((err as { code?: unknown } | null)?.code === DUPLICATE_KEY_ERROR_CODE) {
        throw new ConflictException(`A branch with code "${payload.code}" already exists`);
      }
      throw err;
    }

    // Phase 4 hook: BranchFundBalanceService listens for this and initializes
    // a zero balance document — added here (a one-line emit) rather than
    // retrofitting this service to know about balances directly. See
    // PHASE_4_NOTES.md.
    const branchCreatedEvent: BranchCreatedEvent = { branchId: branch._id.toString() };
    await this.eventEmitter.emitAsync(BRANCH_CREATED_EVENT, branchCreatedEvent);

    return branch;
  }

  /**
   * Added for the Branch Management UI — a branch's `staff`/`activeLoans`
   * counts have no field of their own on the Branch document (see its own
   * doc comment) and no existing endpoint computed them. `staffCount` is
   * every Staff record with this branchId regardless of status (matches
   * `GET /staff?branchId=`'s own scope); `activeLoansCount` is loans
   * currently DISBURSED — money is out and not yet CLOSED, which is what
   * "active" means for a loan (PENDING_APPROVAL/REJECTED aren't live
   * exposure yet, CLOSED no longer is).
   */
  async getStats(branchId: string): Promise<BranchStats> {
    // *** Same bug class as PHASE_8_NOTES.md's BranchFundBalanceService fix
    // and PHASE_11_NOTES.md's staff.service.ts fix *** — a plain string
    // branchId does not reliably cast against a Types.ObjectId-typed field
    // in this codebase's Mongoose setup; explicit casting here avoids
    // silently returning zero for both counts.
    const branchObjectId = new Types.ObjectId(branchId);
    const [staffCount, activeLoansCount] = await Promise.all([
      this.staffModel.countDocuments({ branchId: branchObjectId }).exec(),
      this.loanModel.countDocuments({ branchId: branchObjectId, status: LoanStatus.DISBURSED }).exec(),
    ]);
    return { branchId, staffCount, activeLoansCount };
  }

  async findAll(): Promise<BranchDocument[]> {
    return this.branchModel.find().sort({ name: 1 }).exec();
  }

  async findById(id: string): Promise<BranchDocument> {
    const branch = await this.branchModel.findById(id).exec();
    if (!branch) {
      throw new NotFoundException(`Branch ${id} not found`);
    }
    return branch;
  }

  async update(id: string, dto: UpdateBranchDto, actorId: string): Promise<BranchDocument> {
    const before = await this.findById(id);
    const branch = await this.branchModel
      .findByIdAndUpdate(id, { $set: dto }, { new: true })
      .exec();
    if (!branch) {
      throw new NotFoundException(`Branch ${id} not found`);
    }

    // A branch flipping active/inactive is exactly the kind of "head office
    // acted on your branch" event the Manager dashboard's activity feed
    // surfaces — see getActivity's own doc comment.
    if (dto.active !== undefined && dto.active !== before.active) {
      await this.auditService.record({
        actorId,
        action: dto.active ? 'BRANCH_ACTIVATED' : 'BRANCH_DEACTIVATED',
        entityType: 'BRANCH',
        entityId: id,
        before: { active: before.active },
        after: { active: dto.active },
      });
    }

    return branch;
  }

  /** Used by StaffService to validate a branchId reference before trusting it. */
  async assertExists(id: string): Promise<void> {
    const exists = await this.branchModel.exists({ _id: id });
    if (!exists) {
      throw new BadRequestException(`Branch ${id} does not exist`);
    }
  }

  /**
   * Admin/SuperAdmin/Approver only (see BranchesController's own gate) —
   * hard-deletes a branch that never really got used. Deliberately
   * conservative: the real, sole guard is "does anything still reference
   * it" (staff, customers, groups, loans) — never silently orphaning those
   * records. `active` on its own is NOT a gate: an active branch with
   * nothing in it is exactly as safe to delete as an inactive one (nothing
   * about `active` corresponds to a reference this method would otherwise
   * miss) — a coop proposing/activating a branch by mistake, with nothing
   * ever assigned to it, doesn't need a separate "deactivate first" step
   * to undo that. Cascades to the branch's own fund balance and bank
   * account records, which have no meaning without their branch.
   */
  async deleteBranch(id: string, actorId: string): Promise<void> {
    const branch = await this.findById(id);

    const branchObjectId = new Types.ObjectId(id);
    const [staffCount, loanCount, customerCount, groupCount] = await Promise.all([
      this.staffModel.countDocuments({ branchId: branchObjectId }).exec(),
      this.loanModel.countDocuments({ branchId: branchObjectId }).exec(),
      this.customerModel.countDocuments({ branchId: branchObjectId }).exec(),
      this.groupModel.countDocuments({ branchId: branchObjectId }).exec(),
    ]);
    if (staffCount > 0 || loanCount > 0 || customerCount > 0 || groupCount > 0) {
      throw new ConflictException(
        `Branch ${id} still has records referencing it (staff: ${staffCount}, loans: ${loanCount}, ` +
          `customers: ${customerCount}, groups: ${groupCount}) — it cannot be deleted while any exist`,
      );
    }

    await this.branchModel.deleteOne({ _id: id }).exec();
    await Promise.all([
      this.branchFundBalanceModel.deleteOne({ branchId: branchObjectId }).exec(),
      this.branchBankAccountModel.deleteMany({ branchId: branchObjectId }).exec(),
    ]);

    await this.auditService.record({
      actorId,
      action: 'BRANCH_DELETED',
      entityType: 'BRANCH',
      entityId: id,
      before: { name: branch.name, code: branch.code },
    });
  }

  /** `id -> "First Last"` for a batch of staff ids — same shape/purpose as CustomerService's own resolveStaffNames. */
  async resolveStaffNames(staffIds: string[]): Promise<Map<string, string>> {
    const uniqueIds = [...new Set(staffIds)];
    if (uniqueIds.length === 0) {
      return new Map();
    }
    const staff = await this.staffModel.find({ _id: { $in: uniqueIds } }).exec();
    return new Map(staff.map((s) => [s._id.toString(), `${s.firstName} ${s.lastName}`.trim()]));
  }

  /**
   * A branch's own activity trail — BRANCH_CREATED, BRANCH_ACTIVATED/
   * DEACTIVATED, plus (via AuditService's shared `entityType`/`entityId`
   * convention) BRANCH_FUNDING_VERIFIED/REJECTED already recorded by
   * BranchFundingService against `entityType: 'BRANCH_FUNDING'` — those
   * carry `metadata.branchId`, not `entityId`, so they're fetched
   * separately and merged here rather than missed. Doubles as the Manager
   * dashboard's "notifications from head office" feed: everything on it is
   * something head office (or the system) did to this specific branch.
   */
  async getActivity(branchId: string): Promise<AuditLogDocument[]> {
    const [ownEntries, fundingEntries] = await Promise.all([
      this.auditService.findByEntity('BRANCH', branchId),
      this.auditService.findByBranchMetadata(branchId),
    ]);
    return [...ownEntries, ...fundingEntries].sort(
      (a, b) => a.timestamp.getTime() - b.timestamp.getTime(),
    );
  }
}

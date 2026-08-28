import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, Types } from 'mongoose';

import { CustomerStatus } from '../../common/enums/customer.enums';
import { GroupMemberRole, GroupStatus, LEADERSHIP_ROLES } from '../../common/enums/group.enums';
import { StaffRole } from '../../common/enums/identity.enums';
import { WorkflowEntityType } from '../../common/enums/workflow.enums';
import { AuditService } from '../../platform/audit/audit.service';
import { approveCapability, reviewCapability } from '../../platform/rbac/constants/capabilities';
import {
  WORKFLOW_APPROVED_EVENT,
  WORKFLOW_CANCELLED_EVENT,
  WORKFLOW_DELETED_EVENT,
  WORKFLOW_REJECTED_EVENT,
  WorkflowApprovedEvent,
  WorkflowCancelledEvent,
  WorkflowDeletedEvent,
  WorkflowRejectedEvent,
} from '../../platform/workflow-engine/events/workflow-engine.events';
import { WorkflowRequestDocument } from '../../platform/workflow-engine/schemas/workflow-request.schema';
import { WorkflowEngineService } from '../../platform/workflow-engine/workflow-engine.service';
// Cross-module reads only — raw Branch/Customer models, not their services'
// full modules. Same pattern as identity/staff.service.ts, PHASE_3_NOTES.md.
import { Branch, BranchDocument } from '../branches/schemas/branch.schema';
import { CustomerService } from '../customers/customer.service';
import { Customer, CustomerDocument } from '../customers/schemas/customer.schema';
import { AddGroupMemberDto } from './dto/add-group-member.dto';
import { InitiateGroupCreationDto } from './dto/initiate-group-creation.dto';
import { LOAN_STATUS_PORT, LoanStatusPort } from './interfaces/loan-status-port.interface';
import { GroupMembership, GroupMembershipDocument } from './schemas/group-membership.schema';
import { Group, GroupDocument, GroupEditPrivilegeStatus } from './schemas/group.schema';

const GROUP_CREATE_ACTION = 'CREATE';
const GROUP_REASSIGN_LEADERSHIP_ACTION = 'REASSIGN_LEADERSHIP';
const GROUP_MEMBERSHIP_ADD_ACTION = 'ADD';
const GROUP_MEMBERSHIP_REMOVE_ACTION = 'REMOVE';

interface GroupCreationPayload {
  name: string;
  branchId: string;
  proposedMemberCustomerIds: string[];
  proposedLeaderName?: string;
  meetingDay?: string;
  meetingLocation?: string;
  expectedMemberCount?: number;
}

/** Same shape as CustomerService's CustomerViewerContext — deliberately not
 * shared/imported across modules for this since it's a tiny structural type. */
export interface GroupViewerContext {
  staffId: string;
  role: StaffRole;
  branchId?: string;
}

export interface FindGroupsFilter {
  branchId?: string;
}

interface GroupMembershipAddPayload {
  groupId: string;
  customerId: string;
}

interface GroupMembershipRemovePayload {
  groupId: string;
  customerId: string;
  reason: string;
}

interface GroupLeadershipReassignPayload {
  groupId: string;
  role: GroupMemberRole;
  newCustomerId: string;
}

export interface GroupLeadership {
  head?: GroupMembershipDocument;
  assistant?: GroupMembershipDocument;
  coordinator?: GroupMembershipDocument;
}

export interface IneligibleMember {
  /**
   * `null` for a group-level reason (e.g. "too few active members") that
   * isn't attributable to one specific member — a small, deliberate
   * widening of the brief's `{ customerId: ObjectId; reason: string }[]`
   * shape, which had no slot for a non-member-specific reason. See
   * PHASE_6_NOTES.md.
   */
  customerId: string | null;
  reason: string;
}

export interface GroupLoanEligibilityResult {
  eligible: boolean;
  ineligibleMembers: IneligibleMember[];
}

function roleForProposedIndex(index: number): GroupMemberRole {
  switch (index) {
    case 0:
      return GroupMemberRole.GROUP_HEAD;
    case 1:
      return GroupMemberRole.GROUP_HEAD_ASSISTANT;
    case 2:
      return GroupMemberRole.COORDINATOR;
    default:
      return GroupMemberRole.MEMBER;
  }
}

@Injectable()
export class GroupsService implements OnModuleInit {
  constructor(
    @InjectModel(Group.name) private readonly groupModel: Model<GroupDocument>,
    @InjectModel(GroupMembership.name)
    private readonly groupMembershipModel: Model<GroupMembershipDocument>,
    @InjectModel(Branch.name) private readonly branchModel: Model<BranchDocument>,
    @InjectModel(Customer.name) private readonly customerModel: Model<CustomerDocument>,
    @InjectConnection() private readonly connection: Connection,
    private readonly workflowEngineService: WorkflowEngineService,
    private readonly customerService: CustomerService,
    private readonly auditService: AuditService,
    @Inject(LOAN_STATUS_PORT) private readonly loanStatusPort: LoanStatusPort,
  ) {}

  async onModuleInit(): Promise<void> {
    // GROUP/CREATE and GROUP_MEMBERSHIP/ADD are both two-step (review, then
    // approve) — corrected from Phase 5's original single-step reading of
    // "reviewed and approved" once this phase re-read the brief's identical
    // language for group creation. See PHASE_6_NOTES.md.
    await this.workflowEngineService.registerChainConfig({
      entityType: WorkflowEntityType.GROUP,
      action: GROUP_CREATE_ACTION,
      restartOnReturn: true,
      steps: [
        { order: 0, requiredCapability: reviewCapability(WorkflowEntityType.GROUP) },
        { order: 1, requiredCapability: approveCapability(WorkflowEntityType.GROUP) },
      ],
    });

    // Every proposed member must be an ACTIVE (approved) customer by the
    // time this group is actually approved — not just at proposal time,
    // since a member's own KYC approval can still be pending or even get
    // rejected while the group proposal itself sits under review. Runs only
    // on the *final* approval step — see PreApprovalValidator's own doc
    // comment for why this isn't done inside the WORKFLOW_APPROVED_EVENT
    // handler below (the event emitter swallows exceptions thrown there).
    this.workflowEngineService.registerPreApprovalValidator(
      WorkflowEntityType.GROUP,
      GROUP_CREATE_ACTION,
      async (request) => {
        const latestPayload = request.payloadHistory[request.payloadHistory.length - 1]?.payload ?? {};
        const payload = latestPayload as unknown as GroupCreationPayload;
        const memberIds = payload.proposedMemberCustomerIds ?? [];
        const customers = await this.customerModel
          .find({ _id: { $in: memberIds.map((id) => new Types.ObjectId(id)) } })
          .exec();
        const customersById = new Map(customers.map((c) => [c._id.toString(), c]));
        const notApproved = memberIds.filter((id) => customersById.get(id)?.status !== CustomerStatus.ACTIVE);
        if (notApproved.length > 0) {
          throw new ConflictException(
            `All proposed members must be approved before this group can be approved — ` +
              `${notApproved.length} of ${memberIds.length} member(s) are not yet approved`,
          );
        }
      },
    );

    await this.workflowEngineService.registerChainConfig({
      entityType: WorkflowEntityType.GROUP_MEMBERSHIP,
      action: GROUP_MEMBERSHIP_ADD_ACTION,
      restartOnReturn: true,
      steps: [
        { order: 0, requiredCapability: reviewCapability(WorkflowEntityType.GROUP_MEMBERSHIP) },
        { order: 1, requiredCapability: approveCapability(WorkflowEntityType.GROUP_MEMBERSHIP) },
      ],
    });

    // Same rule as GROUP/CREATE's own validator above, applied to a member
    // joining an *existing* group later: this lets a not-yet-approved
    // customer (e.g. one just onboarded standalone — see
    // CustomerOnboarding.tsx's "Single Customer" flow) be proposed into a
    // group right away, but they can't actually become a member until their
    // own KYC is approved — checked again here, not just at proposal time,
    // since their KYC status can change while this addition itself is under
    // review. A group's *existing* members/status are never touched by
    // this — only this one pending addition is blocked.
    this.workflowEngineService.registerPreApprovalValidator(
      WorkflowEntityType.GROUP_MEMBERSHIP,
      GROUP_MEMBERSHIP_ADD_ACTION,
      async (request) => {
        const latestPayload = request.payloadHistory[request.payloadHistory.length - 1]?.payload ?? {};
        const payload = latestPayload as unknown as GroupMembershipAddPayload;
        const customer = await this.customerModel.findById(payload.customerId).exec();
        if (!customer || customer.status !== CustomerStatus.ACTIVE) {
          throw new ConflictException(
            `Customer ${payload.customerId} must be approved before they can be added to group ${payload.groupId}`,
          );
        }
      },
    );

    // Removal is also workflow-mediated, symmetric with addition — an open
    // question flagged in the brief ("should removal be a direct action
    // instead?"), resolved to "yes, workflow-mediated" per the brief's own
    // stated default: financial-adjacent, worth a second set of eyes. See
    // PHASE_6_NOTES.md.
    await this.workflowEngineService.registerChainConfig({
      entityType: WorkflowEntityType.GROUP_MEMBERSHIP,
      action: GROUP_MEMBERSHIP_REMOVE_ACTION,
      restartOnReturn: true,
      steps: [
        { order: 0, requiredCapability: reviewCapability(WorkflowEntityType.GROUP_MEMBERSHIP) },
        { order: 1, requiredCapability: approveCapability(WorkflowEntityType.GROUP_MEMBERSHIP) },
      ],
    });

    // Narrower, single-step chain — see reassignLeadershipRole's own comment
    // and PHASE_6_NOTES.md for why single-step (vs. the two-step pattern
    // above) was judged sufficient here.
    await this.workflowEngineService.registerChainConfig({
      entityType: WorkflowEntityType.GROUP,
      action: GROUP_REASSIGN_LEADERSHIP_ACTION,
      restartOnReturn: true,
      steps: [{ order: 0, requiredCapability: approveCapability(WorkflowEntityType.GROUP) }],
    });
  }

  // ---------------------------------------------------------------------------
  // Creation
  // ---------------------------------------------------------------------------

  /** Shared by initiateCreation and reviseAndResubmit — same rules either way. */
  private async validateAndBuildGroupCreationPayload(
    dto: InitiateGroupCreationDto,
  ): Promise<GroupCreationPayload> {
    // Redundant with the DTO's @ArrayMinSize(3), but the service must not
    // trust a caller that bypasses the DTO layer (direct service consumers,
    // future internal callers) — no workflow request should ever be created
    // for a proposal that can't pass this rule.
    if (dto.proposedMemberCustomerIds.length < 3) {
      throw new BadRequestException('A group must be created with at least 3 proposed members');
    }

    const uniqueIds = new Set(dto.proposedMemberCustomerIds);
    if (uniqueIds.size !== dto.proposedMemberCustomerIds.length) {
      throw new BadRequestException(
        'proposedMemberCustomerIds must not contain duplicate customer IDs',
      );
    }

    const branchExists = await this.branchModel.exists({ _id: dto.branchId });
    if (!branchExists) {
      throw new BadRequestException(`Branch ${dto.branchId} does not exist`);
    }

    const existingCustomerCount = await this.customerModel.countDocuments({
      _id: { $in: dto.proposedMemberCustomerIds.map((id) => new Types.ObjectId(id)) },
    });
    if (existingCustomerCount !== uniqueIds.size) {
      throw new BadRequestException('One or more proposedMemberCustomerIds do not exist');
    }

    // Deliberately no KYC check here — KYC completion gates loan eligibility
    // (isEligibleForLoanApplication), not group membership itself. See the
    // brief. (The *approval*-time rule — every member must be an ACTIVE
    // customer — is enforced separately, see the pre-approval validator
    // registered in onModuleInit.)

    return {
      name: dto.name,
      branchId: dto.branchId,
      proposedMemberCustomerIds: dto.proposedMemberCustomerIds,
      proposedLeaderName: dto.proposedLeaderName,
      meetingDay: dto.meetingDay,
      meetingLocation: dto.meetingLocation,
      expectedMemberCount: dto.expectedMemberCount,
    };
  }

  async initiateCreation(
    dto: InitiateGroupCreationDto,
    initiatedBy: string,
  ): Promise<WorkflowRequestDocument> {
    const payload = await this.validateAndBuildGroupCreationPayload(dto);

    return this.workflowEngineService.initiate({
      entityType: WorkflowEntityType.GROUP,
      action: GROUP_CREATE_ACTION,
      payload: payload as unknown as Record<string, unknown>,
      initiatedBy,
      branchId: dto.branchId,
    });
  }

  /**
   * The maker's path back in after a REJECTED group proposal — revise
   * whatever was flagged (drop/replace a member, fix the name, ...) and
   * resend for a *fresh* review cycle (WorkflowEngineService.resubmit
   * always restarts a REJECTED request from step 0 — see its own comment).
   * Same validation as initiateCreation; the approval-time "every member
   * must be ACTIVE" rule is re-checked automatically on the next approval
   * attempt regardless, via the same registered pre-approval validator.
   */
  async reviseAndResubmit(
    workflowRequestId: string,
    actorId: string,
    dto: InitiateGroupCreationDto,
  ): Promise<WorkflowRequestDocument> {
    const payload = await this.validateAndBuildGroupCreationPayload(dto);

    return this.workflowEngineService.resubmit({
      workflowRequestId,
      actorId,
      newPayload: payload as unknown as Record<string, unknown>,
    });
  }

  /**
   * The maker fixes a typo (name, expected member count, meeting details, ...)
   * in their own proposal before anyone has reviewed it yet — see
   * WorkflowEngineService.updatePendingPayload's own comment for why this is
   * a distinct, narrower operation from reviseAndResubmit (PENDING_REVIEW
   * only, no chain reset). Same validation as initiateCreation/
   * reviseAndResubmit either way — an edited proposal is held to the same bar.
   */
  async updateProposal(
    workflowRequestId: string,
    actorId: string,
    dto: InitiateGroupCreationDto,
  ): Promise<WorkflowRequestDocument> {
    const payload = await this.validateAndBuildGroupCreationPayload(dto);

    return this.workflowEngineService.updatePendingPayload({
      workflowRequestId,
      actorId,
      newPayload: payload as unknown as Record<string, unknown>,
    });
  }

  /**
   * The maker deletes their own not-yet-approved group proposal — see
   * WorkflowEngineService.deleteRequest's own comment for the underlying
   * PENDING_REVIEW/REJECTED-only, maker-only rule. No real Group/
   * GroupMembership document exists to clean up yet (see this class's own
   * doc comment — nothing is persisted before approval), but the *members*
   * proposed into it very much do: a Marketer's onboarding flow typically
   * creates the group and its member Customer records together in one go
   * (see CustomerOnboarding.tsx), so scrapping the group without also
   * removing the customers raised specifically for it would leave orphaned
   * draft records behind. Best-effort per member: a proposed member who's
   * already gone ACTIVE (pre-existing, merely proposed into this group
   * rather than created for it), or was created by someone else, is left
   * alone exactly as CustomerService.deleteCustomer's own rules dictate —
   * only ever removes what it's actually allowed to.
   */
  async deleteProposal(workflowRequestId: string, actorId: string): Promise<void> {
    const request = await this.workflowEngineService.getById(workflowRequestId);
    if (request.entityType !== WorkflowEntityType.GROUP || request.action !== GROUP_CREATE_ACTION) {
      throw new BadRequestException(`WorkflowRequest ${workflowRequestId} is not a group creation proposal`);
    }
    const latestPayload = request.payloadHistory[request.payloadHistory.length - 1]?.payload as
      | Partial<GroupCreationPayload>
      | undefined;
    const memberIds = latestPayload?.proposedMemberCustomerIds ?? [];

    // Deletes (and authorizes) the WorkflowRequest itself first — if the
    // maker/status checks fail, nothing below ever runs.
    await this.workflowEngineService.deleteRequest({ workflowRequestId, actorId });

    await Promise.all(
      memberIds.map((customerId) => this.customerService.deleteCustomer(customerId, actorId).catch(() => undefined)),
    );
  }

  private async onGroupCreationApproved(event: WorkflowApprovedEvent): Promise<void> {
    const payload = event.payload as unknown as GroupCreationPayload;
    const now = new Date();

    const session = await this.connection.startSession();
    let createdGroup: GroupDocument | null = null;

    try {
      await session.withTransaction(async () => {
        // A group with a partially-created membership set is a bad state to
        // allow, even transiently — Group + every GroupMembership are
        // created in one transaction.
        const created = await this.groupModel.create(
          [
            {
              name: payload.name,
              // Explicit ObjectId casts on every write below — plain
              // ID strings coming out of a WorkflowRequest's opaque
              // Record<string, unknown> payload/event fields have been
              // observed NOT to reliably auto-cast to ObjectId on save in
              // this codebase's Mongoose setup (same family of issue as the
              // KycRecord query-cast bug from Phase 5, but on the write
              // side this time) — verified empirically while building this
              // phase's tests. See PHASE_6_NOTES.md.
              branchId: new Types.ObjectId(payload.branchId),
              status: GroupStatus.ACTIVE,
              createdBy: new Types.ObjectId(event.initiatedBy),
              proposedLeaderName: payload.proposedLeaderName ?? null,
              meetingDay: payload.meetingDay ?? null,
              meetingLocation: payload.meetingLocation ?? null,
              expectedMemberCount: payload.expectedMemberCount ?? null,
            },
          ],
          { session },
        );
        const group = created[0];
        if (!group) {
          throw new Error('groupModel.create([...]) returned an empty array');
        }

        const memberships = payload.proposedMemberCustomerIds.map((customerId, index) => ({
          groupId: group._id,
          customerId: new Types.ObjectId(customerId),
          role: roleForProposedIndex(index),
          joinedAt: now,
          leftAt: null,
          addedBy: new Types.ObjectId(event.initiatedBy),
        }));
        // `ordered: true` is required by Mongoose whenever `create()` is
        // called with a session and more than one document — otherwise it
        // throws synchronously before ever reaching the DB.
        await this.groupMembershipModel.create(memberships, { session, ordered: true });

        createdGroup = group;
      });
    } finally {
      await session.endSession();
    }

    // Unreachable-if-null: withTransaction only resolves normally once the
    // callback above completed without throwing.
    if (!createdGroup) {
      throw new Error(
        `GROUP/CREATE approval transaction for workflow request ${event.workflowRequestId} completed without a result`,
      );
    }
    const group = createdGroup as GroupDocument;

    await this.workflowEngineService.linkEntity(event.workflowRequestId, group._id.toString());

    await this.auditService.record({
      actorId: event.initiatedBy,
      action: 'GROUP_CREATED',
      entityType: 'GROUP',
      entityId: group._id.toString(),
      after: {
        name: payload.name,
        branchId: payload.branchId,
        memberCount: payload.proposedMemberCustomerIds.length,
      },
      metadata: { workflowRequestId: event.workflowRequestId },
    });
  }

  // ---------------------------------------------------------------------------
  // Member addition
  // ---------------------------------------------------------------------------

  async initiateMemberAddition(
    groupId: string,
    dto: AddGroupMemberDto,
    initiatedBy: string,
  ): Promise<WorkflowRequestDocument> {
    const group = await this.findActiveGroupOrThrow(groupId);

    const customerExists = await this.customerModel.exists({ _id: dto.customerId });
    if (!customerExists) {
      throw new BadRequestException(`Customer ${dto.customerId} does not exist`);
    }

    const alreadyActive = await this.groupMembershipModel.exists({
      groupId: new Types.ObjectId(groupId),
      customerId: new Types.ObjectId(dto.customerId),
      leftAt: null,
    });
    if (alreadyActive) {
      throw new ConflictException(
        `Customer ${dto.customerId} already has an active membership in group ${groupId}`,
      );
    }

    // Same "no pending loan" guard as initiateMemberRemoval — see
    // LoanStatusPort's own doc comment. A customer isn't a member of *this*
    // group yet (just checked above), so any pending/active loan they hold
    // necessarily belongs to whichever other group they raised it with; a
    // group loan is raised per-group, and a customer straddling two groups'
    // loan cycles at once is exactly what this blocks.
    const hasPendingLoan = await this.loanStatusPort.hasPendingLoan(dto.customerId);
    if (hasPendingLoan) {
      throw new ConflictException(
        `Customer ${dto.customerId} has a pending/active loan with another group and cannot be added to group ${groupId}`,
      );
    }

    const payload: GroupMembershipAddPayload = { groupId, customerId: dto.customerId };

    const request = await this.workflowEngineService.initiate({
      entityType: WorkflowEntityType.GROUP_MEMBERSHIP,
      action: GROUP_MEMBERSHIP_ADD_ACTION,
      payload: payload as unknown as Record<string, unknown>,
      initiatedBy,
      branchId: group.branchId.toString(),
    });

    // Submitted for approval -> the group itself goes back under review,
    // same "must be fully approved, not just proposed" rule GROUP/CREATE's
    // own PreApprovalValidator enforces for its initial members — see
    // GroupStatus's own doc comment. Reverted back to ACTIVE by whichever
    // of onMemberAdditionApproved/onMemberAdditionRejected/
    // onMemberAdditionAbandoned below this one resolves to.
    await this.groupModel.updateOne({ _id: groupId }, { $set: { status: GroupStatus.PENDING } }).exec();

    return request;
  }

  private async onMemberAdditionApproved(event: WorkflowApprovedEvent): Promise<void> {
    const payload = event.payload as unknown as GroupMembershipAddPayload;

    // Leadership roles are only assigned at initial creation or via
    // reassignLeadershipRole — never via a later addition. Explicit ObjectId
    // casts — see onGroupCreationApproved's comment.
    const created = await this.groupMembershipModel.create({
      groupId: new Types.ObjectId(payload.groupId),
      customerId: new Types.ObjectId(payload.customerId),
      role: GroupMemberRole.MEMBER,
      joinedAt: new Date(),
      leftAt: null,
      addedBy: new Types.ObjectId(event.initiatedBy),
    });

    await this.workflowEngineService.linkEntity(event.workflowRequestId, created._id.toString());

    // The addition is now genuinely settled — the group comes back off
    // PENDING (see initiateMemberAddition's own comment).
    await this.groupModel.updateOne({ _id: payload.groupId }, { $set: { status: GroupStatus.ACTIVE } }).exec();

    await this.auditService.record({
      actorId: event.initiatedBy,
      action: 'GROUP_MEMBER_ADDED',
      entityType: 'GROUP_MEMBERSHIP',
      entityId: created._id.toString(),
      after: {
        groupId: payload.groupId,
        customerId: payload.customerId,
        role: GroupMemberRole.MEMBER,
      },
      metadata: { workflowRequestId: event.workflowRequestId },
    });
  }

  /**
   * A pending addition that never went through (rejected, or abandoned via
   * cancel/delete) undoes the one side effect initiateMemberAddition had —
   * the group goes back to ACTIVE, nothing else about it changed. Shared by
   * the REJECTED/CANCELLED/DELETED dispatchers below; a plain `updateOne`
   * (not `findActiveGroupOrThrow`) since the group is expected to be
   * PENDING here, not ACTIVE — and is harmlessly idempotent if called twice
   * (e.g. deleting an already-REJECTED request).
   */
  private async revertGroupFromPendingAddition(groupId: string): Promise<void> {
    await this.groupModel
      .updateOne({ _id: groupId, status: GroupStatus.PENDING }, { $set: { status: GroupStatus.ACTIVE } })
      .exec();
  }

  // ---------------------------------------------------------------------------
  // Member removal
  // ---------------------------------------------------------------------------

  async initiateMemberRemoval(
    groupId: string,
    customerId: string,
    reason: string,
    initiatedBy: string,
  ): Promise<WorkflowRequestDocument> {
    const group = await this.findActiveGroupOrThrow(groupId);

    const activeMembership = await this.groupMembershipModel
      .findOne({
        groupId: new Types.ObjectId(groupId),
        customerId: new Types.ObjectId(customerId),
        leftAt: null,
      })
      .exec();
    if (!activeMembership) {
      throw new NotFoundException(
        `Customer ${customerId} has no active membership in group ${groupId}`,
      );
    }

    // The "no pending loan" guard — see LoanStatusPort's doc comment. Checked
    // before ever creating a WorkflowRequest, same principle as the >=3
    // members check on creation.
    const hasPendingLoan = await this.loanStatusPort.hasPendingLoan(customerId);
    if (hasPendingLoan) {
      throw new ConflictException(
        `Customer ${customerId} has a pending loan and cannot be removed from group ${groupId}`,
      );
    }

    const payload: GroupMembershipRemovePayload = { groupId, customerId, reason };

    return this.workflowEngineService.initiate({
      entityType: WorkflowEntityType.GROUP_MEMBERSHIP,
      action: GROUP_MEMBERSHIP_REMOVE_ACTION,
      payload: payload as unknown as Record<string, unknown>,
      initiatedBy,
      branchId: group.branchId.toString(),
    });
  }

  private async onMemberRemovalApproved(event: WorkflowApprovedEvent): Promise<void> {
    const payload = event.payload as unknown as GroupMembershipRemovePayload;

    // Never hard-delete — set leftAt/removedBy/removalReason. If the removed
    // member held a leadership role, it's left vacant on purpose: no
    // confirmed succession policy exists, so no automatic promotion happens
    // here. See reassignLeadershipRole for the deliberate, explicit way to
    // fill a vacancy.
    const updated = await this.groupMembershipModel
      .findOneAndUpdate(
        {
          groupId: new Types.ObjectId(payload.groupId),
          customerId: new Types.ObjectId(payload.customerId),
          leftAt: null,
        },
        {
          $set: {
            leftAt: new Date(),
            removedBy: new Types.ObjectId(event.initiatedBy),
            removalReason: payload.reason,
          },
        },
        { new: true },
      )
      .exec();

    if (!updated) {
      throw new Error(
        `No active membership found for customer ${payload.customerId} in group ${payload.groupId} at GROUP_MEMBERSHIP/REMOVE approval time`,
      );
    }

    await this.workflowEngineService.linkEntity(event.workflowRequestId, updated._id.toString());

    await this.auditService.record({
      actorId: event.initiatedBy,
      action: 'GROUP_MEMBER_REMOVED',
      entityType: 'GROUP_MEMBERSHIP',
      entityId: updated._id.toString(),
      after: { groupId: payload.groupId, customerId: payload.customerId },
      metadata: { workflowRequestId: event.workflowRequestId, reason: payload.reason },
    });
  }

  // ---------------------------------------------------------------------------
  // Leadership reassignment (Admin/SuperAdmin only — fills a vacant role)
  // ---------------------------------------------------------------------------

  /**
   * Deliberately does NOT require `newCustomerId` to already be an active
   * MEMBER of the group — the brief doesn't say either way, and forcing a
   * separate "add as member" step before this already Admin/SuperAdmin-gated,
   * workflow-approved action seemed like unnecessary friction. On approval,
   * if `newCustomerId` already has an active membership (any role), that row
   * is closed and a new one is opened with the leadership role — same
   * close-old/open-new convention as BranchManagerAssignmentService
   * (branches/branch-manager-assignment.service.ts) — otherwise a fresh
   * membership row is created directly. Flagged in PHASE_6_NOTES.md.
   */
  async reassignLeadershipRole(
    groupId: string,
    role: GroupMemberRole,
    newCustomerId: string,
    initiatedBy: string,
  ): Promise<WorkflowRequestDocument> {
    if (!LEADERSHIP_ROLES.includes(role)) {
      throw new BadRequestException(
        `${role} is not a leadership role — only ${LEADERSHIP_ROLES.join(', ')} can be reassigned this way`,
      );
    }

    const group = await this.findActiveGroupOrThrow(groupId);

    // Belt-and-braces: this same guarantee is also enforced at the DB level
    // by GroupMembershipSchema's partial unique indexes, so a concurrent
    // double-reassign can't slip through even if this read-then-write raced
    // (same principle as BranchManagerAssignmentService.assignManager).
    const currentHolderExists = await this.groupMembershipModel.exists({
      groupId: new Types.ObjectId(groupId),
      role,
      leftAt: null,
    });
    if (currentHolderExists) {
      throw new ConflictException(
        `Group ${groupId} already has an active ${role} — remove them first before reassigning`,
      );
    }

    const customerExists = await this.customerModel.exists({ _id: newCustomerId });
    if (!customerExists) {
      throw new BadRequestException(`Customer ${newCustomerId} does not exist`);
    }

    const payload: GroupLeadershipReassignPayload = { groupId, role, newCustomerId };

    return this.workflowEngineService.initiate({
      entityType: WorkflowEntityType.GROUP,
      action: GROUP_REASSIGN_LEADERSHIP_ACTION,
      payload: payload as unknown as Record<string, unknown>,
      initiatedBy,
      branchId: group.branchId.toString(),
    });
  }

  private async onLeadershipReassignmentApproved(event: WorkflowApprovedEvent): Promise<void> {
    const payload = event.payload as unknown as GroupLeadershipReassignPayload;
    const now = new Date();

    const existingActiveMembership = await this.groupMembershipModel
      .findOne({
        groupId: new Types.ObjectId(payload.groupId),
        customerId: new Types.ObjectId(payload.newCustomerId),
        leftAt: null,
      })
      .exec();

    if (existingActiveMembership) {
      await this.groupMembershipModel
        .updateOne(
          { _id: existingActiveMembership._id },
          {
            $set: {
              leftAt: now,
              removedBy: new Types.ObjectId(event.initiatedBy),
              removalReason: `Reassigned to ${payload.role}`,
            },
          },
        )
        .exec();
    }

    const created = await this.groupMembershipModel.create({
      groupId: new Types.ObjectId(payload.groupId),
      customerId: new Types.ObjectId(payload.newCustomerId),
      role: payload.role,
      joinedAt: now,
      leftAt: null,
      addedBy: new Types.ObjectId(event.initiatedBy),
    });

    await this.workflowEngineService.linkEntity(event.workflowRequestId, created._id.toString());

    await this.auditService.record({
      actorId: event.initiatedBy,
      action: 'GROUP_LEADERSHIP_REASSIGNED',
      entityType: 'GROUP',
      entityId: payload.groupId,
      after: { role: payload.role, newCustomerId: payload.newCustomerId },
      metadata: {
        workflowRequestId: event.workflowRequestId,
        previousMembershipId: existingActiveMembership?._id.toString() ?? null,
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Workflow event dispatch
  // ---------------------------------------------------------------------------

  // GROUP_MEMBERSHIP/ADD is the one exception to "nothing is ever persisted
  // before approval" — initiateMemberAddition flips the target group to
  // PENDING right at submission (see its own comment), so unlike
  // GROUP/CREATE, GROUP_MEMBERSHIP/REMOVE, and GROUP/REASSIGN_LEADERSHIP
  // (which still have nothing to clean up on rejection, same reasoning as
  // identity/staff.service.ts), this one DOES need REJECTED/CANCELLED/
  // DELETED handlers to undo that one side effect.
  @OnEvent(WORKFLOW_REJECTED_EVENT)
  async handleWorkflowRejected(event: WorkflowRejectedEvent): Promise<void> {
    if (event.entityType === WorkflowEntityType.GROUP_MEMBERSHIP && event.action === GROUP_MEMBERSHIP_ADD_ACTION) {
      const payload = event.payload as unknown as GroupMembershipAddPayload;
      await this.revertGroupFromPendingAddition(payload.groupId);
    }
  }

  @OnEvent(WORKFLOW_CANCELLED_EVENT)
  async handleWorkflowCancelled(event: WorkflowCancelledEvent): Promise<void> {
    if (event.entityType === WorkflowEntityType.GROUP_MEMBERSHIP && event.action === GROUP_MEMBERSHIP_ADD_ACTION) {
      const payload = event.payload as unknown as GroupMembershipAddPayload;
      await this.revertGroupFromPendingAddition(payload.groupId);
    }
  }

  @OnEvent(WORKFLOW_DELETED_EVENT)
  async handleWorkflowDeleted(event: WorkflowDeletedEvent): Promise<void> {
    if (event.entityType === WorkflowEntityType.GROUP_MEMBERSHIP && event.action === GROUP_MEMBERSHIP_ADD_ACTION) {
      const payload = event.payload as unknown as GroupMembershipAddPayload;
      await this.revertGroupFromPendingAddition(payload.groupId);
    }
  }

  @OnEvent(WORKFLOW_APPROVED_EVENT)
  async handleWorkflowApproved(event: WorkflowApprovedEvent): Promise<void> {
    const entityType = event.entityType as WorkflowEntityType;

    if (entityType === WorkflowEntityType.GROUP && event.action === GROUP_CREATE_ACTION) {
      await this.onGroupCreationApproved(event);
      return;
    }
    if (
      entityType === WorkflowEntityType.GROUP &&
      event.action === GROUP_REASSIGN_LEADERSHIP_ACTION
    ) {
      await this.onLeadershipReassignmentApproved(event);
      return;
    }
    if (
      entityType === WorkflowEntityType.GROUP_MEMBERSHIP &&
      event.action === GROUP_MEMBERSHIP_ADD_ACTION
    ) {
      await this.onMemberAdditionApproved(event);
      return;
    }
    if (
      entityType === WorkflowEntityType.GROUP_MEMBERSHIP &&
      event.action === GROUP_MEMBERSHIP_REMOVE_ACTION
    ) {
      await this.onMemberRemovalApproved(event);
    }
  }

  // ---------------------------------------------------------------------------
  // Reads / eligibility (Phase 8 depends on these directly)
  // ---------------------------------------------------------------------------

  async findById(groupId: string): Promise<GroupDocument> {
    return this.findGroupOrThrow(groupId);
  }

  /**
   * Row-level scoping mirrors CustomerService.findAllForActor exactly (see
   * that method's own doc comment): ADMIN/SUPERADMIN/APPROVER see every
   * non-rejected group (optionally narrowed by `filter.branchId`); a MANAGER
   * only ever sees their own branch's groups; anyone else (MARKETER) only
   * sees groups they themselves created. `status !== REJECTED` rather than
   * `=== ACTIVE`: a PENDING group (a member addition currently under
   * review — see GroupStatus's own doc comment) is a real, existing group
   * that should stay visible everywhere it already was, not vanish from
   * lists/lookups the moment a member addition is proposed. REJECTED is
   * excluded on the same "never actually stored" grounds as GroupStatus's
   * own doc comment (a rejected creation never produces a Group document at
   * all) — kept here defensively rather than assumed away.
   */
  async findAllForActor(filter: FindGroupsFilter, viewer: GroupViewerContext): Promise<GroupDocument[]> {
    const query: Record<string, unknown> = { status: { $ne: GroupStatus.REJECTED } };

    if (viewer.role === StaffRole.MANAGER) {
      if (!viewer.branchId) {
        return [];
      }
      query.branchId = new Types.ObjectId(viewer.branchId);
    } else if (
      viewer.role !== StaffRole.ADMIN &&
      viewer.role !== StaffRole.SUPERADMIN &&
      viewer.role !== StaffRole.APPROVER
    ) {
      query.createdBy = new Types.ObjectId(viewer.staffId);
    } else if (filter.branchId) {
      query.branchId = new Types.ObjectId(filter.branchId);
    }

    return this.groupModel.find(query).sort({ createdAt: -1 }).exec();
  }

  /**
   * `branchId -> branch name`, for GroupsController to attach as
   * `branchName` on its list/single responses — same reasoning as
   * CustomerService.resolveBranchNames: the frontend's `branches` redux
   * lookup is only ever populated for org:manage-capable roles (see
   * lookupsSlice.ts), so it's empty for a MARKETER/MANAGER and any
   * client-side `branches.find(...)` cross-reference silently falls back to
   * showing the raw branchId for them. Resolving server-side instead means
   * every role sees the actual branch name.
   */
  async resolveBranchNames(branchIds: string[]): Promise<Map<string, string>> {
    const uniqueIds = [...new Set(branchIds)];
    if (uniqueIds.length === 0) {
      return new Map();
    }
    const branches = await this.branchModel.find({ _id: { $in: uniqueIds } }).exec();
    return new Map(branches.map((b) => [b._id.toString(), b.name]));
  }

  // ---------------------------------------------------------------------------
  // Edit privilege — same one-shot request/grant/consume shape as
  // CustomerService's own (see EditPrivilege's doc comment on
  // customers/schemas/customer.schema.ts), minus the signature requirement:
  // there's no group-level equivalent of "a photo of the customer's
  // signature" for editing a group's own free-text intake fields.
  // ---------------------------------------------------------------------------

  private assertIsCreator(group: GroupDocument, actorId: string): void {
    if (group.createdBy.toString() !== actorId) {
      throw new ForbiddenException('Only the staff member who created this group may update it');
    }
  }

  async requestEditPrivilege(groupId: string, reason: string, requestedBy: string): Promise<GroupDocument> {
    const group = await this.findActiveGroupOrThrow(groupId);
    this.assertIsCreator(group, requestedBy);
    if (group.editPrivilege.status === GroupEditPrivilegeStatus.PENDING) {
      throw new ConflictException('An edit privilege request is already pending for this group');
    }

    group.editPrivilege = {
      status: GroupEditPrivilegeStatus.PENDING,
      reason,
      requestedBy: new Types.ObjectId(requestedBy),
      requestedAt: new Date(),
      decidedBy: null,
      decidedAt: null,
      decisionComment: null,
    };
    await group.save();

    await this.auditService.record({
      actorId: requestedBy,
      action: 'GROUP_EDIT_PRIVILEGE_REQUESTED',
      entityType: 'GROUP',
      entityId: groupId,
      after: { reason },
    });

    return group;
  }

  async decideEditPrivilege(
    groupId: string,
    approve: boolean,
    comment: string | undefined,
    decidedBy: string,
  ): Promise<GroupDocument> {
    const group = await this.findActiveGroupOrThrow(groupId);
    if (group.editPrivilege.status !== GroupEditPrivilegeStatus.PENDING) {
      throw new ConflictException(`Group ${groupId} has no pending edit privilege request`);
    }

    group.editPrivilege.status = approve ? GroupEditPrivilegeStatus.GRANTED : GroupEditPrivilegeStatus.REJECTED;
    group.editPrivilege.decidedBy = new Types.ObjectId(decidedBy);
    group.editPrivilege.decidedAt = new Date();
    group.editPrivilege.decisionComment = comment?.trim() || null;
    await group.save();

    await this.auditService.record({
      actorId: decidedBy,
      action: approve ? 'GROUP_EDIT_PRIVILEGE_GRANTED' : 'GROUP_EDIT_PRIVILEGE_REJECTED',
      entityType: 'GROUP',
      entityId: groupId,
      metadata: { comment: comment?.trim() || null },
    });

    return group;
  }

  /**
   * Creator only, and only once an Admin/SuperAdmin/Approver has granted a
   * pending request (see requestEditPrivilege/decideEditPrivilege above) —
   * same one-shot "consumed on use" rule as CustomerService.updateOnboardingDetails.
   * Deliberately limited to the same free-text/informational fields the
   * onboarding wizard collects (see Group schema's own doc comment) — `name`
   * and `branchId` are not editable here, matching how a Customer's own
   * branchId/name are never touched by updateOnboardingDetails either.
   */
  async updateGroupDetails(
    groupId: string,
    updatedBy: string,
    changes: {
      proposedLeaderName?: string | null;
      meetingDay?: string | null;
      meetingLocation?: string | null;
      expectedMemberCount?: number | null;
    },
  ): Promise<GroupDocument> {
    const group = await this.findActiveGroupOrThrow(groupId);
    this.assertIsCreator(group, updatedBy);
    if (group.editPrivilege.status !== GroupEditPrivilegeStatus.GRANTED) {
      throw new ConflictException(
        `Group ${groupId} is already approved — request edit privilege before updating its details`,
      );
    }

    if (changes.proposedLeaderName !== undefined) {
      group.proposedLeaderName = changes.proposedLeaderName;
    }
    if (changes.meetingDay !== undefined) {
      group.meetingDay = changes.meetingDay;
    }
    if (changes.meetingLocation !== undefined) {
      group.meetingLocation = changes.meetingLocation;
    }
    if (changes.expectedMemberCount !== undefined) {
      group.expectedMemberCount = changes.expectedMemberCount;
    }
    // Consumed — a fresh request is needed for any subsequent edit, same
    // one-shot spirit as Customer.editPrivilege.
    group.editPrivilege.status = GroupEditPrivilegeStatus.NONE;
    await group.save();

    await this.auditService.record({
      actorId: updatedBy,
      action: 'GROUP_DETAILS_UPDATED',
      entityType: 'GROUP',
      entityId: groupId,
      after: changes,
    });

    return group;
  }

  /** Existence only — a PENDING group (a member addition currently under review, see GroupStatus's own doc comment) is still fully readable, just not writable. */
  private async findGroupOrThrow(groupId: string): Promise<GroupDocument> {
    const group = await this.groupModel.findById(groupId).exec();
    if (!group) {
      throw new NotFoundException(`Group ${groupId} not found`);
    }
    return group;
  }

  /** Every write path's own guard — a PENDING group accepts no further mutation until its one pending member addition resolves. See GroupStatus's own doc comment. */
  private async findActiveGroupOrThrow(groupId: string): Promise<GroupDocument> {
    const group = await this.findGroupOrThrow(groupId);
    if (group.status !== GroupStatus.ACTIVE) {
      throw new ConflictException(
        `Group ${groupId} is ${group.status}, not ACTIVE` +
          (group.status === GroupStatus.PENDING
            ? ' — it has a member addition awaiting review/approval'
            : ''),
      );
    }
    return group;
  }

  async getActiveMembers(groupId: string): Promise<GroupMembershipDocument[]> {
    return this.groupMembershipModel
      .find({ groupId: new Types.ObjectId(groupId), leftAt: null })
      .exec();
  }

  async getLeadership(groupId: string): Promise<GroupLeadership> {
    const activeLeaders = await this.groupMembershipModel
      .find({
        groupId: new Types.ObjectId(groupId),
        leftAt: null,
        role: { $in: LEADERSHIP_ROLES },
      })
      .exec();

    return {
      head: activeLeaders.find((m) => m.role === GroupMemberRole.GROUP_HEAD) ?? undefined,
      assistant:
        activeLeaders.find((m) => m.role === GroupMemberRole.GROUP_HEAD_ASSISTANT) ?? undefined,
      coordinator: activeLeaders.find((m) => m.role === GroupMemberRole.COORDINATOR) ?? undefined,
    };
  }

  /**
   * ASSUMPTION (flagged, see PHASE_6_NOTES.md): the brief only states a
   * minimum of 3 members *at creation*. A group that has since dropped below
   * 3 active members via removals is treated as ineligible for a *fresh*
   * loan application too — a group under the stated minimum for whatever
   * reason doesn't seem like it should be able to originate new lending.
   */
  async isEligibleForLoanApplication(groupId: string): Promise<GroupLoanEligibilityResult> {
    const group = await this.findGroupOrThrow(groupId);
    const activeMembers = await this.getActiveMembers(groupId);
    const ineligibleMembers: IneligibleMember[] = [];

    // A PENDING group (a member addition currently under review — see
    // GroupStatus's own doc comment) reports gracefully here rather than
    // throwing, same as every other reason below — lets the frontend show
    // *why* a loan can't be raised right now instead of a raw error.
    if (group.status !== GroupStatus.ACTIVE) {
      ineligibleMembers.push({
        customerId: null,
        reason: `Group is ${group.status}, not ACTIVE — it must be fully approved before a loan can be raised`,
      });
    }

    if (activeMembers.length < 3) {
      ineligibleMembers.push({
        customerId: null,
        reason: `Group has only ${activeMembers.length} active member(s) — minimum 3 required`,
      });
    }

    for (const member of activeMembers) {
      const customerId = member.customerId.toString();
      const eligible = await this.customerService.isLoanEligible(customerId);
      if (!eligible) {
        ineligibleMembers.push({ customerId, reason: 'KYC not complete' });
      }
    }

    return { eligible: ineligibleMembers.length === 0, ineligibleMembers };
  }
}

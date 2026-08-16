import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, Types } from 'mongoose';

import { GroupMemberRole, GroupStatus, LEADERSHIP_ROLES } from '../../common/enums/group.enums';
import { WorkflowEntityType } from '../../common/enums/workflow.enums';
import { AuditService } from '../../platform/audit/audit.service';
import { approveCapability, reviewCapability } from '../../platform/rbac/constants/capabilities';
import {
  WORKFLOW_APPROVED_EVENT,
  WorkflowApprovedEvent,
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
import { Group, GroupDocument } from './schemas/group.schema';

const GROUP_CREATE_ACTION = 'CREATE';
const GROUP_REASSIGN_LEADERSHIP_ACTION = 'REASSIGN_LEADERSHIP';
const GROUP_MEMBERSHIP_ADD_ACTION = 'ADD';
const GROUP_MEMBERSHIP_REMOVE_ACTION = 'REMOVE';

interface GroupCreationPayload {
  name: string;
  branchId: string;
  proposedMemberCustomerIds: string[];
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

    await this.workflowEngineService.registerChainConfig({
      entityType: WorkflowEntityType.GROUP_MEMBERSHIP,
      action: GROUP_MEMBERSHIP_ADD_ACTION,
      restartOnReturn: true,
      steps: [
        { order: 0, requiredCapability: reviewCapability(WorkflowEntityType.GROUP_MEMBERSHIP) },
        { order: 1, requiredCapability: approveCapability(WorkflowEntityType.GROUP_MEMBERSHIP) },
      ],
    });

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

  async initiateCreation(
    dto: InitiateGroupCreationDto,
    initiatedBy: string,
  ): Promise<WorkflowRequestDocument> {
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
    // (isEligibleForLoanApplication), not group membership itself. See the brief.

    const payload: GroupCreationPayload = {
      name: dto.name,
      branchId: dto.branchId,
      proposedMemberCustomerIds: dto.proposedMemberCustomerIds,
    };

    return this.workflowEngineService.initiate({
      entityType: WorkflowEntityType.GROUP,
      action: GROUP_CREATE_ACTION,
      payload: payload as unknown as Record<string, unknown>,
      initiatedBy,
      branchId: dto.branchId,
    });
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

    const payload: GroupMembershipAddPayload = { groupId, customerId: dto.customerId };

    return this.workflowEngineService.initiate({
      entityType: WorkflowEntityType.GROUP_MEMBERSHIP,
      action: GROUP_MEMBERSHIP_ADD_ACTION,
      payload: payload as unknown as Record<string, unknown>,
      initiatedBy,
      branchId: group.branchId.toString(),
    });
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

  // No `@OnEvent(WORKFLOW_REJECTED_EVENT)` handler — nothing is ever
  // persisted before approval for any of GROUP/CREATE, GROUP_MEMBERSHIP/ADD,
  // GROUP_MEMBERSHIP/REMOVE, or GROUP/REASSIGN_LEADERSHIP, so there's
  // genuinely nothing to clean up on rejection (same reasoning as
  // identity/staff.service.ts, which also has no rejection handler).
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
    return this.findActiveGroupOrThrow(groupId);
  }

  private async findActiveGroupOrThrow(groupId: string): Promise<GroupDocument> {
    const group = await this.groupModel.findById(groupId).exec();
    if (!group) {
      throw new NotFoundException(`Group ${groupId} not found`);
    }
    if (group.status !== GroupStatus.ACTIVE) {
      throw new ConflictException(`Group ${groupId} is not ACTIVE`);
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
    await this.findActiveGroupOrThrow(groupId);
    const activeMembers = await this.getActiveMembers(groupId);
    const ineligibleMembers: IneligibleMember[] = [];

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

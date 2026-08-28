import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { WorkflowStatus, WorkflowStepAction } from '../../common/enums/workflow.enums';
import { AuditService } from '../audit/audit.service';
import {
  WORKFLOW_APPROVED_EVENT,
  WORKFLOW_CANCELLED_EVENT,
  WORKFLOW_DELETED_EVENT,
  WORKFLOW_REJECTED_EVENT,
  WORKFLOW_RESUBMITTED_EVENT,
  WORKFLOW_RETURNED_EVENT,
  WorkflowApprovedEvent,
  WorkflowCancelledEvent,
  WorkflowDeletedEvent,
  WorkflowRejectedEvent,
  WorkflowResubmittedEvent,
  WorkflowReturnedEvent,
} from './events/workflow-engine.events';
import {
  ActingStaff,
  ActOnWorkflowInput,
  InitiateWorkflowInput,
  RegisterChainConfigInput,
  ResubmitWorkflowInput,
  UpdatePendingPayloadInput,
} from './interfaces/workflow-engine.interfaces';
import {
  WorkflowChainConfig,
  WorkflowChainConfigDocument,
} from './schemas/workflow-chain-config.schema';
import {
  WorkflowRequest,
  WorkflowRequestDocument,
  WorkflowStepRecord,
} from './schemas/workflow-request.schema';

const ACTIONABLE_STATUSES: readonly WorkflowStatus[] = [
  WorkflowStatus.PENDING_REVIEW,
  WorkflowStatus.PENDING_APPROVAL,
];

/**
 * A domain-specific check that must pass before a request is allowed to
 * make its *final* transition to APPROVED — throw to block it. Registered
 * per (entityType, action) via `registerPreApprovalValidator`, called
 * synchronously (plain await, not the event emitter) right before the
 * commit, so a thrown exception propagates normally to the approver as an
 * HTTP error and nothing is persisted. Deliberately NOT wired through
 * `@nestjs/event-emitter`'s `emitAsync` — that mechanism *logs and
 * swallows* exceptions thrown inside an `@OnEvent` listener rather than
 * propagating them (a real, previously-discovered class of "invisible
 * failure" — see BranchesService's own duplicate-branch-code doc comment
 * for the first time this bit us), which would make a blocked approval
 * silently look like it succeeded. `WorkflowEngineService` still has zero
 * compile-time dependency on any domain module — this is an opaque
 * function reference a domain module hands in at `onModuleInit`, the exact
 * same extensibility shape `registerChainConfig` already uses.
 *
 * `actor` param added for the Initiator/Authorizer RBAC feature — the acting
 * approver, exactly as passed to `act()` (see `ActingStaff.role`'s own doc
 * comment for why `role` is optional there). Backward-compatible: an
 * existing validator that only reads `request` is unaffected by the extra
 * argument.
 */
export type PreApprovalValidator = (
  request: WorkflowRequestDocument,
  actor: ActingStaff,
) => Promise<void> | void;

@Injectable()
export class WorkflowEngineService {
  private readonly preApprovalValidators = new Map<string, PreApprovalValidator>();
  constructor(
    @InjectModel(WorkflowChainConfig.name)
    private readonly chainConfigModel: Model<WorkflowChainConfigDocument>,
    @InjectModel(WorkflowRequest.name)
    private readonly workflowRequestModel: Model<WorkflowRequestDocument>,
    private readonly auditService: AuditService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  // ---------------------------------------------------------------------------
  // Chain configuration
  // ---------------------------------------------------------------------------

  /**
   * Idempotent — safe to call on every module init. Only inserts when no chain
   * is registered yet for (entityType, action); never overwrites an existing
   * one, so an Admin's later edits (once a chain-editing endpoint exists) survive
   * redeploys, same principle as RbacService's capability seeding.
   */
  async registerChainConfig(
    config: RegisterChainConfigInput,
  ): Promise<WorkflowChainConfigDocument> {
    this.validateSteps(config.steps);

    const doc = await this.chainConfigModel
      .findOneAndUpdate(
        { entityType: config.entityType, action: config.action },
        {
          $setOnInsert: {
            entityType: config.entityType,
            action: config.action,
            restartOnReturn: config.restartOnReturn,
            steps: config.steps,
            isActive: true,
          },
        },
        { upsert: true, new: true },
      )
      .exec();

    if (!doc) {
      throw new Error(
        `Failed to upsert WorkflowChainConfig for ${config.entityType}:${config.action}`,
      );
    }
    return doc;
  }

  /** See PreApprovalValidator's own doc comment. Called by a domain module at `onModuleInit`, same shape as `registerChainConfig`. */
  registerPreApprovalValidator(
    entityType: string,
    action: string,
    validator: PreApprovalValidator,
  ): void {
    this.preApprovalValidators.set(`${entityType}:${action}`, validator);
  }

  /**
   * Unlike `registerChainConfig` (idempotent, insert-only — `$setOnInsert`
   * protects an Admin's later manual chain edits from being clobbered on
   * every boot), this ALWAYS overwrites the stored `steps`/`restartOnReturn`
   * for `(entityType, action)`, creating the config if it doesn't exist yet.
   * For a chain whose *shape* is itself admin-configurable data living in a
   * domain document (e.g. `LoanProduct.approvalChainSteps` — see
   * `modules/loan-products/loan-products.service.ts`, PHASE_7_NOTES.md),
   * there's no independent "manual edit" to protect: the domain document
   * already is the source of truth, and re-deriving the chain config from
   * it on every approved product create/update is exactly the intended
   * behavior, not a clobber risk.
   *
   * Existing `WorkflowRequest`s are unaffected either way — `initiate()`
   * snapshots `steps` onto the request at creation time (see below), so a
   * request already in flight keeps acting on whatever chain shape was
   * current when it started, never the live chain config.
   */
  async replaceChainConfig(config: RegisterChainConfigInput): Promise<WorkflowChainConfigDocument> {
    this.validateSteps(config.steps);

    const doc = await this.chainConfigModel
      .findOneAndUpdate(
        { entityType: config.entityType, action: config.action },
        {
          $set: {
            entityType: config.entityType,
            action: config.action,
            restartOnReturn: config.restartOnReturn,
            steps: config.steps,
            isActive: true,
          },
        },
        { upsert: true, new: true },
      )
      .exec();

    if (!doc) {
      throw new Error(
        `Failed to upsert (replace) WorkflowChainConfig for ${config.entityType}:${config.action}`,
      );
    }
    return doc;
  }

  private validateSteps(steps: { order: number }[]): void {
    if (steps.length === 0) {
      throw new BadRequestException('A workflow chain must have at least one step');
    }
    const orders = [...steps].map((s) => s.order).sort((a, b) => a - b);
    const expected = orders.map((_, i) => i);
    const isContiguousFromZero = orders.every((order, i) => order === expected[i]);
    if (!isContiguousFromZero) {
      throw new BadRequestException(
        'Workflow chain steps must have contiguous zero-based `order` values (0, 1, 2, ...)',
      );
    }
  }

  private computeStatus(stepIndex: number, totalSteps: number): WorkflowStatus {
    return stepIndex === totalSteps - 1
      ? WorkflowStatus.PENDING_APPROVAL
      : WorkflowStatus.PENDING_REVIEW;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async initiate(input: InitiateWorkflowInput): Promise<WorkflowRequestDocument> {
    const chain = await this.chainConfigModel
      .findOne({ entityType: input.entityType, action: input.action, isActive: true })
      .exec();

    if (!chain) {
      throw new NotFoundException(
        `No active workflow chain registered for ${input.entityType}:${input.action}`,
      );
    }

    const steps: WorkflowStepRecord[] = chain.steps
      .slice()
      .sort((a, b) => a.order - b.order)
      .map((step) => ({
        order: step.order,
        requiredCapability: step.requiredCapability,
        actedBy: null,
        action: null,
        comment: null,
        actedAt: null,
      }));

    const now = new Date();
    const created = await this.workflowRequestModel.create({
      entityType: input.entityType,
      // See InitiateWorkflowInput.entityId's doc comment — null unless a caller
      // (Phase 8's Loan) already created its entity before initiating.
      entityId: input.entityId ?? null,
      action: input.action,
      status: this.computeStatus(0, steps.length),
      chainConfigRef: `${input.entityType}:${input.action}`,
      steps,
      currentStepIndex: 0,
      payloadHistory: [
        { payload: input.payload, submittedBy: input.initiatedBy, submittedAt: now },
      ],
      initiatedBy: input.initiatedBy,
      branchId: input.branchId ?? null,
    });

    await this.auditService.record({
      actorId: input.initiatedBy,
      action: 'WORKFLOW_REQUEST_INITIATED',
      entityType: 'WORKFLOW_REQUEST',
      entityId: created._id.toString(),
      after: { status: created.status, entityType: input.entityType, action: input.action },
      metadata: { branchId: input.branchId ?? null },
    });

    return created;
  }

  async act(input: ActOnWorkflowInput): Promise<WorkflowRequestDocument> {
    const { workflowRequestId, actor, action, comment } = input;

    const current = await this.workflowRequestModel.findById(workflowRequestId).exec();
    if (!current) {
      throw new NotFoundException(`WorkflowRequest ${workflowRequestId} not found`);
    }

    if (!ACTIONABLE_STATUSES.includes(current.status)) {
      throw new ConflictException(
        `WorkflowRequest ${workflowRequestId} is in status ${current.status} and cannot be acted on`,
      );
    }

    // A maker can never review or approve their own request.
    if (actor.staffId === current.initiatedBy) {
      throw new ForbiddenException('The maker of a request cannot act on their own request');
    }

    // The same person cannot act twice in one chain.
    if (current.steps.some((step) => step.actedBy === actor.staffId)) {
      throw new ForbiddenException('This actor has already acted on this request');
    }

    const stepIndex = current.currentStepIndex;
    const currentStep = current.steps[stepIndex];
    if (!currentStep) {
      throw new Error(
        `WorkflowRequest ${workflowRequestId} has no step at currentStepIndex ${stepIndex} — data corruption`,
      );
    }

    if (!actor.capabilities.includes(currentStep.requiredCapability)) {
      throw new ForbiddenException(
        `Actor lacks the required capability for this step: ${currentStep.requiredCapability}`,
      );
    }

    if ((action === WorkflowStepAction.RETURNED || action === WorkflowStepAction.REJECTED) && !comment) {
      throw new BadRequestException('A comment is required when rejecting or returning a request');
    }

    const totalSteps = current.steps.length;
    let newStatus: WorkflowStatus;
    let newStepIndex = stepIndex;

    if (action === WorkflowStepAction.APPROVED) {
      const isLastStep = stepIndex === totalSteps - 1;
      newStepIndex = isLastStep ? stepIndex : stepIndex + 1;
      newStatus = isLastStep
        ? WorkflowStatus.APPROVED
        : this.computeStatus(newStepIndex, totalSteps);

      // Only at the *final* step — an intermediate review passing through
      // never triggers this (a Manager's "mark as reviewed" is unaffected).
      if (isLastStep) {
        const validator = this.preApprovalValidators.get(`${current.entityType}:${current.action}`);
        if (validator) {
          await validator(current, actor);
        }
      }
    } else if (action === WorkflowStepAction.REJECTED) {
      newStatus = WorkflowStatus.REJECTED;
    } else {
      newStatus = WorkflowStatus.RETURNED_TO_MAKER;
    }

    const updated = await this.workflowRequestModel
      .findOneAndUpdate(
        { _id: workflowRequestId, status: current.status, currentStepIndex: stepIndex },
        {
          $set: {
            'steps.$[elem].actedBy': actor.staffId,
            'steps.$[elem].action': action,
            'steps.$[elem].comment': comment ?? null,
            'steps.$[elem].actedAt': new Date(),
            status: newStatus,
            currentStepIndex: newStepIndex,
          },
        },
        { new: true, arrayFilters: [{ 'elem.order': stepIndex }] },
      )
      .exec();

    if (!updated) {
      throw new ConflictException(
        `WorkflowRequest ${workflowRequestId} was concurrently modified — retry the action`,
      );
    }

    await this.auditService.record({
      actorId: actor.staffId,
      action: `WORKFLOW_REQUEST_${action}`,
      entityType: 'WORKFLOW_REQUEST',
      entityId: workflowRequestId,
      before: { status: current.status, currentStepIndex: stepIndex },
      after: { status: newStatus, currentStepIndex: newStepIndex },
      metadata: { comment: comment ?? null, stepOrder: stepIndex },
    });

    const eventBase = {
      workflowRequestId,
      entityType: updated.entityType,
      entityId: updated.entityId,
      action: updated.action,
      branchId: updated.branchId,
    };

    // emitAsync + await, not emit — callers of `act()` (a controller handling
    // an approval request, say) must be able to trust that a domain module's
    // `workflow.approved` reaction (e.g. "create the Staff record") has
    // actually finished before `act()` resolves, not fire-and-forget in the
    // background. Bug found and fixed while wiring Phase 3's first real
    // consumer — see PHASE_3_NOTES.md.
    if (newStatus === WorkflowStatus.APPROVED) {
      const latestPayload = updated.payloadHistory[updated.payloadHistory.length - 1];
      const approvedEvent: WorkflowApprovedEvent = {
        ...eventBase,
        payload: latestPayload?.payload ?? {},
        initiatedBy: updated.initiatedBy,
        approvedBy: actor.staffId,
      };
      await this.eventEmitter.emitAsync(WORKFLOW_APPROVED_EVENT, approvedEvent);
    } else if (action === WorkflowStepAction.REJECTED) {
      const latestPayload = updated.payloadHistory[updated.payloadHistory.length - 1];
      const rejectedEvent: WorkflowRejectedEvent = {
        ...eventBase,
        payload: latestPayload?.payload ?? {},
        rejectedBy: actor.staffId,
        comment,
      };
      await this.eventEmitter.emitAsync(WORKFLOW_REJECTED_EVENT, rejectedEvent);
    } else if (action === WorkflowStepAction.RETURNED) {
      const returnedEvent: WorkflowReturnedEvent = {
        ...eventBase,
        returnedBy: actor.staffId,
        // validated non-empty above
        comment: comment as string,
      };
      await this.eventEmitter.emitAsync(WORKFLOW_RETURNED_EVENT, returnedEvent);
    }

    return updated;
  }

  /**
   * The maker edits their own proposal while it's still sitting untouched at
   * PENDING_REVIEW — unlike `resubmit` (only for REJECTED/RETURNED_TO_MAKER,
   * and always re-enters/restarts the chain), nothing has happened to this
   * request yet, so there's no chain state to reset: just append the new
   * payload version, `steps`/`currentStepIndex`/`status` untouched. A
   * request that's already moved to PENDING_APPROVAL or been RETURNED_TO_MAKER
   * no longer qualifies — the maker isn't the only one with a stake in it
   * anymore.
   */
  async updatePendingPayload(input: UpdatePendingPayloadInput): Promise<WorkflowRequestDocument> {
    const { workflowRequestId, actorId, newPayload } = input;

    const current = await this.workflowRequestModel.findById(workflowRequestId).exec();
    if (!current) {
      throw new NotFoundException(`WorkflowRequest ${workflowRequestId} not found`);
    }

    if (actorId !== current.initiatedBy) {
      throw new ForbiddenException('Only the initiator may edit their own request');
    }

    if (current.status !== WorkflowStatus.PENDING_REVIEW) {
      throw new BadRequestException('Only a PENDING_REVIEW request can be edited this way');
    }

    const updated = await this.workflowRequestModel
      .findOneAndUpdate(
        { _id: workflowRequestId, status: WorkflowStatus.PENDING_REVIEW },
        { $push: { payloadHistory: { payload: newPayload, submittedBy: actorId, submittedAt: new Date() } } },
        { new: true },
      )
      .exec();

    if (!updated) {
      throw new ConflictException(
        `WorkflowRequest ${workflowRequestId} was concurrently modified — retry the edit`,
      );
    }

    await this.auditService.record({
      actorId,
      action: 'WORKFLOW_REQUEST_PAYLOAD_EDITED',
      entityType: 'WORKFLOW_REQUEST',
      entityId: workflowRequestId,
      metadata: { priorPayloadVersionIndex: current.payloadHistory.length - 1 },
    });

    return updated;
  }

  async resubmit(input: ResubmitWorkflowInput): Promise<WorkflowRequestDocument> {
    const { workflowRequestId, actorId, newPayload } = input;

    const current = await this.workflowRequestModel.findById(workflowRequestId).exec();
    if (!current) {
      throw new NotFoundException(`WorkflowRequest ${workflowRequestId} not found`);
    }

    const isRejected = current.status === WorkflowStatus.REJECTED;
    const isReturned = current.status === WorkflowStatus.RETURNED_TO_MAKER;
    if (!isRejected && !isReturned) {
      throw new BadRequestException(
        'Only a REJECTED or RETURNED_TO_MAKER request can be resubmitted',
      );
    }

    if (actorId !== current.initiatedBy) {
      throw new ForbiddenException('Only the original initiator may resubmit this request');
    }

    const chain = await this.chainConfigModel
      .findOne({ entityType: current.entityType, action: current.action })
      .exec();
    if (!chain) {
      throw new NotFoundException(
        `No workflow chain registered for ${current.entityType}:${current.action}`,
      );
    }

    // Preserve the round that's about to be cleared — never lose it, even though
    // it also lives in payloadHistory (the step-by-step actions taken on it don't).
    await this.auditService.record({
      actorId,
      action: 'WORKFLOW_REQUEST_ROUND_ARCHIVED',
      entityType: 'WORKFLOW_REQUEST',
      entityId: workflowRequestId,
      before: { steps: current.steps, currentStepIndex: current.currentStepIndex },
      metadata: { priorPayloadVersionIndex: current.payloadHistory.length - 1 },
    });

    let newSteps: WorkflowStepRecord[];
    let newStepIndex: number;

    // A REJECTED request always restarts from step 0 on resubmission —
    // unlike RETURNED_TO_MAKER (which may resume mid-chain, per
    // `chain.restartOnReturn`), REJECTED is a genuinely final "no" from
    // whoever acted; a corrected resubmission earns a fresh review cycle,
    // not a silent resume past whichever step rejected it.
    if (isRejected || chain.restartOnReturn) {
      newSteps = chain.steps
        .slice()
        .sort((a, b) => a.order - b.order)
        .map((step) => ({
          order: step.order,
          requiredCapability: step.requiredCapability,
          actedBy: null,
          action: null,
          comment: null,
          actedAt: null,
        }));
      newStepIndex = 0;
    } else {
      // Built as plain objects (not spread off the Mongoose subdocuments) —
      // spreading a subdocument instance does not reliably carry its
      // schema-defined fields through to a plain object for a $set write.
      newSteps = current.steps.map((step, index) => ({
        order: step.order,
        requiredCapability: step.requiredCapability,
        actedBy: index === current.currentStepIndex ? null : step.actedBy,
        action: index === current.currentStepIndex ? null : step.action,
        comment: index === current.currentStepIndex ? null : step.comment,
        actedAt: index === current.currentStepIndex ? null : step.actedAt,
      }));
      newStepIndex = current.currentStepIndex;
    }

    const newStatus = this.computeStatus(newStepIndex, newSteps.length);

    const updated = await this.workflowRequestModel
      .findOneAndUpdate(
        { _id: workflowRequestId, status: current.status },
        {
          $set: { steps: newSteps, currentStepIndex: newStepIndex, status: newStatus },
          $push: {
            payloadHistory: { payload: newPayload, submittedBy: actorId, submittedAt: new Date() },
          },
        },
        { new: true },
      )
      .exec();

    if (!updated) {
      throw new ConflictException(
        `WorkflowRequest ${workflowRequestId} was concurrently modified — retry the resubmission`,
      );
    }

    await this.auditService.record({
      actorId,
      action: 'WORKFLOW_REQUEST_RESUBMITTED',
      entityType: 'WORKFLOW_REQUEST',
      entityId: workflowRequestId,
      before: { status: current.status },
      after: { status: newStatus, currentStepIndex: newStepIndex },
    });

    const resubmittedEvent: WorkflowResubmittedEvent = {
      workflowRequestId,
      entityType: updated.entityType,
      entityId: updated.entityId,
      action: updated.action,
      branchId: updated.branchId,
      resubmittedBy: actorId,
    };
    await this.eventEmitter.emitAsync(WORKFLOW_RESUBMITTED_EVENT, resubmittedEvent);

    return updated;
  }

  /**
   * The maker withdraws their own not-yet-decided (or already-decided-but-
   * abandoned) proposal — e.g. a Marketer who raised a Customer/Group
   * they've realized was a mistake, before waiting on someone else to
   * reject it. Only the original `initiatedBy` may call this, and only
   * while the request hasn't reached its own terminal "someone else
   * decided" outcome (APPROVED, or already CANCELLED). Deliberately no
   * event is emitted — unlike REJECTED/APPROVED, a cancelled request never
   * had (nor gets) a domain entity for some other module to react to; a
   * caller that needs to clean up its own side (e.g. CustomerService
   * deleting the Customer document itself) does that around this call.
   */
  async cancel(input: { workflowRequestId: string; actorId: string }): Promise<WorkflowRequestDocument> {
    const { workflowRequestId, actorId } = input;

    const current = await this.workflowRequestModel.findById(workflowRequestId).exec();
    if (!current) {
      throw new NotFoundException(`WorkflowRequest ${workflowRequestId} not found`);
    }

    if (actorId !== current.initiatedBy) {
      throw new ForbiddenException('Only the initiator may cancel their own request');
    }

    if (current.status === WorkflowStatus.APPROVED) {
      throw new BadRequestException('An already-approved request cannot be cancelled');
    }
    if (current.status === WorkflowStatus.CANCELLED) {
      throw new ConflictException(`WorkflowRequest ${workflowRequestId} has already been cancelled`);
    }

    const updated = await this.workflowRequestModel
      .findOneAndUpdate(
        { _id: workflowRequestId, status: current.status },
        { $set: { status: WorkflowStatus.CANCELLED } },
        { new: true },
      )
      .exec();

    if (!updated) {
      throw new ConflictException(
        `WorkflowRequest ${workflowRequestId} was concurrently modified — retry the cancellation`,
      );
    }

    await this.auditService.record({
      actorId,
      action: 'WORKFLOW_REQUEST_CANCELLED',
      entityType: 'WORKFLOW_REQUEST',
      entityId: workflowRequestId,
      before: { status: current.status },
      after: { status: WorkflowStatus.CANCELLED },
    });

    const latestPayload = updated.payloadHistory[updated.payloadHistory.length - 1];
    const cancelledEvent: WorkflowCancelledEvent = {
      workflowRequestId,
      entityType: updated.entityType,
      entityId: updated.entityId,
      action: updated.action,
      branchId: updated.branchId,
      payload: latestPayload?.payload ?? {},
      cancelledBy: actorId,
    };
    await this.eventEmitter.emitAsync(WORKFLOW_CANCELLED_EVENT, cancelledEvent);

    return updated;
  }

  /**
   * The maker permanently removes their own request — unlike `cancel`
   * (which keeps a CANCELLED record around, e.g. so CustomerService can
   * silence a pending request tied to a Customer it's deleting without
   * losing that Customer's own audit trail), this is a genuine hard
   * delete, for entity types where the request itself *is* the record
   * (e.g. GROUP/CREATE — no domain document exists until approval, see
   * WorkflowEntityType.GROUP's own doc comment) and a maker withdrawing a
   * mistaken proposal expects it to just be gone. Deliberately narrower
   * than `cancel`: only PENDING_REVIEW (nobody has acted on it yet) or
   * REJECTED (a reviewer's final "no") — once a request has advanced to
   * PENDING_APPROVAL or been RETURNED_TO_MAKER, someone has already put
   * work into it and it's no longer the maker's alone to erase.
   */
  async deleteRequest(input: { workflowRequestId: string; actorId: string }): Promise<void> {
    const { workflowRequestId, actorId } = input;

    const current = await this.workflowRequestModel.findById(workflowRequestId).exec();
    if (!current) {
      throw new NotFoundException(`WorkflowRequest ${workflowRequestId} not found`);
    }

    if (actorId !== current.initiatedBy) {
      throw new ForbiddenException('Only the initiator may delete their own request');
    }

    if (current.status !== WorkflowStatus.PENDING_REVIEW && current.status !== WorkflowStatus.REJECTED) {
      throw new BadRequestException(
        'Only a PENDING_REVIEW or REJECTED request can be deleted',
      );
    }

    const deleted = await this.workflowRequestModel
      .findOneAndDelete({ _id: workflowRequestId, status: current.status })
      .exec();
    if (!deleted) {
      throw new ConflictException(
        `WorkflowRequest ${workflowRequestId} was concurrently modified — retry the deletion`,
      );
    }

    await this.auditService.record({
      actorId,
      action: 'WORKFLOW_REQUEST_DELETED',
      entityType: 'WORKFLOW_REQUEST',
      entityId: workflowRequestId,
      before: { status: current.status, entityType: current.entityType, action: current.action },
    });

    // `current` (captured before the delete above) is the only source left
    // for `payload` — the document itself is gone.
    const latestPayload = current.payloadHistory[current.payloadHistory.length - 1];
    const deletedEvent: WorkflowDeletedEvent = {
      workflowRequestId,
      entityType: current.entityType,
      entityId: current.entityId,
      action: current.action,
      branchId: current.branchId,
      payload: latestPayload?.payload ?? {},
      deletedBy: actorId,
    };
    await this.eventEmitter.emitAsync(WORKFLOW_DELETED_EVENT, deletedEvent);
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  /**
   * All pending WorkflowRequests, across every entity type, where the current
   * step's requiredCapability is held by this actor — excluding requests they
   * initiated or have already acted on. Single query via `$expr` rather than
   * per-entity-type calls, which is the entire point of a generic engine.
   */
  async getPendingForActor(
    actorId: string,
    actorCapabilities: string[],
  ): Promise<WorkflowRequestDocument[]> {
    if (actorCapabilities.length === 0) {
      return [];
    }

    return this.workflowRequestModel
      .find({
        status: { $in: ACTIONABLE_STATUSES },
        initiatedBy: { $ne: actorId },
        'steps.actedBy': { $ne: actorId },
        $expr: {
          $in: [
            { $arrayElemAt: ['$steps.requiredCapability', '$currentStepIndex'] },
            actorCapabilities,
          ],
        },
      })
      .sort({ createdAt: -1 })
      .exec();
  }

  /** Full timeline of WorkflowRequests raised against one entity, oldest first. */
  async getHistory(entityType: string, entityId: string): Promise<WorkflowRequestDocument[]> {
    return this.workflowRequestModel.find({ entityType, entityId }).sort({ createdAt: 1 }).exec();
  }

  /**
   * Same as `getHistory`, batched across many entities of the same type in
   * one query — for a caller building a list where every row needs its own
   * "is there a pending request, and what step is it on" answer (e.g. every
   * repayment on a Loan Detail page) without an N+1 `getHistory` call per
   * row. Returns every WorkflowRequest for every id given, unsorted within
   * an entity's own group — a caller that needs "most recent" should still
   * pick the max by `createdAt` itself, same as a single-entity `getHistory`
   * result would require.
   */
  async getHistoryForEntities(
    entityType: string,
    entityIds: string[],
  ): Promise<WorkflowRequestDocument[]> {
    if (entityIds.length === 0) {
      return [];
    }
    return this.workflowRequestModel
      .find({ entityType, entityId: { $in: [...new Set(entityIds)] } })
      .sort({ createdAt: 1 })
      .exec();
  }

  /**
   * Every still-pending WorkflowRequest for one entity type, regardless of
   * who can act on it — unlike `getPendingForActor`, this deliberately
   * *doesn't* exclude the caller's own submissions. Exists so a maker who
   * just proposed something (e.g. a new LoanProduct, which doesn't exist as
   * a real entity yet — see `entityId`'s own doc comment) can see it's
   * genuinely pending rather than concluding it silently vanished; the
   * frontend is expected to hide the actual approve/reject action for
   * entries the viewer initiated, same rule `act()` enforces server-side.
   */
  async getPendingByEntityType(entityType: string): Promise<WorkflowRequestDocument[]> {
    return this.workflowRequestModel
      .find({ entityType, status: { $in: ACTIONABLE_STATUSES } })
      .sort({ createdAt: -1 })
      .exec();
  }

  /**
   * Every REJECTED WorkflowRequest for one entity type — the "Rejected" tab
   * counterpart to `getPendingByEntityType` above. A rejected CREATE never
   * persists a domain entity (see LoanProduct's own doc comment on
   * REJECTED), so this is the *only* place that history is visible at all
   * once a request leaves PENDING_*; `WorkflowRequestSummaryDto.steps`
   * carries who rejected it, when, and their required comment.
   */
  async getRejectedByEntityType(entityType: string): Promise<WorkflowRequestDocument[]> {
    return this.workflowRequestModel
      .find({ entityType, status: WorkflowStatus.REJECTED })
      .sort({ createdAt: -1 })
      .exec();
  }

  /**
   * Added in Phase 11 — `NotificationService`'s `resolveInvolvedParties`
   * needs to read a request's `steps` (to find which Admin/SuperAdmin acted
   * on it) without reaching into the model directly from another module. A
   * small, read-only addition; every mutation still goes exclusively through
   * `initiate`/`act`/`resubmit` above. See PHASE_11_NOTES.md.
   */
  async getById(workflowRequestId: string): Promise<WorkflowRequestDocument> {
    const request = await this.workflowRequestModel.findById(workflowRequestId).exec();
    if (!request) {
      throw new NotFoundException(`WorkflowRequest ${workflowRequestId} not found`);
    }
    return request;
  }

  /**
   * Backfills `entityId` once a domain module has actually created its entity
   * after an `workflow.approved` event — not in the original spec, added so
   * `getHistory` stays useful for "create" flows (which start with entityId: null).
   */
  async linkEntity(workflowRequestId: string, entityId: string): Promise<WorkflowRequestDocument> {
    const updated = await this.workflowRequestModel
      .findByIdAndUpdate(workflowRequestId, { $set: { entityId } }, { new: true })
      .exec();
    if (!updated) {
      throw new NotFoundException(`WorkflowRequest ${workflowRequestId} not found`);
    }
    return updated;
  }
}

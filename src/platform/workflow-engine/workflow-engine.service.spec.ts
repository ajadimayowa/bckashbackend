import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { EventEmitter2, EventEmitterModule } from '@nestjs/event-emitter';
import { MongooseModule } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';

import { WorkflowStatus, WorkflowStepAction } from '../../common/enums/workflow.enums';
import { InMemoryMongo } from '../../test-utils/in-memory-mongo';
import { AuditModule } from '../audit/audit.module';
import { AuditService } from '../audit/audit.service';
import {
  WORKFLOW_APPROVED_EVENT,
  WORKFLOW_REJECTED_EVENT,
  WORKFLOW_RESUBMITTED_EVENT,
  WORKFLOW_RETURNED_EVENT,
} from './events/workflow-engine.events';
import {
  WorkflowChainConfig,
  WorkflowChainConfigSchema,
} from './schemas/workflow-chain-config.schema';
import { WorkflowRequest, WorkflowRequestSchema } from './schemas/workflow-request.schema';
import { WorkflowEngineService } from './workflow-engine.service';

describe('WorkflowEngineService', () => {
  const mongo = new InMemoryMongo();
  let moduleRef: TestingModule;
  let service: WorkflowEngineService;
  let auditService: AuditService;
  let eventEmitter: EventEmitter2;

  beforeAll(async () => {
    await mongo.start();

    moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(mongo.getUri()),
        MongooseModule.forFeature([
          { name: WorkflowChainConfig.name, schema: WorkflowChainConfigSchema },
          { name: WorkflowRequest.name, schema: WorkflowRequestSchema },
        ]),
        AuditModule,
        EventEmitterModule.forRoot(),
      ],
      providers: [WorkflowEngineService],
    }).compile();

    service = moduleRef.get(WorkflowEngineService);
    auditService = moduleRef.get(AuditService);
    eventEmitter = moduleRef.get(EventEmitter2);
  }, 60_000);

  afterEach(async () => {
    await mongo.clearAllCollections();
  });

  afterAll(async () => {
    await moduleRef.close();
    await mongo.stop();
  });

  const REVIEW_CAP = 'cap:review';
  const APPROVE_CAP = 'cap:approve';

  async function registerTwoStepChain(
    entityType: string,
    action: string,
    restartOnReturn: boolean,
  ) {
    return service.registerChainConfig({
      entityType,
      action,
      restartOnReturn,
      steps: [
        { order: 0, requiredCapability: REVIEW_CAP },
        { order: 1, requiredCapability: APPROVE_CAP },
      ],
    });
  }

  describe('registerChainConfig', () => {
    it('rejects an empty steps array', async () => {
      await expect(
        service.registerChainConfig({
          entityType: 'X',
          action: 'Y',
          restartOnReturn: true,
          steps: [],
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects non-contiguous step orders', async () => {
      await expect(
        service.registerChainConfig({
          entityType: 'X',
          action: 'Z',
          restartOnReturn: true,
          steps: [
            { order: 0, requiredCapability: 'a' },
            { order: 2, requiredCapability: 'b' },
          ],
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('is idempotent — a second registration does not overwrite the first', async () => {
      await registerTwoStepChain('IDEMPOTENT', 'CREATE', true);
      await service.registerChainConfig({
        entityType: 'IDEMPOTENT',
        action: 'CREATE',
        restartOnReturn: false,
        steps: [{ order: 0, requiredCapability: 'different' }],
      });

      const request = await service.initiate({
        entityType: 'IDEMPOTENT',
        action: 'CREATE',
        payload: {},
        initiatedBy: 'someone',
      });

      // still the original 2-step chain, not the second registration attempt
      expect(request.steps).toHaveLength(2);
    });
  });

  describe('initiate', () => {
    it('throws when no chain is registered for the entityType/action pair', async () => {
      await expect(
        service.initiate({ entityType: 'NOPE', action: 'NOPE', payload: {}, initiatedBy: 'a' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('creates a request in PENDING_REVIEW for a multi-step chain, with the first payload version recorded', async () => {
      await registerTwoStepChain('GROUP', 'CREATE', true);

      const request = await service.initiate({
        entityType: 'GROUP',
        action: 'CREATE',
        payload: { name: 'Group A' },
        initiatedBy: 'staff-A',
        branchId: 'branch-1',
      });

      expect(request.status).toBe(WorkflowStatus.PENDING_REVIEW);
      expect(request.currentStepIndex).toBe(0);
      expect(request.payloadHistory).toHaveLength(1);
      expect(request.payloadHistory[0]?.payload).toEqual({ name: 'Group A' });
      expect(request.entityId).toBeNull();
    });

    it('creates a request straight in PENDING_APPROVAL for a single-step chain', async () => {
      await service.registerChainConfig({
        entityType: 'SINGLE_STEP',
        action: 'CREATE',
        restartOnReturn: true,
        steps: [{ order: 0, requiredCapability: APPROVE_CAP }],
      });

      const request = await service.initiate({
        entityType: 'SINGLE_STEP',
        action: 'CREATE',
        payload: {},
        initiatedBy: 'staff-A',
      });

      expect(request.status).toBe(WorkflowStatus.PENDING_APPROVAL);
    });
  });

  describe('act — maker/checker enforcement', () => {
    it('never lets the maker act on their own request, at any step', async () => {
      await registerTwoStepChain('GROUP', 'CREATE', true);
      const request = await service.initiate({
        entityType: 'GROUP',
        action: 'CREATE',
        payload: {},
        initiatedBy: 'staff-A',
      });

      await expect(
        service.act({
          workflowRequestId: request._id.toString(),
          actor: { staffId: 'staff-A', capabilities: [REVIEW_CAP] },
          action: WorkflowStepAction.APPROVED,
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('never lets the maker act at a later step either', async () => {
      await registerTwoStepChain('GROUP', 'CREATE', true);
      const request = await service.initiate({
        entityType: 'GROUP',
        action: 'CREATE',
        payload: {},
        initiatedBy: 'staff-A',
      });

      await service.act({
        workflowRequestId: request._id.toString(),
        actor: { staffId: 'staff-B', capabilities: [REVIEW_CAP] },
        action: WorkflowStepAction.APPROVED,
      });

      await expect(
        service.act({
          workflowRequestId: request._id.toString(),
          actor: { staffId: 'staff-A', capabilities: [APPROVE_CAP] },
          action: WorkflowStepAction.APPROVED,
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('does not let the same non-maker actor act twice in one chain', async () => {
      await registerTwoStepChain('GROUP', 'CREATE', true);
      const request = await service.initiate({
        entityType: 'GROUP',
        action: 'CREATE',
        payload: {},
        initiatedBy: 'staff-A',
      });

      await service.act({
        workflowRequestId: request._id.toString(),
        actor: { staffId: 'staff-B', capabilities: [REVIEW_CAP, APPROVE_CAP] },
        action: WorkflowStepAction.APPROVED,
      });

      await expect(
        service.act({
          workflowRequestId: request._id.toString(),
          actor: { staffId: 'staff-B', capabilities: [REVIEW_CAP, APPROVE_CAP] },
          action: WorkflowStepAction.APPROVED,
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('rejects an actor missing the required capability for the current step', async () => {
      await registerTwoStepChain('GROUP', 'CREATE', true);
      const request = await service.initiate({
        entityType: 'GROUP',
        action: 'CREATE',
        payload: {},
        initiatedBy: 'staff-A',
      });

      await expect(
        service.act({
          workflowRequestId: request._id.toString(),
          actor: { staffId: 'staff-B', capabilities: [APPROVE_CAP] }, // wrong capability for step 0
          action: WorkflowStepAction.APPROVED,
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('requires a comment when returning to maker', async () => {
      await registerTwoStepChain('GROUP', 'CREATE', true);
      const request = await service.initiate({
        entityType: 'GROUP',
        action: 'CREATE',
        payload: {},
        initiatedBy: 'staff-A',
      });

      await expect(
        service.act({
          workflowRequestId: request._id.toString(),
          actor: { staffId: 'staff-B', capabilities: [REVIEW_CAP] },
          action: WorkflowStepAction.RETURNED,
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('act — approval progression and events', () => {
    it('advances to the next step (PENDING_APPROVAL) on approval at a non-last step, without emitting workflow.approved', async () => {
      await registerTwoStepChain('GROUP', 'CREATE', true);
      const request = await service.initiate({
        entityType: 'GROUP',
        action: 'CREATE',
        payload: {},
        initiatedBy: 'staff-A',
      });

      const emitSpy = jest.spyOn(eventEmitter, 'emit');

      const updated = await service.act({
        workflowRequestId: request._id.toString(),
        actor: { staffId: 'staff-B', capabilities: [REVIEW_CAP] },
        action: WorkflowStepAction.APPROVED,
      });

      expect(updated.status).toBe(WorkflowStatus.PENDING_APPROVAL);
      expect(updated.currentStepIndex).toBe(1);
      expect(emitSpy).not.toHaveBeenCalledWith(WORKFLOW_APPROVED_EVENT, expect.anything());
    });

    it('reaches APPROVED and emits workflow.approved with the latest payload on approval at the last step', async () => {
      await registerTwoStepChain('GROUP', 'CREATE', true);
      const request = await service.initiate({
        entityType: 'GROUP',
        action: 'CREATE',
        payload: { name: 'Group Z' },
        initiatedBy: 'staff-A',
      });

      await service.act({
        workflowRequestId: request._id.toString(),
        actor: { staffId: 'staff-B', capabilities: [REVIEW_CAP] },
        action: WorkflowStepAction.APPROVED,
      });

      const events: unknown[] = [];
      eventEmitter.once(WORKFLOW_APPROVED_EVENT, (event: unknown) => events.push(event));

      const updated = await service.act({
        workflowRequestId: request._id.toString(),
        actor: { staffId: 'staff-C', capabilities: [APPROVE_CAP] },
        action: WorkflowStepAction.APPROVED,
      });

      expect(updated.status).toBe(WorkflowStatus.APPROVED);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        workflowRequestId: request._id.toString(),
        entityType: 'GROUP',
        payload: { name: 'Group Z' },
        initiatedBy: 'staff-A',
      });
    });

    it('rejects and terminates the request, emitting workflow.rejected', async () => {
      await registerTwoStepChain('GROUP', 'CREATE', true);
      const request = await service.initiate({
        entityType: 'GROUP',
        action: 'CREATE',
        payload: {},
        initiatedBy: 'staff-A',
      });

      const events: unknown[] = [];
      eventEmitter.once(WORKFLOW_REJECTED_EVENT, (event: unknown) => events.push(event));

      const updated = await service.act({
        workflowRequestId: request._id.toString(),
        actor: { staffId: 'staff-B', capabilities: [REVIEW_CAP] },
        action: WorkflowStepAction.REJECTED,
        comment: 'not eligible',
      });

      expect(updated.status).toBe(WorkflowStatus.REJECTED);
      expect(events).toHaveLength(1);

      // terminal — nobody can act on it again
      await expect(
        service.act({
          workflowRequestId: request._id.toString(),
          actor: { staffId: 'staff-C', capabilities: [REVIEW_CAP, APPROVE_CAP] },
          action: WorkflowStepAction.APPROVED,
        }),
      ).rejects.toThrow();
    });

    it('returns to maker and emits workflow.returned', async () => {
      await registerTwoStepChain('GROUP', 'CREATE', true);
      const request = await service.initiate({
        entityType: 'GROUP',
        action: 'CREATE',
        payload: {},
        initiatedBy: 'staff-A',
      });

      const events: unknown[] = [];
      eventEmitter.once(WORKFLOW_RETURNED_EVENT, (event: unknown) => events.push(event));

      const updated = await service.act({
        workflowRequestId: request._id.toString(),
        actor: { staffId: 'staff-B', capabilities: [REVIEW_CAP] },
        action: WorkflowStepAction.RETURNED,
        comment: 'missing info',
      });

      expect(updated.status).toBe(WorkflowStatus.RETURNED_TO_MAKER);
      expect(events).toEqual([
        expect.objectContaining({ returnedBy: 'staff-B', comment: 'missing info' }),
      ]);
    });

    it('cannot be acted on by anyone (not even the original reviewer) while RETURNED_TO_MAKER — only resubmit is valid', async () => {
      await registerTwoStepChain('GROUP', 'CREATE', true);
      const request = await service.initiate({
        entityType: 'GROUP',
        action: 'CREATE',
        payload: {},
        initiatedBy: 'staff-A',
      });

      await service.act({
        workflowRequestId: request._id.toString(),
        actor: { staffId: 'staff-B', capabilities: [REVIEW_CAP] },
        action: WorkflowStepAction.RETURNED,
        comment: 'missing info',
      });

      await expect(
        service.act({
          workflowRequestId: request._id.toString(),
          actor: { staffId: 'staff-B', capabilities: [REVIEW_CAP] },
          action: WorkflowStepAction.APPROVED,
        }),
      ).rejects.toThrow();

      await expect(
        service.resubmit({
          workflowRequestId: request._id.toString(),
          actorId: 'staff-B', // not the initiator
          newPayload: { name: 'fixed' },
        }),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('resubmit', () => {
    it('restartOnReturn: true resets to step 0, clears all step records, and preserves the prior round in payloadHistory and the audit log', async () => {
      await registerTwoStepChain('GROUP', 'RESTART_CREATE', true);
      const request = await service.initiate({
        entityType: 'GROUP',
        action: 'RESTART_CREATE',
        payload: { name: 'v0' },
        initiatedBy: 'staff-A',
      });
      const id = request._id.toString();

      await service.act({
        workflowRequestId: id,
        actor: { staffId: 'staff-B', capabilities: [REVIEW_CAP] },
        action: WorkflowStepAction.APPROVED,
      });
      await service.act({
        workflowRequestId: id,
        actor: { staffId: 'staff-C', capabilities: [APPROVE_CAP] },
        action: WorkflowStepAction.RETURNED,
        comment: 'fix the name',
      });

      const events: unknown[] = [];
      eventEmitter.once(WORKFLOW_RESUBMITTED_EVENT, (event: unknown) => events.push(event));

      const resubmitted = await service.resubmit({
        workflowRequestId: id,
        actorId: 'staff-A',
        newPayload: { name: 'v1' },
      });

      expect(resubmitted.status).toBe(WorkflowStatus.PENDING_REVIEW);
      expect(resubmitted.currentStepIndex).toBe(0);
      expect(resubmitted.steps.every((s) => s.actedBy === null)).toBe(true);
      expect(resubmitted.payloadHistory).toHaveLength(2);
      expect(resubmitted.payloadHistory[0]?.payload).toEqual({ name: 'v0' });
      expect(resubmitted.payloadHistory[1]?.payload).toEqual({ name: 'v1' });
      expect(events).toHaveLength(1);

      const auditTrail = await auditService.findByEntity('WORKFLOW_REQUEST', id);
      const archived = auditTrail.find((e) => e.action === 'WORKFLOW_REQUEST_ROUND_ARCHIVED');
      expect(archived).toBeDefined();
      const before = archived?.before as { steps: { actedBy: string | null }[] } | null;
      expect(before?.steps[0]?.actedBy).toBe('staff-B');
      expect(before?.steps[1]?.actedBy).toBe('staff-C');

      // the cleared chain is fully fresh — the original reviewer can act again
      const reReviewed = await service.act({
        workflowRequestId: id,
        actor: { staffId: 'staff-B', capabilities: [REVIEW_CAP] },
        action: WorkflowStepAction.APPROVED,
      });
      expect(reReviewed.currentStepIndex).toBe(1);
    });

    it('restartOnReturn: false resumes at the step that returned it, preserving earlier approved steps', async () => {
      await registerTwoStepChain('GROUP', 'NORESTART_CREATE', false);
      const request = await service.initiate({
        entityType: 'GROUP',
        action: 'NORESTART_CREATE',
        payload: { name: 'v0' },
        initiatedBy: 'staff-A',
      });
      const id = request._id.toString();

      await service.act({
        workflowRequestId: id,
        actor: { staffId: 'staff-B', capabilities: [REVIEW_CAP] },
        action: WorkflowStepAction.APPROVED,
      });
      await service.act({
        workflowRequestId: id,
        actor: { staffId: 'staff-C', capabilities: [APPROVE_CAP] },
        action: WorkflowStepAction.RETURNED,
        comment: 'fix the amount',
      });

      const resubmitted = await service.resubmit({
        workflowRequestId: id,
        actorId: 'staff-A',
        newPayload: { name: 'v1' },
      });

      expect(resubmitted.currentStepIndex).toBe(1);
      expect(resubmitted.status).toBe(WorkflowStatus.PENDING_APPROVAL);
      // step 0's earlier approval is untouched
      expect(resubmitted.steps[0]?.actedBy).toBe('staff-B');
      expect(resubmitted.steps[0]?.action).toBe(WorkflowStepAction.APPROVED);
      // step 1 (the one that returned it) is cleared and actionable again
      expect(resubmitted.steps[1]?.actedBy).toBeNull();

      const reApproved = await service.act({
        workflowRequestId: id,
        actor: { staffId: 'staff-C', capabilities: [APPROVE_CAP] },
        action: WorkflowStepAction.APPROVED,
      });
      expect(reApproved.status).toBe(WorkflowStatus.APPROVED);
    });

    it('only the original initiator may resubmit', async () => {
      await registerTwoStepChain('GROUP', 'CREATE', true);
      const request = await service.initiate({
        entityType: 'GROUP',
        action: 'CREATE',
        payload: {},
        initiatedBy: 'staff-A',
      });
      await service.act({
        workflowRequestId: request._id.toString(),
        actor: { staffId: 'staff-B', capabilities: [REVIEW_CAP] },
        action: WorkflowStepAction.RETURNED,
        comment: 'nope',
      });

      await expect(
        service.resubmit({
          workflowRequestId: request._id.toString(),
          actorId: 'staff-Z',
          newPayload: {},
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('only a RETURNED_TO_MAKER request can be resubmitted', async () => {
      await registerTwoStepChain('GROUP', 'CREATE', true);
      const request = await service.initiate({
        entityType: 'GROUP',
        action: 'CREATE',
        payload: {},
        initiatedBy: 'staff-A',
      });

      await expect(
        service.resubmit({
          workflowRequestId: request._id.toString(),
          actorId: 'staff-A',
          newPayload: {},
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('getPendingForActor', () => {
    it('returns mixed-entity-type results, excluding requests the actor initiated or already acted on, or lacks capability for', async () => {
      await registerTwoStepChain('GROUP', 'CREATE', true);
      await service.registerChainConfig({
        entityType: 'LOAN',
        action: 'APPLY',
        restartOnReturn: true,
        steps: [
          { order: 0, requiredCapability: 'cap:loan-review' },
          { order: 1, requiredCapability: APPROVE_CAP },
        ],
      });

      const groupReq = await service.initiate({
        entityType: 'GROUP',
        action: 'CREATE',
        payload: {},
        initiatedBy: 'staff-A',
      });
      const loanReq = await service.initiate({
        entityType: 'LOAN',
        action: 'APPLY',
        payload: {},
        initiatedBy: 'staff-A',
      });
      const ownRequest = await service.initiate({
        entityType: 'GROUP',
        action: 'CREATE',
        payload: {},
        initiatedBy: 'staff-B', // staff-B is the maker here — must be excluded from staff-B's own pending list
      });
      const alreadyActedReq = await service.initiate({
        entityType: 'GROUP',
        action: 'CREATE',
        payload: {},
        initiatedBy: 'staff-A',
      });
      await service.act({
        workflowRequestId: alreadyActedReq._id.toString(),
        actor: { staffId: 'staff-B', capabilities: [REVIEW_CAP] },
        action: WorkflowStepAction.APPROVED,
      });

      const pending = await service.getPendingForActor('staff-B', [REVIEW_CAP, 'cap:loan-review']);
      const pendingIds = pending.map((p) => p._id.toString());

      expect(pendingIds).toEqual(
        expect.arrayContaining([groupReq._id.toString(), loanReq._id.toString()]),
      );
      expect(pendingIds).not.toContain(ownRequest._id.toString());
      expect(pendingIds).not.toContain(alreadyActedReq._id.toString());
    });

    it('returns nothing for an actor with none of the required capabilities', async () => {
      await registerTwoStepChain('GROUP', 'CREATE', true);
      await service.initiate({
        entityType: 'GROUP',
        action: 'CREATE',
        payload: {},
        initiatedBy: 'staff-A',
      });

      const pending = await service.getPendingForActor('staff-B', ['cap:unrelated']);
      expect(pending).toEqual([]);
    });
  });

  describe('getHistory', () => {
    it('returns all WorkflowRequests raised against one entity, oldest first', async () => {
      await registerTwoStepChain('GROUP', 'CREATE', true);
      const request = await service.initiate({
        entityType: 'GROUP',
        action: 'CREATE',
        payload: {},
        initiatedBy: 'staff-A',
      });
      await service.linkEntity(request._id.toString(), 'group-123');

      const history = await service.getHistory('GROUP', 'group-123');

      expect(history).toHaveLength(1);
      expect(history[0]?._id.toString()).toBe(request._id.toString());
    });
  });

  describe('concurrency guard', () => {
    it('lets exactly one of two concurrent approvals on the same step succeed; the other gets a conflict', async () => {
      await registerTwoStepChain('GROUP', 'RACE_CREATE', true);
      const request = await service.initiate({
        entityType: 'GROUP',
        action: 'RACE_CREATE',
        payload: {},
        initiatedBy: 'staff-A',
      });
      const id = request._id.toString();

      const [resultD, resultE] = await Promise.allSettled([
        service.act({
          workflowRequestId: id,
          actor: { staffId: 'staff-D', capabilities: [REVIEW_CAP] },
          action: WorkflowStepAction.APPROVED,
        }),
        service.act({
          workflowRequestId: id,
          actor: { staffId: 'staff-E', capabilities: [REVIEW_CAP] },
          action: WorkflowStepAction.APPROVED,
        }),
      ]);

      const outcomes = [resultD, resultE];
      const fulfilled = outcomes.filter((r) => r.status === 'fulfilled');
      const rejected = outcomes.filter((r) => r.status === 'rejected');

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      // currentStepIndex must have advanced exactly once, not twice or zero times
      const winner = fulfilled[0]?.status === 'fulfilled' ? fulfilled[0].value : undefined;
      expect(winner?.currentStepIndex).toBe(1);
      expect(['staff-D', 'staff-E']).toContain(winner?.steps[0]?.actedBy);
    });
  });
});

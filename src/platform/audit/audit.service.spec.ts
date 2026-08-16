import { MongooseModule } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';

import { InMemoryMongo } from '../../test-utils/in-memory-mongo';
import { AuditService } from './audit.service';
import { AuditLog, AuditLogSchema } from './schemas/audit-log.schema';

describe('AuditService', () => {
  const mongo = new InMemoryMongo();
  let moduleRef: TestingModule;
  let auditService: AuditService;

  beforeAll(async () => {
    await mongo.start();

    moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(mongo.getUri()),
        MongooseModule.forFeature([{ name: AuditLog.name, schema: AuditLogSchema }]),
      ],
      providers: [AuditService],
    }).compile();

    auditService = moduleRef.get(AuditService);
  }, 60_000);

  afterEach(async () => {
    await mongo.clearAllCollections();
  });

  afterAll(async () => {
    await moduleRef.close();
    await mongo.stop();
  });

  describe('record', () => {
    it('persists all fields', async () => {
      const before = new Date();

      const entry = await auditService.record({
        actorId: 'staff-1',
        action: 'WORKFLOW_REQUEST_APPROVED',
        entityType: 'WORKFLOW_REQUEST',
        entityId: 'wf-1',
        before: { status: 'PENDING_APPROVAL' },
        after: { status: 'APPROVED' },
        metadata: { branchId: 'branch-1' },
      });

      expect(entry.actorId).toBe('staff-1');
      expect(entry.action).toBe('WORKFLOW_REQUEST_APPROVED');
      expect(entry.entityType).toBe('WORKFLOW_REQUEST');
      expect(entry.entityId).toBe('wf-1');
      expect(entry.before).toEqual({ status: 'PENDING_APPROVAL' });
      expect(entry.after).toEqual({ status: 'APPROVED' });
      expect(entry.metadata).toEqual({ branchId: 'branch-1' });
      expect(entry.timestamp.getTime()).toBeGreaterThanOrEqual(before.getTime());
    });

    it('defaults before/after/metadata to null and accepts a null actorId for system actions', async () => {
      const entry = await auditService.record({
        actorId: null,
        action: 'PENALTY_SWEEP_APPLIED',
        entityType: 'REPAYMENT_SCHEDULE_ENTRY',
        entityId: 'sched-1',
      });

      expect(entry.actorId).toBeNull();
      expect(entry.before).toBeNull();
      expect(entry.after).toBeNull();
      expect(entry.metadata).toBeNull();
    });
  });

  describe('findByEntity', () => {
    it('returns the full timeline for one entity, oldest first', async () => {
      await auditService.record({
        actorId: 'staff-1',
        action: 'WORKFLOW_REQUEST_CREATED',
        entityType: 'WORKFLOW_REQUEST',
        entityId: 'wf-2',
        timestamp: new Date('2026-01-01T00:00:00Z'),
      });
      await auditService.record({
        actorId: 'staff-2',
        action: 'WORKFLOW_REQUEST_APPROVED',
        entityType: 'WORKFLOW_REQUEST',
        entityId: 'wf-2',
        timestamp: new Date('2026-01-02T00:00:00Z'),
      });
      // noise — different entity, must not show up
      await auditService.record({
        actorId: 'staff-1',
        action: 'WORKFLOW_REQUEST_CREATED',
        entityType: 'WORKFLOW_REQUEST',
        entityId: 'wf-other',
      });

      const timeline = await auditService.findByEntity('WORKFLOW_REQUEST', 'wf-2');

      expect(timeline).toHaveLength(2);
      expect(timeline[0]?.action).toBe('WORKFLOW_REQUEST_CREATED');
      expect(timeline[1]?.action).toBe('WORKFLOW_REQUEST_APPROVED');
    });
  });

  describe('findByActor', () => {
    it('returns everything one actor did, newest first', async () => {
      await auditService.record({
        actorId: 'staff-3',
        action: 'A',
        entityType: 'X',
        entityId: '1',
        timestamp: new Date('2026-01-01T00:00:00Z'),
      });
      await auditService.record({
        actorId: 'staff-3',
        action: 'B',
        entityType: 'X',
        entityId: '2',
        timestamp: new Date('2026-01-02T00:00:00Z'),
      });

      const activity = await auditService.findByActor('staff-3');

      expect(activity).toHaveLength(2);
      expect(activity[0]?.action).toBe('B');
      expect(activity[1]?.action).toBe('A');
    });
  });

  describe('append-only guarantee', () => {
    it('exposes no update or delete method — the class only has record/find methods', () => {
      const serviceMethods = Object.getOwnPropertyNames(Object.getPrototypeOf(auditService));

      expect(serviceMethods).toEqual(
        expect.arrayContaining(['record', 'findByEntity', 'findByActor']),
      );
      for (const forbidden of ['update', 'updateOne', 'delete', 'deleteOne', 'remove']) {
        expect(serviceMethods).not.toContain(forbidden);
      }
    });
  });
});

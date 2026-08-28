import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { Model, Types } from 'mongoose';

import { NotificationCategory, NotificationTrigger } from '../../common/enums/notification.enums';
import { InMemoryMongo } from '../../test-utils/in-memory-mongo';
import { StaffService } from '../identity/staff.service';
import { NotificationInboxService } from './notification-inbox.service';
import { Notification, NotificationDocument, NotificationSchema } from './schemas/notification.schema';

describe('NotificationInboxService', () => {
  const mongo = new InMemoryMongo();
  let moduleRef: TestingModule;
  let service: NotificationInboxService;
  let notificationModel: Model<NotificationDocument>;
  let findActiveByRole: jest.Mock;

  beforeAll(async () => {
    await mongo.start();

    findActiveByRole = jest.fn().mockResolvedValue([]);

    moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(mongo.getUri()),
        MongooseModule.forFeature([{ name: Notification.name, schema: NotificationSchema }]),
      ],
      providers: [
        NotificationInboxService,
        { provide: StaffService, useValue: { findActiveByRole } },
      ],
    }).compile();

    service = moduleRef.get(NotificationInboxService);
    notificationModel = moduleRef.get(getModelToken(Notification.name));
  }, 60_000);

  afterEach(async () => {
    findActiveByRole.mockReset().mockResolvedValue([]);
    await mongo.clearAllCollections();
  });

  afterAll(async () => {
    await moduleRef.close();
    await mongo.stop();
  });

  function fakeStaff(id: string) {
    return { _id: new Types.ObjectId(id) };
  }

  describe('persistCopies', () => {
    it('is a true no-op (no DB write) when primaryRecipientStaffId is null', async () => {
      await service.persistCopies({
        type: NotificationTrigger.LOAN_RAISED,
        sourceEntityId: 'src-1',
        category: NotificationCategory.GENERAL,
        branchId: null,
        title: 't',
        body: 'b',
        primaryRecipientStaffId: null,
      });

      expect(await notificationModel.countDocuments({}).exec()).toBe(0);
      expect(findActiveByRole).not.toHaveBeenCalled();
    });

    it('writes one row for the primary recipient plus one per active SuperAdmin', async () => {
      const primaryId = new Types.ObjectId().toString();
      const superAdminId = new Types.ObjectId().toString();
      findActiveByRole.mockResolvedValue([fakeStaff(superAdminId)]);

      await service.persistCopies({
        type: NotificationTrigger.BRANCH_FUNDING_RECORDED,
        sourceEntityId: 'funding-1',
        category: NotificationCategory.BRANCH_MANAGER,
        branchId: new Types.ObjectId().toString(),
        title: 'New funding record',
        body: 'body',
        primaryRecipientStaffId: primaryId,
      });

      const rows = await notificationModel.find({}).exec();
      expect(rows).toHaveLength(2);

      const primaryRow = rows.find((r) => r.recipientStaffId.toString() === primaryId);
      expect(primaryRow?.category).toBe(NotificationCategory.BRANCH_MANAGER);

      const mirrorRow = rows.find((r) => r.recipientStaffId.toString() === superAdminId);
      expect(mirrorRow?.category).toBe(NotificationCategory.SUPERADMIN_MIRROR);
    });

    it('skips a duplicate row when the primary recipient IS a SuperAdmin (no double row)', async () => {
      const primaryId = new Types.ObjectId().toString();
      findActiveByRole.mockResolvedValue([fakeStaff(primaryId)]);

      await service.persistCopies({
        type: NotificationTrigger.BRANCH_FUNDING_RECORDED,
        sourceEntityId: 'funding-2',
        category: NotificationCategory.BRANCH_MANAGER,
        branchId: null,
        title: 't',
        body: 'b',
        primaryRecipientStaffId: primaryId,
      });

      const rows = await notificationModel.find({}).exec();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.category).toBe(NotificationCategory.BRANCH_MANAGER);
    });

    it('calling with the same (type, sourceEntityId, recipient) key twice does not duplicate a row (retry-safety)', async () => {
      const primaryId = new Types.ObjectId().toString();

      const input = {
        type: NotificationTrigger.BRANCH_REQUEST_RAISED,
        sourceEntityId: 'request-1',
        category: NotificationCategory.BRANCH_ADMIN_APPROVER,
        branchId: null,
        title: 't',
        body: 'b',
        primaryRecipientStaffId: primaryId,
      };

      await service.persistCopies(input);
      await service.persistCopies(input);

      expect(await notificationModel.countDocuments({ recipientStaffId: primaryId }).exec()).toBe(1);
    });
  });

  describe('findForStaff / markRead / markAllRead', () => {
    it('paginates, respects unreadOnly, and never returns another staff member\'s rows', async () => {
      const staffId = new Types.ObjectId().toString();
      const otherStaffId = new Types.ObjectId().toString();

      await notificationModel.create([
        {
          recipientStaffId: staffId,
          type: NotificationTrigger.LOAN_RAISED,
          category: NotificationCategory.GENERAL,
          sourceEntityId: 'a',
          branchId: null,
          title: 't1',
          body: 'b1',
          isRead: false,
        },
        {
          recipientStaffId: staffId,
          type: NotificationTrigger.LOAN_RAISED,
          category: NotificationCategory.GENERAL,
          sourceEntityId: 'b',
          branchId: null,
          title: 't2',
          body: 'b2',
          isRead: true,
        },
        {
          recipientStaffId: otherStaffId,
          type: NotificationTrigger.LOAN_RAISED,
          category: NotificationCategory.GENERAL,
          sourceEntityId: 'c',
          branchId: null,
          title: 't3',
          body: 'b3',
          isRead: false,
        },
      ]);

      const page = await service.findForStaff(staffId);
      expect(page.total).toBe(2);
      expect(page.unreadCount).toBe(1);
      expect(page.items.every((item) => item.recipientStaffId.toString() === staffId)).toBe(true);

      const unreadOnly = await service.findForStaff(staffId, { unreadOnly: true });
      expect(unreadOnly.items).toHaveLength(1);
      expect(unreadOnly.items[0]?.title).toBe('t1');
    });

    it('markRead 404s for a notification belonging to a different recipient', async () => {
      const owner = new Types.ObjectId().toString();
      const stranger = new Types.ObjectId().toString();

      const created = await notificationModel.create({
        recipientStaffId: owner,
        type: NotificationTrigger.LOAN_RAISED,
        category: NotificationCategory.GENERAL,
        sourceEntityId: 'x',
        branchId: null,
        title: 't',
        body: 'b',
        isRead: false,
      });

      await expect(service.markRead(created._id.toString(), stranger)).rejects.toThrow(/not found/i);
    });

    it('markAllRead only touches the caller\'s own unread rows', async () => {
      const staffId = new Types.ObjectId().toString();
      const otherStaffId = new Types.ObjectId().toString();

      await notificationModel.create([
        {
          recipientStaffId: staffId,
          type: NotificationTrigger.LOAN_RAISED,
          category: NotificationCategory.GENERAL,
          sourceEntityId: 'a',
          branchId: null,
          title: 't1',
          body: 'b1',
          isRead: false,
        },
        {
          recipientStaffId: otherStaffId,
          type: NotificationTrigger.LOAN_RAISED,
          category: NotificationCategory.GENERAL,
          sourceEntityId: 'b',
          branchId: null,
          title: 't2',
          body: 'b2',
          isRead: false,
        },
      ]);

      const result = await service.markAllRead(staffId);
      expect(result.modifiedCount).toBe(1);

      const otherStill = await notificationModel.findOne({ recipientStaffId: otherStaffId }).exec();
      expect(otherStill?.isRead).toBe(false);
    });
  });
});

import { Types } from 'mongoose';

import { NotificationTrigger } from '../../common/enums/notification.enums';
import { BranchManagerAssignedEvent } from '../branches/events/branch.events';
import { BranchEventListenersService } from './branch-event-listeners.service';
import { NotificationRecipient } from './interfaces/notification-recipient.interface';
import { NotificationService } from './notification.service';

type DispatchCall = [NotificationTrigger, string, NotificationRecipient, Record<string, unknown>];

describe('BranchEventListenersService', () => {
  let notificationService: { dispatch: jest.Mock };
  let branchManagerAssignmentService: { getCurrentManager: jest.Mock };
  let branchesService: { findById: jest.Mock };
  let staffService: { findById: jest.Mock };
  let listener: BranchEventListenersService;

  const branchId = new Types.ObjectId().toString();
  const managerStaffId = new Types.ObjectId().toString();
  const assignedById = new Types.ObjectId().toString();

  beforeEach(() => {
    notificationService = { dispatch: jest.fn().mockResolvedValue(undefined) };
    branchManagerAssignmentService = { getCurrentManager: jest.fn() };
    branchesService = { findById: jest.fn().mockResolvedValue({ name: 'Ikeja Branch' }) };
    staffService = {
      findById: jest.fn((id: string) =>
        id === managerStaffId
          ? Promise.resolve({ _id: managerStaffId, firstName: 'Ada', lastName: 'Okoye', email: 'ada@example.com' })
          : Promise.resolve({ _id: assignedById, firstName: 'Femi', lastName: 'Bakare', email: 'femi@example.com' }),
      ),
    };
    listener = new BranchEventListenersService(
      notificationService as unknown as NotificationService,
      branchManagerAssignmentService as never,
      branchesService as never,
      staffService as never,
    );
  });

  describe('handleManagerAssigned', () => {
    it('dispatches BRANCH_MANAGER_ASSIGNED, email-only, to the newly-assigned manager', async () => {
      const event: BranchManagerAssignedEvent = {
        branchId,
        staffId: managerStaffId,
        assignedBy: assignedById,
        approvedBy: new Types.ObjectId().toString(),
      };

      await listener.handleManagerAssigned(event);

      expect(notificationService.dispatch).toHaveBeenCalledTimes(1);
      const [type, sourceEntityId, recipient, payload] = notificationService.dispatch.mock
        .calls[0] as DispatchCall;

      expect(type).toBe(NotificationTrigger.BRANCH_MANAGER_ASSIGNED);
      expect(sourceEntityId).toBe(branchId);
      expect(recipient).toEqual({
        kind: 'STAFF',
        id: managerStaffId,
        email: 'ada@example.com',
        phone: null,
      });
      expect(payload.firstName).toBe('Ada');
      expect(payload.branchName).toBe('Ikeja Branch');
      expect(payload.assignedByName).toBe('Femi Bakare');
    });

    it('falls back to a generic branch name when the branch can no longer be resolved', async () => {
      branchesService.findById.mockRejectedValueOnce(new Error('not found'));
      const event: BranchManagerAssignedEvent = {
        branchId,
        staffId: managerStaffId,
        assignedBy: assignedById,
        approvedBy: new Types.ObjectId().toString(),
      };

      await listener.handleManagerAssigned(event);

      const [, , , payload] = notificationService.dispatch.mock.calls[0] as DispatchCall;
      expect(payload.branchName).toBe('your assigned branch');
    });

    it('does nothing (no dispatch) if the newly-assigned staff member no longer exists', async () => {
      staffService.findById.mockImplementation((id: string) =>
        id === managerStaffId ? Promise.reject(new Error('not found')) : Promise.resolve({ firstName: 'Femi' }),
      );
      const event: BranchManagerAssignedEvent = {
        branchId,
        staffId: managerStaffId,
        assignedBy: assignedById,
        approvedBy: new Types.ObjectId().toString(),
      };

      await listener.handleManagerAssigned(event);

      expect(notificationService.dispatch).not.toHaveBeenCalled();
    });
  });
});

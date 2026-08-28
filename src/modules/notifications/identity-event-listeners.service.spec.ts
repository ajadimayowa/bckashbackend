import { Types } from 'mongoose';

import { NotificationTrigger } from '../../common/enums/notification.enums';
import { StaffRole, StaffUserType } from '../../common/enums/identity.enums';
import { LoginOtpIssuedEvent } from '../identity/events/auth-otp.events';
import {
  PasswordResetCompletedEvent,
  PasswordResetRequestedEvent,
} from '../identity/events/password-reset.events';
import {
  StaffCreatedEvent,
  StaffDisabledEvent,
  StaffPasswordChangedEvent,
} from '../identity/events/staff.events';
import { IdentityEventListenersService } from './identity-event-listeners.service';
import { NotificationRecipient } from './interfaces/notification-recipient.interface';
import { NotificationService } from './notification.service';

type DispatchCall = [NotificationTrigger, string, NotificationRecipient, Record<string, unknown>];

describe('IdentityEventListenersService', () => {
  let notificationService: { dispatch: jest.Mock };
  let departmentsService: { findById: jest.Mock };
  let branchesService: { findById: jest.Mock };
  let staffService: { findById: jest.Mock };
  let listener: IdentityEventListenersService;

  beforeEach(() => {
    notificationService = { dispatch: jest.fn().mockResolvedValue(undefined) };
    departmentsService = { findById: jest.fn().mockResolvedValue({ name: 'Operations' }) };
    branchesService = { findById: jest.fn().mockResolvedValue({ name: 'Head Office' }) };
    staffService = {
      findById: jest.fn().mockResolvedValue({ firstName: 'Chidi', lastName: 'Eze' }),
    };
    listener = new IdentityEventListenersService(
      notificationService as unknown as NotificationService,
      departmentsService as never,
      branchesService as never,
      staffService as never,
    );
  });

  describe('handleStaffCreated', () => {
    it('dispatches STAFF_WELCOME with resolved department/branch names, role, userType, and the temporary password', async () => {
      const event: StaffCreatedEvent = {
        staffId: new Types.ObjectId().toString(),
        firstName: 'Ada',
        lastName: 'Okoye',
        email: 'ada@example.com',
        phoneNumber: '08012345678',
        role: StaffRole.MANAGER,
        // Deliberately not the role-derived default (Reviewer) — userType is
        // freely chosen at creation time, independent of role. Proves this
        // listener passes the event's own value through rather than
        // re-deriving it from `role`.
        userType: StaffUserType.AUTHORIZER,
        departmentId: new Types.ObjectId().toString(),
        branchId: new Types.ObjectId().toString(),
        temporaryPassword: 'Tmp!2345Word',
      };

      await listener.handleStaffCreated(event);

      expect(notificationService.dispatch).toHaveBeenCalledTimes(1);
      const [type, sourceEntityId, recipient, payload] = notificationService.dispatch.mock
        .calls[0] as DispatchCall;
      expect(type).toBe(NotificationTrigger.STAFF_WELCOME);
      expect(sourceEntityId).toBe(event.staffId);
      expect(recipient).toEqual({
        kind: 'STAFF',
        id: event.staffId,
        email: event.email,
        phone: event.phoneNumber,
      });
      expect(payload).toMatchObject({
        departmentName: 'Operations',
        branchName: 'Head Office',
        role: StaffRole.MANAGER,
        userType: StaffUserType.AUTHORIZER,
        temporaryPassword: event.temporaryPassword,
      });
    });

    it('still dispatches (with blank names) if department/branch lookup fails', async () => {
      departmentsService.findById.mockRejectedValue(new Error('not found'));
      branchesService.findById.mockRejectedValue(new Error('not found'));
      const event: StaffCreatedEvent = {
        staffId: new Types.ObjectId().toString(),
        firstName: 'Tunde',
        lastName: 'Bakare',
        email: 'tunde@example.com',
        phoneNumber: '08087654321',
        role: StaffRole.MARKETER,
        userType: StaffUserType.INITIATOR,
        departmentId: new Types.ObjectId().toString(),
        branchId: new Types.ObjectId().toString(),
        temporaryPassword: 'Tmp!9999Word',
      };

      await expect(listener.handleStaffCreated(event)).resolves.toBeUndefined();
      const [, , , payload] = notificationService.dispatch.mock.calls[0] as DispatchCall;
      expect(payload).toMatchObject({ departmentName: '', branchName: '', userType: 'Initiator' });
    });
  });

  describe('handleLoginOtpIssued', () => {
    it('dispatches LOGIN_OTP with the code and recipient', async () => {
      const event: LoginOtpIssuedEvent = {
        staffId: new Types.ObjectId().toString(),
        firstName: 'Ada',
        email: 'ada@example.com',
        phoneNumber: '08012345678',
        code: '654321',
        expiresAt: new Date(Date.now() + 60_000),
      };

      await listener.handleLoginOtpIssued(event);

      expect(notificationService.dispatch).toHaveBeenCalledWith(
        NotificationTrigger.LOGIN_OTP,
        event.staffId,
        { kind: 'STAFF', id: event.staffId, email: event.email, phone: event.phoneNumber },
        expect.objectContaining({ code: '654321', firstName: 'Ada' }),
      );
    });
  });

  describe('handlePasswordResetRequested', () => {
    it('dispatches PASSWORD_RESET_OTP to the email only (no phone)', async () => {
      const event: PasswordResetRequestedEvent = {
        staffId: new Types.ObjectId().toString(),
        firstName: 'Ada',
        email: 'ada@example.com',
        code: '112233',
        expiresAt: new Date(Date.now() + 60_000),
      };

      await listener.handlePasswordResetRequested(event);

      expect(notificationService.dispatch).toHaveBeenCalledWith(
        NotificationTrigger.PASSWORD_RESET_OTP,
        event.staffId,
        { kind: 'STAFF', id: event.staffId, email: event.email, phone: null },
        expect.objectContaining({ code: '112233', firstName: 'Ada' }),
      );
    });
  });

  describe('handlePasswordResetCompleted', () => {
    it('dispatches PASSWORD_RESET_CONFIRMATION to the email only (no phone)', async () => {
      const event: PasswordResetCompletedEvent = {
        staffId: new Types.ObjectId().toString(),
        firstName: 'Ada',
        email: 'ada@example.com',
      };

      await listener.handlePasswordResetCompleted(event);

      expect(notificationService.dispatch).toHaveBeenCalledWith(
        NotificationTrigger.PASSWORD_RESET_CONFIRMATION,
        event.staffId,
        { kind: 'STAFF', id: event.staffId, email: event.email, phone: null },
        expect.objectContaining({ firstName: 'Ada' }),
      );
    });
  });

  describe('handleStaffPasswordChanged', () => {
    it('dispatches STAFF_PASSWORD_CHANGED to the email only (no phone)', async () => {
      const event: StaffPasswordChangedEvent = {
        staffId: new Types.ObjectId().toString(),
        firstName: 'Ada',
        email: 'ada@example.com',
      };

      await listener.handleStaffPasswordChanged(event);

      expect(notificationService.dispatch).toHaveBeenCalledWith(
        NotificationTrigger.STAFF_PASSWORD_CHANGED,
        event.staffId,
        { kind: 'STAFF', id: event.staffId, email: event.email, phone: null },
        expect.objectContaining({ firstName: 'Ada' }),
      );
    });
  });

  describe('handleStaffDisabled', () => {
    it('dispatches ACCOUNT_DISABLED with the reason and resolved disabledByName', async () => {
      const event: StaffDisabledEvent = {
        staffId: new Types.ObjectId().toString(),
        firstName: 'Ada',
        email: 'ada@example.com',
        phoneNumber: '08012345678',
        reason: 'Policy violation',
        disabledByStaffId: new Types.ObjectId().toString(),
        disabledAt: new Date(),
      };

      await listener.handleStaffDisabled(event);

      expect(staffService.findById).toHaveBeenCalledWith(event.disabledByStaffId);
      expect(notificationService.dispatch).toHaveBeenCalledWith(
        NotificationTrigger.ACCOUNT_DISABLED,
        event.staffId,
        { kind: 'STAFF', id: event.staffId, email: event.email, phone: event.phoneNumber },
        expect.objectContaining({
          firstName: 'Ada',
          reason: 'Policy violation',
          disabledByName: 'Chidi Eze',
        }),
      );
    });

    it('falls back to a generic disabledByName if the lookup fails', async () => {
      staffService.findById.mockRejectedValue(new Error('not found'));
      const event: StaffDisabledEvent = {
        staffId: new Types.ObjectId().toString(),
        firstName: 'Ada',
        email: 'ada@example.com',
        phoneNumber: '08012345678',
        reason: 'Policy violation',
        disabledByStaffId: new Types.ObjectId().toString(),
        disabledAt: new Date(),
      };

      await expect(listener.handleStaffDisabled(event)).resolves.toBeUndefined();
      const [, , , payload] = notificationService.dispatch.mock.calls[0] as DispatchCall;
      expect(payload).toMatchObject({ disabledByName: 'An administrator' });
    });
  });
});

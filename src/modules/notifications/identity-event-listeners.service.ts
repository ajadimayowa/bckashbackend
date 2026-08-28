import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import { NotificationTrigger } from '../../common/enums/notification.enums';
import { BranchesService } from '../branches/branches.service';
import { DepartmentsService } from '../identity/departments.service';
import { LOGIN_OTP_ISSUED_EVENT, LoginOtpIssuedEvent } from '../identity/events/auth-otp.events';
import {
  PASSWORD_RESET_COMPLETED_EVENT,
  PASSWORD_RESET_REQUESTED_EVENT,
  PasswordResetCompletedEvent,
  PasswordResetRequestedEvent,
} from '../identity/events/password-reset.events';
import {
  STAFF_CREATED_EVENT,
  STAFF_DISABLED_EVENT,
  STAFF_PASSWORD_CHANGED_EVENT,
  StaffCreatedEvent,
  StaffDisabledEvent,
  StaffPasswordChangedEvent,
} from '../identity/events/staff.events';
import { StaffService } from '../identity/staff.service';
import { NotificationRecipient } from './interfaces/notification-recipient.interface';
import { NotificationService } from './notification.service';

/**
 * Listens for the IdentityModule events that need a notification but can't
 * call `NotificationService`/`NOTIFICATION_PORT` directly without creating
 * a module import cycle (NotificationsModule already imports IdentityModule)
 * — see STAFF_CREATED_EVENT's, LOGIN_OTP_ISSUED_EVENT's, STAFF_DISABLED_EVENT's,
 * and password-reset.events.ts's own doc comments. `STAFF_CREATED_EVENT`,
 * `LOGIN_OTP_ISSUED_EVENT`, and `PASSWORD_RESET_REQUESTED_EVENT` each carry
 * a plaintext credential (temporaryPassword / OTP code / reset code) that
 * exists only in-memory for the duration of the matching handler.
 */
@Injectable()
export class IdentityEventListenersService {
  constructor(
    private readonly notificationService: NotificationService,
    private readonly departmentsService: DepartmentsService,
    private readonly branchesService: BranchesService,
    private readonly staffService: StaffService,
  ) {}

  @OnEvent(STAFF_CREATED_EVENT)
  async handleStaffCreated(event: StaffCreatedEvent): Promise<void> {
    const [department, branch] = await Promise.all([
      this.departmentsService.findById(event.departmentId).catch(() => null),
      this.branchesService.findById(event.branchId).catch(() => null),
    ]);

    const recipient: NotificationRecipient = {
      kind: 'STAFF',
      id: event.staffId,
      email: event.email,
      phone: event.phoneNumber,
    };

    await this.notificationService.dispatch(
      NotificationTrigger.STAFF_WELCOME,
      event.staffId,
      recipient,
      {
        firstName: event.firstName,
        lastName: event.lastName,
        email: event.email,
        role: event.role,
        departmentName: department?.name ?? '',
        branchName: branch?.name ?? '',
        userType: event.userType,
        temporaryPassword: event.temporaryPassword,
      },
    );
  }

  @OnEvent(LOGIN_OTP_ISSUED_EVENT)
  async handleLoginOtpIssued(event: LoginOtpIssuedEvent): Promise<void> {
    const recipient: NotificationRecipient = {
      kind: 'STAFF',
      id: event.staffId,
      email: event.email,
      phone: event.phoneNumber,
    };

    await this.notificationService.dispatch(
      NotificationTrigger.LOGIN_OTP,
      event.staffId,
      recipient,
      {
        firstName: event.firstName,
        code: event.code,
        expiresAt: event.expiresAt,
      },
    );
  }

  @OnEvent(PASSWORD_RESET_REQUESTED_EVENT)
  async handlePasswordResetRequested(event: PasswordResetRequestedEvent): Promise<void> {
    // Email only, by design — see NotificationTrigger.PASSWORD_RESET_OTP's
    // own comment. No phone on this recipient means the queue processor
    // never attempts an SMS leg for it.
    const recipient: NotificationRecipient = {
      kind: 'STAFF',
      id: event.staffId,
      email: event.email,
      phone: null,
    };

    await this.notificationService.dispatch(
      NotificationTrigger.PASSWORD_RESET_OTP,
      event.staffId,
      recipient,
      {
        firstName: event.firstName,
        code: event.code,
        expiresAt: event.expiresAt,
      },
    );
  }

  @OnEvent(PASSWORD_RESET_COMPLETED_EVENT)
  async handlePasswordResetCompleted(event: PasswordResetCompletedEvent): Promise<void> {
    const recipient: NotificationRecipient = {
      kind: 'STAFF',
      id: event.staffId,
      email: event.email,
      phone: null,
    };

    await this.notificationService.dispatch(
      NotificationTrigger.PASSWORD_RESET_CONFIRMATION,
      event.staffId,
      recipient,
      { firstName: event.firstName },
    );
  }

  @OnEvent(STAFF_PASSWORD_CHANGED_EVENT)
  async handleStaffPasswordChanged(event: StaffPasswordChangedEvent): Promise<void> {
    const recipient: NotificationRecipient = {
      kind: 'STAFF',
      id: event.staffId,
      email: event.email,
      phone: null,
    };

    await this.notificationService.dispatch(
      NotificationTrigger.STAFF_PASSWORD_CHANGED,
      event.staffId,
      recipient,
      { firstName: event.firstName },
    );
  }

  @OnEvent(STAFF_DISABLED_EVENT)
  async handleStaffDisabled(event: StaffDisabledEvent): Promise<void> {
    // The event only carries the disabling staff member's id (see
    // STAFF_DISABLED_EVENT's own doc comment) — resolved to a display name
    // here, same shape as STAFF_CREATED_EVENT's department/branch lookup
    // above. A lookup failure (id somehow stale) falls back to a generic
    // label rather than failing the whole notification.
    const disabledByStaff = await this.staffService
      .findById(event.disabledByStaffId)
      .catch(() => null);

    const recipient: NotificationRecipient = {
      kind: 'STAFF',
      id: event.staffId,
      email: event.email,
      phone: event.phoneNumber,
    };

    await this.notificationService.dispatch(
      NotificationTrigger.ACCOUNT_DISABLED,
      event.staffId,
      recipient,
      {
        firstName: event.firstName,
        reason: event.reason,
        disabledByName: disabledByStaff
          ? `${disabledByStaff.firstName} ${disabledByStaff.lastName}`
          : 'An administrator',
        disabledAt: event.disabledAt,
      },
    );
  }
}

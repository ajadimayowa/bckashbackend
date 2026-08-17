import { Injectable } from '@nestjs/common';

import { CustomerService } from '../../customers/customer.service';
import { NotificationRecipient } from '../interfaces/notification-recipient.interface';

/**
 * Customer-facing notifications (loan raised, disbursement, repayment,
 * penalty) resolve straight off the Customer record — `phoneNumber` is
 * mandatory at KYC (see Phase 5), `email` is optional and skipped
 * gracefully at the dispatch level when absent (see
 * `NotificationDispatchProcessor`) rather than failing the whole
 * notification.
 */
@Injectable()
export class CustomerRecipientResolver {
  constructor(private readonly customerService: CustomerService) {}

  async resolve(customerId: string): Promise<NotificationRecipient> {
    const customer = await this.customerService.findById(customerId);
    return {
      kind: 'CUSTOMER',
      id: customerId,
      email: customer.email,
      phone: customer.phoneNumber,
    };
  }
}

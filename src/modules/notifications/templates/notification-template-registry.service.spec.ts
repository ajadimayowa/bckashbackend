import { NotificationTrigger } from '../../../common/enums/notification.enums';
import { NotificationTemplateRegistry } from './notification-template-registry.service';

describe('NotificationTemplateRegistry', () => {
  it('registers a template for every NotificationTrigger value at module init, without throwing', () => {
    const registry = new NotificationTemplateRegistry();
    expect(() => registry.onModuleInit()).not.toThrow();
  });

  it('getTemplate returns a template for every NotificationTrigger value', () => {
    const registry = new NotificationTemplateRegistry();
    for (const type of Object.values(NotificationTrigger)) {
      const template = registry.getTemplate(type);
      expect(template.type).toBe(type);
    }
  });

  it('every registered template renders a non-empty email subject/body and SMS body from a realistic payload', () => {
    const registry = new NotificationTemplateRegistry();
    const payload = {
      memberAmountKobo: 50_000,
      groupCumulativeAmountKobo: 200_000,
      amountKobo: 10_000,
      channel: 'TRANSFER',
      context: 'Installment 1 overdue penalty',
      reason: 'BVN mismatch',
      loanId: 'loan-1',
      status: 'VERIFIED',
      entityType: 'LOAN',
      outcome: 'APPROVED',
      repaymentRecordId: 'repayment-1',
      details: 'Q1 funding',
    };
    for (const type of Object.values(NotificationTrigger)) {
      const template = registry.getTemplate(type);
      expect(template.emailSubject?.(payload).length).toBeGreaterThan(0);
      expect(template.emailBody?.(payload).length).toBeGreaterThan(0);
      expect(template.smsBody?.(payload).length).toBeGreaterThan(0);
    }
  });
});

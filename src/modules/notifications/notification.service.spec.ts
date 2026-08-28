import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';

import { NotificationCategory, NotificationTrigger } from '../../common/enums/notification.enums';
import { NotificationService } from './notification.service';

function fakeConfigService(): ConfigService {
  return {
    get: () => ({ maxAttempts: 5, backoffBaseDelayMs: 5000 }),
  } as unknown as ConfigService;
}

describe('NotificationService.dispatch', () => {
  it('builds a stable job id from (type, sourceEntityId, recipientId) and passes the configured retry policy', async () => {
    const add = jest.fn().mockResolvedValue(undefined);
    const queue = { add } as unknown as Queue;
    const service = new NotificationService(queue, fakeConfigService());
    const recipient = {
      kind: 'CUSTOMER' as const,
      id: 'cust-1',
      email: null,
      phone: '2348012345678',
    };

    await service.dispatch(NotificationTrigger.LOAN_RAISED, 'loan-1', recipient, {
      amountKobo: 1_000,
    });

    expect(add).toHaveBeenCalledWith(
      NotificationTrigger.LOAN_RAISED,
      {
        type: NotificationTrigger.LOAN_RAISED,
        recipient,
        payload: { amountKobo: 1_000 },
        sourceEntityId: 'loan-1',
        category: NotificationCategory.GENERAL,
        branchId: null,
      },
      expect.objectContaining({
        jobId: 'LOAN_RAISED:loan-1:cust-1',
        attempts: 5,
        backoff: { type: 'exponential', delay: 5000 },
      }),
    );
  });

  it('folds the optional inAppMeta (category/branchId) into the job data', async () => {
    const add = jest.fn().mockResolvedValue(undefined);
    const queue = { add } as unknown as Queue;
    const service = new NotificationService(queue, fakeConfigService());
    const recipient = { kind: 'STAFF' as const, id: 'staff-1', email: 's@example.com', phone: null };

    await service.dispatch(
      NotificationTrigger.BRANCH_FUNDING_RECORDED,
      'funding-1',
      recipient,
      { amountKobo: 500 },
      { category: NotificationCategory.BRANCH_MANAGER, branchId: 'branch-1' },
    );

    expect(add).toHaveBeenCalledWith(
      NotificationTrigger.BRANCH_FUNDING_RECORDED,
      expect.objectContaining({ category: NotificationCategory.BRANCH_MANAGER, branchId: 'branch-1' }),
      expect.anything(),
    );
  });

  it('produces the same job id for two calls with identical (type, sourceEntityId, recipientId)', async () => {
    const add = jest.fn().mockResolvedValue(undefined);
    const queue = { add } as unknown as Queue;
    const service = new NotificationService(queue, fakeConfigService());
    const recipient = {
      kind: 'CUSTOMER' as const,
      id: 'cust-2',
      email: null,
      phone: '2348012345678',
    };

    await service.dispatch(NotificationTrigger.PENALTY_CHARGED, 'penalty-1', recipient, {});
    await service.dispatch(NotificationTrigger.PENALTY_CHARGED, 'penalty-1', recipient, {});

    const jobIds = add.mock.calls.map((call: unknown[]) => (call[2] as { jobId: string }).jobId);
    expect(jobIds[0]).toBe(jobIds[1]);
  });
});

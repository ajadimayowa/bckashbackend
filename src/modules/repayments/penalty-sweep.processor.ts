import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, OnModuleInit } from '@nestjs/common';
import { Job, Queue } from 'bullmq';

import {
  PENALTY_SWEEP_CRON,
  PENALTY_SWEEP_DAILY_JOB_ID,
  PENALTY_SWEEP_QUEUE,
} from './penalty-sweep.queue';
import { PenaltySweepService } from './penalty-sweep.service';

/**
 * Thin wrapper — every actual sweep decision lives in
 * `PenaltySweepService.runDailySweep`, which is fully unit-testable without
 * BullMQ/Redis in the loop (see that class's own doc comment and
 * PHASE_9_NOTES.md). This class exists only to (a) schedule the daily
 * repeatable job and (b) let a job on the `penalty-sweep` queue trigger the
 * sweep.
 */
@Processor(PENALTY_SWEEP_QUEUE)
export class PenaltySweepProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(PenaltySweepProcessor.name);

  constructor(
    private readonly penaltySweepService: PenaltySweepService,
    @InjectQueue(PENALTY_SWEEP_QUEUE) private readonly queue: Queue,
  ) {
    super();
  }

  async onModuleInit(): Promise<void> {
    // upsertJobScheduler (idempotent — safe on every boot, replaces rather
    // than duplicating an existing schedule under the same id) registers the
    // recurring trigger; the actual work happens in `process` below.
    await this.queue.upsertJobScheduler(
      PENALTY_SWEEP_DAILY_JOB_ID,
      { pattern: PENALTY_SWEEP_CRON },
      { name: PENALTY_SWEEP_DAILY_JOB_ID },
    );
  }

  async process(job: Job): Promise<void> {
    this.logger.log(`Running penalty sweep (job ${job.id})`);
    const result = await this.penaltySweepService.runDailySweep();
    this.logger.log(
      `Penalty sweep job ${job.id} complete: ${JSON.stringify({
        penaltyChargesApplied: result.penaltyChargesApplied,
        liquidationDelayChargesApplied: result.liquidationDelayChargesApplied,
        accountsAtPenaltyCap: result.accountsAtPenaltyCap.length,
        liquidationsAtDelayChargeCap: result.liquidationsAtDelayChargeCap.length,
      })}`,
    );
  }
}

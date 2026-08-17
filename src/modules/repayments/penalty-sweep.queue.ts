/** Named exactly as anticipated in app.module.ts's Phase 1/2 BullMQ comment. */
export const PENALTY_SWEEP_QUEUE = 'penalty-sweep';
export const PENALTY_SWEEP_DAILY_JOB_ID = 'penalty-sweep-daily';
/** 01:00 server time, daily — after most overnight batch/reconciliation activity, before business hours. */
export const PENALTY_SWEEP_CRON = '0 1 * * *';

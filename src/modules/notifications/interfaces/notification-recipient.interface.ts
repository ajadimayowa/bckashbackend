/**
 * The two recipient shapes `NotificationService.dispatch` accepts — built by
 * the resolvers in `recipient-resolution/`, never constructed ad hoc by a
 * `NotificationPort` method. `email`/`phone` are already resolved values
 * (not ids the queue processor has to look up), so a job's payload is
 * self-contained and replayable without a fresh DB read on every retry.
 */
export type NotificationRecipient =
  | { kind: 'CUSTOMER'; id: string; email: string | null; phone: string }
  | { kind: 'STAFF'; id: string; email: string; phone: string | null };

# notifications

Email/SMS dispatch (Brevo/Termii). Built in Phase 11.

**Phase 8 note:** `schemas/pending-notification-log.schema.ts` already exists,
written by the loans module's `NotificationPort` stub
(`modules/loans/notifications/pending-notification-log.port.ts`). Phase 11
must drain the `dispatched: false` backlog already sitting in that collection
— see that schema file's doc comment and PHASE_8_NOTES.md.

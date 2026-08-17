# Phase 11 Notes — Notifications (real email/SMS dispatch, `NotificationPort` rebinding)

`src/modules/notifications/`, `src/platform/integrations/brevo/`,
`src/platform/integrations/termii/`. **382 unit tests passing** (up from
344 — 38 new: 37 in the notifications/brevo/termii trees, 1 Phase 9
regression test), 5 e2e tests (up from 1 — a new live-Redis suite, see
below), `npm audit --omit=dev` → 0 vulnerabilities. Full typecheck/lint/
format/build clean. Boot smoke test run against the real Atlas dev DB and
deleted (see "Boot smoke test" below).

## TERMII_SENDER_ID — found, not guessed

The brief flagged this as needing confirmation ("check the existing
codebase/Termii dashboard for it; don't guess a placeholder into production
config"). It was already present in `.env`: `TERMII_SENDER_ID=FloathHub`,
alongside a real `TERMII_API_KEY` and `TERMII_BASE_URL=https://v3.api.termii.com`
— pre-existing, populated config, not a placeholder. Used as-is.

## Phone-number normalization — implemented, NOT live-verified (user's explicit choice)

Asked directly: verifying the `08...`→`234...` normalization against a real
Termii call means sending one real, billed SMS to a real phone number — an
outward-facing, costed action I flagged rather than doing unilaterally. The
user chose to skip live verification. `normalizePhoneNumberForTermii`
(`platform/integrations/termii/phone-number.util.ts`) implements Termii's
own documented convention (strip a leading `0` and prepend `234`; strip a
leading `+` if already international; prepend `234` as a last resort if
neither form matches) and is unit-tested for every input shape, but **this
has not been confirmed against a live Termii response** — flagged clearly in
the util's own doc comment. If a real SMS ever bounces specifically on
number format, this is the first place to check.

## Config reconciliation — brief's env var names vs. this codebase's actual ones

The brief's SMTP/SMS config sketch (`BREVO_SMTP_*`, `MAIL_FROM_NAME`/
`MAIL_FROM_EMAIL`, `SMS_SENDER_PROVIDER`, `SMS_SENDER_APIKEY`) didn't exactly
match what was already established here:

- **Brevo**: `.env` already had `BREVO_API_KEY`/`BREVO_SENDER_EMAIL`/
  `BREVO_SENDER_NAME` (a pre-existing Phase 1/2 REST-API-shaped
  `BrevoConfig`) *and* a commented-out SMTP block
  (`BREVO_SMTP_HOST/PORT/SECURE/LOGIN/KEY`) with real-looking values —
  `BREVO_SMTP_KEY` matching `BREVO_API_KEY` exactly, which is correct: Brevo's
  SMTP relay uses your API key as the SMTP password. Since the brief
  explicitly wants SMTP via Nodemailer, this block was **uncommented and
  used as-is** rather than left disabled or reinvented under new names.
  `BrevoConfig` gained a `smtp` sub-object and a `useMock` flag (mirroring
  BVN/S3's own `useMock` convention: explicit override, or mock whenever SMTP
  credentials are absent). `senderEmail`/`senderName` remain the From-header
  source; a new optional `MAIL_FROM` env var (unset by default) provides the
  brief's requested full-string override — this one genuinely didn't exist
  before, so it was added rather than reconciled to something pre-existing.
- **Termii**: the brief's `SMS_SENDER_PROVIDER`/`SMS_SENDER_APIKEY` map
  directly onto the already-established `TERMII_BASE_URL`/`TERMII_API_KEY` —
  reused rather than duplicated under new names. The `/api/sms/send` path is
  built in code (`real-sms.adapter.ts`), not a separate env var, since it's
  part of the API contract, not deployment-specific. `TermiiConfig` gained a
  `useMock` flag, same convention as Brevo/BVN/S3.
- **Retry policy**: `NOTIFICATION_MAX_ATTEMPTS`/`NOTIFICATION_BACKOFF_BASE_DELAY_MS`
  are new (default 5 / 5000ms), named constants per the brief's own
  instruction against hardcoded magic numbers.

All of this is additive/activating, not a rename of anything a caller
depended on — `env.validation.ts` updated to match.

## `NotificationPort` rebinding — grep evidence

```
Production DI (loans.module.ts):
  { provide: NOTIFICATION_PORT, useExisting: RealNotificationPort }

PendingNotificationLogPort (the Phase 8 stub) — only referenced in:
  loans.service.spec.ts, repayments-test-context.ts   (test fixtures only)
```

`RepaymentsModule` already imported `LoansModule` to reuse the
`LEDGER_POSTING_PORT`/`NOTIFICATION_PORT` bound singletons (Phase 9's own
comment anticipated exactly this) — the rebinding cascades transparently,
no changes needed there. `NotificationsModule` has no dependency on
`modules/loans` beyond one raw, read-only `Loan` schema registration (for
`sendVerificationEscalation`'s involved-parties resolution) — no circular
import.

## Template registry vs. `NotificationPort`'s real method surface — a deliberate distinction

The brief's own `NotificationType` list (10 values) and the instruction to
"implement every method the interface accumulated across Phases 8 and 9"
describe two different scopes, kept deliberately separate:

- **Template registry** (`NOTIFICATION_TEMPLATES`, `NotificationTemplateRegistry`):
  covers **11** values — all 10 from the brief's list, reconciled onto the
  pre-existing `NotificationTrigger` enum (`VERIFICATION_ESCALATION`→
  `VERIFICATION_ESCALATED`, `REPAYMENT_DISPUTE_RAISED`→`REPAYMENT_DISPUTED`,
  `PENALTY_APPLIED`→`PENALTY_CHARGED`, `WORKFLOW_REQUEST_OUTCOME`→
  `WORKFLOW_OUTCOME` — name variants of the same pre-existing Phase 1/2
  enum, not new parallel types; `STAFF_ONBOARDING_OUTCOME` was genuinely
  missing and added), plus the pre-existing `FUNDING_REMINDER` value (not in
  the brief's list, but already on the enum and free to template).
  `NotificationTemplateRegistry.onModuleInit` defensively asserts every
  enum value has a template, so a future enum addition without one fails
  loudly at boot.
- **`NotificationPort`**: implements exactly the **5** methods that have a
  real, wired call site — `sendLoanRaisedNotification`/
  `sendVerificationEscalation`/`sendDisbursementCompleted`/
  `sendPenaltyCharged` (Phase 8/9) plus `sendRepaymentDisputeRaised` (this
  phase's retrofit, below). `REPAYMENT_RECORDED`/`KYC_STATUS_CHANGED`/
  `STAFF_ONBOARDING_OUTCOME`/`ACCOUNT_DISABLED`/`WORKFLOW_REQUEST_OUTCOME`
  have templates ready but no caller anywhere in this codebase yet — verified
  by grep (no `sendXxx` method for any of them exists on `NotificationPort`,
  and no call site references them). These are forward-looking hooks,
  primarily for Phase 12 (HR) — flagged, not built further, since the brief
  didn't ask for new trigger points beyond the explicit retrofit.

**Two related gaps found and deliberately left alone** (confirmed real, out
of this phase's requested scope): `StaffService.disable`/`enable` (Phase 3)
never call any notification — there's no `sendAccountDisabled` method on
`NotificationPort` for them to call, and the brief's retrofit list named
only the repayment-dispute gap. `CustomerService`'s KYC status transitions
(Phase 5) never call one either. Both would need their own `NotificationPort`
method additions, same shape as this phase's retrofit — flagged for
Phase 12 or a future pass, not built speculatively here.

## Recipient resolution

`CustomerRecipientResolver` — trivial, straight off the `Customer` record.
`email: null` is passed through, not treated as an error; `NotificationDispatchProcessor`
skips the email leg gracefully when absent (tested: a customer with no
email still gets the SMS leg, dispatch doesn't fail as a whole).

`InvolvedPartiesResolver.resolveInvolvedParties` — built once, per the
brief, shared by `sendVerificationEscalation` (loan approval chain via a
new `WorkflowEngineService.getById`, and the Loan's own `raisedBy`) and
`sendRepaymentDisputeRaised` (the repayment approval chain, `recordedBy` as
initiator). Exactly the brief's own pseudocode: initiator + current branch
manager + every Admin/SuperAdmin who acted on the related request, falling
back to branch-level Admin/SuperAdmin when none has acted yet, deduplicated
via a `Set`. Tested for every one of those cases plus the "initiator is also
the branch manager" dedup case. Each resolved recipient gets its own
`dispatch()` call — verified explicitly (`toHaveBeenCalledTimes(n)` for n
resolved staff, never one combined job).

## A real, pre-existing bug found and fixed along the way

Writing `InvolvedPartiesResolver`'s test (`findActiveByRoleAndBranch`, a new
`StaffService` method this phase) surfaced a genuine bug: a raw string
`branchId` passed straight into `.find({ branchId, ... })` **does not
reliably auto-cast** against the schema's `Types.ObjectId` field in this
project's Mongoose 8.9.5 setup — the query silently matched nothing rather
than erroring. Isolated and confirmed directly (`.find({branchId: someString})`
→ 0 matches; `.find({branchId: new Types.ObjectId(someString)})` → correct
matches, same data). Fixed by explicitly casting in the new method — and,
since the exact same pattern already existed in `StaffService.findAll`
(used by the real `GET /staff?branchId=...` endpoint), **that was silently
broken too** — any branch-filtered staff listing returned an empty list.
Fixed there as well, with a doc comment on the method itself. Not a
speculative audit of the rest of the codebase for the same pattern (out of
this phase's scope), but flagged here in case other `branchId`/`departmentId`
raw-string filters elsewhere have the same latent issue.

## Idempotent backlog drain

`NotificationBacklogDrainService.drain()`: enqueue first (using the
`PendingNotificationLog._id` itself as the dispatch job's `sourceEntityId`,
so BullMQ's own job-id dedupe already protects a concurrent double-drain
racing the same row), **then** atomically mark `dispatched: true` via the
same conditional-update-on-the-flag pattern used elsewhere in this system
for exactly-once semantics (`RepaymentsService.applyToBalance`'s
`appliedToBalance` guard is the precedent). If enqueue throws, the entry is
left `dispatched: false` for the next run to retry — tested directly,
including "re-running the drain against already-dispatched entries is a
safe no-op" and "a crash mid-drain leaves the entry retriable, not stuck."

Explicit Admin-triggered endpoint (`POST /notifications/backlog/drain`), not
run on module init/every boot — per the brief's own stated lean, so a
backlog isn't silently drained (and potentially spamming customers) on an
unattended deploy.

**Tested against real accumulated entries from Phases 8–9's test runs?**
Checked directly against the real Atlas dev DB: **zero** `PendingNotificationLog`
documents exist there. Every prior phase's boot smoke test evidently cleaned
up after itself (or never happened to trigger a notification-worthy branch
during its run) — there was no real backlog sitting there to drain. This
phase's own boot smoke test (below) seeds several real entries into the
real DB via the exact same stub class Phase 8/9 used, then drains them for
real, as the closest honest equivalent to what the brief asked for. The
`--runInBand` unit suite separately covers the drain's logic exhaustively
against `mongodb-memory-server`.

## The Phase 9 retrofit — applied and tested

`RepaymentsService.raiseDispute` didn't call `NotificationPort` when built
(out of Phase 9's scope at the time). Added now: `NotificationPort` injected
(same pattern as the existing `LedgerPostingPort` injection), and
`raiseDispute` calls the new `sendRepaymentDisputeRaised` method after the
dispute is persisted, sourcing `relatedWorkflowRequestId` from
`workflowEngineService.getHistory(REPAYMENT_RECORD, repaymentId)` (the
original recording's two-step approval chain — see PHASE_9_NOTES.md).
Regression test added directly to `repayments.service.spec.ts` (not a new
file — this is Phase 9's own test file gaining a Phase 11 addition, flagged
in that test's own comment): confirms the call happens exactly once, with
the correct `repaymentRecordId`/`recordedBy`/`raisedBy`/`reason`.

## Queue mechanics — a new, deliberate live-Redis test dependency

The brief requires verifying BullMQ's *own* mechanics — stable-job-id
dedupe, real retry/backoff, dead-lettering on exhaustion — not just this
phase's business logic sitting on top of them. That can't be honestly done
without a real queue backend, which is a deliberate departure from
PHASE_9_NOTES.md's own precedent ("this project's established `npm test`
convention has never depended on a live Redis connection"). Resolved by
adding **`test/notification-dispatch.e2e-spec.ts`** — the first suite in
this project needing live Redis, isolated in `test/` (not the `--runInBand`
unit suite) so a missing Redis fails exactly one clearly-named e2e file,
not the whole gate. It:

- Boots the **real `AppModule`** (not a hand-assembled subset) with
  `MONGO_URI` overridden to an in-memory replica set (never touches Atlas),
  `BREVO_USE_MOCK`/`TERMII_USE_MOCK` forced `true` (never sends a real
  email/SMS), and `NOTIFICATION_MAX_ATTEMPTS`/`NOTIFICATION_BACKOFF_BASE_DELAY_MS`
  overridden low (3 attempts / 50ms base) so the retry/backoff test finishes
  in under a second of real backoff time rather than the production ~75s.
- Confirms `NOTIFICATION_PORT` resolves to `RealNotificationPort` in the
  *actual* production DI graph, and that calling it enqueues a real BullMQ
  job with **zero** `PendingNotificationLog` writes — proving the rebinding
  end-to-end, not just that the class compiles.
- Confirms two `dispatch()` calls with an identical `(type, sourceEntityId,
  recipientId)` result in exactly one adapter `send()` call — real BullMQ
  dedupe, not simulated.
- Confirms repeated adapter failure exhausts the (overridden) 3-attempt
  limit and produces exactly one `NotificationDeadLetterLog` entry with
  `attemptCount: 3` and the right `lastError`.
- `npm run test:e2e` now takes ~26s (was ~4s) and requires Redis running
  locally — already true of this dev environment (`REDIS_HOST=localhost`),
  confirmed via `redis-cli ping` before relying on it.

If Redis is ever unavailable when `test:e2e` runs (a fresh CI runner without
a Redis service, for instance), this file — and only this file — will fail
with a connection error; `health.e2e-spec.ts` and every unit test remain
unaffected.

## §3/§4 — everything else, briefly

- `EmailAdapter`/`SmsAdapter`: never throw (tested for both success and
  transport/network failure), mock variants selected via `useMock` follow
  the exact same factory pattern as `BvnIntegrationModule`. `SmsCallLog`
  written on every call, success or failure, by both the real and mock SMS
  adapters (same "mock still logs" precedent as `MockBvnVerificationAdapter`).
- `NotificationDispatchProcessor`: one job = one notification to one
  recipient; throws (triggering retry) if any *attempted* channel fails; a
  recipient with neither email nor phone logs a warning and resolves
  without retrying (retrying a permanently-missing contact method is
  pointless). Dead-letters only on the *final* attempt
  (`attemptsMade >= opts.attempts`), never an intermediate retry — the
  `channel` field on `NotificationDeadLetterLog` is singular per the
  brief's own schema; when both legs are attempted and both fail, it biases
  toward `EMAIL` (full detail of both failures is preserved in `lastError`)
  — a flagged simplification of a schema that assumes one channel per entry.
- No HTTP endpoint exposes `WorkflowEngineService.act()` directly — same as
  every prior phase.

## Deliverable

- `src/platform/integrations/brevo/`: `EmailAdapter` interface,
  `RealEmailAdapter` (Nodemailer, pooled SMTP transport built once),
  `MockEmailAdapter`, module.
- `src/platform/integrations/termii/`: `SmsAdapter` interface,
  `RealSmsAdapter`, `MockSmsAdapter`, `SmsCallLog` schema/service,
  `normalizePhoneNumberForTermii`, module.
- `src/modules/notifications/`: template registry (11 types),
  `NotificationDeadLetterLog` schema, `CustomerRecipientResolver`/
  `InvolvedPartiesResolver`, `NotificationService.dispatch`, BullMQ queue +
  `NotificationDispatchProcessor`, `NotificationBacklogDrainService` +
  admin endpoints, `RealNotificationPort`, module — rebound in
  `LoansModule` (cascading to `RepaymentsModule`).
- Small supporting additions: `WorkflowEngineService.getById`,
  `StaffService.findByIds`/`findActiveByRoleAndBranch` (plus the
  `findAll` bug fix above), `NOTIFICATIONS_MANAGE_CAPABILITY`,
  `STAFF_ONBOARDING_OUTCOME` enum value.
- The Phase 9 `raiseDispute` retrofit, tested.
- Full test suite per the brief's required-tests list, green: 382 unit
  tests, 5 e2e tests (including the new live-Redis suite).

## Verification gates — all green

`tsc --noEmit` clean · `eslint` clean · `prettier --check` clean ·
`nest build` clean · full unit suite: **45 suites / 382 tests** ·
`test:e2e`: **2 suites / 5 tests** (including the new live-Redis suite) ·
`npm audit --omit=dev`: 0 vulnerabilities · boot smoke test (real loan-raise
→ verification-escalation → disbursement → penalty-charge notifications,
plus a seeded-and-drained real `PendingNotificationLog` backlog, all against
the real Atlas dev DB and real Redis) run and deleted, all documents cleaned
up afterward.

Do not start Phase 12 (HR) until this is reviewed. Per the brief's own
framing, this is the last phase with a cross-phase port-rebinding
dependency — Phase 12 is largely self-contained. Two forward-looking flags
for whoever picks up Phase 12: `STAFF_ONBOARDING_OUTCOME` and
`ACCOUNT_DISABLED` already have templates registered and are ready for
`NotificationPort` methods once Phase 12 needs them.

# Phase 5 Notes — Customers/KYC, BVN Adapter, S3 Adapter, Staff BVN

`src/platform/integrations/bvn/`, `src/platform/integrations/s3/`, `src/platform/encryption/`,
`src/modules/customers/`, plus the Staff BVN extension in `src/modules/identity/`.
**160 unit tests passing** (up from 113), full-app boot smoke test confirms the
`CUSTOMER/CREATE` chain registers and boots cleanly with the mock BVN adapter
(no live credentials required).

## How the real BVN contract was confirmed

The brief pointed at `BVN_QUERY_BASEURL`/`BVN_QUERY_AUTH_EMAIL`/`BVN_QUERY_AUTH_PASSWORD`
as an "existing internal service" and asked me to confirm the exact login route
from the existing codebase. `/Users/kingfloat/Desktop/BCKash2.0` was in my
accessible working directories, and its `.env` matched those exact variable
names — so I read `bckashbackend2.0`'s own `src/config/authenticateBVNApiServer.ts`,
`src/controllers/bvn.controller.ts`, and `src/validators/bvn.validators.ts` to
confirm the real shapes, rather than guessing from the brief's summary alone.

**One real discrepancy found**: the brief describes auth as "login, then bearer
token on every call." The actual confirmed contract is login (`POST /initialisation/init`
with `{ Email, Password }`, capitalized) returning `{ Authorisation: { auth, accesscode } }`,
then **two** headers on every subsequent call: `X-Auth-Signature: {auth}` **and**
`Authorization: Bearer {accesscode}`. Built to the two-header reality
(`BvnProviderAuthService`/`BvnHttpClient`), not the brief's simplified
single-token description.

**Residual uncertainty, flagged rather than hidden**: the source app's own
response-formatting middleware wraps its `/bvn/*` route responses inconsistently
(`/bvn/verify` uses a `data` key that gets cleanly re-wrapped; `/bvn/verify-user-kyc-consent`
uses a `payload` key that gets *double*-wrapped by the same middleware — almost
certainly an accidental quirk in that codebase, not a deliberate contract). I
don't know whether the actual service reachable at `BVN_QUERY_BASEURL` in
production has this same quirk or a cleaner one — `bvn-response.util.ts`'s
`unwrapEnvelope()` defensively unwraps up to two levels of `{payload:...}`/`{data:...}`
nesting to cover every shape found during investigation, rather than hard-coding
one. **Please confirm against a real sandbox call before going live** — this is
inference from a related but not necessarily identical codebase, not a verified
live contract.

**Also confirmed and built to**: `verify-user-kyc-consent` returns HTTP 401
specifically to mean "OTP didn't match" (a business outcome), which collides
with the generic convention "401 = our session token expired." `BvnHttpClient.post()`
takes a `retryOnUnauthorized` flag, `false` on that one endpoint only, so a
wrong OTP doesn't waste a second billable provider call auto-retrying with the
same wrong code.

## Decisions you asked to have flagged explicitly

### 1. Create-in-draft-then-submit — confirmed to hold, with one caveat
A `Customer` + `KycRecord` are persisted the moment BVN consent is confirmed
(`confirmBvnConsent`), before the marketer has entered anything else, and
before `submitForApproval` ever calls the workflow engine. This is a real
deviation from Phase 3's staff pattern (nothing persisted until approval) —
justified because an OTP-confirmed BVN identity is a meaningfully stronger
guarantee than an unverified onboarding form. Reasoning holds, but one
caveat worth naming: `Customer.status` uses the *same* `PENDING_APPROVAL`
value both before and after `submitForApproval` is called (the schema you
specified has no separate "draft" state). I distinguish the two states
internally by checking whether a `WorkflowRequest` already exists for the
customer (`workflowEngineService.getHistory('CUSTOMER', customerId)`) rather
than adding an undocumented field — `submitForApproval` rejects a second
call this way. If you'd rather have an explicit `submittedAt` field for
clarity, that's a small change.

### 2. Biometric capture — made mandatory before submission, as you defaulted
`submitForApproval` throws `BadRequestException` if `KycRecord.biometricImageKey`
is unset. Matches your stated default; tested explicitly.

### 3. NIN correctly does not gate `kycStatus`/loan eligibility — confirmed
`recomputeKycStatus` is `VERIFIED` iff `bvnVerifiedAt` **and** `biometricImageKey`
are both set — tested with NIN absent, present-but-unverified, and
present-and-manually-verified, all three producing the identical `VERIFIED`
result. `isLoanEligible` is a thin wrapper (`kycStatus === VERIFIED`), so it
inherits the same guarantee — this is the method Phase 6 will call directly.
`PENDING_VERIFICATION` and `MISMATCH_FLAGGED` exist in the `KycStatus` enum
for schema completeness (matching the type given in the brief) but have no
producer in this phase's actual flow — BVN resolves synchronously via the
OTP round-trip, and there's no submitted-vs-provider mismatch opportunity
once identity fields are sourced *from* BVN rather than checked *against* it
after the fact (see the schema's own doc comment for the full reasoning).

### 4. Staff BVN enforcement level — chose (c), visibility only
No functional action is blocked by `bvnVerified: false` anywhere in this
codebase — confirmed by a test that creates an unverified staff member and
asserts their `status` is still `ACTIVE` with no other gate touched. What's
built: the flag + timestamps on `Staff`, `StaffService.verifyBvn()` (via
`directVerify`, no OTP — an Admin/HR compliance check, not customer
self-attestation), and `GET /staff/bvn/unverified` for an Admin dashboard.
Options (a) (block `act()`) and (b) (grace-period auto-disable) are real
policy decisions I did not implement — flagging for your call, not guessing.

### 5. Capability reuse: `manuallyVerifyNin` gated by `workflow:approve:CUSTOMER`
Reused rather than introducing `customer:nin_verify` — both represent "someone
empowered to finalize this customer's KYC standing," and capability sprawl
has a real cost (every new flat capability is one more thing to seed, document,
and keep in sync). Easy to split later since it's DB-seeded data.

### 6. "additionalFields" in `updateOnboardingDetails` interpreted as `email`
The only other optional `Customer` field not covered elsewhere in the flow
(address and NIN are both named explicitly in the brief). Flagging the
interpretation rather than silently picking it.

## A real bug found, fixed, and one near-miss reverted

**Found and fixed**: `CustomerService.getKycRecordOrThrow` queried
`kycRecordModel.findOne({ customerId })` with `customerId` as a plain string
— against `KycRecord.customerId`, a declared `Types.ObjectId` field — and
silently matched zero documents (confirmed via direct debugging: the same
query with the actual `ObjectId` value matched correctly; the string form did
not). Every test that captured biometric or read KYC data right after
`confirmBvnConsent` failed with `NotFoundException` until this was fixed by
explicitly casting: `findOne({ customerId: new Types.ObjectId(customerId) })`.

**Near-miss, reverted**: given how serious that class of bug is, I proactively
applied the same explicit-cast pattern to `BranchFundBalanceService` and
`BranchManagerAssignmentService` (Phase 3/4 code) as a precaution — Phase 8
depends heavily on the fund-balance primitive being correct. Their full test
suites then **failed** (duplicate-key errors, "not current manager" false
negatives) — clear proof those files were *not* affected by whatever caused
the `KycRecord` case, and forcing the cast there actively broke working
behavior. Reverted both files via `git checkout` back to their tested,
working Phase 3/4 state. I don't have a confirmed root cause for why one
non-`_id` ObjectId query-filter path was affected and two structurally
similar ones weren't — flagging the uncertainty honestly rather than
asserting a general Mongoose bug I haven't actually proven. If this class of
issue resurfaces, the fix (explicit `new Types.ObjectId(...)` in the
filter) is cheap and known.

## Other implementation notes

- **`EncryptionService`** (`platform/encryption/`) is a thin DI-friendly
  wrapper around the AES-256-GCM functions already built in
  `common/crypto/pii-encryption.ts` (unused until now) — the pure functions
  stay there because Mongoose `set`/`get` schema transforms run outside
  Nest's DI container and need to call them directly; this service is for
  ordinary application code. Marked `@Global()`, same reasoning as
  `AuditModule`/`RbacModule`.
- **`bvnConsentDetails`** is stored as a single encrypted JSON blob
  (`bvnConsentDetailsEncrypted`), not a queryable embedded sub-document —
  nothing needs to query into its fields, and it's exactly as sensitive as
  `bvn`/`nin` (name, DOB, phone, raw NIBSS payload), so it gets the same
  at-rest protection rather than a bespoke partial-encryption scheme.
- **KYC-data-read auditing** goes through one internal choke point
  (`CustomerService.readAndAudit`) that every decrypt/signed-URL call is
  routed through, so the `KYC_DATA_READ` audit call can't be forgotten at a
  future call site — tested for BVN, NIN, and biometric signed-URL reads.
- **`BvnCallLog`** (provider-call reconciliation) and the generic audit
  trail (`KYC_DATA_READ`, internal access accountability) are deliberately
  separate collections serving different purposes, per your instruction —
  never conflated.
- **NIBSS → BVN naming cleanup**: Phase 1's placeholder `NIBSS_*` env vars
  (never implemented against anything real) are replaced with `BVN_QUERY_*`
  now that the real contract is confirmed. `nibss` config namespace removed
  from `configuration.ts`/`env.validation.ts`.
- **S3 adapter**: real (`@aws-sdk/client-s3` + presigner) and mock
  (in-memory) implementations, selected via config the same way as the BVN
  adapter (`AWS_S3_USE_MOCK`, or auto-mock when credentials are absent).
  Required bucket policy/IAM role shape documented as a comment in
  `s3.service.ts` (scoped to the `kyc/*` prefix) — actual bucket/IAM
  provisioning is out of scope for this codebase, as instructed.
- **Mock BVN adapter** (`MockBvnVerificationAdapter`) is a real, deterministic
  stand-in — fixed OTP (`MOCK_BVN_OTP`), one-time-use consent tokens, still
  writes real `BvnCallLog` entries — used throughout this phase's own test
  suite, not just as a placeholder for "someday."

## Open questions before Phase 6

1. **Confirm the BVN response-envelope shape against a real sandbox call**
   before production use — see the "residual uncertainty" section above.
   `unwrapEnvelope()`'s defensive multi-level unwrap covers every shape found
   during investigation, but investigation ≠ verification.
2. **The create-in-draft-then-submit reasoning** (§1 above) — please confirm
   it still holds now that it's implemented, particularly the "same
   `PENDING_APPROVAL` value covers both draft and submitted" design.
3. **Staff BVN enforcement** — confirm option (c) (visibility only) is right,
   or tell me whether (a)/(b) should be scheduled for a specific later phase.

`isLoanEligible` is tested and trustworthy — ready for Phase 6 (Groups) to
depend on it directly, per your instruction.

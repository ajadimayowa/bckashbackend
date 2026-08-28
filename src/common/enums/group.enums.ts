/**
 * Superseded from a Phase 2 forward-looking placeholder (`DRAFT` /
 * `PENDING_REVIEW` / `PENDING_APPROVAL` / `APPROVED` / `REJECTED`, unused
 * anywhere in the codebase) once Phase 6's actual spec confirmed the real
 * shape: no PENDING_* status on Group *creation* — same pattern as
 * StaffStatus (see identity.enums.ts), a Group document doesn't exist until
 * its GROUP/CREATE workflow request is approved. See PHASE_6_NOTES.md.
 *
 * REJECTED is kept for symmetry/documentation of the state space, but — same
 * caveat as StaffStatus — a rejected creation never produces a Group document
 * at all, so no Group document today ever actually holds REJECTED.
 *
 * PENDING was added later, explicitly per product decision, for a
 * *different* moment than creation: an already-ACTIVE group whose
 * membership is changing. As soon as a new member is proposed
 * (GroupsService.initiateMemberAddition), the group flips ACTIVE -> PENDING
 * and is locked out of every other write (add/remove another member,
 * reassign leadership, edit-privilege requests — see
 * findActiveGroupOrThrow) and out of raising a loan
 * (isEligibleForLoanApplication) until that one addition resolves — flips
 * back to ACTIVE on approval, rejection, cancellation, or deletion of the
 * addition request (see GroupsService's own workflow-event handlers). Still
 * fully readable while PENDING (see findGroupOrThrow) — only writes/lending
 * are blocked, not visibility.
 */
export enum GroupStatus {
  ACTIVE = 'ACTIVE',
  PENDING = 'PENDING',
  REJECTED = 'REJECTED',
}

export enum GroupMemberRole {
  GROUP_HEAD = 'GROUP_HEAD',
  GROUP_HEAD_ASSISTANT = 'GROUP_HEAD_ASSISTANT',
  COORDINATOR = 'COORDINATOR',
  MEMBER = 'MEMBER',
}

/**
 * The three roles with an "exactly one active holder per group" constraint
 * (see GroupMembershipSchema's partial unique indexes). MEMBER is
 * deliberately excluded — many active MEMBER rows per group are expected.
 */
export const LEADERSHIP_ROLES: readonly GroupMemberRole[] = [
  GroupMemberRole.GROUP_HEAD,
  GroupMemberRole.GROUP_HEAD_ASSISTANT,
  GroupMemberRole.COORDINATOR,
];

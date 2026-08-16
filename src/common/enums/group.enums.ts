/**
 * Superseded from a Phase 2 forward-looking placeholder (`DRAFT` /
 * `PENDING_REVIEW` / `PENDING_APPROVAL` / `APPROVED` / `REJECTED`, unused
 * anywhere in the codebase) once Phase 6's actual spec confirmed the real
 * shape: no PENDING_* status on Group itself — same pattern as StaffStatus
 * (see identity.enums.ts), a Group document doesn't exist until its
 * GROUP/CREATE workflow request is approved. See PHASE_6_NOTES.md.
 *
 * REJECTED is kept for symmetry/documentation of the state space, but — same
 * caveat as StaffStatus — a rejected creation never produces a Group document
 * at all, so no Group document today ever actually holds REJECTED.
 */
export enum GroupStatus {
  ACTIVE = 'ACTIVE',
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

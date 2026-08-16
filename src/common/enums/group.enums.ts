export enum GroupStatus {
  DRAFT = 'DRAFT',
  PENDING_REVIEW = 'PENDING_REVIEW',
  PENDING_APPROVAL = 'PENDING_APPROVAL',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
}

/**
 * Assigned automatically, in order, to the first three members onboarded into a
 * group; every member after that is a plain MEMBER. Exactly one active holder of
 * each of the three leadership roles is enforced per group at a time.
 */
export enum LeadershipRole {
  GROUP_HEAD = 'GROUP_HEAD',
  GROUP_HEAD_ASSISTANT = 'GROUP_HEAD_ASSISTANT',
  COORDINATOR = 'COORDINATOR',
  MEMBER = 'MEMBER',
}

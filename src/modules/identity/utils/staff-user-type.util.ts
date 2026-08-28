import { StaffRole, StaffUserType } from '../../../common/enums/identity.enums';

/**
 * The role-based fallback a Staff document's `userType` default resolves to
 * when a caller doesn't supply one (see Staff schema's `userType` prop) —
 * ONLY ever actually invoked for a legacy record created before `userType`
 * existed (see the schema prop's own doc comment); every *new* record goes
 * through `StaffService.resolveUserType` instead, which forces MARKETER to
 * INITIATOR and rejects REVIEWER outright for every other role. This
 * function's REVIEWER result for MANAGER is therefore now a real, if
 * unfortunate, consequence for any pre-existing Manager record that never
 * got an explicit userType: since the Initiator/Authorizer RBAC feature
 * (RbacService.resolveContext) treats REVIEWER as neither Initiator nor
 * Authorizer, such a record can act on nothing (initiate, review, or
 * approve) until an Admin/SuperAdmin explicitly reassigns it — this
 * function's mapping only decides what value gets backfilled onto the
 * legacy record in the first place, not what that value is allowed to do.
 * Historical mapping preserved as-is below (not retroactively rewritten to
 * INITIATOR/AUTHORIZER-only) so this stays a faithful record of what a
 * pre-existing document's value actually is/was:
 *
 * - MARKETER: initiates only → Initiator.
 * - MANAGER: initiates + reviews, but review is what distinguishes it from
 *   MARKETER ("the first pair of eyes reviewer role in most chains") → Reviewer.
 * - ADMIN / SUPERADMIN: review + approve, but approval is the final,
 *   defining authority → Authorizer.
 * - APPROVER: approves only → Authorizer.
 */
export function deriveStaffUserType(role: StaffRole): StaffUserType {
  switch (role) {
    case StaffRole.MARKETER:
      return StaffUserType.INITIATOR;
    case StaffRole.MANAGER:
      return StaffUserType.REVIEWER;
    case StaffRole.ADMIN:
    case StaffRole.SUPERADMIN:
    case StaffRole.APPROVER:
      return StaffUserType.AUTHORIZER;
  }
}

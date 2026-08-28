import { GroupStatus } from '../../../common/enums/group.enums';
import { GroupDocument, GroupEditPrivilegeStatus } from '../schemas/group.schema';

/** Whitelisted view of Group.editPrivilege — same shape as CustomerResponseDto's own EditPrivilegeResponseDto, minus the signature (no group-level equivalent). */
export class GroupEditPrivilegeResponseDto {
  status!: GroupEditPrivilegeStatus;
  reason!: string | null;
  requestedBy!: string | null;
  requestedAt!: Date | null;
  decidedBy!: string | null;
  decidedAt!: Date | null;
  decisionComment!: string | null;
}

/**
 * Adds `branchName` on top of the same raw `_id`-shaped wire format
 * GroupsController has always returned (the frontend's `RawGroup`/
 * `normalizeGroup` already handle that shape — see groups.types.ts's own
 * doc comment — so `_id`/`branchId` etc. are deliberately left as-is here,
 * not remapped to `id`). Without `branchName`, the Customers page's Groups
 * tab fell back to a client-side `branches.find(...)` lookup against the
 * redux `branches` list — which is only ever populated for org:manage-
 * capable roles (see lookupsSlice.ts) and therefore empty for a MARKETER/
 * MANAGER, silently showing the raw branch ObjectId to them instead of a name.
 */
export class GroupResponseDto {
  _id!: string;
  name!: string;
  branchId!: string;
  /** Resolved via GroupsService.resolveBranchNames — null only if the branch itself no longer exists. */
  branchName!: string | null;
  status!: GroupStatus;
  createdBy!: string;
  proposedLeaderName!: string | null;
  meetingDay!: string | null;
  meetingLocation!: string | null;
  expectedMemberCount!: number | null;
  editPrivilege!: GroupEditPrivilegeResponseDto;
  createdAt!: Date;
  updatedAt!: Date;

  static fromDocument(doc: GroupDocument, branchName: string | null): GroupResponseDto {
    const dto = new GroupResponseDto();
    dto._id = doc._id.toString();
    dto.name = doc.name;
    dto.branchId = doc.branchId.toString();
    dto.branchName = branchName;
    dto.status = doc.status;
    dto.createdBy = doc.createdBy.toString();
    dto.proposedLeaderName = doc.proposedLeaderName;
    dto.meetingDay = doc.meetingDay;
    dto.meetingLocation = doc.meetingLocation;
    dto.expectedMemberCount = doc.expectedMemberCount;
    dto.editPrivilege = {
      status: doc.editPrivilege.status,
      reason: doc.editPrivilege.reason,
      requestedBy: doc.editPrivilege.requestedBy?.toString() ?? null,
      requestedAt: doc.editPrivilege.requestedAt,
      decidedBy: doc.editPrivilege.decidedBy?.toString() ?? null,
      decidedAt: doc.editPrivilege.decidedAt,
      decisionComment: doc.editPrivilege.decisionComment,
    };
    dto.createdAt = doc.createdAt;
    dto.updatedAt = doc.updatedAt;
    return dto;
  }
}

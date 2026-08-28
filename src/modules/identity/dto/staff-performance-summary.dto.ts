/**
 * GET /staff/:id/performance — real counts, computed on request (not
 * cached/stored on the Staff document, so they're never stale). Cross-module
 * reads only (Customer.createdBy / Group.createdBy / Loan.raisedBy) — see
 * StaffService.getPerformanceSummary's own comment on why that's a raw
 * model injection rather than importing CustomersService/GroupsService/LoansService.
 */
export class StaffPerformanceSummaryDto {
  customersOnboarded!: number;
  activeGroups!: number;
  loansRaised!: number;
  lastLoginAt!: Date | null;
}

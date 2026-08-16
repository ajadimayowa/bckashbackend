/**
 * TODO(business rule): leave type taxonomy is not specified in the brief. Using a
 * conventional Nigerian-employer default set as a placeholder — confirm the real
 * list (and any per-type entitlement/day-count rules) before Phase 12 builds the
 * leave application flow on top of this schema.
 */
export enum LeaveType {
  ANNUAL = 'ANNUAL',
  SICK = 'SICK',
  MATERNITY = 'MATERNITY',
  PATERNITY = 'PATERNITY',
  COMPASSIONATE = 'COMPASSIONATE',
  UNPAID = 'UNPAID',
  OTHER = 'OTHER',
}

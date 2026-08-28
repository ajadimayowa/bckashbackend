/**
 * Shared by every schema in modules/platform-config. Money is always integer
 * **kobo**, rates/percentages are always integer **basis points** — the same
 * project-wide convention documented on loan-product.enums.ts.
 */

/**
 * Every config record in this module is append-only/versioned rather than
 * edited in place — proposing a change creates a brand-new record on
 * approval, and whichever record was previously ACTIVE (if any) is flipped
 * to INACTIVE in the same operation. "The latest active one is the active
 * one": at most one record per config type is ever ACTIVE at a time, and the
 * full version history (who proposed/approved each one, and when) stays
 * queryable rather than being overwritten. No REJECTED member here — same
 * reasoning as ProductStatus: a rejected proposal never persists a document
 * at all, it only ever lived in the WorkflowRequest.
 */
export enum ConfigRecordStatus {
  ACTIVE = 'ACTIVE',
  INACTIVE = 'INACTIVE',
}

export enum RepaymentFrequency {
  WEEKLY = 'WEEKLY',
  BIWEEKLY = 'BIWEEKLY',
  MONTHLY = 'MONTHLY',
}

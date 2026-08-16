import { ModuleName, StaffRole } from '../../../common/enums/identity.enums';

/**
 * What an upstream JWT auth guard is expected to attach to `req.user` once the
 * identity module (Phase 3) exists. RBAC depends only on this shape, not on the
 * identity module itself — keeps the dependency direction one-way
 * (identity → rbac, never the reverse).
 */
export interface AuthenticatedStaffPrincipal {
  staffId: string;
  role: StaffRole;
  branchId?: string;
}

/**
 * `AuthenticatedStaffPrincipal` enriched with resolved capabilities + module
 * access. Attached to `req.staffContext` by StaffContextGuard so downstream
 * guards/services never re-query RBAC for the same request.
 */
export interface ResolvedStaffContext extends AuthenticatedStaffPrincipal {
  capabilities: string[];
  modules: ModuleName[];
}

declare module 'express' {
  interface Request {
    /** Set by Phase 3's JWT auth guard once the identity module exists. */
    user?: AuthenticatedStaffPrincipal;
    /** Set by StaffContextGuard, downstream of `user` being populated. */
    staffContext?: ResolvedStaffContext;
  }
}

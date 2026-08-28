import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { ModuleName, StaffRole, StaffUserType } from '../../common/enums/identity.enums';
import { DEFAULT_ROLE_CAPABILITIES } from './constants/default-role-capabilities';
import {
  AuthenticatedStaffPrincipal,
  ResolvedStaffContext,
} from './interfaces/staff-context.interface';
import { RoleCapabilities, RoleCapabilitiesDocument } from './schemas/role-capabilities.schema';
import { StaffModuleAccess, StaffModuleAccessDocument } from './schemas/staff-module-access.schema';

@Injectable()
export class RbacService implements OnModuleInit {
  private readonly logger = new Logger(RbacService.name);

  constructor(
    @InjectModel(RoleCapabilities.name)
    private readonly roleCapabilitiesModel: Model<RoleCapabilitiesDocument>,
    @InjectModel(StaffModuleAccess.name)
    private readonly staffModuleAccessModel: Model<StaffModuleAccessDocument>,
  ) {}

  /**
   * Seed default capabilities on boot — but only for roles that don't already
   * have a document, via `$setOnInsert` + upsert. An Admin's later edits (through
   * the endpoint below) must never be silently overwritten by a redeploy.
   */
  async onModuleInit(): Promise<void> {
    await Promise.all(
      DEFAULT_ROLE_CAPABILITIES.map((seed) =>
        this.roleCapabilitiesModel
          .updateOne(
            { role: seed.role },
            { $setOnInsert: { role: seed.role, capabilities: seed.capabilities } },
            { upsert: true },
          )
          .exec(),
      ),
    );
    this.logger.log('Role capability seed check complete');
  }

  async getCapabilitiesForRole(role: StaffRole): Promise<string[]> {
    const doc = await this.roleCapabilitiesModel.findOne({ role }).lean().exec();
    return doc?.capabilities ?? [];
  }

  async getModulesForStaff(staffId: string): Promise<ModuleName[]> {
    const doc = await this.staffModuleAccessModel.findOne({ staffId }).lean().exec();
    return doc?.modules ?? [];
  }

  /**
   * Combines a role's capabilities with a staff member's module access into
   * one resolved context — then narrows the result by `principal.userType`
   * (see `filterCapabilitiesByUserType`'s own doc comment). This is the
   * SINGLE choke point for the Initiator/Authorizer RBAC feature: every
   * `@RequireCapability` guard and every `WorkflowEngineService.initiate()`/
   * `act()` call already only ever consults `capabilities` (never `role`
   * directly), so filtering it here enforces "only Initiator can initiate,
   * only Authorizer can review/approve" across every single workflow entity
   * type in the system with no changes needed to the engine, any domain
   * module, or any of their DTOs/controllers.
   */
  async resolveContext(principal: AuthenticatedStaffPrincipal): Promise<ResolvedStaffContext> {
    const [roleCapabilities, modules] = await Promise.all([
      this.getCapabilitiesForRole(principal.role),
      this.getModulesForStaff(principal.staffId),
    ]);
    const capabilities = this.filterCapabilitiesByUserType(roleCapabilities, principal.userType);

    return { ...principal, capabilities, modules };
  }

  /**
   * A role can hold `workflow:initiate:*`/`workflow:review:*`/
   * `workflow:approve:*` capabilities (see capabilities.ts's own naming-
   * convention comment) that a given STAFF MEMBER of that role isn't
   * personally allowed to exercise, per the Initiator/Authorizer RBAC rule:
   * a staff member flagged `userType: Initiator` may only ever *initiate* —
   * `workflow:review:*`/`workflow:approve:*` capabilities their role would
   * otherwise grant are stripped. A staff member flagged `Authorizer` may
   * only ever *review/approve* — `workflow:initiate:*` is stripped. Every
   * other, non-`workflow:*` capability (flat/operational ones like
   * `staff:disable`, `org:manage`, `loan:disbursement_ops`, ...) is
   * completely unaffected — this feature only governs the maker-checker
   * workflow engine's own three step actions, nothing else.
   *
   * `Reviewer` (the third, legacy StaffUserType value — see its own doc
   * comment) is treated the same as neither Initiator nor Authorizer here:
   * a Reviewer-flagged staff member (only possible on a pre-existing
   * record — new staff can no longer be created with this value, see
   * StaffService.resolveUserType) can neither initiate nor review/approve
   * anything until an Admin/SuperAdmin updates their userType. Flagged
   * as a deliberate, if blunt, resolution — the brief's model is binary
   * (Initiator vs Authorizer), with no enforced meaning for Reviewer.
   */
  private filterCapabilitiesByUserType(capabilities: string[], userType: StaffUserType): string[] {
    return capabilities.filter((capability) => {
      if (capability.startsWith('workflow:initiate:')) {
        return userType === StaffUserType.INITIATOR;
      }
      if (capability.startsWith('workflow:review:') || capability.startsWith('workflow:approve:')) {
        return userType === StaffUserType.AUTHORIZER;
      }
      return true;
    });
  }

  /** Admin-editable — gate the caller (controller) behind RBAC_MANAGE_CAPABILITY. */
  async setCapabilitiesForRole(role: StaffRole, capabilities: string[]): Promise<RoleCapabilities> {
    const doc = await this.roleCapabilitiesModel
      .findOneAndUpdate({ role }, { $set: { capabilities } }, { new: true, upsert: true })
      .lean()
      .exec();
    if (!doc) {
      // Unreachable with upsert: true + new: true — guarding for strict null checks.
      throw new Error(`Failed to upsert RoleCapabilities for role ${role}`);
    }
    return doc;
  }

  /**
   * Incremental complement to `setCapabilitiesForRole` (which replaces the
   * whole list — easy to accidentally revoke everything else with a stale
   * client-side copy). `$addToSet` is atomic and idempotent: granting a
   * capability the role already has is a no-op, not a duplicate entry.
   * Admin-editable — gate the caller (controller) behind RBAC_MANAGE_CAPABILITY.
   */
  async addCapabilityToRole(role: StaffRole, capability: string): Promise<RoleCapabilities> {
    const doc = await this.roleCapabilitiesModel
      .findOneAndUpdate(
        { role },
        { $addToSet: { capabilities: capability } },
        { new: true, upsert: true },
      )
      .lean()
      .exec();
    if (!doc) {
      // Unreachable with upsert: true + new: true — guarding for strict null checks.
      throw new Error(`Failed to upsert RoleCapabilities for role ${role}`);
    }
    return doc;
  }

  /** Symmetric with addCapabilityToRole — atomic, idempotent removal of a single capability. */
  async removeCapabilityFromRole(role: StaffRole, capability: string): Promise<RoleCapabilities> {
    const doc = await this.roleCapabilitiesModel
      .findOneAndUpdate(
        { role },
        { $pull: { capabilities: capability } },
        { new: true, upsert: true },
      )
      .lean()
      .exec();
    if (!doc) {
      // Unreachable with upsert: true + new: true — guarding for strict null checks.
      throw new Error(`Failed to upsert RoleCapabilities for role ${role}`);
    }
    return doc;
  }

  /** Admin-editable — gate the caller (controller) behind RBAC_MANAGE_CAPABILITY. */
  async setModulesForStaff(staffId: string, modules: ModuleName[]): Promise<StaffModuleAccess> {
    const doc = await this.staffModuleAccessModel
      .findOneAndUpdate({ staffId }, { $set: { modules } }, { new: true, upsert: true })
      .lean()
      .exec();
    if (!doc) {
      // Unreachable with upsert: true + new: true — guarding for strict null checks.
      throw new Error(`Failed to upsert StaffModuleAccess for staffId ${staffId}`);
    }
    return doc;
  }

  async listRoleCapabilities(): Promise<RoleCapabilities[]> {
    return this.roleCapabilitiesModel.find().lean().exec();
  }
}

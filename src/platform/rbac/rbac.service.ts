import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { ModuleName, StaffRole } from '../../common/enums/identity.enums';
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

  /** Combines a role's capabilities with a staff member's module access into one resolved context. */
  async resolveContext(principal: AuthenticatedStaffPrincipal): Promise<ResolvedStaffContext> {
    const [capabilities, modules] = await Promise.all([
      this.getCapabilitiesForRole(principal.role),
      this.getModulesForStaff(principal.staffId),
    ]);

    return { ...principal, capabilities, modules };
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

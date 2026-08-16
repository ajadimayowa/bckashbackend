import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

import { StaffRole } from '../../../common/enums/identity.enums';

export type RoleCapabilitiesDocument = HydratedDocument<RoleCapabilities>;

/**
 * DB-backed capability matrix, one document per role — seeded from
 * DEFAULT_ROLE_CAPABILITIES at boot and editable afterwards via the
 * `rbac:manage`-gated admin endpoint, so adjusting who can do what never needs a
 * code deploy.
 */
@Schema({ timestamps: true, collection: 'role_capabilities' })
export class RoleCapabilities {
  @Prop({ type: String, enum: StaffRole, required: true, unique: true })
  role!: StaffRole;

  @Prop({ type: [String], required: true, default: [] })
  capabilities!: string[];
}

export const RoleCapabilitiesSchema = SchemaFactory.createForClass(RoleCapabilities);

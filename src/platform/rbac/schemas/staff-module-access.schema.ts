import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

import { ModuleName } from '../../../common/enums/identity.enums';

export type StaffModuleAccessDocument = HydratedDocument<StaffModuleAccess>;

/**
 * Module access is a separate dimension from role — this collection is the
 * source of truth for which modules (LOANS/ACCOUNTING/HR) a given staff member
 * may reach, independent of their role's capabilities.
 *
 * `staffId` is stored as a plain string (not `ref: Staff.name`) because the
 * identity module doesn't exist yet in this phase — RBAC must not depend on it.
 * Once identity lands, this can stay a string id or be swapped to a real ref
 * without changing the shape callers see.
 */
@Schema({ timestamps: true, collection: 'staff_module_access' })
export class StaffModuleAccess {
  @Prop({ type: String, required: true, unique: true })
  staffId!: string;

  @Prop({ type: [String], enum: ModuleName, required: true, default: [] })
  modules!: ModuleName[];
}

export const StaffModuleAccessSchema = SchemaFactory.createForClass(StaffModuleAccess);

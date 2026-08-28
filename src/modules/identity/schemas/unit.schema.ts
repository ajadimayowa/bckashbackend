import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type UnitDocument = HydratedDocument<Unit>;

@Schema({ timestamps: true, collection: 'units' })
export class Unit {
  @Prop({ type: Types.ObjectId, ref: 'Department', required: true })
  departmentId!: Types.ObjectId;

  @Prop({ type: String, required: true, trim: true })
  name!: string;

  @Prop({ type: Boolean, required: true, default: true })
  active!: boolean;

  createdAt!: Date;
  updatedAt!: Date;
}

export const UnitSchema = SchemaFactory.createForClass(Unit);

// A unit name only needs to be unique within its own department.
UnitSchema.index({ departmentId: 1, name: 1 }, { unique: true });

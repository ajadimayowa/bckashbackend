import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type DepartmentDocument = HydratedDocument<Department>;

@Schema({ timestamps: true, collection: 'departments' })
export class Department {
  @Prop({ type: String, required: true, unique: true, trim: true })
  name!: string;

  @Prop({ type: Boolean, required: true, default: true })
  active!: boolean;

  createdAt!: Date;
  updatedAt!: Date;
}

export const DepartmentSchema = SchemaFactory.createForClass(Department);

import { IsMongoId } from 'class-validator';

export class AssignManagerDto {
  @IsMongoId()
  staffId!: string;
}

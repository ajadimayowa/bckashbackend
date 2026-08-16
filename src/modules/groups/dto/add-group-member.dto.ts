import { IsMongoId } from 'class-validator';

export class AddGroupMemberDto {
  @IsMongoId()
  customerId!: string;
}

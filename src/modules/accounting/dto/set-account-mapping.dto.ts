import { IsMongoId } from 'class-validator';

/** `key` comes from the route param — see AccountingController. */
export class SetAccountMappingDto {
  @IsMongoId()
  accountId!: string;
}

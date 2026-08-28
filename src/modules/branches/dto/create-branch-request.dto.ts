import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/** branchId is implied — always the raising Manager's own branch (see BranchRequestsService.create). */
export class CreateBranchRequestDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  subject!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  message!: string;
}

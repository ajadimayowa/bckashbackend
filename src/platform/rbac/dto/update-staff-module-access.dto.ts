import { ArrayUnique, IsArray, IsEnum } from 'class-validator';

import { ModuleName } from '../../../common/enums/identity.enums';

export class UpdateStaffModuleAccessDto {
  @IsArray()
  @ArrayUnique()
  @IsEnum(ModuleName, { each: true })
  modules!: ModuleName[];
}

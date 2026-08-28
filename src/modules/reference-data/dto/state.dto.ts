import { ApiProperty } from '@nestjs/swagger';

export class StateDto {
  @ApiProperty({ example: 'lagos', description: 'Stable kebab-case slug — safe to persist.' })
  id!: string;

  @ApiProperty({ example: 'Lagos' })
  name!: string;
}

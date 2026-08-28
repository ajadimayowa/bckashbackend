import { ApiProperty } from '@nestjs/swagger';

/**
 * Always carries its parent state's id/name alongside its own — the caller
 * asked for this explicitly so a city record is self-describing without a
 * second lookup back to GET /reference-data/states.
 */
export class CityDto {
  @ApiProperty({ example: 'lagos-ikeja', description: 'Stable kebab-case slug — safe to persist.' })
  id!: string;

  @ApiProperty({ example: 'Ikeja' })
  name!: string;

  @ApiProperty({ example: 'lagos' })
  stateId!: string;

  @ApiProperty({ example: 'Lagos' })
  stateName!: string;
}

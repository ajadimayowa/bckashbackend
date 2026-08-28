import { Module } from '@nestjs/common';

import { ReferenceDataController } from './reference-data.controller';
import { ReferenceDataService } from './reference-data.service';

@Module({
  controllers: [ReferenceDataController],
  providers: [ReferenceDataService],
})
export class ReferenceDataModule {}

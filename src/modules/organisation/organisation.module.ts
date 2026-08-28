import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { AuditModule } from '../../platform/audit/audit.module';
import { S3IntegrationModule } from '../../platform/integrations/s3/s3.module';
import { OrganisationController } from './organisation.controller';
import { OrganisationService } from './organisation.service';
import { Organisation, OrganisationSchema } from './schemas/organisation.schema';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Organisation.name, schema: OrganisationSchema }]),
    AuditModule,
    S3IntegrationModule,
  ],
  controllers: [OrganisationController],
  providers: [OrganisationService],
  exports: [OrganisationService],
})
export class OrganisationModule {}

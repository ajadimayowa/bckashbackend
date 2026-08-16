import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { WorkflowEngineModule } from '../../platform/workflow-engine/workflow-engine.module';
import { IdentityModule } from '../identity/identity.module';
import { FeeDefinitionsController } from './fee-definitions.controller';
import { FeeDefinitionsService } from './fee-definitions.service';
import { LoanProductsController } from './loan-products.controller';
import { LoanProductsService } from './loan-products.service';
import { FeeDefinition, FeeDefinitionSchema } from './schemas/fee-definition.schema';
import { LoanProduct, LoanProductSchema } from './schemas/loan-product.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: FeeDefinition.name, schema: FeeDefinitionSchema },
      { name: LoanProduct.name, schema: LoanProductSchema },
    ]),
    WorkflowEngineModule,
    IdentityModule,
  ],
  controllers: [FeeDefinitionsController, LoanProductsController],
  providers: [FeeDefinitionsService, LoanProductsService],
  exports: [FeeDefinitionsService, LoanProductsService],
})
export class LoanProductsModule {}

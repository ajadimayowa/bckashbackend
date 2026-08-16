import { IsInt, IsString, Min } from 'class-validator';

/** One step of LoanProduct.approvalChainSteps — fed straight into WorkflowEngineService.registerChainConfig on approval. */
export class ApprovalChainStepDto {
  @IsInt()
  @Min(0)
  order!: number;

  @IsString()
  requiredCapability!: string;
}

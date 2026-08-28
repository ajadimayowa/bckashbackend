import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';

import { WorkflowEntityType } from '../../common/enums/workflow.enums';
import { approveCapability, initiateCapability } from '../../platform/rbac/constants/capabilities';
import { CurrentStaffContext } from '../../platform/rbac/decorators/current-staff-context.decorator';
import { RequireCapability } from '../../platform/rbac/decorators/require-capability.decorator';
import { CapabilityGuard } from '../../platform/rbac/guards/capability.guard';
import { StaffContextGuard } from '../../platform/rbac/guards/staff-context.guard';
import type { ResolvedStaffContext } from '../../platform/rbac/interfaces/staff-context.interface';
import { WorkflowRequestSummaryDto } from '../../platform/workflow-engine/dto/workflow-request-summary.dto';
import { JwtAuthGuard } from '../identity/guards/jwt-auth.guard';
import { RaiseDisputeDto } from './dto/raise-dispute.dto';
import { RecordRepaymentDto } from './dto/record-repayment.dto';
import { ResolveDisputeDto } from './dto/resolve-dispute.dto';
import { RepaymentsService } from './repayments.service';
import { RepaymentRecord } from './schemas/repayment-record.schema';

const INITIATE_REPAYMENT = initiateCapability(WorkflowEntityType.REPAYMENT_RECORD);
const APPROVE_REPAYMENT = approveCapability(WorkflowEntityType.REPAYMENT_RECORD);

@ApiTags('repayments')
@ApiBearerAuth('access-token')
@Controller('repayments')
@UseGuards(JwtAuthGuard, StaffContextGuard, CapabilityGuard)
export class RepaymentsController {
  constructor(private readonly repaymentsService: RepaymentsService) {}

  @Post()
  @RequireCapability(INITIATE_REPAYMENT)
  @ApiOperation({
    summary: 'Record a repayment',
    description: 'No balance effect until Manager review + Admin/Approver approval.',
  })
  async recordRepayment(
    @Body() dto: RecordRepaymentDto,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<WorkflowRequestSummaryDto> {
    const { workflowRequest } = await this.repaymentsService.recordRepayment(dto, actor.staffId);
    return WorkflowRequestSummaryDto.fromDocument(workflowRequest);
  }

  @Post(':id/proof')
  @RequireCapability(INITIATE_REPAYMENT)
  @UseInterceptors(FileInterceptor('image'))
  @ApiOperation({
    summary: 'Attach proof-of-payment to a repayment record',
    description: 'Attachable at any point, not gated by status.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: { image: { type: 'string', format: 'binary' } },
      required: ['image'],
    },
  })
  async recordProofOfPayment(
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
  ): Promise<{ proofOfPaymentImageKey: string | null }> {
    const record = await this.repaymentsService.recordProofOfPayment(
      id,
      file.buffer,
      file.mimetype,
    );
    return { proofOfPaymentImageKey: record.proofOfPaymentImageKey };
  }

  @Post(':id/dispute')
  @RequireCapability(INITIATE_REPAYMENT)
  @ApiOperation({
    summary: 'Raise a dispute on a repayment record',
    description:
      'Reverses the balance effect first if it was already APPROVED — idempotent, never double-reverses.',
  })
  async raiseDispute(
    @Param('id') id: string,
    @Body() dto: RaiseDisputeDto,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<RepaymentRecord> {
    return this.repaymentsService.raiseDispute(id, actor.staffId, dto.reason);
  }

  @Post(':id/dispute/resolve')
  @RequireCapability(APPROVE_REPAYMENT)
  @ApiOperation({
    summary: 'Resolve a repayment dispute',
    description:
      'APPROVED re-applies the balance effect; REJECTED leaves it reversed. Requires a note.',
  })
  async resolveDispute(
    @Param('id') id: string,
    @Body() dto: ResolveDisputeDto,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<RepaymentRecord> {
    return this.repaymentsService.resolveDispute(id, actor.staffId, dto.resolution, dto.note);
  }

  // Admin visibility — see RepaymentsService.findStaleDisputes's own doc comment.
  @Get('disputes/stale')
  @RequireCapability(APPROVE_REPAYMENT)
  @ApiOperation({
    summary: 'List disputes raised before a cutoff (default 7 days) and still unresolved',
  })
  async findStaleDisputes(@Query('days') days?: string): Promise<RepaymentRecord[]> {
    return this.repaymentsService.findStaleDisputes(days ? Number(days) : undefined);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a repayment record by id' })
  findOne(@Param('id') id: string): Promise<RepaymentRecord> {
    return this.repaymentsService.findByIdOrThrow(id);
  }
}

import { BadRequestException, Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { LOAN_DISBURSEMENT_OPS_CAPABILITY } from '../../platform/rbac/constants/capabilities';
import { CurrentStaffContext } from '../../platform/rbac/decorators/current-staff-context.decorator';
import { RequireCapability } from '../../platform/rbac/decorators/require-capability.decorator';
import { CapabilityGuard } from '../../platform/rbac/guards/capability.guard';
import { StaffContextGuard } from '../../platform/rbac/guards/staff-context.guard';
import type { ResolvedStaffContext } from '../../platform/rbac/interfaces/staff-context.interface';
import { JwtAuthGuard } from '../identity/guards/jwt-auth.guard';
import { RecordFeePaymentDto } from './dto/record-fee-payment.dto';
import { AvailableFeeItem, CustomerFeePaymentItem, FeePaymentsService } from './fee-payments.service';
import { FeePayment } from './schemas/fee-payment.schema';

/**
 * Front-desk operational endpoint — reuses LOAN_DISBURSEMENT_OPS_CAPABILITY
 * rather than a dedicated capability, same "cash-collection is operational,
 * not maker-checker" reasoning as FeePayment's own schema doc comment. See
 * PHASE_8_NOTES.md.
 */
@ApiTags('loans')
@ApiBearerAuth('access-token')
@Controller('fee-payments')
@UseGuards(JwtAuthGuard, StaffContextGuard, CapabilityGuard)
export class FeePaymentsController {
  constructor(private readonly feePaymentsService: FeePaymentsService) {}

  @Post()
  @RequireCapability(LOAN_DISBURSEMENT_OPS_CAPABILITY)
  @ApiOperation({
    summary: 'Record a fee payment (PAID or WAIVED)',
    description:
      'Upserts on (customerId, productId, feeDefinitionId) — recording the same fee twice overwrites, matching a real front-desk correction.',
  })
  recordPayment(
    @Body() dto: RecordFeePaymentDto,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<FeePayment> {
    return this.feePaymentsService.recordPayment(
      dto.customerId,
      dto.productId,
      dto.feeDefinitionId,
      dto.amountKobo,
      dto.status,
      actor.staffId,
      dto.accountPaidTo,
      dto.paymentReference,
    );
  }

  // Reads: authenticated-only, no capability gate — same "reads are open"
  // convention as Groups/LoanProducts (see loans.controller.ts's own comment).
  @Get('available')
  @ApiOperation({
    summary: "List every fee a customer could owe, paid or not",
    description:
      "Every PRE_LOAN fee on an active LoanProduct, cross-referenced against what's already been " +
      'recorded for this customer — PENDING for anything never recorded. See AvailableFeeItem\'s own doc comment.',
  })
  listAvailableFees(@Query('customerId') customerId: string | undefined): Promise<AvailableFeeItem[]> {
    if (!customerId) {
      throw new BadRequestException('customerId query param is required');
    }
    return this.feePaymentsService.listAvailableFeesForCustomer(customerId);
  }

  @Get()
  @ApiOperation({ summary: "List a customer's fee payment history" })
  listForCustomer(@Query('customerId') customerId: string | undefined): Promise<CustomerFeePaymentItem[]> {
    if (!customerId) {
      throw new BadRequestException('customerId query param is required');
    }
    return this.feePaymentsService.listForCustomer(customerId);
  }
}

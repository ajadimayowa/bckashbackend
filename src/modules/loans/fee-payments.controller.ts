import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { LOAN_DISBURSEMENT_OPS_CAPABILITY } from '../../platform/rbac/constants/capabilities';
import { CurrentStaffContext } from '../../platform/rbac/decorators/current-staff-context.decorator';
import { RequireCapability } from '../../platform/rbac/decorators/require-capability.decorator';
import { CapabilityGuard } from '../../platform/rbac/guards/capability.guard';
import { StaffContextGuard } from '../../platform/rbac/guards/staff-context.guard';
import type { ResolvedStaffContext } from '../../platform/rbac/interfaces/staff-context.interface';
import { JwtAuthGuard } from '../identity/guards/jwt-auth.guard';
import { RecordFeePaymentDto } from './dto/record-fee-payment.dto';
import { FeePaymentsService } from './fee-payments.service';
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
    );
  }
}

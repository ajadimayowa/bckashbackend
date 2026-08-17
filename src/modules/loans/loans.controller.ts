import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { WorkflowEntityType } from '../../common/enums/workflow.enums';
import { initiateCapability } from '../../platform/rbac/constants/capabilities';
import { CurrentStaffContext } from '../../platform/rbac/decorators/current-staff-context.decorator';
import { RequireCapability } from '../../platform/rbac/decorators/require-capability.decorator';
import { CapabilityGuard } from '../../platform/rbac/guards/capability.guard';
import { StaffContextGuard } from '../../platform/rbac/guards/staff-context.guard';
import type { ResolvedStaffContext } from '../../platform/rbac/interfaces/staff-context.interface';
import { JwtAuthGuard } from '../identity/guards/jwt-auth.guard';
import { RaiseLoanApplicationDto } from './dto/raise-loan-application.dto';
import { LoansService, RaiseApplicationResult } from './loans.service';
import { MemberLoanAccount } from './schemas/member-loan-account.schema';
import { Loan } from './schemas/loan.schema';

const INITIATE_LOAN = initiateCapability(WorkflowEntityType.LOAN);

@ApiTags('loans')
@ApiBearerAuth('access-token')
@Controller('loans')
@UseGuards(JwtAuthGuard, StaffContextGuard, CapabilityGuard)
export class LoansController {
  constructor(private readonly loansService: LoansService) {}

  @Post()
  @RequireCapability(INITIATE_LOAN)
  raiseApplication(
    @Body() dto: RaiseLoanApplicationDto,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<RaiseApplicationResult> {
    return this.loansService.raiseApplication(
      dto.groupId,
      dto.productId,
      dto.tenureMonths,
      dto.memberLoanRequests,
      actor.staffId,
    );
  }

  // Reads: authenticated-only, no capability gate — same reasoning as
  // Groups/LoanProducts' read endpoints (see PHASE_6_NOTES.md/PHASE_7_NOTES.md).
  @Get(':id')
  findOne(@Param('id') id: string): Promise<Loan> {
    return this.loansService.findByIdOrThrow(id);
  }

  @Get(':id/member-accounts')
  getMemberLoanAccounts(@Param('id') id: string): Promise<MemberLoanAccount[]> {
    return this.loansService.getMemberLoanAccounts(id);
  }
}

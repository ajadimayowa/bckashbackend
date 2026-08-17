import {
  Body,
  Controller,
  Param,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiTags } from '@nestjs/swagger';

import { WorkflowEntityType } from '../../common/enums/workflow.enums';
import {
  approveCapability,
  LOAN_DISBURSEMENT_OPS_CAPABILITY,
} from '../../platform/rbac/constants/capabilities';
import { CurrentStaffContext } from '../../platform/rbac/decorators/current-staff-context.decorator';
import { RequireCapability } from '../../platform/rbac/decorators/require-capability.decorator';
import { CapabilityGuard } from '../../platform/rbac/guards/capability.guard';
import { StaffContextGuard } from '../../platform/rbac/guards/staff-context.guard';
import type { ResolvedStaffContext } from '../../platform/rbac/interfaces/staff-context.interface';
import { JwtAuthGuard } from '../identity/guards/jwt-auth.guard';
import { InitiateMemberVerificationDto } from './dto/initiate-member-verification.dto';
import { ResolveEscalationDto } from './dto/resolve-escalation.dto';
import { LoanVerificationService } from './loan-verification.service';
import { DisbursementVerification } from './schemas/disbursement-verification.schema';
import { Loan } from './schemas/loan.schema';
import { MemberLoanAccount } from './schemas/member-loan-account.schema';

const APPROVE_LOAN = approveCapability(WorkflowEntityType.LOAN);

@ApiTags('loans')
@ApiBearerAuth('access-token')
@Controller('loans')
@UseGuards(JwtAuthGuard, StaffContextGuard, CapabilityGuard)
export class LoanVerificationController {
  constructor(private readonly loanVerificationService: LoanVerificationService) {}

  @Post(':loanId/members/:customerId/verify')
  @RequireCapability(LOAN_DISBURSEMENT_OPS_CAPABILITY)
  @UseInterceptors(FileInterceptor('liveImage'))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        liveImage: { type: 'string', format: 'binary' },
        officeId: { type: 'string' },
        officerId: { type: 'string' },
      },
      required: ['liveImage'],
    },
  })
  initiateMemberVerification(
    @Param('loanId') loanId: string,
    @Param('customerId') customerId: string,
    @UploadedFile() file: Express.Multer.File,
    @Body() dto: InitiateMemberVerificationDto,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<DisbursementVerification> {
    return this.loanVerificationService.initiateMemberVerification(
      loanId,
      customerId,
      file.buffer,
      actor.staffId,
      { officeId: dto.officeId, officerId: dto.officerId },
    );
  }

  // Admin/Approver capability required — a meaningful compliance/rejection
  // decision, distinct from the operational LOAN_DISBURSEMENT_OPS_CAPABILITY
  // gating initiation above. See LoanVerificationService.resolveEscalation.
  @Post('verifications/:verificationId/resolve')
  @RequireCapability(APPROVE_LOAN)
  resolveEscalation(
    @Param('verificationId') verificationId: string,
    @Body() dto: ResolveEscalationDto,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<DisbursementVerification> {
    return this.loanVerificationService.resolveEscalation(
      verificationId,
      actor.staffId,
      dto.resolution,
      dto.note,
    );
  }

  @Post(':loanId/check-and-disburse')
  @RequireCapability(LOAN_DISBURSEMENT_OPS_CAPABILITY)
  checkAndDisburse(
    @Param('loanId') loanId: string,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<Loan> {
    return this.loanVerificationService.checkAndDisburse(loanId, actor.staffId);
  }

  @Post('member-accounts/:memberLoanAccountId/confirm-cheque-handover')
  @RequireCapability(LOAN_DISBURSEMENT_OPS_CAPABILITY)
  confirmChequeHandover(
    @Param('memberLoanAccountId') memberLoanAccountId: string,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<MemberLoanAccount> {
    return this.loanVerificationService.confirmChequeHandover(memberLoanAccountId, actor.staffId);
  }
}

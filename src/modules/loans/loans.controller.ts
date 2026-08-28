import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';

import { LoanStatus } from '../../common/enums/loan.enums';
import { WorkflowEntityType } from '../../common/enums/workflow.enums';
import { initiateCapability } from '../../platform/rbac/constants/capabilities';
import { CurrentStaffContext } from '../../platform/rbac/decorators/current-staff-context.decorator';
import { RequireCapability } from '../../platform/rbac/decorators/require-capability.decorator';
import { CapabilityGuard } from '../../platform/rbac/guards/capability.guard';
import { StaffContextGuard } from '../../platform/rbac/guards/staff-context.guard';
import type { ResolvedStaffContext } from '../../platform/rbac/interfaces/staff-context.interface';
import { JwtAuthGuard } from '../identity/guards/jwt-auth.guard';
import { RaiseLoanApplicationDto } from './dto/raise-loan-application.dto';
import { RequestLoanConsentDto } from './dto/request-loan-consent.dto';
import { UpdatePendingLoanApplicationDto } from './dto/update-pending-loan-application.dto';
import { IssuedLoanConsentChallenge, LoanConsentService } from './loan-consent.service';
import { CustomerLoanHistoryItem, LoanSummary, LoansService, RaiseApplicationResult } from './loans.service';
import { MemberLoanAccount } from './schemas/member-loan-account.schema';
import { Loan } from './schemas/loan.schema';

const INITIATE_LOAN = initiateCapability(WorkflowEntityType.LOAN);

@ApiTags('loans')
@ApiBearerAuth('access-token')
@Controller('loans')
@UseGuards(JwtAuthGuard, StaffContextGuard, CapabilityGuard)
export class LoansController {
  constructor(
    private readonly loansService: LoansService,
    private readonly loanConsentService: LoanConsentService,
  ) {}

  @Post('consent/request')
  @RequireCapability(INITIATE_LOAN)
  @ApiOperation({
    summary: "Send a customer a consent code before raising a loan on their behalf",
    description:
      'A 6-digit code sent by SMS/email to the customer — they read it back to the staff member, ' +
      'who enters it (with the returned challengeId) into POST /loans. Expires after 10 minutes.',
  })
  requestConsent(
    @Body() dto: RequestLoanConsentDto,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<IssuedLoanConsentChallenge> {
    return this.loanConsentService.issueChallenge(dto.customerId, actor.staffId);
  }

  @Post()
  @RequireCapability(INITIATE_LOAN)
  @ApiOperation({
    summary: 'Raise a group loan application',
    description:
      'Creates the Loan and every MemberLoanAccount immediately (visible before approval), and starts the approval chain. ' +
      'Requires a consent code issued via POST /loans/consent/request for one of memberLoanRequests\' customers.',
  })
  raiseApplication(
    @Body() dto: RaiseLoanApplicationDto,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<RaiseApplicationResult> {
    return this.loansService.raiseApplication(
      dto.groupId,
      dto.productId,
      dto.tenureDays,
      dto.memberLoanRequests,
      actor.staffId,
      dto.consentChallengeId,
      dto.consentCode,
      dto.purpose,
    );
  }

  @Post('member-accounts/:id/applicant-photo')
  @RequireCapability(INITIATE_LOAN)
  @UseInterceptors(FileInterceptor('image'))
  @ApiOperation({
    summary: 'Upload a photo of the customer taken at loan-application time',
    description: 'Stored in S3 — a follow-up call after raiseApplication, not part of it.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: { type: 'object', properties: { image: { type: 'string', format: 'binary' } } },
  })
  async uploadApplicantPhoto(
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
  ): Promise<{ applicantPhotoImageKey: string }> {
    return this.loansService.uploadApplicantPhoto(id, file.buffer, file.mimetype);
  }

  @Get('member-accounts/:id/applicant-photo-url')
  @ApiOperation({ summary: 'A short-lived signed URL for the applicant photo, if one was captured' })
  getApplicantPhotoSignedUrl(@Param('id') id: string): Promise<{ url: string | null }> {
    return this.loansService.getApplicantPhotoSignedUrl(id);
  }

  // Reads: authenticated-only, no capability gate — same reasoning as
  // Groups/LoanProducts' read endpoints (see PHASE_6_NOTES.md/PHASE_7_NOTES.md).
  // Declared before `:id` — a literal route must precede a dynamic
  // single-segment one, same convention as elsewhere in this codebase
  // (workflow-requests, branches).
  @Get('member-accounts')
  @ApiOperation({
    summary: "List a customer's loan history",
    description: "Every MemberLoanAccount for the given customerId, across all their loans, newest first.",
  })
  getMemberLoanAccountsForCustomer(
    @Query('customerId') customerId: string | undefined,
  ): Promise<CustomerLoanHistoryItem[]> {
    if (!customerId) {
      throw new BadRequestException('customerId query param is required');
    }
    return this.loansService.getMemberLoanAccountsForCustomer(customerId);
  }

  // Declared before `:id` — a literal route must precede a dynamic
  // single-segment one, same convention as elsewhere in this codebase.
  @Get()
  @ApiOperation({
    summary: 'List group loans',
    description:
      'Row-scoped like GET /groups: ADMIN/SUPERADMIN/APPROVER see every loan (optionally narrowed ' +
      "by branchId/groupId/raisedBy), a MANAGER only their own branch's loans (branchId/raisedBy " +
      "ignored), a MARKETER only loans they themselves raised (raisedBy is themselves, regardless " +
      'of what — if anything — is passed).',
  })
  @ApiQuery({ name: 'branchId', required: false, description: 'ADMIN/SUPERADMIN/APPROVER only — ignored for MANAGER/MARKETER.' })
  @ApiQuery({ name: 'groupId', required: false })
  @ApiQuery({ name: 'status', required: false, enum: LoanStatus })
  @ApiQuery({
    name: 'raisedBy',
    required: false,
    description:
      "Staff id of the loan's raiser — ADMIN/SUPERADMIN/APPROVER only, to filter to one marketer's " +
      'loans; ignored for MANAGER (branch-locked) and MARKETER (already forced to their own).',
  })
  listForActor(
    @Query('branchId') branchId: string | undefined,
    @Query('groupId') groupId: string | undefined,
    @Query('status') status: LoanStatus | undefined,
    @Query('raisedBy') raisedBy: string | undefined,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<LoanSummary[]> {
    return this.loansService.listForActor({ branchId, groupId, status, raisedBy }, actor);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a loan by id' })
  findOne(@Param('id') id: string): Promise<Loan> {
    return this.loansService.findByIdOrThrow(id);
  }

  @Patch(':id')
  @RequireCapability(INITIATE_LOAN)
  @ApiOperation({
    summary: 'Edit a still-pending loan application',
    description: "Raiser only, and only while PENDING_APPROVAL — locked the moment any step of the approval chain has acted.",
  })
  async updatePending(
    @Param('id') id: string,
    @Body() dto: UpdatePendingLoanApplicationDto,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<{ loan: Loan; memberLoanAccounts: MemberLoanAccount[] }> {
    return this.loansService.updatePendingApplication(id, actor.staffId, dto);
  }

  @Delete(':id')
  @RequireCapability(INITIATE_LOAN)
  @ApiOperation({
    summary: 'Hard-delete a still-pending loan application',
    description:
      'Raiser only, and only while PENDING_APPROVAL — cancels the pending WorkflowRequest and removes ' +
      'the Loan and every MemberLoanAccount. Once approved, a loan can no longer be deleted.',
  })
  async remove(
    @Param('id') id: string,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<{ deleted: true }> {
    await this.loansService.deleteLoan(id, actor.staffId);
    return { deleted: true };
  }

  @Get(':id/member-accounts')
  @ApiOperation({ summary: "List a loan's per-member accounts" })
  getMemberLoanAccounts(@Param('id') id: string): Promise<MemberLoanAccount[]> {
    return this.loansService.getMemberLoanAccounts(id);
  }
}

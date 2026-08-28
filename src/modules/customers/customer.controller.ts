import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
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
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';

import { IdDocumentType } from '../../common/enums/customer.enums';
import { WorkflowEntityType } from '../../common/enums/workflow.enums';
import { WorkflowRequestSummaryDto } from '../../platform/workflow-engine/dto/workflow-request-summary.dto';
import { approveCapability, initiateCapability, reviewCapability } from '../../platform/rbac/constants/capabilities';
import { CurrentStaffContext } from '../../platform/rbac/decorators/current-staff-context.decorator';
import { RequireCapability } from '../../platform/rbac/decorators/require-capability.decorator';
import { CapabilityGuard } from '../../platform/rbac/guards/capability.guard';
import { StaffContextGuard } from '../../platform/rbac/guards/staff-context.guard';
import type { ResolvedStaffContext } from '../../platform/rbac/interfaces/staff-context.interface';
import { JwtAuthGuard } from '../identity/guards/jwt-auth.guard';
import { CustomerService } from './customer.service';
import { ConfirmBvnVerificationDto } from './dto/confirm-bvn-verification.dto';
import { CustomerAuditEntryDto } from './dto/customer-audit-entry.dto';
import { CustomerResponseDto } from './dto/customer-response.dto';
import { DecideEditPrivilegeDto } from './dto/decide-edit-privilege.dto';
import { DisableCustomerDto } from './dto/disable-customer.dto';
import { ManuallyVerifyNinDto } from './dto/manually-verify-nin.dto';
import { RecordNinDto } from './dto/record-nin.dto';
import { ResolveIdentityMismatchDto } from './dto/resolve-identity-mismatch.dto';
import { UpdateOnboardingDetailsDto } from './dto/update-onboarding-details.dto';
import { VerifyBvnDto } from './dto/verify-bvn.dto';
import { MismatchFlag } from './schemas/kyc-record.schema';

const INITIATE_CUSTOMER = initiateCapability(WorkflowEntityType.CUSTOMER);
const APPROVE_CUSTOMER = approveCapability(WorkflowEntityType.CUSTOMER);
const REVIEW_CUSTOMER = reviewCapability(WorkflowEntityType.CUSTOMER);

@ApiTags('customers')
@ApiBearerAuth('access-token')
@Controller('customers')
@UseGuards(JwtAuthGuard, StaffContextGuard, CapabilityGuard)
export class CustomerController {
  constructor(private readonly customerService: CustomerService) {}

  @Post('verify-bvn')
  @RequireCapability(INITIATE_CUSTOMER)
  @ApiOperation({
    summary: 'Verify a BVN against the provider (step 1 of KYC) — creates nothing yet',
    description:
      'The BC Kash MFB provider has no OTP/consent step — one live call verifies the BVN and returns ' +
      "what it resolved, plus mismatchFlags comparing that against whatever fullName/phoneNumber were " +
      'submitted here ([] when nothing was submitted, or nothing mismatched). No Customer/KycRecord is ' +
      'created at this point — the resolved details are held in a short-lived preview (previewId, ' +
      'expiresAt) instead. The actual record is only created once the caller explicitly confirms via ' +
      'POST /customers/confirm-bvn-verification, whether or not anything was flagged.',
  })
  async verifyBvn(
    @Body() dto: VerifyBvnDto,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<{
    previewId: string;
    resolved: { firstName: string; lastName: string; phoneNumber: string };
    mismatchFlags: MismatchFlag[];
    expiresAt: Date;
  }> {
    return this.customerService.previewBvn(dto.bvn, dto.branchId, actor.staffId, {
      fullName: dto.fullName,
      phoneNumber: dto.phoneNumber,
    });
  }

  @Post('confirm-bvn-verification')
  @RequireCapability(INITIATE_CUSTOMER)
  @ApiOperation({
    summary: 'Create the draft Customer record from a verified BVN (step 2 of KYC)',
    description:
      "Only the staff member who ran POST /customers/verify-bvn may confirm it, and only while the " +
      'preview is still live (expiresAt) and unused. Same choice as PATCH :id/resolve-identity-mismatch — ' +
      "keep the provider's resolved identity (default, no reason needed) or use what was originally " +
      'submitted (requires a reason, only for whichever fields were actually flagged) — just made before ' +
      'creation rather than as a later patch.',
  })
  async confirmBvnVerification(
    @Body() dto: ConfirmBvnVerificationDto,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<{ customer: CustomerResponseDto; mismatchFlags: MismatchFlag[] }> {
    const result = await this.customerService.confirmCustomerFromPreview(dto.previewId, actor.staffId, {
      useSubmittedValues: dto.useSubmittedValues,
      fullName: dto.fullName,
      phoneNumber: dto.phoneNumber,
      reason: dto.reason,
    });
    return {
      customer: CustomerResponseDto.fromDocument(result.customer),
      mismatchFlags: result.mismatchFlags,
    };
  }

  @Get()
  @ApiOperation({
    summary: 'List customers',
    description:
      'Any authenticated staff member — scoped to what they may see, not everything: ' +
      'ADMIN/SUPERADMIN/APPROVER see everything (and may pass branchId/createdById to filter); ' +
      "a MANAGER only ever sees their own branch's customers; anyone else (MARKETER) only sees " +
      'customers they themselves created — regardless of what branchId/createdById they pass.',
  })
  async findAll(
    @Query('branchId') branchId: string | undefined,
    @Query('createdById') createdById: string | undefined,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<CustomerResponseDto[]> {
    const customers = await this.customerService.findAllForActor({ branchId, createdById }, actor);
    const [branchNamesById, groupNamesByCustomerId] = await Promise.all([
      this.customerService.resolveBranchNames(customers.map((c) => c.branchId.toString())),
      this.customerService.resolveGroupNames(customers.map((c) => c._id.toString())),
    ]);
    return customers.map((customer) =>
      CustomerResponseDto.fromDocument(customer, {
        branchName: branchNamesById.get(customer.branchId.toString()) ?? null,
        groupName: groupNamesByCustomerId.get(customer._id.toString()) ?? null,
      }),
    );
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get a customer by id',
    description:
      'Any authenticated staff member — same row-level scope as GET /customers (see its own doc comment).',
  })
  async findOne(
    @Param('id') id: string,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<CustomerResponseDto> {
    const customer = await this.customerService.findByIdForActor(id, actor);
    const [branchNamesById, groupNamesByCustomerId] = await Promise.all([
      this.customerService.resolveBranchNames([customer.branchId.toString()]),
      this.customerService.resolveGroupNames([customer._id.toString()]),
    ]);
    return CustomerResponseDto.fromDocument(customer, {
      branchName: branchNamesById.get(customer.branchId.toString()) ?? null,
      groupName: groupNamesByCustomerId.get(customer._id.toString()) ?? null,
    });
  }

  @Get(':id/audit-trail')
  @ApiOperation({
    summary: "Get a customer's full audit trail",
    description:
      'Every recorded action — onboarding edits, KYC captures, submissions, workflow decisions, ' +
      'mismatch resolutions, KYC data reads — oldest first. Same row-level view scope as GET /customers/:id.',
  })
  async getAuditTrail(
    @Param('id') id: string,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<CustomerAuditEntryDto[]> {
    const entries = await this.customerService.getAuditTrail(id, actor);
    const actorIds = entries
      .map((entry) => entry.actorId)
      .filter((actorId): actorId is string => Boolean(actorId));
    const namesById = await this.customerService.resolveStaffNames(actorIds);
    return entries.map((entry) =>
      CustomerAuditEntryDto.fromDocument(entry, entry.actorId ? namesById.get(entry.actorId) ?? null : null),
    );
  }

  @Get(':id/kyc-status')
  @ApiOperation({
    summary: 'Whether biometric/ID document/NIN have been captured',
    description:
      'Presence-only flags, never the actual decrypted value — same view scope as GET /customers/:id. ' +
      'Drives the "uploaded" indicator + eye icon in the KYC & Verification tab.',
  })
  async getKycCaptureStatus(
    @Param('id') id: string,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<{
    biometricCaptured: boolean;
    idDocumentCaptured: boolean;
    idDocumentType: IdDocumentType | null;
    ninRecorded: boolean;
    ninVerified: boolean;
    bvnVerifiedAt: Date | null;
  }> {
    return this.customerService.getKycCaptureStatus(id, actor);
  }

  @Post(':id/disable')
  @RequireCapability(APPROVE_CUSTOMER)
  @ApiOperation({
    summary: 'Disable an active customer',
    description: 'Admin/SuperAdmin/Approver only. Independent of the onboarding workflow.',
  })
  async disable(
    @Param('id') id: string,
    @Body() dto: DisableCustomerDto,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<CustomerResponseDto> {
    const customer = await this.customerService.disable(id, actor.staffId, dto.reason);
    return CustomerResponseDto.fromDocument(customer);
  }

  @Post(':id/enable')
  @RequireCapability(APPROVE_CUSTOMER)
  @ApiOperation({ summary: 'Re-enable a disabled customer', description: 'Admin/SuperAdmin/Approver only.' })
  async enable(
    @Param('id') id: string,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<CustomerResponseDto> {
    const customer = await this.customerService.enable(id, actor.staffId);
    return CustomerResponseDto.fromDocument(customer);
  }

  @Patch(':id/onboarding-details')
  @RequireCapability(INITIATE_CUSTOMER)
  @ApiOperation({ summary: 'Fill in the remaining onboarding details after BVN consent' })
  async updateOnboardingDetails(
    @Param('id') id: string,
    @Body() dto: UpdateOnboardingDetailsDto,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<CustomerResponseDto> {
    const customer = await this.customerService.updateOnboardingDetails(id, dto, actor.staffId);
    return CustomerResponseDto.fromDocument(customer);
  }

  @Post(':id/biometric')
  @RequireCapability(INITIATE_CUSTOMER)
  @UseInterceptors(FileInterceptor('image'))
  @ApiOperation({
    summary: "Upload a customer's biometric capture image",
    description:
      'Stored in S3; compared against the BVN photo during disbursement verification (Rekognition).',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        image: { type: 'string', format: 'binary' },
      },
      required: ['image'],
    },
  })
  async captureBiometric(
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<{ biometricImageKey: string | null }> {
    const kyc = await this.customerService.captureBiometric(
      id,
      file.buffer,
      file.mimetype,
      actor.staffId,
    );
    return { biometricImageKey: kyc.biometricImageKey };
  }

  @Post(':id/id-document')
  @RequireCapability(INITIATE_CUSTOMER)
  @UseInterceptors(FileInterceptor('image'))
  @ApiOperation({
    summary: "Upload a photo of the customer's ID document",
    description: 'Stored in S3 — a photo of a NIN slip, voter\'s card, etc. Never gates kycStatus.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        image: { type: 'string', format: 'binary' },
        documentType: { type: 'string', enum: Object.values(IdDocumentType) },
      },
      required: ['image'],
    },
  })
  async captureIdDocument(
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
    @Body('documentType') documentType: IdDocumentType | undefined,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<{ idDocumentImageKey: string | null; idDocumentType: IdDocumentType | null }> {
    const kyc = await this.customerService.captureIdDocument(
      id,
      file.buffer,
      file.mimetype,
      actor.staffId,
      documentType,
    );
    return { idDocumentImageKey: kyc.idDocumentImageKey, idDocumentType: kyc.idDocumentType };
  }

  @Post(':id/nin')
  @RequireCapability(INITIATE_CUSTOMER)
  @ApiOperation({
    summary: "Record a customer's NIN",
    description: 'Encrypted at rest. No automated provider — capture is manual.',
  })
  async recordNin(
    @Param('id') id: string,
    @Body() dto: RecordNinDto,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<{ recorded: true }> {
    await this.customerService.recordNin(id, dto.nin, actor.staffId);
    return { recorded: true };
  }

  @Post(':id/nin/verify')
  @RequireCapability(APPROVE_CUSTOMER)
  @ApiOperation({
    summary: 'Manually verify a recorded NIN',
    description: 'A recorded fact, not a maker-checker approval — requires a note.',
  })
  async manuallyVerifyNin(
    @Param('id') id: string,
    @Body() dto: ManuallyVerifyNinDto,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<{ verified: true }> {
    await this.customerService.manuallyVerifyNin(id, actor.staffId, dto.note);
    return { verified: true };
  }

  @Post(':id/submit')
  @RequireCapability(INITIATE_CUSTOMER)
  @ApiOperation({ summary: 'Submit a completed KYC record for Admin/Approver approval' })
  async submitForApproval(
    @Param('id') id: string,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<WorkflowRequestSummaryDto> {
    const request = await this.customerService.submitForApproval(id, actor.staffId);
    return WorkflowRequestSummaryDto.fromDocument(request);
  }

  @Post(':id/resubmit')
  @RequireCapability(INITIATE_CUSTOMER)
  @ApiOperation({
    summary: 'Resubmit a REJECTED KYC record after fixing whatever was flagged',
    description: 'Creator only. Starts a fresh review cycle (always restarts from the review step).',
  })
  async resubmitForApproval(
    @Param('id') id: string,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<WorkflowRequestSummaryDto> {
    const request = await this.customerService.resubmitForApproval(id, actor.staffId);
    return WorkflowRequestSummaryDto.fromDocument(request);
  }

  @Delete(':id')
  @RequireCapability(INITIATE_CUSTOMER)
  @ApiOperation({
    summary: 'Delete a draft or REJECTED customer record',
    description:
      'Creator only, and only before the record has ever gone ACTIVE — withdraws a mistaken ' +
      "draft/submission. If it's still awaiting someone else's review/approval, that " +
      'WorkflowRequest is cancelled first. There is no way to delete an ACTIVE customer — see disable.',
  })
  async remove(
    @Param('id') id: string,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<{ deleted: true }> {
    await this.customerService.deleteCustomer(id, actor.staffId);
    return { deleted: true };
  }

  @Post(':id/edit-privilege/request')
  @RequireCapability(INITIATE_CUSTOMER)
  @UseInterceptors(FileInterceptor('signature'))
  @ApiOperation({
    summary: "Request permission to edit an already-approved customer's details",
    description:
      "Creator only, ACTIVE customers only — a reason plus a photo of the customer's signature. " +
      'Only Admin/SuperAdmin/Approver can grant it (see POST :id/edit-privilege/decide).',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        reason: { type: 'string' },
        signature: { type: 'string', format: 'binary' },
      },
      required: ['reason', 'signature'],
    },
  })
  async requestEditPrivilege(
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
    @Body('reason') reason: string,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<CustomerResponseDto> {
    if (!reason?.trim()) {
      throw new BadRequestException('reason is required');
    }
    if (!file) {
      throw new BadRequestException('signature image is required');
    }
    const customer = await this.customerService.requestEditPrivilege(
      id,
      reason.trim(),
      file.buffer,
      file.mimetype,
      actor.staffId,
    );
    return CustomerResponseDto.fromDocument(customer);
  }

  @Post(':id/edit-privilege/decide')
  @RequireCapability(APPROVE_CUSTOMER)
  @ApiOperation({ summary: 'Grant or reject a pending edit privilege request' })
  async decideEditPrivilege(
    @Param('id') id: string,
    @Body() dto: DecideEditPrivilegeDto,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<CustomerResponseDto> {
    const customer = await this.customerService.decideEditPrivilege(id, dto.approve, dto.comment, actor.staffId);
    return CustomerResponseDto.fromDocument(customer);
  }

  @Get(':id/edit-privilege/signature-url')
  @RequireCapability(APPROVE_CUSTOMER)
  @ApiOperation({ summary: "Short-lived signed URL for the customer's signature on a pending/decided edit privilege request" })
  async getEditPrivilegeSignatureUrl(
    @Param('id') id: string,
    @Query('expiresInSeconds') expiresInSeconds: string | undefined,
  ): Promise<{ url: string | null }> {
    const url = await this.customerService.getEditPrivilegeSignatureUrl(
      id,
      expiresInSeconds ? Number(expiresInSeconds) : undefined,
    );
    return { url };
  }

  @Get(':id/mismatch-flags')
  @ApiOperation({
    summary: "Get a customer's BVN submission mismatch flags",
    description:
      "Whatever was recorded at bvn-consent/confirm time comparing the marketer's submitted " +
      "fullName/phoneNumber against the provider's resolved values — [] if nothing was submitted " +
      'or nothing mismatched. Reviewer (Manager) or approver only — checked manually here rather ' +
      'than via @RequireCapability, since either capability should pass. So a Manager reviewing a ' +
      "submission can see the marketer's mismatched values before deciding. Every read is " +
      'audit-logged (KYC_DATA_READ).',
  })
  async getMismatchFlags(
    @Param('id') id: string,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<{ mismatchFlags: MismatchFlag[] }> {
    if (!actor.capabilities.includes(REVIEW_CUSTOMER) && !actor.capabilities.includes(APPROVE_CUSTOMER)) {
      throw new ForbiddenException(`Missing required capability: ${REVIEW_CUSTOMER} or ${APPROVE_CUSTOMER}`);
    }
    const mismatchFlags = await this.customerService.getMismatchFlags(id, actor.staffId);
    return { mismatchFlags };
  }

  @Patch(':id/resolve-identity-mismatch')
  @RequireCapability(INITIATE_CUSTOMER)
  @ApiOperation({
    summary: "Resolve a flagged BVN-submission mismatch",
    description:
      'Creator only. Pick between the provider\'s resolved identity (default, no reason needed) and ' +
      'what was originally submitted (requires a reason, overwrites firstName/lastName/phoneNumber).',
  })
  async resolveIdentityMismatch(
    @Param('id') id: string,
    @Body() dto: ResolveIdentityMismatchDto,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<{ customer: CustomerResponseDto; mismatchFlags: MismatchFlag[] }> {
    const result = await this.customerService.resolveIdentityMismatch(id, actor.staffId, {
      useSubmittedValues: dto.useSubmittedValues,
      fullName: dto.fullName,
      phoneNumber: dto.phoneNumber,
      reason: dto.reason,
    });
    return {
      customer: CustomerResponseDto.fromDocument(result.customer),
      mismatchFlags: result.mismatchFlags,
    };
  }

  @Post(':id/bvn/review-comparison')
  @ApiOperation({
    summary: "Re-verify a customer's BVN live against the provider, for a reviewer/approver to compare against what's on record",
    description:
      'Reviewer (Manager) or approver only — checked manually here rather than via ' +
      '@RequireCapability, since either capability should pass (no OR support on that decorator). ' +
      'Every call is audit-logged (KYC_DATA_READ) and refreshes the KycRecord\'s own bvnVerifiedAt.',
  })
  async getBvnReviewComparison(
    @Param('id') id: string,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<{
    provider: { firstName: string; lastName: string; phoneNumber: string; dateOfBirth: string };
    onRecord: { firstName: string; lastName: string; phoneNumber: string };
  }> {
    if (!actor.capabilities.includes(REVIEW_CUSTOMER) && !actor.capabilities.includes(APPROVE_CUSTOMER)) {
      throw new ForbiddenException(`Missing required capability: ${REVIEW_CUSTOMER} or ${APPROVE_CUSTOMER}`);
    }
    const result = await this.customerService.reviewBvnComparison(id, actor.staffId);
    return {
      provider: {
        firstName: result.provider.firstName,
        lastName: result.provider.lastName,
        phoneNumber: result.provider.phoneNumber,
        dateOfBirth: result.provider.dateOfBirth,
      },
      onRecord: result.onRecord,
    };
  }

  @Get(':id/bvn')
  @RequireCapability(APPROVE_CUSTOMER)
  @ApiOperation({
    summary: "Get a customer's decrypted BVN",
    description: 'Every read is audit-logged (KYC_DATA_READ).',
  })
  async getDecryptedBvn(
    @Param('id') id: string,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<{ bvn: string }> {
    const bvn = await this.customerService.getDecryptedBvn(id, actor.staffId);
    return { bvn };
  }

  @Get(':id/nin')
  @ApiOperation({
    summary: "Get a customer's decrypted NIN",
    description:
      "Same view scope as GET /customers/:id (whoever created it, their branch's Manager, or " +
      'Admin/SuperAdmin/Approver) rather than Admin/Approver-only — the maker who just recorded ' +
      "it, or a Manager reviewing it, needs to see it too. Every read is still audit-logged " +
      '(KYC_DATA_READ).',
  })
  async getDecryptedNin(
    @Param('id') id: string,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<{ nin: string | null }> {
    await this.customerService.findByIdForActor(id, actor);
    const nin = await this.customerService.getDecryptedNin(id, actor.staffId);
    return { nin };
  }

  @Get(':id/biometric-url')
  @ApiOperation({
    summary: "Get a short-lived signed URL for a customer's biometric image",
    description: "Same view scope as GET /customers/:id — see GET :id/nin's own doc comment for why.",
  })
  async getBiometricSignedUrl(
    @Param('id') id: string,
    @Query('expiresInSeconds') expiresInSeconds: string | undefined,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<{ url: string | null }> {
    await this.customerService.findByIdForActor(id, actor);
    const url = await this.customerService.getBiometricSignedUrl(
      id,
      actor.staffId,
      expiresInSeconds ? Number(expiresInSeconds) : undefined,
    );
    return { url };
  }

  @Get(':id/id-document-url')
  @ApiOperation({
    summary: "Get a short-lived signed URL for a customer's ID document image",
    description: "Same view scope as GET /customers/:id — see GET :id/nin's own doc comment for why.",
  })
  async getIdDocumentSignedUrl(
    @Param('id') id: string,
    @Query('expiresInSeconds') expiresInSeconds: string | undefined,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<{ url: string | null }> {
    await this.customerService.findByIdForActor(id, actor);
    const url = await this.customerService.getIdDocumentSignedUrl(
      id,
      actor.staffId,
      expiresInSeconds ? Number(expiresInSeconds) : undefined,
    );
    return { url };
  }
}

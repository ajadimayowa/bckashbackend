import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';

import { WorkflowEntityType } from '../../common/enums/workflow.enums';
import { staffDocumentUploadOptions, type StaffDocumentFiles } from '../../common/upload/upload.config';
import { WorkflowRequestSummaryDto } from '../../platform/workflow-engine/dto/workflow-request-summary.dto';
import {
  ORG_MANAGE_CAPABILITY,
  STAFF_CREATE_DIRECT_CAPABILITY,
  STAFF_DISABLE_CAPABILITY,
  initiateCapability,
} from '../../platform/rbac/constants/capabilities';
import { CurrentStaffContext } from '../../platform/rbac/decorators/current-staff-context.decorator';
import { RequireCapability } from '../../platform/rbac/decorators/require-capability.decorator';
import { CapabilityGuard } from '../../platform/rbac/guards/capability.guard';
import { StaffContextGuard } from '../../platform/rbac/guards/staff-context.guard';
import type { ResolvedStaffContext } from '../../platform/rbac/interfaces/staff-context.interface';
import { BvnPreviewResponseDto } from './dto/bvn-preview-response.dto';
import { CreateStaffDirectDto } from './dto/create-staff-direct.dto';
import { DisableStaffDto } from './dto/disable-staff.dto';
import { InitiateStaffOnboardingDto } from './dto/initiate-staff-onboarding.dto';
import { StaffActivityEntryDto } from './dto/staff-activity-entry.dto';
import { StaffPerformanceSummaryDto } from './dto/staff-performance-summary.dto';
import { StaffResponseDto } from './dto/staff-response.dto';
import { UpdateOwnStaffProfileDto } from './dto/update-own-staff-profile.dto';
import { UpdateStaffComplianceDto } from './dto/update-staff-compliance.dto';
import { UpdateStaffProfileDto } from './dto/update-staff-profile.dto';
import { VerifyStaffBvnDto } from './dto/verify-staff-bvn.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { StaffService } from './staff.service';

/** Shared by every route below that accepts the same two optional upload fields. */
const staffDocumentUploadInterceptor = () =>
  FileFieldsInterceptor(
    [
      { name: 'passportPhoto', maxCount: 1 },
      { name: 'idDocument', maxCount: 1 },
    ],
    staffDocumentUploadOptions(),
  );

const staffDocumentUploadApiBody = {
  schema: {
    type: 'object',
    properties: {
      passportPhoto: { type: 'string', format: 'binary', description: 'Image only (jpeg/jpg/png/webp).' },
      idDocument: { type: 'string', format: 'binary', description: 'Image or PDF.' },
      // Every other DTO field also goes in this same multipart body as a
      // plain form field — nested objects/arrays JSON-encoded, see
      // parseJsonField's own doc comment.
    },
  },
} as const;

@ApiTags('staff')
@ApiBearerAuth('access-token')
@Controller('staff')
@UseGuards(JwtAuthGuard, StaffContextGuard, CapabilityGuard)
export class StaffController {
  constructor(private readonly staffService: StaffService) {}

  @Post('onboard')
  @RequireCapability(initiateCapability(WorkflowEntityType.STAFF))
  @UseInterceptors(staffDocumentUploadInterceptor())
  @ApiOperation({
    summary: 'Initiate staff onboarding, via workflow',
    description:
      'Branch Managers onboard staff this way, for any role in ONBOARDABLE_STAFF_ROLES ' +
      '(every real role except SUPERADMIN — see InitiateStaffOnboardingDto) — creates a ' +
      'WorkflowRequest, not a Staff record; the Staff record is only created once ' +
      'Admin/SuperAdmin/Approver approves, with exactly the role that was proposed. Accepts ' +
      'either application/json or multipart/form-data — use the latter to attach ' +
      'passportPhoto/idDocument (both optional) alongside the rest of the fields.',
  })
  @ApiConsumes('multipart/form-data', 'application/json')
  @ApiBody(staffDocumentUploadApiBody)
  async onboard(
    @Body() dto: InitiateStaffOnboardingDto,
    @UploadedFiles() files: StaffDocumentFiles,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<WorkflowRequestSummaryDto> {
    const request = await this.staffService.initiateOnboarding(dto, actor.staffId, actor.role, files);
    return WorkflowRequestSummaryDto.fromDocument(request);
  }

  @Post('onboard/:requestId/resubmit')
  @RequireCapability(initiateCapability(WorkflowEntityType.STAFF))
  @UseInterceptors(staffDocumentUploadInterceptor())
  @ApiOperation({
    summary: 'Edit and resubmit a REJECTED (or RETURNED_TO_MAKER) staff onboarding proposal',
    description:
      'Only the original initiator, and only while the request is REJECTED/RETURNED_TO_MAKER — ' +
      'see WorkflowEngineService.resubmit. Re-runs every check `onboard` itself would (org refs ' +
      'exist, email/phone still available, ADMIN/APPROVER role restricted to an Admin/SuperAdmin ' +
      'initiator, userType resolution) against the newly-edited fields, then restarts the chain ' +
      'from scratch. passportPhoto/idDocument are both optional here too — omit either to keep ' +
      "what the rejected proposal already had on file rather than clearing it.",
  })
  @ApiConsumes('multipart/form-data', 'application/json')
  @ApiBody(staffDocumentUploadApiBody)
  async resubmitOnboarding(
    @Param('requestId') requestId: string,
    @Body() dto: InitiateStaffOnboardingDto,
    @UploadedFiles() files: StaffDocumentFiles,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<WorkflowRequestSummaryDto> {
    const request = await this.staffService.resubmitOnboarding(
      requestId,
      dto,
      actor.staffId,
      actor.role,
      files,
    );
    return WorkflowRequestSummaryDto.fromDocument(request);
  }

  @Post('direct')
  @RequireCapability(STAFF_CREATE_DIRECT_CAPABILITY)
  @UseInterceptors(staffDocumentUploadInterceptor())
  @ApiOperation({
    summary: 'Create a staff account directly, bypassing workflow',
    description:
      'SuperAdmin only. Immediate, no-approval creation — /staff/onboard (workflow-mediated, ' +
      'Branch-Manager-initiated) covers every role including these same ones now, so this ' +
      'endpoint exists purely for the "I need this account right now, no approval round-trip" ' +
      'case. Never SUPERADMIN (see the seeder for how the first SuperAdmin is created). ' +
      'Accepts either application/json or multipart/form-data — use the latter to attach ' +
      'passportPhoto/idDocument (both optional) alongside the rest of the fields.',
  })
  @ApiConsumes('multipart/form-data', 'application/json')
  @ApiBody(staffDocumentUploadApiBody)
  async createDirect(
    @Body() dto: CreateStaffDirectDto,
    @UploadedFiles() files: StaffDocumentFiles,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<StaffResponseDto> {
    const staff = await this.staffService.createDirect(dto, actor.staffId, files);
    return StaffResponseDto.fromDocument(staff);
  }

  @Patch(':id/documents')
  @RequireCapability(ORG_MANAGE_CAPABILITY)
  @UseInterceptors(staffDocumentUploadInterceptor())
  @ApiOperation({
    summary: "Replace a staff member's passport photo and/or ID document",
    description:
      'multipart/form-data, both fields optional — send just the one you want to replace. ' +
      'The old file on disk is left in place (not deleted); only the Staff record\'s URL is updated.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody(staffDocumentUploadApiBody)
  async updateDocuments(
    @Param('id') id: string,
    @UploadedFiles() files: StaffDocumentFiles,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<StaffResponseDto> {
    const staff = await this.staffService.updateDocuments(id, files, actor.staffId);
    return StaffResponseDto.fromDocument(staff);
  }

  @Post('verify-bvn-preview')
  @ApiOperation({
    summary: 'Look up a BVN before a staff record exists (onboarding pre-check)',
    description:
      'Same no-consent provider recheck as POST /staff/:id/verify-bvn, but usable while ' +
      "still filling out the onboarding form — before any Staff record exists to verify " +
      "*onto*. Returns the provider's resolved name/date of birth/phone number so the " +
      'onboarder can confirm the BVN belongs to the person they\'re entering, but nothing ' +
      'is persisted here (no capability required beyond being signed in — the actual ' +
      "onboard/direct-create endpoints are what's capability-gated). The real, persisted " +
      'bvnVerified=true only happens later via POST /staff/:id/verify-bvn, once the staff ' +
      'record exists.',
  })
  async verifyBvnPreview(
    @Body() dto: VerifyStaffBvnDto,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<BvnPreviewResponseDto> {
    return this.staffService.verifyBvnPreview(dto.bvn, actor.staffId);
  }

  // No @RequireCapability — every authenticated staff member may read their
  // own record. Must precede `@Get(':id')` below — otherwise "me" would be
  // matched as an :id.
  @Get('me')
  @ApiOperation({ summary: "Get the signed-in staff member's own record" })
  async findMe(@CurrentStaffContext() actor: ResolvedStaffContext): Promise<StaffResponseDto> {
    const staff = await this.staffService.findById(actor.staffId);
    return StaffResponseDto.fromDocument(staff);
  }

  // No @RequireCapability — self-service, same reasoning as GET 'me' above.
  @Patch('me')
  @ApiOperation({
    summary: "Update the signed-in staff member's own contact/personal details",
    description:
      'Self-service subset only: phoneNumber, residentialAddress, nextOfKin, reference. ' +
      'Everything org-managed (role/department/unit/branch/email/moduleAccess/status) and ' +
      "everything with its own dedicated endpoint (BVN, documents) is untouched here — see " +
      'UpdateOwnStaffProfileDto.',
  })
  async updateMe(
    @Body() dto: UpdateOwnStaffProfileDto,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<StaffResponseDto> {
    const staff = await this.staffService.updateOwnProfile(actor.staffId, dto);
    return StaffResponseDto.fromDocument(staff);
  }

  @Get()
  @RequireCapability(ORG_MANAGE_CAPABILITY)
  @ApiOperation({ summary: 'List staff', description: 'Optionally filter to one branch.' })
  async findAll(@Query('branchId') branchId?: string): Promise<StaffResponseDto[]> {
    const staff = await this.staffService.findAll(branchId ? { branchId } : {});
    return staff.map((s) => StaffResponseDto.fromDocument(s));
  }

  // Must precede `@Get(':id')` — otherwise "bvn" would be matched as an :id.
  @Get('bvn/unverified')
  @RequireCapability(ORG_MANAGE_CAPABILITY)
  @ApiOperation({ summary: 'List staff whose BVN has not yet been verified' })
  async findWithUnverifiedBvn(): Promise<StaffResponseDto[]> {
    const staff = await this.staffService.findStaffWithUnverifiedBvn();
    return staff.map((s) => StaffResponseDto.fromDocument(s));
  }

  @Get(':id')
  @RequireCapability(ORG_MANAGE_CAPABILITY)
  @ApiOperation({ summary: 'Get a staff member by id' })
  async findOne(@Param('id') id: string): Promise<StaffResponseDto> {
    const staff = await this.staffService.findById(id);
    return StaffResponseDto.fromDocument(staff);
  }

  @Patch(':id')
  @RequireCapability(ORG_MANAGE_CAPABILITY)
  @ApiOperation({
    summary: "Update another staff member's record (Admin/SuperAdmin)",
    description:
      'Every field optional — send only what changed. Cannot touch status (use ' +
      '/disable|/enable), BVN verification (use /verify-bvn), compliance verification ' +
      '(use PATCH :id/compliance), or documents (use PATCH :id/documents) — each of those ' +
      'stays on its own dedicated, differently-audited endpoint. SUPERADMIN can neither be ' +
      'assigned nor edited away from through this route.',
  })
  async updateProfile(
    @Param('id') id: string,
    @Body() dto: UpdateStaffProfileDto,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<StaffResponseDto> {
    const staff = await this.staffService.updateProfile(id, dto, actor.staffId);
    return StaffResponseDto.fromDocument(staff);
  }

  @Patch(':id/compliance')
  @RequireCapability(ORG_MANAGE_CAPABILITY)
  @ApiOperation({
    summary: 'Manually sign off on NIN/guarantor-form/offer-letter paperwork',
    description: 'No live verification provider behind any of these three (unlike BVN) — a manual admin toggle each.',
  })
  async updateCompliance(
    @Param('id') id: string,
    @Body() dto: UpdateStaffComplianceDto,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<StaffResponseDto> {
    const staff = await this.staffService.updateCompliance(id, dto, actor.staffId);
    return StaffResponseDto.fromDocument(staff);
  }

  @Get(':id/performance')
  @RequireCapability(ORG_MANAGE_CAPABILITY)
  @ApiOperation({
    summary: "A staff member's real, computed-on-request performance counts",
    description: 'Customers onboarded, active groups, loans raised, and last login — never cached/stale.',
  })
  async getPerformance(@Param('id') id: string): Promise<StaffPerformanceSummaryDto> {
    return this.staffService.getPerformanceSummary(id);
  }

  @Get(':id/activity')
  @RequireCapability(ORG_MANAGE_CAPABILITY)
  @ApiOperation({
    summary: "A staff member's activity log",
    description: 'Sourced from the real append-only audit trail (actions this staff member performed), newest first.',
  })
  async getActivity(@Param('id') id: string): Promise<StaffActivityEntryDto[]> {
    return this.staffService.getActivity(id);
  }

  @Post(':id/verify-bvn')
  @RequireCapability(STAFF_DISABLE_CAPABILITY)
  @ApiOperation({
    summary: "Record a staff member's verified BVN",
    description: 'Encrypted at rest.',
  })
  async verifyBvn(
    @Param('id') id: string,
    @Body() dto: VerifyStaffBvnDto,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<StaffResponseDto> {
    const staff = await this.staffService.verifyBvn(id, dto.bvn, actor.staffId);
    return StaffResponseDto.fromDocument(staff);
  }

  @Post(':id/disable')
  @RequireCapability(STAFF_DISABLE_CAPABILITY)
  @ApiOperation({
    summary: 'Disable a staff account',
    description: 'A disabled staff member cannot log in or act on any workflow request.',
  })
  async disable(
    @Param('id') id: string,
    @Body() dto: DisableStaffDto,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<StaffResponseDto> {
    const staff = await this.staffService.disable(id, actor.staffId, dto.reason);
    return StaffResponseDto.fromDocument(staff);
  }

  @Post(':id/enable')
  @RequireCapability(STAFF_DISABLE_CAPABILITY)
  @ApiOperation({ summary: 'Re-enable a disabled staff account' })
  async enable(
    @Param('id') id: string,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<StaffResponseDto> {
    const staff = await this.staffService.enable(id, actor.staffId);
    return StaffResponseDto.fromDocument(staff);
  }
}

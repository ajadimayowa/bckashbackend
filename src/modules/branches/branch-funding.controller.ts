import {
  BadRequestException,
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

import {
  BRANCH_FUND_CAPABILITY,
  BRANCH_VERIFY_FUNDING_CAPABILITY,
} from '../../platform/rbac/constants/capabilities';
import { CurrentStaffContext } from '../../platform/rbac/decorators/current-staff-context.decorator';
import { RequireCapability } from '../../platform/rbac/decorators/require-capability.decorator';
import { CapabilityGuard } from '../../platform/rbac/guards/capability.guard';
import { StaffContextGuard } from '../../platform/rbac/guards/staff-context.guard';
import type { ResolvedStaffContext } from '../../platform/rbac/interfaces/staff-context.interface';
import { JwtAuthGuard } from '../identity/guards/jwt-auth.guard';
import { BranchFundingService } from './branch-funding.service';
import { RaiseBranchFundingDisputeDto } from './dto/raise-branch-funding-dispute.dto';
import { RecordBranchFundingDto } from './dto/record-branch-funding.dto';
import { RejectBranchFundingDto } from './dto/reject-branch-funding.dto';
import { ResolveBranchFundingDisputeDto } from './dto/resolve-branch-funding-dispute.dto';
import { BranchFunding } from './schemas/branch-funding.schema';

@ApiTags('branch-funding')
@ApiBearerAuth('access-token')
@Controller('branch-funding')
@UseGuards(JwtAuthGuard, StaffContextGuard, CapabilityGuard)
export class BranchFundingController {
  constructor(private readonly branchFundingService: BranchFundingService) {}

  @Post()
  @RequireCapability(BRANCH_FUND_CAPABILITY)
  @ApiOperation({
    summary: 'Record head-office funding for a branch',
    description:
      'Pending until a Branch Manager verifies it — does not touch the branch balance yet.',
  })
  record(
    @Body() dto: RecordBranchFundingDto,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<BranchFunding> {
    return this.branchFundingService.recordFunding(dto, actor.staffId);
  }

  // Reads: authenticated-only, no capability gate. ADMIN/SUPERADMIN/APPROVER
  // see every record (optionally narrowed by ?branchId); a Manager only ever
  // sees their own branch's, regardless of what they pass — the row-scoping
  // happens server-side in BranchFundingService.findAll. This deliberately
  // does NOT reuse BRANCH_FUND_CAPABILITY (head-office-only) as the gate,
  // since Manager needs to list funding records to find the ones they're
  // meant to verify/reject but never holds that capability.
  @Get()
  @ApiOperation({
    summary: 'List branch funding records',
    description:
      'Admin/SuperAdmin/Approver see all (optionally filtered by branchId); everyone else sees only their own branch.',
  })
  findAll(
    @Query('branchId') branchId: string | undefined,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<BranchFunding[]> {
    return this.branchFundingService.findAll(branchId, actor);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a branch funding record by id' })
  findOne(@Param('id') id: string): Promise<BranchFunding> {
    return this.branchFundingService.findById(id);
  }

  @Post(':id/verify')
  @RequireCapability(BRANCH_VERIFY_FUNDING_CAPABILITY)
  @ApiOperation({
    summary: 'Verify a funding record',
    description:
      "Only the receiving branch's own current manager may verify it — credits the branch balance.",
  })
  verify(
    @Param('id') id: string,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<BranchFunding> {
    return this.branchFundingService.verifyFunding(id, actor.staffId);
  }

  @Post(':id/reject')
  @RequireCapability(BRANCH_VERIFY_FUNDING_CAPABILITY)
  @ApiOperation({ summary: 'Reject a funding record', description: 'No balance effect.' })
  reject(
    @Param('id') id: string,
    @Body() dto: RejectBranchFundingDto,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<BranchFunding> {
    return this.branchFundingService.rejectFunding(id, actor.staffId, dto.reason);
  }

  @Post(':id/nudge')
  @RequireCapability(BRANCH_FUND_CAPABILITY)
  @ApiOperation({
    summary: "Nudge the branch's current manager",
    description: 'Sends a FUNDING_REMINDER email/SMS. Only meaningful while still PENDING_VERIFICATION.',
  })
  nudge(
    @Param('id') id: string,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<BranchFunding> {
    return this.branchFundingService.nudgeManager(id, actor.staffId);
  }

  @Post(':id/disputes')
  @RequireCapability(BRANCH_VERIFY_FUNDING_CAPABILITY)
  @UseInterceptors(FileInterceptor('evidence'))
  @ApiOperation({
    summary: 'Raise a dispute over a funding record',
    description:
      "Only the receiving branch's own current manager may raise one — document evidence is required.",
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        reason: { type: 'string' },
        evidence: { type: 'string', format: 'binary' },
      },
      required: ['reason', 'evidence'],
    },
  })
  async raiseDispute(
    @Param('id') id: string,
    @Body() dto: RaiseBranchFundingDisputeDto,
    @UploadedFile() file: Express.Multer.File,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<BranchFunding> {
    if (!file) {
      throw new BadRequestException('Document evidence is required to raise a dispute');
    }
    return this.branchFundingService.raiseDispute(id, actor.staffId, dto.reason, {
      buffer: file.buffer,
      contentType: file.mimetype,
    });
  }

  @Post(':id/disputes/resolve')
  @RequireCapability(BRANCH_FUND_CAPABILITY)
  @ApiOperation({ summary: "Resolve a funding record's dispute" })
  resolveDispute(
    @Param('id') id: string,
    @Body() dto: ResolveBranchFundingDisputeDto,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<BranchFunding> {
    return this.branchFundingService.resolveDispute(id, actor.staffId, dto.resolution, dto.note);
  }

  @Get(':id/disputes/evidence-url')
  @ApiOperation({ summary: "A short-lived signed URL for a dispute's evidence document" })
  async getDisputeEvidenceUrl(@Param('id') id: string): Promise<{ url: string | null }> {
    const url = await this.branchFundingService.getDisputeEvidenceSignedUrl(id);
    return { url };
  }
}

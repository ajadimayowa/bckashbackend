import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';

import { ORGANISATION_MANAGE_CAPABILITY } from '../../platform/rbac/constants/capabilities';
import { CurrentStaffContext } from '../../platform/rbac/decorators/current-staff-context.decorator';
import { RequireCapability } from '../../platform/rbac/decorators/require-capability.decorator';
import { CapabilityGuard } from '../../platform/rbac/guards/capability.guard';
import { StaffContextGuard } from '../../platform/rbac/guards/staff-context.guard';
import type { ResolvedStaffContext } from '../../platform/rbac/interfaces/staff-context.interface';
import { JwtAuthGuard } from '../identity/guards/jwt-auth.guard';
import { CreateOrganisationDto } from './dto/create-organisation.dto';
import { OrganisationResponseDto } from './dto/organisation-response.dto';
import { UpdateOrganisationDto } from './dto/update-organisation.dto';
import { OrganisationService } from './organisation.service';

/**
 * Singleton company profile. `create`/`update`/`remove`/the CAC doc upload
 * are SuperAdmin/Admin only (`ORGANISATION_MANAGE_CAPABILITY`) — reads need
 * only authentication, no capability, same "any staff can view, only the
 * top roles can change it" split as StaffController's BVN-unverified list
 * vs. verifyBvn. No `ModuleName`/`RequireModule` gate — this isn't scoped to
 * LOANS/ACCOUNTING/HR, it's a platform-level singleton.
 *
 * Whether the organisation profile exists yet ("must be set up before
 * anything else") is treated as a frontend routing concern: `GET
 * /organisation` 404s until one is created, and the frontend is expected to
 * redirect to a setup screen on that 404 — no backend guard blocks any
 * other route on this.
 */
@ApiTags('organisation')
@ApiBearerAuth('access-token')
@Controller('organisation')
@UseGuards(JwtAuthGuard, StaffContextGuard, CapabilityGuard)
export class OrganisationController {
  constructor(private readonly organisationService: OrganisationService) {}

  @Post()
  @RequireCapability(ORGANISATION_MANAGE_CAPABILITY)
  @ApiOperation({
    summary: 'Create the organisation profile',
    description:
      'SuperAdmin/Admin only. Fails if one already exists — use PATCH to update it instead. ' +
      'Exactly one organisation profile can ever exist.',
  })
  async create(
    @Body() dto: CreateOrganisationDto,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<OrganisationResponseDto> {
    const organisation = await this.organisationService.create(dto, actor.staffId);
    return OrganisationResponseDto.fromDocument(organisation);
  }

  @Get()
  @ApiOperation({
    summary: 'Get the organisation profile',
    description:
      'Any authenticated staff member. 404s if no organisation profile has been created yet.',
  })
  async findOne(): Promise<OrganisationResponseDto> {
    const organisation = await this.organisationService.findOneOrThrow();
    return OrganisationResponseDto.fromDocument(organisation);
  }

  @Patch()
  @RequireCapability(ORGANISATION_MANAGE_CAPABILITY)
  @ApiOperation({
    summary: 'Update the organisation profile',
    description: 'SuperAdmin/Admin only. Only the fields present in the body are changed.',
  })
  async update(
    @Body() dto: UpdateOrganisationDto,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<OrganisationResponseDto> {
    const organisation = await this.organisationService.update(dto, actor.staffId);
    return OrganisationResponseDto.fromDocument(organisation);
  }

  @Delete()
  @HttpCode(204)
  @RequireCapability(ORGANISATION_MANAGE_CAPABILITY)
  @ApiOperation({
    summary: 'Delete the organisation profile',
    description:
      'SuperAdmin/Admin only. The singleton rule means this is the only way to start over — ' +
      'once deleted, POST /organisation can create a fresh one (e.g. to change the ' +
      'unique businessRegNumber, or correct a botched initial setup).',
  })
  async remove(@CurrentStaffContext() actor: ResolvedStaffContext): Promise<void> {
    await this.organisationService.remove(actor.staffId);
  }

  @Post('cac-doc')
  @RequireCapability(ORGANISATION_MANAGE_CAPABILITY)
  @UseInterceptors(FileInterceptor('cacDoc'))
  @ApiOperation({
    summary: 'Upload (or replace) the CAC document',
    description:
      'SuperAdmin/Admin only. Optional — the organisation profile can exist without one. ' +
      'Replacing an existing document deletes the old S3 object.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: { cacDoc: { type: 'string', format: 'binary' } },
      required: ['cacDoc'],
    },
  })
  async uploadCacDoc(
    @UploadedFile() file: Express.Multer.File,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<OrganisationResponseDto> {
    const organisation = await this.organisationService.uploadCacDoc(
      file.buffer,
      file.mimetype,
      actor.staffId,
    );
    return OrganisationResponseDto.fromDocument(organisation);
  }

  @Get('cac-doc/signed-url')
  @ApiOperation({
    summary: 'Get a short-lived signed URL for the CAC document',
    description: 'Any authenticated staff member. Returns null if none has been uploaded yet.',
  })
  async getCacDocSignedUrl(
    @Query('expiresInSeconds') expiresInSeconds?: string,
  ): Promise<{ url: string | null }> {
    const url = await this.organisationService.getCacDocSignedUrl(
      expiresInSeconds ? Number(expiresInSeconds) : undefined,
    );
    return { url };
  }
}

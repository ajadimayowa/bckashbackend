import {
  Body,
  Controller,
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
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiTags } from '@nestjs/swagger';

import { WorkflowEntityType } from '../../common/enums/workflow.enums';
import { WorkflowRequestSummaryDto } from '../../platform/workflow-engine/dto/workflow-request-summary.dto';
import { approveCapability, initiateCapability } from '../../platform/rbac/constants/capabilities';
import { CurrentStaffContext } from '../../platform/rbac/decorators/current-staff-context.decorator';
import { RequireCapability } from '../../platform/rbac/decorators/require-capability.decorator';
import { CapabilityGuard } from '../../platform/rbac/guards/capability.guard';
import { StaffContextGuard } from '../../platform/rbac/guards/staff-context.guard';
import type { ResolvedStaffContext } from '../../platform/rbac/interfaces/staff-context.interface';
import { JwtAuthGuard } from '../identity/guards/jwt-auth.guard';
import { CustomerService, StartBvnConsentResult } from './customer.service';
import { ConfirmBvnConsentDto } from './dto/confirm-bvn-consent.dto';
import { CustomerResponseDto } from './dto/customer-response.dto';
import { ManuallyVerifyNinDto } from './dto/manually-verify-nin.dto';
import { RecordNinDto } from './dto/record-nin.dto';
import { StartBvnConsentDto } from './dto/start-bvn-consent.dto';
import { UpdateOnboardingDetailsDto } from './dto/update-onboarding-details.dto';

const INITIATE_CUSTOMER = initiateCapability(WorkflowEntityType.CUSTOMER);
const APPROVE_CUSTOMER = approveCapability(WorkflowEntityType.CUSTOMER);

@ApiTags('customers')
@ApiBearerAuth('access-token')
@Controller('customers')
@UseGuards(JwtAuthGuard, StaffContextGuard, CapabilityGuard)
export class CustomerController {
  constructor(private readonly customerService: CustomerService) {}

  @Post('bvn-consent/start')
  @RequireCapability(INITIATE_CUSTOMER)
  startBvnConsent(
    @Body() dto: StartBvnConsentDto,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<StartBvnConsentResult> {
    return this.customerService.startBvnConsent(dto.bvn, actor.staffId, dto.branchId);
  }

  @Post('bvn-consent/confirm')
  @RequireCapability(INITIATE_CUSTOMER)
  async confirmBvnConsent(@Body() dto: ConfirmBvnConsentDto): Promise<CustomerResponseDto> {
    const customer = await this.customerService.confirmBvnConsent(dto.pendingConsentId, dto.otp);
    return CustomerResponseDto.fromDocument(customer);
  }

  @Get(':id')
  @RequireCapability(INITIATE_CUSTOMER)
  async findOne(@Param('id') id: string): Promise<CustomerResponseDto> {
    const customer = await this.customerService.findById(id);
    return CustomerResponseDto.fromDocument(customer);
  }

  @Patch(':id/onboarding-details')
  @RequireCapability(INITIATE_CUSTOMER)
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

  @Post(':id/nin')
  @RequireCapability(INITIATE_CUSTOMER)
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
  async submitForApproval(
    @Param('id') id: string,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<WorkflowRequestSummaryDto> {
    const request = await this.customerService.submitForApproval(id, actor.staffId);
    return WorkflowRequestSummaryDto.fromDocument(request);
  }

  @Get(':id/bvn')
  @RequireCapability(APPROVE_CUSTOMER)
  async getDecryptedBvn(
    @Param('id') id: string,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<{ bvn: string }> {
    const bvn = await this.customerService.getDecryptedBvn(id, actor.staffId);
    return { bvn };
  }

  @Get(':id/nin')
  @RequireCapability(APPROVE_CUSTOMER)
  async getDecryptedNin(
    @Param('id') id: string,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<{ nin: string | null }> {
    const nin = await this.customerService.getDecryptedNin(id, actor.staffId);
    return { nin };
  }

  @Get(':id/biometric-url')
  @RequireCapability(APPROVE_CUSTOMER)
  async getBiometricSignedUrl(
    @Param('id') id: string,
    @Query('expiresInSeconds') expiresInSeconds: string | undefined,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<{ url: string | null }> {
    const url = await this.customerService.getBiometricSignedUrl(
      id,
      actor.staffId,
      expiresInSeconds ? Number(expiresInSeconds) : undefined,
    );
    return { url };
  }
}

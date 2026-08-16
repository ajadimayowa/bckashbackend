import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { BRANCH_MANAGE_ACCOUNTS_CAPABILITY } from '../../platform/rbac/constants/capabilities';
import { RequireCapability } from '../../platform/rbac/decorators/require-capability.decorator';
import { CapabilityGuard } from '../../platform/rbac/guards/capability.guard';
import { StaffContextGuard } from '../../platform/rbac/guards/staff-context.guard';
import { JwtAuthGuard } from '../identity/guards/jwt-auth.guard';
import { BranchBankAccountsService } from './branch-bank-accounts.service';
import { CreateBranchBankAccountDto } from './dto/create-branch-bank-account.dto';
import { UpdateBranchBankAccountDto } from './dto/update-branch-bank-account.dto';
import { BranchBankAccount } from './schemas/branch-bank-account.schema';

@ApiTags('bank-accounts')
@ApiBearerAuth('access-token')
@Controller('bank-accounts')
@UseGuards(JwtAuthGuard, StaffContextGuard, CapabilityGuard)
@RequireCapability(BRANCH_MANAGE_ACCOUNTS_CAPABILITY)
export class BranchBankAccountsController {
  constructor(private readonly bankAccountsService: BranchBankAccountsService) {}

  @Post()
  create(@Body() dto: CreateBranchBankAccountDto): Promise<BranchBankAccount> {
    return this.bankAccountsService.create(dto);
  }

  @Get()
  findAll(@Query('branchId') branchId?: string): Promise<BranchBankAccount[]> {
    return this.bankAccountsService.findAll(branchId);
  }

  @Get(':id')
  findOne(@Param('id') id: string): Promise<BranchBankAccount> {
    return this.bankAccountsService.findById(id);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateBranchBankAccountDto,
  ): Promise<BranchBankAccount> {
    return this.bankAccountsService.update(id, dto);
  }
}

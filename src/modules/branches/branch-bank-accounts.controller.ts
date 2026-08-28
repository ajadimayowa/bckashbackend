import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

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
export class BranchBankAccountsController {
  constructor(private readonly bankAccountsService: BranchBankAccountsService) {}

  @Post()
  @RequireCapability(BRANCH_MANAGE_ACCOUNTS_CAPABILITY)
  @ApiOperation({ summary: 'Add a bank account for a branch' })
  create(@Body() dto: CreateBranchBankAccountDto): Promise<BranchBankAccount> {
    return this.bankAccountsService.create(dto);
  }

  // Reads: authenticated-only, no capability gate — same reasoning as
  // Groups/Loans/LoanProducts' own read endpoints. Anyone recording a
  // repayment (INITIATE_REPAYMENT — Marketer/Manager) needs to see which
  // account to attribute it to, not just Admin/SuperAdmin.
  @Get()
  @ApiOperation({
    summary: 'List bank accounts',
    description: 'Optionally filter to one branch and/or to only the currently active one.',
  })
  findAll(
    @Query('branchId') branchId?: string,
    @Query('active') active?: string,
  ): Promise<BranchBankAccount[]> {
    return this.bankAccountsService.findAll(branchId, active === undefined ? undefined : active === 'true');
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a bank account by id' })
  findOne(@Param('id') id: string): Promise<BranchBankAccount> {
    return this.bankAccountsService.findById(id);
  }

  @Patch(':id')
  @RequireCapability(BRANCH_MANAGE_ACCOUNTS_CAPABILITY)
  @ApiOperation({ summary: 'Update a bank account' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateBranchBankAccountDto,
  ): Promise<BranchBankAccount> {
    return this.bankAccountsService.update(id, dto);
  }
}

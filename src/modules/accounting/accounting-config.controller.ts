import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { AccountMappingKey, AccountType } from '../../common/enums/accounting.enums';
import { ModuleName } from '../../common/enums/identity.enums';
import { ACCOUNTING_MANAGE_CAPABILITY } from '../../platform/rbac/constants/capabilities';
import { RequireCapability } from '../../platform/rbac/decorators/require-capability.decorator';
import { RequireModule } from '../../platform/rbac/decorators/require-module.decorator';
import { CapabilityGuard } from '../../platform/rbac/guards/capability.guard';
import { ModuleAccessGuard } from '../../platform/rbac/guards/module-access.guard';
import { StaffContextGuard } from '../../platform/rbac/guards/staff-context.guard';
import { JwtAuthGuard } from '../identity/guards/jwt-auth.guard';
import { AccountingService } from './accounting.service';
import { CreateAccountDto } from './dto/create-account.dto';
import { SetAccountMappingDto } from './dto/set-account-mapping.dto';
import { UpdateAccountDto } from './dto/update-account.dto';
import { AccountMapping } from './schemas/account-mapping.schema';
import { Account } from './schemas/account.schema';

/**
 * Chart-of-accounts CRUD and account-mapping updates — deliberately not
 * workflow-mediated (see `ACCOUNTING_MANAGE_CAPABILITY`'s own doc comment
 * and PHASE_10_NOTES.md for the flagged assumption this rests on). Every
 * route here requires BOTH `ModuleName.ACCOUNTING` module access AND the
 * flat `ACCOUNTING_MANAGE_CAPABILITY` — distinct from `LedgerController`'s
 * read/propose routes, which need only module access.
 */
@ApiTags('accounting')
@ApiBearerAuth('access-token')
@Controller('accounting')
@UseGuards(JwtAuthGuard, StaffContextGuard, ModuleAccessGuard, CapabilityGuard)
@RequireModule(ModuleName.ACCOUNTING)
@RequireCapability(ACCOUNTING_MANAGE_CAPABILITY)
export class AccountingConfigController {
  constructor(private readonly accountingService: AccountingService) {}

  @Post('accounts')
  @ApiOperation({ summary: 'Create a chart-of-accounts account' })
  createAccount(@Body() dto: CreateAccountDto): Promise<Account> {
    return this.accountingService.createAccount(dto);
  }

  @Patch('accounts/:id')
  @ApiOperation({
    summary: 'Update an account',
    description: 'name/parentAccountId/active only — code/type are immutable.',
  })
  updateAccount(@Param('id') id: string, @Body() dto: UpdateAccountDto): Promise<Account> {
    return this.accountingService.updateAccount(id, dto);
  }

  @Get('accounts')
  @ApiOperation({
    summary: 'List accounts',
    description: 'Optionally filter by type and/or active status.',
  })
  findAllAccounts(
    @Query('type') type?: AccountType,
    @Query('active') active?: string,
  ): Promise<Account[]> {
    return this.accountingService.findAllAccounts({
      type,
      active: active !== undefined ? active === 'true' : undefined,
    });
  }

  @Get('accounts/:id')
  @ApiOperation({ summary: 'Get an account by id' })
  findAccount(@Param('id') id: string): Promise<Account> {
    return this.accountingService.findAccountByIdOrThrow(id);
  }

  @Get('mappings')
  @ApiOperation({
    summary: 'List every account-mapping key and the account it currently resolves to',
  })
  listMappings(): Promise<AccountMapping[]> {
    return this.accountingService.listMappings();
  }

  @Post('mappings/:key')
  @ApiOperation({
    summary: 'Point an account-mapping key at a different account',
    description: 'e.g. change which account DISBURSEMENT_CREDIT posts to.',
  })
  setMapping(
    @Param('key') key: AccountMappingKey,
    @Body() dto: SetAccountMappingDto,
  ): Promise<AccountMapping> {
    return this.accountingService.setMapping(key, dto.accountId);
  }
}

import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CustomerService } from '../customers/customer.service';
import { CapabilityGuard } from '../../platform/rbac/guards/capability.guard';
import { StaffContextGuard } from '../../platform/rbac/guards/staff-context.guard';
import { CurrentStaffContext } from '../../platform/rbac/decorators/current-staff-context.decorator';
import type { ResolvedStaffContext } from '../../platform/rbac/interfaces/staff-context.interface';
import { JwtAuthGuard } from '../identity/guards/jwt-auth.guard';
import { CustomerRepaymentRiskSummary, CustomerRiskService } from './customer-risk.service';

/**
 * Separate controller (not a method on CustomerController) for the same
 * "lives here because of module access" reasoning as LoanDetailController —
 * CustomerRiskService needs MemberLoanAccount/Loan/PenaltyCharge, all owned
 * by modules RepaymentsModule already imports, and CustomersModule doesn't
 * import RepaymentsModule back (see CustomersModule/RepaymentsModule's own
 * import graphs) — putting this in CustomersModule would need a cycle.
 * Still mounted under the same `customers` route prefix.
 */
@ApiTags('customers')
@ApiBearerAuth('access-token')
@Controller('customers')
@UseGuards(JwtAuthGuard, StaffContextGuard, CapabilityGuard)
export class CustomerRiskController {
  constructor(
    private readonly customerRiskService: CustomerRiskService,
    private readonly customerService: CustomerService,
  ) {}

  @Get(':id/repayment-risk')
  @ApiOperation({
    summary: "A customer's current late-repayment warning flag (NONE/AMBER/RED)",
    description:
      'Live read against the customer\'s own ACTIVE loan accounts (not dependent on the nightly ' +
      'penalty sweep having already run) — drives the warning banner on the Customer Detail page. ' +
      'Same row-level view scope as GET /customers/:id (throws if the viewer cannot see this customer).',
  })
  async getRepaymentRisk(
    @Param('id') id: string,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<CustomerRepaymentRiskSummary> {
    // Row-scoping gate only — same permission check GET /customers/:id
    // itself runs; the result is discarded, we only need it to throw for a
    // viewer who shouldn't see this customer at all.
    await this.customerService.findByIdForActor(id, actor);
    return this.customerRiskService.getRepaymentRisk(id);
  }
}

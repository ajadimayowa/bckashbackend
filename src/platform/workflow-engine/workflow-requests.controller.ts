import { Body, Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Model } from 'mongoose';

import { CurrentStaffContext } from '../rbac/decorators/current-staff-context.decorator';
import { StaffContextGuard } from '../rbac/guards/staff-context.guard';
import type { ResolvedStaffContext } from '../rbac/interfaces/staff-context.interface';
import { JwtAuthGuard } from '../../modules/identity/guards/jwt-auth.guard';
import { Staff, StaffDocument } from '../../modules/identity/schemas/staff.schema';
import { ActOnWorkflowDto } from './dto/act-on-workflow.dto';
import { WorkflowRequestDetailDto } from './dto/workflow-request-detail.dto';
import { WorkflowRequestSummaryDto } from './dto/workflow-request-summary.dto';
import { WorkflowRequestDocument } from './schemas/workflow-request.schema';
import { WorkflowEngineService } from './workflow-engine.service';

/**
 * The generic maker-checker surface every domain module's `initiate()` call
 * feeds into (Staff onboarding, Customer KYC, Group creation, LoanProduct/
 * FeeDefinition/SalaryRecord config changes, ...) — one controller, not one
 * per entity type, which is the entire point of a generic engine (see
 * WorkflowEngineService's own doc comments). No `@RequireCapability` here:
 * `act()` validates the actor's capability against the *specific* pending
 * step itself (which varies per entity type/chain), so a static
 * per-route capability gate can't express it — `CapabilityGuard` is
 * deliberately left off `@UseGuards` below, same reasoning as
 * StaffController's `verify-bvn-preview` route.
 */
@ApiTags('workflow-requests')
@ApiBearerAuth('access-token')
@Controller('workflow-requests')
@UseGuards(JwtAuthGuard, StaffContextGuard)
export class WorkflowRequestsController {
  constructor(
    private readonly workflowEngineService: WorkflowEngineService,
    @InjectModel(Staff.name) private readonly staffModel: Model<StaffDocument>,
  ) {}

  /**
   * Bulk staff-id -> "First Last" lookup for `initiatedBy`/every step's
   * `actedBy` across a batch of requests — one query per response instead of
   * N+1 per document. A staff id that no longer resolves (deleted record)
   * is simply absent from the map; the DTOs fall back to null for those.
   */
  private async resolveNames(requests: WorkflowRequestDocument[]): Promise<Map<string, string>> {
    const ids = new Set<string>();
    for (const request of requests) {
      ids.add(request.initiatedBy);
      for (const step of request.steps) {
        if (step.actedBy) ids.add(step.actedBy);
      }
    }
    if (ids.size === 0) return new Map();

    const staff = await this.staffModel
      .find({ _id: { $in: Array.from(ids) } })
      .select('firstName lastName')
      .lean()
      .exec();
    return new Map(staff.map((s) => [s._id.toString(), `${s.firstName} ${s.lastName}`.trim()]));
  }

  @Get('pending')
  @ApiOperation({
    summary: 'List every WorkflowRequest currently awaiting this actor',
    description:
      'Across every entity type — whatever the current step of each pending request requires ' +
      "matches one of the caller's own capabilities. Excludes requests they initiated or " +
      'already acted on (maker-checker).',
  })
  async getPending(@CurrentStaffContext() actor: ResolvedStaffContext): Promise<WorkflowRequestSummaryDto[]> {
    const requests = await this.workflowEngineService.getPendingForActor(actor.staffId, actor.capabilities);
    const namesById = await this.resolveNames(requests);
    return requests.map((request) => WorkflowRequestSummaryDto.fromDocument(request, namesById));
  }

  // Must precede `@Get(':id')` below — otherwise "pending-all" would be
  // matched as an :id.
  @Get('pending-all/:entityType')
  @ApiOperation({
    summary: 'List every still-pending WorkflowRequest for one entity type',
    description:
      "Unlike GET pending, this doesn't exclude the caller's own submissions — a maker who just " +
      "proposed something (e.g. a new LoanProduct, which has no entity of its own yet — see " +
      "WorkflowRequestSummaryDto.entityId) can see it's genuinely pending instead of concluding " +
      'it silently vanished. The frontend is expected to hide the approve/reject action for ' +
      'entries the viewer initiated themselves — act() enforces that same rule server-side either way.',
  })
  async getPendingByEntityType(@Param('entityType') entityType: string): Promise<WorkflowRequestSummaryDto[]> {
    const requests = await this.workflowEngineService.getPendingByEntityType(entityType);
    const namesById = await this.resolveNames(requests);
    return requests.map((request) => WorkflowRequestSummaryDto.fromDocument(request, namesById));
  }

  // Must precede `@Get(':id')` below — same reasoning as 'pending-all/:entityType'.
  @Get('rejected-all/:entityType')
  @ApiOperation({
    summary: 'List every REJECTED WorkflowRequest for one entity type',
    description:
      'The "Rejected" tab counterpart to GET pending-all/:entityType — a rejected CREATE never persists a ' +
      "domain entity, so this (and each entry's `steps`, which carries who rejected it and their comment) is " +
      'the only place that outcome is visible at all.',
  })
  async getRejectedByEntityType(@Param('entityType') entityType: string): Promise<WorkflowRequestSummaryDto[]> {
    const requests = await this.workflowEngineService.getRejectedByEntityType(entityType);
    const namesById = await this.resolveNames(requests);
    return requests.map((request) => WorkflowRequestSummaryDto.fromDocument(request, namesById));
  }

  @Get(':entityType/:entityId/history')
  @ApiOperation({ summary: 'Full WorkflowRequest timeline for one entity, oldest first' })
  async getHistory(
    @Param('entityType') entityType: string,
    @Param('entityId') entityId: string,
  ): Promise<WorkflowRequestSummaryDto[]> {
    const requests = await this.workflowEngineService.getHistory(entityType, entityId);
    const namesById = await this.resolveNames(requests);
    return requests.map((request) => WorkflowRequestSummaryDto.fromDocument(request, namesById));
  }

  // Must come after 'pending'/'pending-all/:entityType' above — otherwise
  // either would be matched as this :id instead.
  @Get(':id')
  @ApiOperation({
    summary: 'Get one WorkflowRequest, including the payload it would apply if approved',
    description:
      "The list/history endpoints deliberately omit the payload (see WorkflowRequestSummaryDto's " +
      'own doc comment) — this is the one place a reviewer can see what they\'re actually being ' +
      'asked to approve before deciding.',
  })
  async getById(@Param('id') id: string): Promise<WorkflowRequestDetailDto> {
    const request = await this.workflowEngineService.getById(id);
    const namesById = await this.resolveNames([request]);
    return WorkflowRequestDetailDto.fromDocument(request, namesById);
  }

  @Post(':id/cancel')
  @ApiOperation({
    summary: "Withdraw the caller's own not-yet-approved (or already-decided) WorkflowRequest",
    description:
      'Only the original initiator may cancel their own request, and only while it has not ' +
      'already reached APPROVED. Used for e.g. a Marketer deleting a Customer/Group proposal ' +
      "they raised by mistake — the caller is responsible for any of its own entity's cleanup " +
      '(no domain event is emitted here).',
  })
  async cancel(
    @Param('id') id: string,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<WorkflowRequestSummaryDto> {
    const request = await this.workflowEngineService.cancel({
      workflowRequestId: id,
      actorId: actor.staffId,
    });
    return WorkflowRequestSummaryDto.fromDocument(request);
  }

  @Delete(':id')
  @ApiOperation({
    summary: "Permanently delete the caller's own PENDING_REVIEW or REJECTED WorkflowRequest",
    description:
      'Only the original initiator, and only while nothing has advanced past the first review ' +
      "step (PENDING_REVIEW) or a reviewer has flatly said no (REJECTED) — see cancel for the " +
      "softer 'withdraw, keep the record' alternative used once a request has gone further. " +
      'For an entity type with no domain document until approval (e.g. GROUP/CREATE), this is a ' +
      'genuine hard delete — nothing else is left behind.',
  })
  async remove(
    @Param('id') id: string,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<{ deleted: true }> {
    await this.workflowEngineService.deleteRequest({ workflowRequestId: id, actorId: actor.staffId });
    return { deleted: true };
  }

  @Post(':id/act')
  @ApiOperation({
    summary: 'Approve, reject, or return a WorkflowRequest',
    description:
      'Whoever calls this needs the capability the *current step* requires — the maker can ' +
      "never act on their own request, and nobody can act twice in the same chain. A comment " +
      'is required when returning a request to its maker.',
  })
  async act(
    @Param('id') id: string,
    @Body() dto: ActOnWorkflowDto,
    @CurrentStaffContext() actor: ResolvedStaffContext,
  ): Promise<WorkflowRequestSummaryDto> {
    const request = await this.workflowEngineService.act({
      workflowRequestId: id,
      // `role` — see ActingStaff.role's own doc comment: only a
      // PreApprovalValidator (e.g. StaffService's STAFF/CREATE same-role
      // check) ever reads this; the engine's own capability check doesn't.
      actor: { staffId: actor.staffId, capabilities: actor.capabilities, role: actor.role },
      action: dto.action,
      comment: dto.comment,
    });
    return WorkflowRequestSummaryDto.fromDocument(request);
  }
}

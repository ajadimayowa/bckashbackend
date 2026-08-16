import { SetMetadata } from '@nestjs/common';

export const CAPABILITY_METADATA_KEY = 'rbac:requiredCapability';

/**
 * Gate a route behind a single capability string, e.g.
 * `@RequireCapability(approveCapability(WorkflowEntityType.LOAN))` or a flat
 * capability like `RBAC_MANAGE_CAPABILITY`. Checked by CapabilityGuard against
 * `request.staffContext.capabilities` (populated upstream by StaffContextGuard).
 * Composable with `@RequireModule(...)` on the same route — apply both guards.
 */
export const RequireCapability = (capability: string): MethodDecorator & ClassDecorator =>
  SetMetadata(CAPABILITY_METADATA_KEY, capability);

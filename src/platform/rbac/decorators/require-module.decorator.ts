import { SetMetadata } from '@nestjs/common';

import { ModuleName } from '../../../common/enums/identity.enums';

export const MODULE_METADATA_KEY = 'rbac:requiredModule';

/**
 * Gate a route behind module access (LOANS/ACCOUNTING/HR), independent of
 * capability. Checked by ModuleAccessGuard against `request.staffContext.modules`.
 */
export const RequireModule = (module: ModuleName): MethodDecorator & ClassDecorator =>
  SetMetadata(MODULE_METADATA_KEY, module);

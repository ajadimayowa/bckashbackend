/**
 * One-off, re-runnable reconciliation for a known gap in RbacService's boot-time
 * seeding: `onModuleInit` only inserts a role's capability document if none
 * exists yet (`$setOnInsert`), specifically so a redeploy never silently
 * overwrites an Admin's later manual edits (see RbacService's own doc
 * comment). The tradeoff: once a role's document already exists (true for
 * every long-running environment), a *newly introduced* capability — e.g.
 * adding a new WorkflowEntityType like LOAN_CONFIG — never reaches that
 * role's existing document on its own, even though DEFAULT_ROLE_CAPABILITIES
 * in code says it should have it.
 *
 * This script closes that gap the same way an Admin would through the RBAC
 * management endpoint: via `addCapabilityToRole`'s atomic, idempotent
 * `$addToSet` — strictly additive, so it can never remove a capability an
 * Admin deliberately revoked from a role. Run it after adding any new entry
 * to DEFAULT_ROLE_CAPABILITIES (constants/default-role-capabilities.ts) in an
 * environment whose role_capabilities documents already existed before that
 * change:
 *
 *   npx ts-node scripts/reconcile-role-capabilities.ts
 */
import { NestFactory } from '@nestjs/core';

import { AppModule } from '../src/app.module';
import { DEFAULT_ROLE_CAPABILITIES } from '../src/platform/rbac/constants/default-role-capabilities';
import { RbacService } from '../src/platform/rbac/rbac.service';

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const rbacService = app.get(RbacService);

  for (const seed of DEFAULT_ROLE_CAPABILITIES) {
    const existing = new Set(await rbacService.getCapabilitiesForRole(seed.role));
    const missing = seed.capabilities.filter((capability) => !existing.has(capability));

    if (missing.length === 0) {
      console.log(`${seed.role}: already has every default capability, nothing to do.`);
      continue;
    }

    for (const capability of missing) {
      await rbacService.addCapabilityToRole(seed.role, capability);
    }
    console.log(`${seed.role}: added ${missing.length} missing capability(ies): ${missing.join(', ')}`);
  }

  await app.close();
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('reconcile-role-capabilities failed:', error);
    process.exit(1);
  });

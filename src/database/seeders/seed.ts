import 'reflect-metadata';

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AppModule } from '../../app.module';
import { seedDefaultLeaveTypes } from './leave-types.seeder';
import { seedOrgStructure } from './org-structure.seeder';
import { seedSuperAdmin } from './super-admin.seeder';

const logger = new Logger('Seed');

/**
 * `npm run seed` — one-time/idempotent bootstrap data. Boots the real
 * AppModule (same pattern as every phase's own boot smoke tests in this
 * project) so every seeder function runs through the real service layer
 * (with real validation/audit/DB indexes), not a hand-rolled shortcut.
 *
 * Order matters: org structure before SuperAdmin (Staff needs a real
 * department/unit/branch to reference). Leave types don't depend on either.
 */
async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['log', 'warn', 'error'],
  });

  try {
    const org = await seedOrgStructure(app);
    await seedSuperAdmin(app, org);
    await seedDefaultLeaveTypes(app);
    logger.log('Seeding complete.');
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  logger.error('Seeding failed:', error instanceof Error ? error.stack : error);
  process.exit(1);
});

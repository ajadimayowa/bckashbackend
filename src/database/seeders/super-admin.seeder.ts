import { getModelToken } from '@nestjs/mongoose';
import { INestApplicationContext, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcryptjs';
import { Model } from 'mongoose';

import type { SeedConfig } from '../../common/config/configuration';
import { ModuleName, StaffRole, StaffStatus } from '../../common/enums/identity.enums';
import { AuditService } from '../../platform/audit/audit.service';
import { Staff, StaffDocument } from '../../modules/identity/schemas/staff.schema';
import { SeededOrgStructure } from './org-structure.seeder';

const logger = new Logger('SuperAdminSeeder');
const BCRYPT_SALT_ROUNDS = 12;
/** Recognizable non-ObjectId sentinel for automated/system actors — same convention as elsewhere in this codebase (e.g. AuditService callers passing a fixed system id rather than null when "null" would read as "nobody, unaccountably"). */
const SEED_ACTOR_ID = 'SEED_SCRIPT';

/**
 * The first SuperAdmin — genuinely can't come from `POST /staff/direct`
 * (that endpoint's own DTO explicitly excludes SUPERADMIN from its allowed
 * roles; see CreateStaffDirectDto's own doc comment: "how the first
 * SuperAdmin gets created is an open question, not answered by this DTO" —
 * this seeder is the answer). Deliberately bypasses `StaffService.createDirect`
 * (and its role restriction) via direct model access — seeding is a
 * trusted, one-time bootstrap operation, not a live API surface, so it
 * doesn't inherit that surface's restrictions.
 *
 * Idempotent — skips if a Staff document with the configured email already
 * exists (does NOT check "does any SUPERADMIN exist", so a different
 * SuperAdmin created some other way doesn't block re-running this for a
 * *second* one under a different email).
 *
 * Requires `SEED_SUPERADMIN_EMAIL`/`SEED_SUPERADMIN_PASSWORD` — fails
 * loudly rather than falling back to a predictable default, since this is
 * the one account in the whole system nothing else can be locked behind.
 */
export async function seedSuperAdmin(
  app: INestApplicationContext,
  org: SeededOrgStructure,
): Promise<void> {
  const configService = app.get(ConfigService);
  const seedConfig = configService.get<SeedConfig>('seed');

  if (!seedConfig?.superAdminEmail || !seedConfig.superAdminPassword) {
    throw new Error(
      'SEED_SUPERADMIN_EMAIL and SEED_SUPERADMIN_PASSWORD must both be set to seed the bootstrap SuperAdmin — refusing to guess or default a password for the highest-privilege account in the system.',
    );
  }

  const staffModel = app.get<Model<StaffDocument>>(getModelToken(Staff.name));
  const auditService = app.get(AuditService);

  const email = seedConfig.superAdminEmail.toLowerCase();
  const existing = await staffModel.findOne({ email }).exec();
  if (existing) {
    logger.log(`SuperAdmin "${email}" already exists (${existing._id.toString()}) — skipping.`);
    return;
  }

  const passwordHash = await bcrypt.hash(seedConfig.superAdminPassword, BCRYPT_SALT_ROUNDS);
  const created = await staffModel.create({
    firstName: seedConfig.superAdminFirstName,
    lastName: seedConfig.superAdminLastName,
    email,
    phoneNumber: seedConfig.superAdminPhoneNumber,
    passwordHash,
    role: StaffRole.SUPERADMIN,
    // Initiator/Authorizer RBAC — see SeedConfig.superAdminUserType's own
    // doc comment for why Authorizer is the sensible default.
    userType: seedConfig.superAdminUserType,
    departmentId: org.departmentId,
    unitId: org.unitId,
    branchId: org.branchId,
    moduleAccess: [ModuleName.LOANS, ModuleName.ACCOUNTING, ModuleName.HR],
    status: StaffStatus.ACTIVE,
    // Unlike every other Staff record, this password is a real, operator-
    // chosen value from SEED_SUPERADMIN_PASSWORD, not a system-generated
    // temporary one — no welcome email exists to tell them to change it
    // either (this seeder never emits STAFF_CREATED_EVENT — deliberately:
    // it runs via `NestFactory.createApplicationContext`, a plain script
    // context, not the full HTTP app, and the very first SuperAdmin
    // shouldn't depend on Redis/BullMQ being up yet to be usable). The
    // operator is still expected to rotate it after first login, per the
    // log line below, just not enforced via this flag.
    mustChangePassword: false,
  });

  await auditService.record({
    actorId: SEED_ACTOR_ID,
    action: 'SUPERADMIN_SEEDED',
    entityType: 'STAFF',
    entityId: created._id.toString(),
    after: { email, role: StaffRole.SUPERADMIN },
  });

  logger.log(
    `Seeded bootstrap SuperAdmin: ${email} (${created._id.toString()}). Log in and rotate the password.`,
  );
}

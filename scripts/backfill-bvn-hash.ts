/**
 * One-off, re-runnable backfill for KycRecord.bvnHash — added so
 * CustomerService.verifyBvnAndCreateCustomer can reject a BVN already
 * registered to another customer *before* even calling the provider (see
 * that method's own doc comment). `bvnHash` is optional/sparse on the
 * schema specifically because pre-existing records from before this field
 * existed have no way to satisfy a `required` constraint retroactively —
 * this script closes that gap by decrypting each record's own `bvn` (using
 * this environment's PII_ENCRYPTION_KEY) and computing the same
 * deterministic HMAC `EncryptionService.hash` would produce at write time.
 *
 * Safe to re-run — skips any record that already has `bvnHash` set.
 *
 *   npx ts-node scripts/backfill-bvn-hash.ts
 */
import { getModelToken } from '@nestjs/mongoose';
import { NestFactory } from '@nestjs/core';
import { Model } from 'mongoose';

import { AppModule } from '../src/app.module';
import { EncryptionService } from '../src/platform/encryption/encryption.service';
import { KycRecord, KycRecordDocument } from '../src/modules/customers/schemas/kyc-record.schema';

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const kycRecordModel = app.get<Model<KycRecordDocument>>(getModelToken(KycRecord.name));
  const encryptionService = app.get(EncryptionService);

  const missing = await kycRecordModel.find({ bvnHash: null }).exec();
  if (missing.length === 0) {
    console.log('Every KycRecord already has bvnHash set — nothing to do.');
    await app.close();
    return;
  }

  let backfilled = 0;
  let skipped = 0;
  for (const kyc of missing) {
    try {
      const plaintextBvn = encryptionService.decrypt(kyc.bvn);
      kyc.bvnHash = encryptionService.hash(plaintextBvn);
      await kyc.save();
      backfilled += 1;
    } catch (err) {
      // Malformed/undecryptable ciphertext (wrong key, corrupted record) —
      // flagged, not silently swallowed, but doesn't block the rest.
      console.warn(`Skipped KycRecord ${kyc._id.toString()}: ${(err as Error).message}`);
      skipped += 1;
    }
  }

  console.log(`Backfilled bvnHash on ${backfilled} record(s); skipped ${skipped}.`);
  await app.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

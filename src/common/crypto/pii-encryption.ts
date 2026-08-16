import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Field-level encryption for sensitive PII at rest (BVN, NIN, ...). AES-256-GCM:
 * random 12-byte IV per call (so two encryptions of the same plaintext never
 * produce the same ciphertext), 16-byte auth tag (so tampering — or feeding this
 * function the wrong key — fails loudly instead of silently returning garbage).
 *
 * Deliberately plain functions, not a Nest injectable: Mongoose schema `set`/`get`
 * transforms run outside Nest's DI container, so this needs to be callable directly
 * from a schema definition. Nothing here is stateful beyond reading the env var.
 *
 * Ciphertext format stored in Mongo: `<iv>.<authTag>.<ciphertext>`, each base64.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH_BYTES = 12;
const KEY_LENGTH_BYTES = 32;

let cachedKey: Buffer | undefined;

function resolveKey(): Buffer {
  if (cachedKey) {
    return cachedKey;
  }

  const raw = process.env.PII_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      'PII_ENCRYPTION_KEY is not set — cannot encrypt/decrypt PII fields. ' +
        'This should have failed env validation at boot; see src/common/config/env.validation.ts.',
    );
  }

  const key = Buffer.from(raw, 'base64');
  if (key.length !== KEY_LENGTH_BYTES) {
    throw new Error(
      `PII_ENCRYPTION_KEY must decode (base64) to exactly ${KEY_LENGTH_BYTES} bytes, got ${key.length}. ` +
        'Generate one with `openssl rand -base64 32`.',
    );
  }

  cachedKey = key;
  return key;
}

/** Test-only escape hatch — lets specs swap the key between cases without re-spawning the process. */
export function __resetPiiEncryptionKeyCache(): void {
  cachedKey = undefined;
}

export function encryptPii(plaintext: string): string {
  const key = resolveKey();
  const iv = randomBytes(IV_LENGTH_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [iv.toString('base64'), authTag.toString('base64'), encrypted.toString('base64')].join(
    '.',
  );
}

export function decryptPii(ciphertext: string): string {
  const key = resolveKey();
  const parts = ciphertext.split('.');
  if (parts.length !== 3) {
    throw new Error('Malformed PII ciphertext — expected `<iv>.<authTag>.<data>`.');
  }

  const [ivPart, authTagPart, dataPart] = parts as [string, string, string];
  const iv = Buffer.from(ivPart, 'base64');
  const authTag = Buffer.from(authTagPart, 'base64');
  const data = Buffer.from(dataPart, 'base64');

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return decrypted.toString('utf8');
}

/** Last 4 characters of a plaintext identifier, for display (e.g. "•••• 4321") without ever storing the full value unencrypted. */
export function lastFour(plaintext: string): string {
  return plaintext.slice(-4);
}

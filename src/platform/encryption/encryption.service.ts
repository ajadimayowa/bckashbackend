import { Injectable } from '@nestjs/common';

import { decryptPii, encryptPii, hashPii } from '../../common/crypto/pii-encryption';

/**
 * DI-friendly wrapper around common/crypto/pii-encryption.ts's pure
 * functions. The pure functions stay in common/crypto because Mongoose
 * schema `set`/`get` transforms run outside Nest's DI container and need to
 * call them directly; this service exists so ordinary application code
 * (services, not schema definitions) injects and can be mocked in tests
 * rather than reaching for a static import.
 *
 * Lives in platform/ rather than inside the customers module because it's a
 * generic capability other modules will want too (HR salary data, later
 * phases) — same reasoning as platform/audit and platform/rbac.
 */
@Injectable()
export class EncryptionService {
  encrypt(plaintext: string): string {
    return encryptPii(plaintext);
  }

  decrypt(ciphertext: string): string {
    return decryptPii(ciphertext);
  }

  /** Deterministic — for uniqueness lookups only, never reversible. See pii-encryption.ts's own doc comment. */
  hash(plaintext: string): string {
    return hashPii(plaintext);
  }
}

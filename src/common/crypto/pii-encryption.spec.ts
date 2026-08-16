import { randomBytes } from 'node:crypto';

import { __resetPiiEncryptionKeyCache, decryptPii, encryptPii, lastFour } from './pii-encryption';

describe('pii-encryption', () => {
  const originalKey = process.env.PII_ENCRYPTION_KEY;

  beforeEach(() => {
    process.env.PII_ENCRYPTION_KEY = randomBytes(32).toString('base64');
    __resetPiiEncryptionKeyCache();
  });

  afterAll(() => {
    process.env.PII_ENCRYPTION_KEY = originalKey;
    __resetPiiEncryptionKeyCache();
  });

  it('round-trips a plaintext value through encrypt then decrypt', () => {
    const plaintext = '22345678901';

    const ciphertext = encryptPii(plaintext);

    expect(ciphertext).not.toContain(plaintext);
    expect(decryptPii(ciphertext)).toBe(plaintext);
  });

  it('produces a different ciphertext each time for the same plaintext (random IV)', () => {
    const plaintext = '22345678901';

    const first = encryptPii(plaintext);
    const second = encryptPii(plaintext);

    expect(first).not.toBe(second);
    expect(decryptPii(first)).toBe(plaintext);
    expect(decryptPii(second)).toBe(plaintext);
  });

  it('throws rather than silently returning wrong data when the key changes', () => {
    const ciphertext = encryptPii('22345678901');

    process.env.PII_ENCRYPTION_KEY = randomBytes(32).toString('base64');
    __resetPiiEncryptionKeyCache();

    expect(() => decryptPii(ciphertext)).toThrow();
  });

  it('throws on a tampered ciphertext instead of returning corrupted plaintext', () => {
    const ciphertext = encryptPii('22345678901');
    const [iv, authTag, data] = ciphertext.split('.');
    const tamperedData = Buffer.from(data ?? '', 'base64');
    tamperedData[0] = (tamperedData[0] ?? 0) ^ 0xff;
    const tampered = [iv, authTag, tamperedData.toString('base64')].join('.');

    expect(() => decryptPii(tampered)).toThrow();
  });

  it('rejects a malformed ciphertext', () => {
    expect(() => decryptPii('not-the-right-shape')).toThrow(/Malformed PII ciphertext/);
  });

  it('throws a clear error when PII_ENCRYPTION_KEY is missing', () => {
    delete process.env.PII_ENCRYPTION_KEY;
    __resetPiiEncryptionKeyCache();

    expect(() => encryptPii('22345678901')).toThrow(/PII_ENCRYPTION_KEY is not set/);
  });

  it('throws a clear error when PII_ENCRYPTION_KEY is the wrong length', () => {
    process.env.PII_ENCRYPTION_KEY = Buffer.from('too-short').toString('base64');
    __resetPiiEncryptionKeyCache();

    expect(() => encryptPii('22345678901')).toThrow(/must decode \(base64\) to exactly 32 bytes/);
  });

  describe('lastFour', () => {
    it('returns the final 4 characters', () => {
      expect(lastFour('22345678901')).toBe('8901');
    });
  });
});

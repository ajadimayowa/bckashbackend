import { randomInt } from 'node:crypto';

const UPPERCASE = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I/O — avoid look-alike confusion
const LOWERCASE = 'abcdefghijkmnpqrstuvwxyz'; // no l/o
const DIGITS = '23456789'; // no 0/1
const SYMBOLS = '!@#$%^&*';
const ALL = UPPERCASE + LOWERCASE + DIGITS + SYMBOLS;
const LENGTH = 12;

function pick(alphabet: string): string {
  // Safe: randomInt(alphabet.length) is always a valid in-bounds index.
  return alphabet[randomInt(alphabet.length)]!;
}

/**
 * System-generated temporary password for a newly-created staff member —
 * replaces the old design where whoever initiated onboarding/direct-creation
 * typed a password into a form field on the new hire's behalf (awkward: it
 * gave the initiator no real channel to *tell* the new hire what it was).
 * Satisfies the same `IsStrongPassword` shape the DTOs used to validate
 * (10+ chars, upper/lower/number/symbol) by construction — one of each
 * required class first, the rest random, then shuffled so the required
 * characters aren't predictably front-loaded. Uses `crypto.randomInt`
 * (rejection-sampled, uniform), not `Math.random`. Never persisted in
 * plaintext anywhere — only bcrypt-hashed for storage and emitted once, in
 * memory, on the STAFF_CREATED_EVENT the welcome email listens for.
 */
export function generateTemporaryPassword(): string {
  const required = [pick(UPPERCASE), pick(LOWERCASE), pick(DIGITS), pick(SYMBOLS)];
  const rest = Array.from({ length: LENGTH - required.length }, () => pick(ALL));
  const chars = [...required, ...rest];

  // Fisher-Yates shuffle, using the same CSPRNG.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }

  return chars.join('');
}

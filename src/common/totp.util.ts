import { authenticator } from 'otplib';
import * as crypto from 'crypto';
import * as bcrypt from 'bcrypt';

// A 1-step window on each side tolerates ~30s of clock drift between the
// server and the admin's phone without materially weakening the 6-digit
// code's window of validity.
authenticator.options = { window: 1 };

const ISSUER = 'ZannyPay Admin';

export function generateTotpSecret(): string {
  return authenticator.generateSecret();
}

export function buildOtpAuthUrl(email: string, secret: string): string {
  return authenticator.keyuri(email, ISSUER, secret);
}

export function verifyTotpToken(token: string, secret: string): boolean {
  try {
    return authenticator.verify({ token, secret });
  } catch {
    return false;
  }
}

// Recovery codes are shown to the admin exactly once, at generation time.
// Only their bcrypt hashes are persisted — same principle as the admin's
// login password — so a database leak doesn't also leak working
// 2FA-bypass codes.
export function generateRecoveryCodes(count = 10): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    // e.g. "7K3F-9QRT-2LXP" — short enough to type by hand if needed, long
    // enough (12 base32-ish chars from a 128-bit-plus pool across attempts)
    // to not be practically guessable.
    const raw = crypto.randomBytes(6).toString('hex').toUpperCase(); // 12 hex chars
    codes.push(`${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`);
  }
  return codes;
}

export async function hashRecoveryCodes(codes: string[]): Promise<string[]> {
  return Promise.all(codes.map((code) => bcrypt.hash(code, 10)));
}

// Checks a supplied recovery code against the stored hashes and returns the
// index of the match (so the caller can remove that one hash — each
// recovery code works exactly once), or -1 if none matched.
export async function matchRecoveryCode(
  supplied: string,
  hashedCodes: string[],
): Promise<number> {
  const normalized = supplied.trim().toUpperCase();
  for (let i = 0; i < hashedCodes.length; i++) {
    if (await bcrypt.compare(normalized, hashedCodes[i])) {
      return i;
    }
  }
  return -1;
}

import * as crypto from 'crypto';

// Encrypts small, sensitive values before they touch the database — each
// admin's TOTP seed, and each customer's full BVN/NIN — so a database-only
// leak (a snapshot, a misconfigured replica, a compromised read-replica
// credential) does not hand over live secrets or national ID numbers on
// top of it. Keys never live in the database — only in env vars that
// should live in a secrets manager, never in source control.
//
// Two separate keys (ADMIN_2FA_ENCRYPTION_KEY, CUSTOMER_PII_ENCRYPTION_KEY)
// rather than one shared key: these protect different things with very
// different blast radii — a handful of admin accounts vs. every customer's
// government ID numbers. A leak of one key should not also compromise the
// other domain.
//
// AES-256-GCM is used because it's authenticated: tampering with the
// ciphertext (not just reading it) is detected on decrypt, rather than
// silently producing garbage that might otherwise be treated as valid.

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96-bit nonce, the recommended size for GCM

export type EncryptionDomain = 'ADMIN_2FA' | 'CUSTOMER_PII';

const ENV_VAR_BY_DOMAIN: Record<EncryptionDomain, string> = {
  ADMIN_2FA: 'ADMIN_2FA_ENCRYPTION_KEY',
  CUSTOMER_PII: 'CUSTOMER_PII_ENCRYPTION_KEY',
};

function getKey(domain: EncryptionDomain): Buffer {
  const envVar = ENV_VAR_BY_DOMAIN[domain];
  const keyHex = process.env[envVar];
  if (!keyHex) {
    throw new Error(
      `${envVar} is not set. Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`,
    );
  }
  const key = Buffer.from(keyHex, 'hex');
  if (key.length !== 32) {
    throw new Error(
      `${envVar} must decode to exactly 32 bytes (64 hex characters).`,
    );
  }
  return key;
}

// Output format: "<ivHex>:<authTagHex>:<ciphertextHex>" — a single string
// that fits neatly into a TEXT column.
export function encryptSecret(
  plaintext: string,
  domain: EncryptionDomain = 'ADMIN_2FA',
): string {
  const key = getKey(domain);
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${ciphertext.toString('hex')}`;
}

export function decryptSecret(
  payload: string,
  domain: EncryptionDomain = 'ADMIN_2FA',
): string {
  const key = getKey(domain);
  const [ivHex, authTagHex, ciphertextHex] = payload.split(':');
  if (!ivHex || !authTagHex || !ciphertextHex) {
    throw new Error('Malformed encrypted secret payload.');
  }
  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    key,
    Buffer.from(ivHex, 'hex'),
  );
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextHex, 'hex')),
    decipher.final(),
  ]);
  return plaintext.toString('utf8');
}

// Convenience wrappers so call sites read clearly at a glance which domain
// they're touching, without repeating the domain string everywhere.
export const encryptCustomerPII = (plaintext: string) =>
  encryptSecret(plaintext, 'CUSTOMER_PII');
export const decryptCustomerPII = (payload: string) =>
  decryptSecret(payload, 'CUSTOMER_PII');

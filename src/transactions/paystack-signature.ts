import * as crypto from 'crypto';

/** Verify the legacy X-Paystack-Signature against exact raw request bytes. */
export function verifyPaystackSignature(
  rawBody: Buffer,
  signature: unknown,
  secret: string,
): boolean {
  if (!secret || typeof signature !== 'string' || !/^[a-f0-9]{128}$/i.test(signature)) {
    return false;
  }
  const expected = crypto.createHmac('sha512', secret).update(rawBody).digest();
  const supplied = Buffer.from(signature, 'hex');
  return supplied.length === expected.length && crypto.timingSafeEqual(expected, supplied);
}

/**
 * Verify Paystack's timestamped Paystack-Signature header. The whole webhook
 * signing secret (including the whsec_ prefix) is the HMAC key. During secret
 * rotation, Paystack may include multiple v1 signatures; any valid signature
 * within the timestamp tolerance is accepted.
 */
export function verifyPaystackSigningSecret(
  rawBody: Buffer,
  header: unknown,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  if (!secret?.startsWith('whsec_') || typeof header !== 'string' || header.length > 4096) return false;

  let timestamp: string | null = null;
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const separator = part.indexOf('=');
    if (separator < 1) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key === 't') {
      if (timestamp !== null || !/^\d{1,12}$/.test(value)) return false;
      timestamp = value;
    } else if (key === 'v1') {
      const colon = value.indexOf(':');
      if (colon < 1) continue;
      const keyId = value.slice(0, colon);
      const signature = value.slice(colon + 1);
      if (/^whk_[A-Za-z0-9_-]+$/.test(keyId) && /^[a-f0-9]{128}$/.test(signature)) {
        signatures.push(signature);
      }
    }
  }

  if (!timestamp || signatures.length === 0) return false;
  const timestampNumber = Number(timestamp);
  if (!Number.isSafeInteger(timestampNumber) || Math.abs(nowSeconds - timestampNumber) > 300) return false;

  const expected = crypto
    .createHmac('sha512', secret)
    .update(timestamp)
    .update('.')
    .update(rawBody)
    .digest();

  return signatures.some((signature) => {
    const supplied = Buffer.from(signature, 'hex');
    return supplied.length === expected.length && crypto.timingSafeEqual(expected, supplied);
  });
}

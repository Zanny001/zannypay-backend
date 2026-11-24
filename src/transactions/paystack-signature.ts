import * as crypto from 'crypto';

/** Verify Paystack's HMAC-SHA512 signature against the exact raw request bytes. */
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

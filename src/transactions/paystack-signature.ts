import * as crypto from 'crypto';

/**
 * Paystack's x-paystack-signature is an HMAC-SHA512 hex digest of the exact
 * raw HTTP request body. Never verify a parsed-and-reserialized JSON object.
 */
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

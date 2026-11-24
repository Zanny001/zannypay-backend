import * as crypto from 'crypto';
import { verifyPaystackSignature } from './paystack-signature';

describe('Paystack webhook signature verification', () => {
  const secret = 'test-paystack-secret';
  const rawBody = Buffer.from('{ "event": "charge.success", "data": { "reference": "ref-1" } }');

  it('accepts the valid HMAC of the exact raw request bytes', () => {
    const signature = crypto.createHmac('sha512', secret).update(rawBody).digest('hex');
    expect(verifyPaystackSignature(rawBody, signature, secret)).toBe(true);
  });

  it('rejects a signature calculated from reserialized JSON bytes', () => {
    const signature = crypto.createHmac('sha512', secret)
      .update(Buffer.from(JSON.stringify(JSON.parse(rawBody.toString()))))
      .digest('hex');
    expect(verifyPaystackSignature(rawBody, signature, secret)).toBe(false);
  });

  it('rejects malformed, missing and wrong signatures without throwing', () => {
    expect(verifyPaystackSignature(rawBody, undefined, secret)).toBe(false);
    expect(verifyPaystackSignature(rawBody, 'not-a-signature', secret)).toBe(false);
    expect(verifyPaystackSignature(rawBody, '0'.repeat(128), secret)).toBe(false);
  });

  it('fails closed when the webhook secret is absent', () => {
    const signature = crypto.createHmac('sha512', secret).update(rawBody).digest('hex');
    expect(verifyPaystackSignature(rawBody, signature, '')).toBe(false);
  });
});

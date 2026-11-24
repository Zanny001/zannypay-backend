import * as crypto from 'crypto';
import { verifyPaystackSignature } from './paystack-signature';

describe('verifyPaystackSignature', () => {
  const secret = 'unit-test-paystack-secret';

  it('accepts the signature for the exact raw request bytes', () => {
    const rawBody = Buffer.from('{ "event": "charge.success" }');
    const signature = crypto
      .createHmac('sha512', secret)
      .update(rawBody)
      .digest('hex');

    expect(verifyPaystackSignature(rawBody, signature, secret)).toBe(true);
  });

  it('rejects a signature calculated from different bytes', () => {
    const rawBody = Buffer.from('{ "event": "charge.success" }');
    const signature = crypto
      .createHmac('sha512', secret)
      .update(rawBody)
      .digest('hex');

    expect(
      verifyPaystackSignature(Buffer.from('{"event":"charge.success"}'), signature, secret),
    ).toBe(false);
  });

  it('rejects missing or malformed signatures', () => {
    expect(verifyPaystackSignature(Buffer.from('{}'), undefined, secret)).toBe(false);
    expect(verifyPaystackSignature(Buffer.from('{}'), 'invalid', secret)).toBe(false);
  });
});

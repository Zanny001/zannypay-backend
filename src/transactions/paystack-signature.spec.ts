import * as crypto from 'crypto';
import {
  verifyPaystackSignature,
  verifyPaystackSigningSecret,
} from './paystack-signature';

describe('Paystack webhook signatures', () => {
  const secret = 'unit-test-paystack-secret';
  const signingSecret = 'whsec_unit-test-signing-secret';
  const rawBody = Buffer.from('{ "event": "charge.success" }');

  it('accepts the legacy signature for the exact raw request bytes', () => {
    const signature = crypto
      .createHmac('sha512', secret)
      .update(rawBody)
      .digest('hex');
    expect(verifyPaystackSignature(rawBody, signature, secret)).toBe(true);
  });

  it('rejects a legacy signature calculated from different bytes', () => {
    const signature = crypto
      .createHmac('sha512', secret)
      .update(rawBody)
      .digest('hex');
    expect(verifyPaystackSignature(Buffer.from('{}'), signature, secret)).toBe(
      false,
    );
  });

  it('rejects missing or malformed legacy signatures', () => {
    expect(verifyPaystackSignature(rawBody, undefined, secret)).toBe(false);
    expect(verifyPaystackSignature(rawBody, 'invalid', secret)).toBe(false);
  });

  it('accepts timestamped signing-secret signatures, including a rotation overlap', () => {
    const timestamp = '1760270400';
    const signature = crypto
      .createHmac('sha512', signingSecret)
      .update(timestamp)
      .update('.')
      .update(rawBody)
      .digest('hex');
    const header = `t=${timestamp},v1=whk_test-key:${'0'.repeat(128)},v1=whk_active-key:${signature}`;
    expect(
      verifyPaystackSigningSecret(
        rawBody,
        header,
        signingSecret,
        Number(timestamp),
      ),
    ).toBe(true);
  });

  it('rejects timestamped signatures outside the five-minute replay window', () => {
    const timestamp = '1760270400';
    const signature = crypto
      .createHmac('sha512', signingSecret)
      .update(timestamp)
      .update('.')
      .update(rawBody)
      .digest('hex');
    expect(
      verifyPaystackSigningSecret(
        rawBody,
        `t=${timestamp},v1=whk_key:${signature}`,
        signingSecret,
        Number(timestamp) + 301,
      ),
    ).toBe(false);
  });

  it('rejects malformed headers and altered raw bytes', () => {
    const timestamp = '1760270400';
    const signature = crypto
      .createHmac('sha512', signingSecret)
      .update(timestamp)
      .update('.')
      .update(rawBody)
      .digest('hex');
    expect(
      verifyPaystackSigningSecret(
        rawBody,
        `t=x,v1=whk_key:${signature}`,
        signingSecret,
        Number(timestamp),
      ),
    ).toBe(false);
    expect(
      verifyPaystackSigningSecret(
        Buffer.from('{}'),
        `t=${timestamp},v1=whk_key:${signature}`,
        signingSecret,
        Number(timestamp),
      ),
    ).toBe(false);
  });
});

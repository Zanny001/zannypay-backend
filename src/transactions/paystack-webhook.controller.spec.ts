import * as crypto from 'crypto';
import { UnauthorizedException } from '@nestjs/common';
import { PaystackWebhookController } from './paystack-webhook.controller';

describe('PaystackWebhookController', () => {
  const rawBody = Buffer.from('{"event":"charge.success"}');
  const originalWebhookSecret = process.env.PAYSTACK_WEBHOOK_SECRET;
  const originalSecretKey = process.env.PAYSTACK_SECRET_KEY;
  const transactionsService = {
    handlePaystackWebhook: jest
      .fn()
      .mockResolvedValue({ success: true, status: 'completed' }),
  };
  const paystackTransfers = { handleWebhook: jest.fn().mockResolvedValue({ success: true, status: 'completed' }) };
  const controller = new PaystackWebhookController(transactionsService as any, paystackTransfers as any);
  const response = {
    status: jest.fn().mockReturnThis(),
    send: jest.fn().mockReturnThis(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    response.status.mockReturnThis();
    response.send.mockReturnThis();
  });

  afterAll(() => {
    if (originalWebhookSecret === undefined)
      delete process.env.PAYSTACK_WEBHOOK_SECRET;
    else process.env.PAYSTACK_WEBHOOK_SECRET = originalWebhookSecret;
    if (originalSecretKey === undefined) delete process.env.PAYSTACK_SECRET_KEY;
    else process.env.PAYSTACK_SECRET_KEY = originalSecretKey;
  });

  it('verifies the timestamped signing secret before applying a charge.success event', async () => {
    const secret = 'whsec_test-signing-secret';
    process.env.PAYSTACK_WEBHOOK_SECRET = secret;
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = crypto
      .createHmac('sha512', secret)
      .update(timestamp)
      .update('.')
      .update(rawBody)
      .digest('hex');
    const req = {
      rawBody,
      headers: {
        'paystack-signature': `t=${timestamp},v1=whk_test-key:${signature}`,
      },
      body: {
        event: 'charge.success',
        data: { reference: 'FND-test', amount: 10000, currency: 'NGN' },
      },
    };

    await controller.handleWebhook(req, response as any);

    expect(transactionsService.handlePaystackWebhook).toHaveBeenCalledWith(
      'FND-test',
      { amount: 10000, currency: 'NGN' },
    );
    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.send).toHaveBeenCalledWith('Event Acknowledged');
  });

  it('routes signed transfer lifecycle events to the payout service', async () => {
    const secret = 'whsec_test-signing-secret';
    process.env.PAYSTACK_WEBHOOK_SECRET = secret;
    const payload = Buffer.from(JSON.stringify({ event: 'transfer.success', data: { reference: 'ZP-test', amount: 10000, currency: 'NGN' } }));
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = crypto.createHmac('sha512', secret).update(timestamp).update('.').update(payload).digest('hex');
    await controller.handleWebhook({
      rawBody: payload,
      headers: { 'paystack-signature': `t=${timestamp},v1=whk_test-key:${signature}` },
      body: { event: 'transfer.success', data: { reference: 'ZP-test', amount: 10000, currency: 'NGN' } },
    }, response as any);
    expect(paystackTransfers.handleWebhook).toHaveBeenCalledWith('transfer.success', {
      reference: 'ZP-test', amount: 10000, currency: 'NGN',
    });
  });

  it('rejects an invalid timestamped signature without applying the event', async () => {
    process.env.PAYSTACK_WEBHOOK_SECRET = 'whsec_test-signing-secret';
    await expect(
      controller.handleWebhook(
        {
          rawBody,
          headers: {
            'paystack-signature': 't=1760270400,v1=whk_test-key:'.concat(
              '0'.repeat(128),
            ),
          },
          body: {
            event: 'charge.success',
            data: { reference: 'FND-test', amount: 10000, currency: 'NGN' },
          },
        },
        response as any,
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(transactionsService.handlePaystackWebhook).not.toHaveBeenCalled();
  });

  it('continues to verify the legacy header while the signing secret is not configured', async () => {
    delete process.env.PAYSTACK_WEBHOOK_SECRET;
    const secret = 'sk_test_unit_test_only';
    process.env.PAYSTACK_SECRET_KEY = secret;
    const signature = crypto
      .createHmac('sha512', secret)
      .update(rawBody)
      .digest('hex');
    const req = {
      rawBody,
      headers: {
        'paystack-signature': 't=1760270400,v1=whk_test-key:' + '0'.repeat(128),
        'x-paystack-signature': signature,
      },
      body: {
        event: 'charge.success',
        data: { reference: 'FND-legacy', amount: 10000, currency: 'NGN' },
      },
    };

    await controller.handleWebhook(req, response as any);

    expect(transactionsService.handlePaystackWebhook).toHaveBeenCalledWith(
      'FND-legacy',
      { amount: 10000, currency: 'NGN' },
    );
  });
});

import * as crypto from 'crypto';
import { BadRequestException, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import { PaystackWebhookController } from './paystack-webhook.controller';

describe('PaystackWebhookController', () => {
  const secret = 'test-paystack-secret';
  const payload = Buffer.from(JSON.stringify({
    event: 'charge.success',
    data: { reference: 'fund-1', amount: 250000, currency: 'NGN' },
  }));
  const signature = () => crypto.createHmac('sha512', secret).update(payload).digest('hex');
  let controller: PaystackWebhookController;
  let transactions: { handlePaystackWebhook: jest.Mock };

  beforeEach(() => {
    process.env.PAYSTACK_SECRET_KEY = secret;
    transactions = { handlePaystackWebhook: jest.fn() };
    controller = new PaystackWebhookController(transactions as any);
  });

  afterEach(() => {
    delete process.env.PAYSTACK_SECRET_KEY;
  });

  it('fails closed when the webhook secret is missing', async () => {
    delete process.env.PAYSTACK_SECRET_KEY;
    await expect(controller.handleWebhook(
      { rawBody: payload, headers: { 'x-paystack-signature': signature() } },
      JSON.parse(payload.toString()),
      {} as any,
    )).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('rejects invalid signatures before calling the transaction service', async () => {
    await expect(controller.handleWebhook(
      { rawBody: payload, headers: { 'x-paystack-signature': '0'.repeat(128) } },
      JSON.parse(payload.toString()),
      {} as any,
    )).rejects.toBeInstanceOf(BadRequestException);
    expect(transactions.handlePaystackWebhook).not.toHaveBeenCalled();
  });

  it('does not acknowledge an authenticated event when funding was not applied', async () => {
    transactions.handlePaystackWebhook.mockResolvedValue({
      handled: true, success: false, status: 'provider_amount_mismatch',
    });
    await expect(controller.handleWebhook(
      { rawBody: payload, headers: { 'x-paystack-signature': signature() } },
      JSON.parse(payload.toString()),
      {} as any,
    )).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('acknowledges a successfully applied or already-processed payment', async () => {
    transactions.handlePaystackWebhook.mockResolvedValue({
      handled: true, success: true, status: 'completed', alreadyProcessed: true,
    });
    const response = { status: jest.fn().mockReturnThis(), send: jest.fn() };
    await controller.handleWebhook(
      { rawBody: payload, headers: { 'x-paystack-signature': signature() } },
      JSON.parse(payload.toString()),
      response,
    );
    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.send).toHaveBeenCalledWith('Event Acknowledged');
  });
});

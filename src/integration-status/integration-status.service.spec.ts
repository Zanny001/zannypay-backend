import { IntegrationStatusService } from './integration-status.service';

describe('IntegrationStatusService', () => {
  const original = { ...process.env };

  beforeEach(() => {
    delete process.env.TERMII_API_KEY;
    delete process.env.TERMII_SENDER_ID;
    delete process.env.SMTP_HOST;
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASS;
    delete process.env.SMTP_FROM;
    delete process.env.PAYSTACK_SECRET_KEY;
    delete process.env.PAYOUT_PROVIDER;
    delete process.env.PAYSTACK_TRANSFER_ENABLED;
  });

  afterAll(() => {
    process.env = original;
  });

  it('reports provider dependencies as not configured without credentials', () => {
    const result = new IntegrationStatusService().getStatus();
    expect(result.integrations.phoneOtp.configured).toBe(false);
    expect(result.integrations.emailVerification.configured).toBe(false);
    expect(result.integrations.externalBankPayouts.configured).toBe(false);
    expect(result.integrations.virtualCardIssuing.status).toBe(
      'not_integrated',
    );
  });

  it('reports credential presence without claiming live transaction readiness', () => {
    process.env.TERMII_API_KEY = 'test-key';
    process.env.TERMII_SENDER_ID = 'ZannyPay';
    process.env.SMTP_HOST = 'smtp.example.test';
    process.env.SMTP_USER = 'test@example.test';
    process.env.SMTP_PASS = 'test-password';
    process.env.PAYSTACK_SECRET_KEY = 'test-secret';
    process.env.PAYOUT_PROVIDER = 'paystack';
    process.env.PAYSTACK_TRANSFER_ENABLED = 'true';

    const result = new IntegrationStatusService().getStatus();
    expect(result.integrations.phoneOtp.configured).toBe(true);
    expect(result.integrations.emailVerification.configured).toBe(true);
    expect(result.integrations.externalBankPayouts.status).toBe(
      'not_integrated',
    );
    expect(result.disclaimer).toContain('does not prove');
  });
});

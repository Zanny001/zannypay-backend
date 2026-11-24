import { Injectable } from '@nestjs/common';

type IntegrationReadiness = {
  configured: boolean;
  status: 'configured' | 'missing_credentials' | 'not_integrated';
  note: string;
};

@Injectable()
export class IntegrationStatusService {
  getStatus() {
    const env = process.env;
    const smsConfigured = !!(env.TERMII_API_KEY && env.TERMII_SENDER_ID);
    const emailConfigured = !!(
      env.SMTP_HOST &&
      env.SMTP_USER &&
      env.SMTP_PASS &&
      (env.SMTP_FROM || env.SMTP_USER)
    );
    const paystackConfigured = !!env.PAYSTACK_SECRET_KEY;
    const payoutConfigured =
      env.PAYOUT_PROVIDER === 'paystack' &&
      paystackConfigured &&
      env.PAYSTACK_TRANSFER_ENABLED === 'true';

    const status = (
      configured: boolean,
      note: string,
      notIntegrated = false,
    ): IntegrationReadiness => ({
      configured,
      status: notIntegrated
        ? 'not_integrated'
        : configured
          ? 'configured'
          : 'missing_credentials',
      note,
    });

    return {
      generatedAt: new Date().toISOString(),
      disclaimer:
        'Configuration status only. It does not prove provider account approval, network connectivity, successful delivery, or live transaction capability.',
      integrations: {
        phoneOtp: status(
          smsConfigured,
          smsConfigured
            ? 'Termii credentials are present; send a test OTP before production rollout.'
            : 'Configure TERMII_API_KEY and TERMII_SENDER_ID.',
        ),
        emailVerification: status(
          emailConfigured,
          emailConfigured
            ? 'SMTP credentials are present; verify sender-domain authentication and send a test email.'
            : 'Configure SMTP_HOST, SMTP_USER, SMTP_PASS and SMTP_FROM.',
        ),
        bankAccountNameVerification: status(
          paystackConfigured,
          paystackConfigured
            ? 'Paystack secret is present; perform a live/test account-resolution check.'
            : 'Configure PAYSTACK_SECRET_KEY.',
        ),
        externalBankPayouts: status(
          payoutConfigured,
          payoutConfigured
            ? 'Payout configuration is present; complete recipient, webhook, reconciliation and end-to-end test validation.'
            : 'Not enabled. Select an approved payout provider and configure its credentials and transfer permissions.',
        ),
        bvnNinAndLiveness: status(
          false,
          'No production identity-verification adapter is integrated. Select and contract an approved Nigerian identity provider.',
          true,
        ),
        virtualCardIssuing: status(
          false,
          'No genuine card-issuing adapter is integrated. The development mock is not a payment card.',
          true,
        ),
        airtimeDataAndBills: status(
          false,
          'No live biller/airtime fulfilment adapter is integrated.',
          true,
        ),
        loans: status(
          false,
          'No approved lender, funded facility, underwriting rules or disbursement adapter is integrated.',
          true,
        ),
      },
    };
  }
}

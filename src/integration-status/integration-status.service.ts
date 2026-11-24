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
          false,
          'The backend currently blocks external payouts; no live payout adapter is integrated. Provider credentials alone do not enable transfers.',
          true,
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
          env.VTPASS_API_KEY && env.VTPASS_PUBLIC_KEY && env.VTPASS_SECRET_KEY
            ? 'VTpass sandbox client, authenticated catalogue and customer-verification endpoints, catalogue-backed fixed/flexible amount validation, idempotent pending purchase reservation, atomic wallet/ledger posting, provider settlement/reversal and scheduled requery are implemented in the VTpass sandbox adapter. Actual sandbox credentials, provider responses and end-to-end reconciliation have not yet been verified. Purchases require BOTH VTPASS_BILL_PAYMENTS_ENABLED=true and VTPASS_SANDBOX_VERIFIED=true; keep both unset until controlled sandbox tests pass.'
            : 'Configure VTPASS_API_KEY, VTPASS_PUBLIC_KEY and VTPASS_SECRET_KEY for sandbox integration. Purchases remain disabled pending credential and end-to-end sandbox verification.',
          true,
        ),
        loans: status(
          false,
          'No approved lender, funded facility, underwriting rules or disbursement adapter is integrated.',
          true,
        ),
        savingsInterest: status(
          false,
          'Production savings interest is paused until a contracted, funded yield source and required approvals are in place.',
          true,
        ),
      },
    };
  }
}

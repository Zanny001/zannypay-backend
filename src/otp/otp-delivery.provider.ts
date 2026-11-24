import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import * as nodemailer from 'nodemailer';

export interface OtpDeliveryProvider {
  readonly name: string;
  send(target: string, code: string, purpose: string): Promise<void>;
}

/**
 * Development-only delivery. Production module wiring deliberately never
 * selects this class, so a real customer can never be told an OTP was sent
 * when it was merely written to application logs.
 */
@Injectable()
export class MockOtpDeliveryProvider implements OtpDeliveryProvider {
  readonly name = 'mock';
  private readonly logger = new Logger(MockOtpDeliveryProvider.name);

  async send(target: string, code: string, purpose: string): Promise<void> {
    this.logger.warn(
      `[MOCK OTP DELIVERY — development only] ${purpose} code for ${target}: ${code}`,
    );
  }
}

/**
 * Production-capable delivery adapter:
 * - Nigerian/international mobile numbers are delivered through Termii.
 * - Email addresses are delivered through the configured SMTP relay.
 *
 * Credentials are read only from server environment variables. They are
 * never returned by status endpoints or included in logs.
 */
@Injectable()
export class ConfiguredOtpDeliveryProvider implements OtpDeliveryProvider {
  private readonly logger = new Logger(ConfiguredOtpDeliveryProvider.name);

  get name(): string {
    const sms = !!process.env.TERMII_API_KEY;
    const email = !!(
      process.env.SMTP_HOST &&
      process.env.SMTP_USER &&
      process.env.SMTP_PASS
    );
    if (sms && email) return 'termii+smtp';
    if (sms) return 'termii';
    if (email) return 'smtp';
    return 'unconfigured';
  }

  async send(target: string, code: string, purpose: string): Promise<void> {
    if (target.includes('@')) {
      await this.sendEmail(target, code, purpose);
      return;
    }
    await this.sendSms(target, code, purpose);
  }

  private async sendSms(
    target: string,
    code: string,
    purpose: string,
  ): Promise<void> {
    const apiKey = process.env.TERMII_API_KEY;
    const senderId = process.env.TERMII_SENDER_ID;
    if (!apiKey || !senderId) {
      throw new ServiceUnavailableException(
        'SMS delivery is not configured. Please try again later.',
      );
    }

    const digits = target.replace(/\D/g, '');
    const phone =
      digits.length === 11 && digits.startsWith('0')
        ? `234${digits.slice(1)}`
        : digits;
    if (!/^\d{10,15}$/.test(phone)) {
      throw new ServiceUnavailableException(
        'The phone number is not in a supported international format.',
      );
    }

    const baseUrl = (
      process.env.TERMII_BASE_URL || 'https://api.ng.termii.com'
    ).replace(/\/$/, '');
    const messagePurpose = purpose.toLowerCase().replace(/_/g, ' ');
    const response = await fetch(`${baseUrl}/api/sms/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        to: phone,
        from: senderId,
        sms: `Your ZannyPay ${messagePurpose} code is ${code}. It expires in 10 minutes. If you did not request this, ignore this message.`,
        type: 'plain',
        channel: process.env.TERMII_CHANNEL || 'dnd',
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      this.logger.error(
        `Termii SMS request failed with HTTP ${response.status}`,
      );
      throw new ServiceUnavailableException(
        'SMS delivery is temporarily unavailable. Please try again later.',
      );
    }

    const result = (await response.json()) as {
      message?: string;
      message_id?: string;
      code?: string;
    };
    // Termii's documented success payload uses code="ok" alongside a
    // message_id. Treat other codes as failures; do not reject valid sends.
    if (
      (result.code && result.code.toLowerCase() !== 'ok') ||
      (!result.message_id &&
        !result.message?.toLowerCase().includes('success'))
    ) {
      this.logger.error('Termii did not confirm SMS acceptance');
      throw new ServiceUnavailableException(
        'SMS delivery could not be confirmed. Please try again later.',
      );
    }
  }

  private async sendEmail(
    target: string,
    code: string,
    purpose: string,
  ): Promise<void> {
    const host = process.env.SMTP_HOST;
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;
    const from = process.env.SMTP_FROM || user;
    if (!host || !user || !pass || !from) {
      throw new ServiceUnavailableException(
        'Email delivery is not configured. Please try again later.',
      );
    }

    const port = Number(process.env.SMTP_PORT || 587);
    const transporter = nodemailer.createTransport({
      host,
      port,
      secure: process.env.SMTP_SECURE === 'true' || port === 465,
      auth: { user, pass },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 15000,
    });

    try {
      await transporter.sendMail({
        from,
        to: target,
        subject: 'Your ZannyPay verification code',
        text: `Your ZannyPay ${purpose.toLowerCase().replace(/_/g, ' ')} code is ${code}. It expires in 10 minutes. If you did not request this, ignore this email.`,
        html: `<p>Your ZannyPay verification code is:</p><p style="font-size:28px;font-weight:700;letter-spacing:6px">${code}</p><p>This code expires in 10 minutes. If you did not request it, ignore this email.</p>`,
      });
    } catch {
      this.logger.error('SMTP email delivery failed');
      throw new ServiceUnavailableException(
        'Email delivery is temporarily unavailable. Please try again later.',
      );
    } finally {
      transporter.close();
    }
  }
}

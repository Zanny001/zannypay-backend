import { Injectable, Logger } from '@nestjs/common';

// Master audit follow-up: signup accepted any string typed into the
// phone field with zero verification that it belonged to the person
// signing up, and there was no way to recover a forgotten PIN at all —
// an account holding real money with no path back in for its owner.
// This is the pluggable seam for a real SMS/email vendor (Termii,
// Africa's Talking, or Twilio are the common choices for the Nigerian
// market specifically) to actually deliver the code.
export interface OtpDeliveryProvider {
  readonly name: string;
  send(target: string, code: string, purpose: string): Promise<void>;
}

// Logs the code server-side instead of delivering it — there's no real
// SMS/email vendor credential configured. A real deployment MUST set
// OTP_DELIVERY_PROVIDER to an actual vendor before this exists in
// production; logging it is a reasonable, honest stand-in for local
// development (someone testing the flow can read the code from the
// server log), not something that should ever reach this path with a
// real user's phone on the other end.
@Injectable()
export class MockOtpDeliveryProvider implements OtpDeliveryProvider {
  readonly name = 'mock';
  private readonly logger = new Logger(MockOtpDeliveryProvider.name);

  async send(target: string, code: string, purpose: string): Promise<void> {
    this.logger.warn(
      `[MOCK OTP DELIVERY — not actually sent] ${purpose} code for ${target}: ${code}`,
    );
  }
}

import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { PrismaService } from '../prisma/prisma.service';
import type { OtpDeliveryProvider } from './otp-delivery.provider';
import { OTP_DELIVERY_PROVIDER } from './otp.tokens';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';

// Master audit follow-up: signup accepted any string typed into the
// phone field with zero verification that it belonged to the person
// signing up, and there was no way to recover a forgotten PIN at all —
// an account holding real money with no path back in for its owner.
//
// This service issues and verifies one-time codes for two purposes:
//   SIGNUP_VERIFICATION — proves control of the phone number at signup
//   PIN_RESET           — gates the Forgot PIN flow so resetting a PIN
//                         requires proving control of the phone first
//
// Security properties, deliberately chosen:
// - The code is a random 6-digit value from crypto.randomInt (not
//   Math.random — this is a security credential, not a UI animation).
// - Only a bcrypt hash is stored, same discipline as User.pin, so a
//   database read alone can't be used to complete a reset.
// - Codes expire after 10 minutes and allow at most 5 wrong attempts;
//   a locked-out or expired code can only be replaced by requesting a
//   new one, which re-sends to the phone — useless to an attacker who
//   doesn't hold the device.
// - Requesting a new code invalidates every earlier unverified code for
//   the same target+purpose, so at most one live code exists per flow
//   at any time.
// - Verification is purpose-scoped: a code verified for SIGNUP can't be
//   replayed to authorize a PIN_RESET.

export const OTP_PURPOSES = {
  SIGNUP_VERIFICATION: 'SIGNUP_VERIFICATION',
  PIN_RESET: 'PIN_RESET',
} as const;
export type OtpPurpose = (typeof OTP_PURPOSES)[keyof typeof OTP_PURPOSES];

const CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_ATTEMPTS = 5;
const RESEND_COOLDOWN_MS = 60 * 1000; // 1 code per target+purpose per minute

@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(OTP_DELIVERY_PROVIDER)
    private readonly deliveryProvider: OtpDeliveryProvider,
  ) {}

  async requestCode(
    target: string,
    purpose: OtpPurpose,
  ): Promise<{ sent: true; expiresInSeconds: number }> {
    const latest = await this.prisma.otpCode.findFirst({
      where: { target, purpose },
      orderBy: { createdAt: 'desc' },
    });
    if (
      latest &&
      Date.now() - latest.createdAt.getTime() < RESEND_COOLDOWN_MS
    ) {
      // Anti-spam: without this, a script could SMS-bomb someone's phone
      // by hammering the endpoint with their number.
      throw new ThrottlerException(
        'A code was sent less than a minute ago — please wait before requesting another.',
      );
    }

    // Invalidate any earlier unverified codes for this flow — at most one
    // live code per target+purpose at any time.
    await this.prisma.otpCode.deleteMany({
      where: { target, purpose, verified: false },
    });

    const code = crypto.randomInt(0, 1000000).toString().padStart(6, '0');
    const codeHash = await bcrypt.hash(code, 10);

    await this.prisma.otpCode.create({
      data: {
        target,
        purpose,
        codeHash,
        expiresAt: new Date(Date.now() + CODE_TTL_MS),
      },
    });

    await this.deliveryProvider.send(target, code, purpose);
    this.logger.log(
      `OTP issued for purpose ${purpose} via provider '${this.deliveryProvider.name}'`,
    );

    return { sent: true, expiresInSeconds: CODE_TTL_MS / 1000 };
  }

  // Verifies a code and, on success, marks it verified so the consuming
  // flow (signup / PIN reset) can assert ownership happened. Returns true
  // on success; throws otherwise. Each wrong guess consumes one of
  // MAX_ATTEMPTS attempts.
  async verifyCode(
    target: string,
    purpose: OtpPurpose,
    code: string,
  ): Promise<true> {
    const record = await this.prisma.otpCode.findFirst({
      where: { target, purpose, verified: false },
      orderBy: { createdAt: 'desc' },
    });

    if (!record) {
      throw new BadRequestException(
        'No pending code for this number — request a new one.',
      );
    }
    if (record.expiresAt.getTime() < Date.now()) {
      throw new BadRequestException(
        'That code has expired — request a new one.',
      );
    }
    if (record.attempts >= MAX_ATTEMPTS) {
      throw new BadRequestException(
        'Too many wrong attempts — request a new code.',
      );
    }

    const matches = await bcrypt.compare(code, record.codeHash);
    if (!matches) {
      await this.prisma.otpCode.update({
        where: { id: record.id },
        data: { attempts: { increment: 1 } },
      });
      throw new BadRequestException('Incorrect code.');
    }

    await this.prisma.otpCode.update({
      where: { id: record.id },
      data: { verified: true },
    });
    return true;
  }

  // True when a verified, unexpired, unconsumed code exists for this
  // target+purpose. Lets a consuming flow accept a code the client
  // already verified via /auth/otp/verify moments ago, as well as a
  // still-pending code presented directly with the final request.
  async hasVerifiedCode(target: string, purpose: OtpPurpose): Promise<boolean> {
    const record = await this.prisma.otpCode.findFirst({
      where: { target, purpose, verified: true },
      orderBy: { createdAt: 'desc' },
    });
    return !!record && record.expiresAt.getTime() >= Date.now();
  }

  // Asserts that a *verified* code exists for this target+purpose and
  // consumes it (deletes the record) so it can't be reused. Called by the
  // flows the OTP gates — signup completion and PIN reset — rather than
  // by the client directly.
  async consumeVerifiedCode(
    target: string,
    purpose: OtpPurpose,
  ): Promise<void> {
    const record = await this.prisma.otpCode.findFirst({
      where: { target, purpose, verified: true },
      orderBy: { createdAt: 'desc' },
    });

    // A verified code stays valid for the remainder of its original TTL —
    // the user still has to finish the flow promptly, and a stale
    // verification from yesterday can't authorize today's reset.
    if (!record || record.expiresAt.getTime() < Date.now()) {
      throw new BadRequestException(
        'Phone verification is required first — request a code and verify it.',
      );
    }

    await this.prisma.otpCode.delete({ where: { id: record.id } });
  }
}

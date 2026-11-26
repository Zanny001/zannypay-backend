import {
  Injectable,
  BadRequestException,
  ConflictException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { JwtService } from '@nestjs/jwt';
import { SignupDto } from './dto/signup.dto';
import { RequestOtpDto, ResetPinDto, VerifyOtpDto } from './dto/otp.dto';
import { OtpService, OTP_PURPOSES } from '../otp/otp.service';
import {
  generateUniqueReferralCode,
  ensureReferralCode,
} from '../common/referral-code.util';
import {
  AnalyticsService,
  ANALYTICS_EVENTS,
} from '../analytics/analytics.service';
import * as bcrypt from 'bcrypt';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private analyticsService: AnalyticsService,
    private otpService: OtpService,
  ) {}

  async signup(signupDto: SignupDto) {
    const { name, email, phone, pin, referredByCode } = signupDto;

    // Phone-ownership verification is enforced only when
    // REQUIRE_SIGNUP_OTP=true. Default is off because the currently
    // shipped mobile client has no OTP step in its signup flow — turning
    // this on before the client update rolls out would lock every new
    // user out of signup. The endpoints and flow are fully live either
    // way; this flag is the rollout switch, not the feature.
    if (process.env.REQUIRE_SIGNUP_OTP === 'true') {
      await this.otpService.consumeVerifiedCode(
        phone,
        OTP_PURPOSES.SIGNUP_VERIFICATION,
      );
    }

    const existingUser = await this.prisma.user.findUnique({
      where: { phone },
    });
    if (existingUser) {
      throw new ConflictException(
        'A user with this phone number already exists.',
      );
    }

    const hashedPin = await bcrypt.hash(pin, 10);
    const referralCode = await generateUniqueReferralCode(this.prisma);

    // A bad/unknown referral code should never block signup — just proceed
    // without crediting anyone.
    let referredBy: string | undefined;
    if (referredByCode) {
      const referrer = await this.prisma.user.findUnique({
        where: { referralCode: referredByCode.toUpperCase() },
      });
      if (referrer) {
        referredBy = referrer.referralCode;
        // Real reward points for a real referral — not a cosmetic counter.
        await this.prisma.user.update({
          where: { id: referrer.id },
          data: { rewardPoints: { increment: 50 } },
        });
      }
    }

    const newUser = await this.createUserRecord({
      name,
      email,
      phone,
      hashedPin,
      referralCode,
      referredBy,
    });

    const payload = { sub: newUser.id, phone: newUser.phone };
    const accessToken = await this.jwtService.signAsync(payload);

    await this.analyticsService.track(ANALYTICS_EVENTS.SIGNUP_COMPLETED, {
      userId: newUser.id,
      properties: { hasReferrer: !!referredBy },
    });
    if (referredBy) {
      await this.analyticsService.track(ANALYTICS_EVENTS.REFERRAL_SIGNUP, {
        userId: newUser.id,
        properties: { referrerCode: referredBy },
      });
    }

    return {
      access_token: accessToken,
      user: {
        id: newUser.id,
        name: newUser.name,
        email: newUser.email,
        phone: newUser.phone,
        accountNumber: newUser.accountNumber,
        balance: newUser.wallet.balance,
        referralCode: newUser.referralCode,
        kycTier: newUser.kycTier,
        emailVerified: newUser.emailVerified,
      },
    };
  }

  // Account numbers are generated randomly with no uniqueness check at
  // creation time, and a race between two simultaneous signups could both
  // pass the earlier phone-existence check before either finishes creating.
  // Retrying on a P2002 conflict (and regenerating the account number each
  // time) makes signup robust against both without surfacing a raw 500.
  private async createUserRecord(params: {
    name: string;
    email: string;
    phone: string;
    hashedPin: string;
    referralCode: string;
    referredBy?: string;
  }) {
    const { name, email, phone, hashedPin, referralCode, referredBy } = params;

    for (let attempt = 0; attempt < 3; attempt++) {
      const accountNumber =
        '90' + Math.floor(10000000 + Math.random() * 89999999).toString();
      try {
        return await this.prisma.user.create({
          data: {
            name,
            email,
            phone,
            pin: hashedPin,
            accountNumber,
            referralCode,
            referredBy,
            wallet: { create: { balance: 0.0 } },
          },
          include: { wallet: true },
        });
      } catch (error) {
        if (error.code === 'P2002') {
          const conflictField = error.meta?.target?.[0] || error.meta?.target;
          if (conflictField === 'accountNumber') continue;
          if (conflictField?.includes?.('phone') || conflictField === 'phone') {
            throw new ConflictException(
              'A user with this phone number already exists.',
            );
          }
          if (conflictField?.includes?.('email') || conflictField === 'email') {
            throw new ConflictException(
              'A user with this email address already exists.',
            );
          }
        }
        throw error;
      }
    }
    throw new ConflictException(
      'Could not generate a unique account number — please try again.',
    );
  }

  async login(phone: string, plainPin: string) {
    const user = await this.prisma.user.findUnique({ where: { phone } });
    if (!user) throw new UnauthorizedException('No account found.');
    if (user.deletedAt)
      throw new UnauthorizedException('This account has been deleted.');

    const isPinValid = await bcrypt.compare(plainPin, user.pin);
    if (!isPinValid) throw new UnauthorizedException('Incorrect PIN.');

    await ensureReferralCode(this.prisma, user);

    const payload = { sub: user.id, phone: user.phone };
    const accessToken = await this.jwtService.signAsync(payload);

    return {
      access_token: accessToken,
      user: { id: user.id, name: user.name, accountNumber: user.accountNumber },
    };
  }

  // OTP issue/verify — see otp/otp.service.ts for the security model
  // (bcrypt-hashed codes, 10-minute TTL, 5-attempt lockout, single live
  // code per flow, purpose-scoped verification).
  async requestOtp(dto: RequestOtpDto) {
    const isEmailPurpose = dto.purpose === OTP_PURPOSES.EMAIL_VERIFICATION;
    if (isEmailPurpose && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(dto.target)) {
      throw new BadRequestException('A valid email address is required.');
    }
    if (!isEmailPurpose && dto.target.includes('@')) {
      throw new BadRequestException('A valid phone number is required.');
    }

    if (dto.purpose === OTP_PURPOSES.PIN_RESET) {
      const user = await this.prisma.user.findUnique({
        where: { phone: dto.target },
      });
      if (!user) {
        return { sent: true, expiresInSeconds: 600 };
      }
    }

    if (dto.purpose === OTP_PURPOSES.EMAIL_VERIFICATION) {
      const user = await this.prisma.user.findUnique({
        where: { email: dto.target.toLowerCase() },
      });
      if (!user) {
        return { sent: true, expiresInSeconds: 600 };
      }
    }

    const target = isEmailPurpose ? dto.target.toLowerCase() : dto.target;
    return this.otpService.requestCode(target, dto.purpose);
  }

  async verifyOtp(dto: VerifyOtpDto) {
    const target =
      dto.purpose === OTP_PURPOSES.EMAIL_VERIFICATION
        ? dto.target.toLowerCase()
        : dto.target;
    await this.otpService.verifyCode(target, dto.purpose, dto.code);

    if (dto.purpose === OTP_PURPOSES.EMAIL_VERIFICATION) {
      const user = await this.prisma.user.findUnique({
        where: { email: target },
      });
      if (!user) throw new NotFoundException('Email address not found.');
      await this.prisma.user.update({
        where: { id: user.id },
        data: { emailVerified: true },
      });
    }

    return { verified: true };
  }

  // PIN reset is a credential change. Revoke all browser sessions in the
  // same database transaction as the PIN update so a stolen cookie cannot
  // remain valid after the owner has recovered their account.
  async resetPin(dto: ResetPinDto) {
    const user = await this.prisma.user.findUnique({
      where: { phone: dto.phone },
    });
    if (!user)
      throw new NotFoundException('No account found for this phone number.');

    const alreadyVerified = await this.otpService.hasVerifiedCode(
      dto.phone,
      OTP_PURPOSES.PIN_RESET,
    );
    if (!alreadyVerified) {
      await this.otpService.verifyCode(
        dto.phone,
        OTP_PURPOSES.PIN_RESET,
        dto.code,
      );
    }
    await this.otpService.consumeVerifiedCode(
      dto.phone,
      OTP_PURPOSES.PIN_RESET,
    );

    const hashedPin = await bcrypt.hash(dto.newPin, 10);
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: user.id },
        data: { pin: hashedPin },
      }),
      this.prisma.webSession.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);

    await this.analyticsService.track(ANALYTICS_EVENTS.PIN_RESET_COMPLETED, {
      userId: user.id,
    });

    return { reset: true };
  }
}

import { Injectable, ConflictException, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { JwtService } from '@nestjs/jwt';
import { SignupDto } from './dto/signup.dto';
import { generateUniqueReferralCode, ensureReferralCode } from '../common/referral-code.util';
import * as bcrypt from 'bcrypt';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
  ) {}

  async signup(signupDto: SignupDto) {
    const { name, email, phone, pin, referredByCode } = signupDto;

    const existingUser = await this.prisma.user.findUnique({ where: { phone } });
    if (existingUser) {
      throw new ConflictException('A user with this phone number already exists.');
    }

    const hashedPin = await bcrypt.hash(pin, 10);
    const referralCode = await generateUniqueReferralCode(this.prisma);

    // A bad/unknown referral code should never block signup — just proceed
    // without crediting anyone.
    let referredBy: string | undefined;
    if (referredByCode) {
      const referrer = await this.prisma.user.findUnique({ where: { referralCode: referredByCode.toUpperCase() } });
      if (referrer) {
        referredBy = referrer.referralCode;
        // Real reward points for a real referral — not a cosmetic counter.
        await this.prisma.user.update({
          where: { id: referrer.id },
          data: { rewardPoints: { increment: 50 } },
        });
      }
    }

    const newUser = await this.createUserRecord({ name, email, phone, hashedPin, referralCode, referredBy });

    const payload = { sub: newUser.id, phone: newUser.phone };
    const accessToken = await this.jwtService.signAsync(payload);

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
      },
    };
  }

  // Account numbers are generated randomly with no uniqueness check at
  // creation time, and a race between two simultaneous signups could both
  // pass the earlier phone-existence check before either finishes creating.
  // Retrying on a P2002 conflict (and regenerating the account number each
  // time) makes signup robust against both without surfacing a raw 500.
  private async createUserRecord(params: {
    name: string; email: string; phone: string; hashedPin: string; referralCode: string; referredBy?: string;
  }) {
    const { name, email, phone, hashedPin, referralCode, referredBy } = params;

    for (let attempt = 0; attempt < 3; attempt++) {
      const accountNumber = '90' + Math.floor(10000000 + Math.random() * 89999999).toString();
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
            wallet: { create: { balance: 0.00 } },
          },
          include: { wallet: true },
        });
      } catch (error) {
        if (error.code === 'P2002') {
          const conflictField = error.meta?.target?.[0] || error.meta?.target;
          if (conflictField === 'accountNumber') continue; // regenerate and retry
          if (conflictField?.includes?.('phone') || conflictField === 'phone') {
            throw new ConflictException('A user with this phone number already exists.');
          }
          if (conflictField?.includes?.('email') || conflictField === 'email') {
            throw new ConflictException('A user with this email address already exists.');
          }
        }
        throw error;
      }
    }
    throw new ConflictException('Could not generate a unique account number — please try again.');
  }

  async login(phone: string, plainPin: string) {
    const user = await this.prisma.user.findUnique({ where: { phone } });
    if (!user) throw new UnauthorizedException('No account found.');

    const isPinValid = await bcrypt.compare(plainPin, user.pin);
    if (!isPinValid) throw new UnauthorizedException('Incorrect PIN.');

    // Self-heals any legacy row that's still missing a referral code
    // (rather than crashing or leaving it permanently blank).
    await ensureReferralCode(this.prisma, user);

    const payload = { sub: user.id, phone: user.phone };
    const accessToken = await this.jwtService.signAsync(payload);

    return {
      access_token: accessToken,
      user: { id: user.id, name: user.name, accountNumber: user.accountNumber },
    };
  }
}

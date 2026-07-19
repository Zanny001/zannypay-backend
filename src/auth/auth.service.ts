import { Injectable, ConflictException, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { JwtService } from '@nestjs/jwt';
import { SignupDto } from './dto/signup.dto';
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
    const accountNumber = '90' + Math.floor(10000000 + Math.random() * 89999999).toString();
    const referralCode = await this.generateUniqueReferralCode();

    // A bad/unknown referral code should never block signup — just proceed
    // without crediting anyone.
    let referredBy: string | undefined;
    if (referredByCode) {
      const referrer = await this.prisma.user.findUnique({ where: { referralCode: referredByCode.toUpperCase() } });
      if (referrer) referredBy = referrer.referralCode;
    }

    const newUser = await this.prisma.user.create({
      data: {
        name,
        email,
        phone,
        pin: hashedPin,
        accountNumber,
        referralCode,
        referredBy,
        wallet: {
          create: { balance: 0.00 },
        },
      },
      include: { wallet: true },
    });

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

  private async generateUniqueReferralCode(): Promise<string> {
    // A handful of collision retries is more than enough at this user scale;
    // the code space (8 chars, A-Z0-9) is enormous relative to expected volume.
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = Math.random().toString(36).slice(2, 10).toUpperCase();
      const existing = await this.prisma.user.findUnique({ where: { referralCode: code } });
      if (!existing) return code;
    }
    // Extremely unlikely fallback — timestamp-based, still effectively unique.
    return `Z${Date.now().toString(36).toUpperCase()}`;
  }

  async login(phone: string, plainPin: string) {
    const user = await this.prisma.user.findUnique({ where: { phone } });
    if (!user) throw new UnauthorizedException('No account found.');

    const isPinValid = await bcrypt.compare(plainPin, user.pin);
    if (!isPinValid) throw new UnauthorizedException('Incorrect PIN.');

    const payload = { sub: user.id, phone: user.phone };
    const accessToken = await this.jwtService.signAsync(payload);

    return {
      access_token: accessToken,
      user: { id: user.id, name: user.name, accountNumber: user.accountNumber },
    };
  }
}

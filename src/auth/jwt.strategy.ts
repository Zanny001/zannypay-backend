import { ExtractJwt, Strategy } from 'passport-jwt';
import { PassportStrategy } from '@nestjs/passport';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(private readonly prisma: PrismaService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: process.env.JWT_SECRET,
    });
  }

  // Check the customer record on every authenticated request. tokenVersion
  // lets PIN reset/change and account deletion revoke all previously issued
  // native and browser-exchanged JWTs without storing individual JWTs.
  // Tokens issued before this field existed are generation 0 and remain
  // compatible until the customer changes credentials.
  async validate(payload: any) {
    if (!payload?.sub || typeof payload.sub !== 'string') {
      throw new UnauthorizedException('Invalid customer session.');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: {
        id: true,
        phone: true,
        deletedAt: true,
        tokenVersion: true,
      },
    });

    if (
      !user ||
      user.deletedAt ||
      (payload.tokenVersion ?? 0) !== user.tokenVersion
    ) {
      throw new UnauthorizedException('Your session has expired. Please sign in again.');
    }

    return { userId: user.id, phone: user.phone };
  }
}

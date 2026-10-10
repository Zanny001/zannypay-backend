import { ExtractJwt, Strategy } from 'passport-jwt';
import { PassportStrategy } from '@nestjs/passport';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AdminJwtStrategy extends PassportStrategy(Strategy, 'admin-jwt') {
  constructor(private readonly prisma: PrismaService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      // A dedicated secret — never the same value as JWT_SECRET (customer
      // auth). If one leaks, the other's tokens still can't be forged.
      secretOrKey: process.env.ADMIN_JWT_SECRET,
    });
  }

  async validate(payload: any) {
    // A token issued mid-login (after password, before 2FA) carries
    // `mfaPending: true` and is only ever meant to be handed to
    // POST /admin-auth/2fa/verify (which verifies it manually via
    // JwtService, not through this guarded pipeline). If one shows up here
    // instead, 2FA was never completed — refuse it outright rather than
    // silently granting a full session.
    if (payload.mfaPending) {
      throw new UnauthorizedException(
        'Complete two-factor verification to continue.',
      );
    }

    // Re-checking isActive on every request (not just at login) means a
    // deactivated admin's existing token stops working immediately,
    // instead of staying valid until it naturally expires.
    const admin = await this.prisma.adminUser.findUnique({
      where: { id: payload.sub },
    });
    if (!admin || !admin.isActive) {
      throw new UnauthorizedException('This admin session is no longer valid.');
    }

    // Session-table check gives a bare JWT something it can't do on its
    // own: real-time revocation. Logging out, "log out other devices", or
    // a SUPER_ADMIN forcing a revoke all take effect immediately here,
    // rather than waiting out the token's natural 8h expiry.
    if (payload.jti) {
      const session = await this.prisma.adminSession.findUnique({
        where: { jti: payload.jti },
      });
      if (
        !session ||
        session.revokedAt ||
        session.expiresAt.getTime() < Date.now()
      ) {
        throw new UnauthorizedException(
          'This admin session has been revoked or has expired.',
        );
      }
    }

    return {
      adminId: admin.id,
      name: admin.name,
      email: admin.email,
      role: admin.role,
      jti: payload.jti,
    };
  }
}

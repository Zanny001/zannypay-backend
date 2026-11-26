import { Injectable, UnauthorizedException } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import * as bcrypt from 'bcrypt';

export const WEB_SESSION_COOKIE = 'zannypay_session';
export const WEB_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

@Injectable()
export class WebSessionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
  ) {}

  private hash(token: string) {
    return createHash('sha256').update(token).digest('hex');
  }

  // Lock the customer row while validating the credential and inserting the
  // session. PIN-reset/change and account-deletion flows take the same lock.
  // This closes the race where a login verifies an old PIN, waits, and then
  // creates a fresh session after the reset has already revoked old sessions.
  async create(userId: string, request: any, expectedPin?: string) {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + WEB_SESSION_TTL_MS);
    const data = {
      userId,
      tokenHash: this.hash(token),
      expiresAt,
      userAgent: request.headers?.['user-agent']?.slice(0, 500),
      ipAddress: request.ip?.slice(0, 64),
    };

    await this.prisma.$transaction(async (tx) => {
      const users = await tx.$queryRaw<
        Array<{ id: string; pin: string; deletedAt: Date | null }>
      >`SELECT "id", "pin", "deletedAt" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
      const user = users[0];
      if (!user || user.deletedAt) {
        throw new UnauthorizedException('This account is unavailable.');
      }
      if (
        expectedPin !== undefined &&
        !(await bcrypt.compare(expectedPin, user.pin))
      ) {
        throw new UnauthorizedException(
          'Your PIN changed during sign-in. Please try again.',
        );
      }
      await tx.webSession.create({ data });
    });

    return { token, expiresAt };
  }

  async authenticate(token: string) {
    if (!token || token.length > 256) return null;
    const session = await this.prisma.webSession.findUnique({
      where: { tokenHash: this.hash(token) },
      include: {
        user: {
          select: { id: true, phone: true, deletedAt: true, tokenVersion: true },
        },
      },
    });
    if (
      !session ||
      session.revokedAt ||
      session.expiresAt <= new Date() ||
      session.user.deletedAt
    ) {
      return null;
    }
    const accessToken = await this.jwtService.signAsync({
      sub: session.user.id,
      phone: session.user.phone,
      tokenVersion: session.user.tokenVersion,
    });
    return { accessToken, userId: session.user.id };
  }

  async getUser(token: string) {
    if (!token || token.length > 256) return null;
    const session = await this.prisma.webSession.findUnique({
      where: { tokenHash: this.hash(token) },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
            accountNumber: true,
            deletedAt: true,
            businessName: true,
            businessAccountNumber: true,
            profileImage: true,
            kycTier: true,
            kycStatus: true,
            emailVerified: true,
            wallet: { select: { balance: true } },
          },
        },
      },
    });
    if (
      !session ||
      session.revokedAt ||
      session.expiresAt <= new Date() ||
      session.user.deletedAt
    ) {
      return null;
    }
    const user = session.user;
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      accountNumber: user.accountNumber,
      businessName: user.businessName,
      businessAccountNumber: user.businessAccountNumber,
      profileImage: user.profileImage,
      kycTier: user.kycTier,
      kycStatus: user.kycStatus,
      emailVerified: user.emailVerified,
      balance: user.wallet?.balance ?? 0,
    };
  }

  async revoke(token: string) {
    if (!token || token.length > 256) return;
    await this.prisma.webSession.updateMany({
      where: { tokenHash: this.hash(token), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
}

import { Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { JwtService } from '@nestjs/jwt';

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

  async create(userId: string, request: any) {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + WEB_SESSION_TTL_MS);
    await this.prisma.webSession.create({
      data: {
        userId,
        tokenHash: this.hash(token),
        expiresAt,
        userAgent: request.headers?.['user-agent']?.slice(0, 500),
        ipAddress: request.ip?.slice(0, 64),
      },
    });
    return { token, expiresAt };
  }

  async authenticate(token: string) {
    if (!token || token.length > 256) return null;
    const session = await this.prisma.webSession.findUnique({
      where: { tokenHash: this.hash(token) },
      include: { user: { select: { id: true, phone: true, deletedAt: true } } },
    });
    if (!session || session.revokedAt || session.expiresAt <= new Date() || session.user.deletedAt) {
      return null;
    }
    const accessToken = await this.jwtService.signAsync({
      sub: session.user.id,
      phone: session.user.phone,
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
            id: true, name: true, email: true, phone: true, accountNumber: true, deletedAt: true,
            businessName: true, businessAccountNumber: true, profileImage: true,
            kycTier: true, kycStatus: true, emailVerified: true,
            wallet: { select: { balance: true } },
          },
        },
      },
    });
    if (!session || session.revokedAt || session.expiresAt <= new Date() || session.user.deletedAt) return null;
    const { wallet, deletedAt: _deletedAt, ...user } = session.user;
    return { ...user, balance: wallet?.balance ?? 0 };
  }

  async revoke(token: string) {
    if (!token || token.length > 256) return;
    await this.prisma.webSession.updateMany({
      where: { tokenHash: this.hash(token), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
}

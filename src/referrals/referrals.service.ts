import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ensureReferralCode } from '../common/referral-code.util';

// "John Doe" -> "John D." — enough to feel personal in a leaderboard/live
// feed without exposing another user's full name to everyone who opens
// this screen.
function maskName(fullName: string): string {
  const parts = (fullName || 'A ZannyPay user').trim().split(/\s+/);
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1].charAt(0)}.`;
}

@Injectable()
export class ReferralsService {
  constructor(private readonly prisma: PrismaService) {}

  async getMyReferrals(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found.');

    const referralCode = await ensureReferralCode(this.prisma, user);

    const referred = await this.prisma.user.findMany({
      where: { referredBy: referralCode },
      select: { id: true, name: true, createdAt: true, profileImage: true },
      orderBy: { createdAt: 'desc' },
    });

    return {
      referralCode,
      totalReferred: referred.length,
      referred,
    };
  }

  // Real counts, not fabricated — ranks every user who has at least one
  // referral by how many people they've brought in. `referredBy` stores
  // the referrer's *code*, not their id, so this groups by code first and
  // maps back to the referring user afterward.
  async getLeaderboard(userId: string) {
    const grouped = await this.prisma.user.groupBy({
      by: ['referredBy'],
      where: { referredBy: { not: null } },
      _count: { referredBy: true },
    });

    const codes = grouped.map((g) => g.referredBy).filter((c): c is string => !!c);
    const countByCode = Object.fromEntries(grouped.map((g) => [g.referredBy, g._count.referredBy]));

    const referrers = codes.length
      ? await this.prisma.user.findMany({
          where: { referralCode: { in: codes } },
          select: { id: true, name: true, referralCode: true },
        })
      : [];

    const ranked = referrers
      .map((u) => ({ id: u.id, name: maskName(u.name), count: countByCode[u.referralCode!] || 0 }))
      .sort((a, b) => b.count - a.count);

    const me = await this.prisma.user.findUnique({ where: { id: userId }, select: { referralCode: true } });
    const myRankIndex = me?.referralCode ? ranked.findIndex((r) => r.id === userId) : -1;

    // Real recent signups that came through a referral, most recent first —
    // this is the "live activity" feed; nothing here is generated, it's
    // exactly what's in the database.
    const recentActivity = await this.prisma.user.findMany({
      where: { referredBy: { not: null } },
      select: { name: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: 15,
    });

    return {
      leaderboard: ranked.slice(0, 10),
      myRank: myRankIndex >= 0 ? myRankIndex + 1 : null,
      myCount: myRankIndex >= 0 ? ranked[myRankIndex].count : 0,
      recentActivity: recentActivity.map((u) => ({ name: maskName(u.name), joinedAt: u.createdAt })),
    };
  }
}

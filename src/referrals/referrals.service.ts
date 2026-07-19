import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ReferralsService {
  constructor(private readonly prisma: PrismaService) {}

  async getMyReferrals(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found.');

    const referred = await this.prisma.user.findMany({
      where: { referredBy: user.referralCode },
      select: { id: true, name: true, createdAt: true, profileImage: true },
      orderBy: { createdAt: 'desc' },
    });

    return {
      referralCode: user.referralCode,
      totalReferred: referred.length,
      referred,
    };
  }
}

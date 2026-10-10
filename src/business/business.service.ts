import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class BusinessService {
  constructor(private readonly prisma: PrismaService) {}

  // Idempotent — calling this again after activation just returns the
  // existing profile rather than erroring, so the mobile "Activate"
  // button can't accidentally create two numbers for one user.
  async activate(userId: string, businessName: string) {
    const existing = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { businessName: true, businessAccountNumber: true },
    });
    if (existing?.businessAccountNumber) {
      return {
        success: true,
        businessName: existing.businessName,
        businessAccountNumber: existing.businessAccountNumber,
        alreadyActive: true,
      };
    }

    // Same generate-and-retry-on-conflict pattern used for personal account
    // numbers at signup — '91' prefix keeps business numbers visually
    // distinct from the '90'-prefixed personal ones.
    for (let attempt = 0; attempt < 3; attempt++) {
      const businessAccountNumber =
        '91' + Math.floor(10000000 + Math.random() * 89999999).toString();
      try {
        const updated = await this.prisma.user.update({
          where: { id: userId },
          data: { businessName, businessAccountNumber },
          select: { businessName: true, businessAccountNumber: true },
        });
        return { success: true, ...updated, alreadyActive: false };
      } catch (error) {
        if (error.code === 'P2002') continue; // number taken — regenerate and retry
        throw error;
      }
    }
    throw new Error(
      'Could not generate a unique business account number — please try again.',
    );
  }

  async getMyBusiness(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { businessName: true, businessAccountNumber: true },
    });
    if (!user?.businessAccountNumber) {
      throw new NotFoundException(
        'ZannyPay Business has not been activated for this account yet.',
      );
    }

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    // Deliberately a filtered read on the existing Transaction table, not a
    // separate ledger — see the schema comment on User.businessAccountNumber
    // for why. `receivedVia: 'business'` is only ever set on the credit leg
    // of an internal transfer that specifically targeted this number.
    const [todayAgg, totalAgg, todayCount] = await Promise.all([
      this.prisma.transaction.aggregate({
        where: {
          userId,
          type: 'credit',
          receivedVia: 'business',
          createdAt: { gte: startOfToday },
        },
        _sum: { amount: true },
      }),
      this.prisma.transaction.aggregate({
        where: { userId, type: 'credit', receivedVia: 'business' },
        _sum: { amount: true },
      }),
      this.prisma.transaction.count({
        where: {
          userId,
          type: 'credit',
          receivedVia: 'business',
          createdAt: { gte: startOfToday },
        },
      }),
    ]);

    return {
      businessName: user.businessName,
      businessAccountNumber: user.businessAccountNumber,
      todayReceived: Number(todayAgg._sum.amount) || 0,
      todayTransactionCount: todayCount,
      totalReceived: Number(totalAgg._sum.amount) || 0,
    };
  }
}

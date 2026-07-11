import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class UserService {
  constructor(private readonly prisma: PrismaService) {}

  async getUserDashboard(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        wallet: true,
        savingsGoals: true, // <-- GAP A/B: Hydrate savings
        loans: true,        // <-- GAP A/B: Hydrate loans
        cards: true,        // <-- GAP E: Hydrate cards
        invoices: true,     // <-- GAP E: Hydrate invoices
        transactions: {
          orderBy: { createdAt: 'desc' },
          take: 50,
        },
      },
    });

    if (!user) {
      throw new NotFoundException('User profile not found.');
    }

    const { pin, ...safeUserData } = user;

    return {
      user: safeUserData,
      balance: user.wallet?.balance ? Number(user.wallet.balance) : 0,
      transactions: user.transactions || [],
    };
  }
}

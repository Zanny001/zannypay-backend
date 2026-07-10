import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class SavingsService {
  constructor(private prisma: PrismaService) {}

  async createGoal(userId: string, name: string, target: number) {
    if (!name || target <= 0) {
      throw new BadRequestException('Invalid goal name or target amount.');
    }

    const goal = await this.prisma.savingsGoal.create({
      data: {
        userId,
        name,
        target,
        saved: 0,
      },
    });

    return { success: true, goal };
  }

  async deposit(userId: string, goalId: string, amount: number) {
    if (amount <= 0) throw new BadRequestException('Amount must be greater than zero.');

    return await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: userId }, include: { wallet: true } });
      if (!user) throw new NotFoundException('User not found.');

      if (Number(user.wallet.balance) < amount) {
        throw new BadRequestException('Insufficient wallet balance for this deposit.');
      }

      const goal = await tx.savingsGoal.findUnique({ where: { id: goalId } });
      if (!goal || goal.userId !== userId) {
        throw new NotFoundException('Savings goal not found.');
      }

      await tx.wallet.update({
        where: { userId },
        data: { balance: { decrement: amount } },
      });

      const updatedGoal = await tx.savingsGoal.update({
        where: { id: goalId },
        data: { saved: { increment: amount } },
      });

      await tx.transaction.create({
        data: {
          userId,
          type: 'debit',
          category: 'Savings',
          title: `Saved towards ${goal.name}`,
          subtitle: 'Moved to Cashbox',
          amount,
          status: 'completed',
          reference: `SAV-DEP-${Date.now()}`,
        },
      });

      return { success: true, goal: updatedGoal };
    });
  }

  async withdraw(userId: string, goalId: string, amount: number) {
    if (amount <= 0) throw new BadRequestException('Amount must be greater than zero.');

    return await this.prisma.$transaction(async (tx) => {
      const goal = await tx.savingsGoal.findUnique({ where: { id: goalId } });
      if (!goal || goal.userId !== userId) {
        throw new NotFoundException('Savings goal not found.');
      }

      if (Number(goal.saved) < amount) {
        throw new BadRequestException('Insufficient funds in this savings goal.');
      }

      const updatedGoal = await tx.savingsGoal.update({
        where: { id: goalId },
        data: { saved: { decrement: amount } },
      });

      await tx.wallet.update({
        where: { userId },
        data: { balance: { increment: amount } },
      });

      await tx.transaction.create({
        data: {
          userId,
          type: 'credit',
          category: 'Savings',
          title: `Withdrew from ${goal.name}`,
          subtitle: 'Returned to Wallet',
          amount,
          status: 'completed',
          reference: `SAV-WTD-${Date.now()}`,
        },
      });

      return { success: true, goal: updatedGoal };
    });
  }
}

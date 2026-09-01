import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class BudgetsService {
  constructor(private readonly prisma: PrismaService) {}

  async getBudgets(userId: string) {
    const budgets = await this.prisma.budget.findMany({ where: { userId } });
    return { budgets };
  }

  async setBudget(userId: string, category: string, monthlyLimit: number) {
    if (!category || !monthlyLimit || monthlyLimit <= 0) {
      throw new BadRequestException('Provide a category and a valid monthly limit.');
    }

    const budget = await this.prisma.budget.upsert({
      where: { userId_category: { userId, category } },
      update: { monthlyLimit },
      create: { userId, category, monthlyLimit },
    });

    return { success: true, budget };
  }

  async deleteBudget(userId: string, category: string) {
    await this.prisma.budget.deleteMany({ where: { userId, category } });
    return { success: true };
  }
}

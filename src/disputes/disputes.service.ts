import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class DisputesService {
  constructor(private readonly prisma: PrismaService) {}

  async createDispute(userId: string, transactionId: string, reason: string, details?: string) {
    if (!transactionId || !reason) {
      throw new BadRequestException('A transaction and a reason are required to raise a dispute.');
    }

    const transaction = await this.prisma.transaction.findFirst({ where: { id: transactionId, userId } });
    if (!transaction) {
      throw new NotFoundException('That transaction could not be found on your account.');
    }

    const existingOpenDispute = await this.prisma.dispute.findFirst({
      where: { transactionId, userId, status: { in: ['open', 'under_review'] } },
    });
    if (existingOpenDispute) {
      return { success: true, dispute: existingOpenDispute, alreadyExists: true };
    }

    const dispute = await this.prisma.dispute.create({
      data: { userId, transactionId, reason, details },
    });

    return { success: true, dispute };
  }

  async getMyDisputes(userId: string) {
    const disputes = await this.prisma.dispute.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
    return { disputes };
  }
}

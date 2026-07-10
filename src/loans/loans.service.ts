import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class LoansService {
  private readonly LOAN_INTEREST_RATE = 0.05; // 5% flat fee

  constructor(private prisma: PrismaService) {}

  async requestLoan(userId: string, amount: number, termDays: number = 30) {
    if (amount <= 0) throw new BadRequestException('Invalid loan amount.');

    return await this.prisma.$transaction(async (tx) => {
      const activeLoan = await tx.loan.findFirst({
        where: { userId, repaid: false },
      });

      if (activeLoan) {
        throw new BadRequestException('You already have an active loan. Please repay it first.');
      }

      const fee = amount * this.LOAN_INTEREST_RATE;
      const totalOwed = amount + fee;
      const dueDate = new Date(Date.now() + termDays * 24 * 60 * 60 * 1000);

      const loan = await tx.loan.create({
        data: {
          userId,
          principal: amount,
          fee,
          totalOwed,
          termDays,
          dueDate,
        },
      });

      await tx.wallet.update({
        where: { userId },
        data: { balance: { increment: amount } },
      });

      await tx.transaction.create({
        data: {
          userId,
          type: 'credit',
          category: 'Flexi Credit',
          title: 'Loan Disbursed',
          subtitle: `${termDays}-day term`,
          amount,
          status: 'completed',
          reference: `LOAN-DIS-${Date.now()}`,
        },
      });

      return { success: true, loan };
    });
  }

  async repayLoan(userId: string, amount: number) {
    if (amount <= 0) throw new BadRequestException('Amount must be greater than zero.');

    return await this.prisma.$transaction(async (tx) => {
      const activeLoan = await tx.loan.findFirst({
        where: { userId, repaid: false },
      });

      if (!activeLoan) {
        throw new BadRequestException('No active loan found to repay.');
      }

      const user = await tx.user.findUnique({ where: { id: userId }, include: { wallet: true } });
      if (!user) throw new NotFoundException('User not found.');

      if (Number(user.wallet.balance) < amount) {
        throw new BadRequestException('Insufficient wallet balance to make this repayment.');
      }

      const remainingBalance = Number(activeLoan.totalOwed) - Number(activeLoan.amountRepaid);
      const paymentAmount = Math.min(amount, remainingBalance);

      const newAmountRepaid = Number(activeLoan.amountRepaid) + paymentAmount;
      const isRepaid = newAmountRepaid >= Number(activeLoan.totalOwed);

      const updatedLoan = await tx.loan.update({
        where: { id: activeLoan.id },
        data: {
          amountRepaid: newAmountRepaid,
          repaid: isRepaid,
        },
      });

      await tx.wallet.update({
        where: { userId },
        data: { balance: { decrement: paymentAmount } },
      });

      await tx.transaction.create({
        data: {
          userId,
          type: 'debit',
          category: 'Flexi Credit',
          title: isRepaid ? 'Loan Fully Repaid' : 'Loan Repayment',
          subtitle: `Payment applied to balance`,
          amount: paymentAmount,
          status: 'completed',
          reference: `LOAN-REP-${Date.now()}`,
        },
      });

      return { success: true, loan: updatedLoan };
    });
  }
}

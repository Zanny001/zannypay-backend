import {
  Injectable,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { LedgerAccountType, LedgerDirection } from '@prisma/client';
import {
  AnalyticsService,
  ANALYTICS_EVENTS,
} from '../analytics/analytics.service';

@Injectable()
export class LoansService {
  private readonly LOAN_INTEREST_RATE = 0.05; // 5% flat fee

  constructor(
    private prisma: PrismaService,
    private ledgerService: LedgerService,
    private analyticsService: AnalyticsService,
  ) {}

  async requestLoan(userId: string, amount: number, termDays: number = 30) {
    if (amount <= 0) throw new BadRequestException('Invalid loan amount.');

    const result = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: userId } });
      if (!user) throw new NotFoundException('User not found.');
      if (user.isFrozen)
        throw new ForbiddenException(
          'Your account is currently restricted. Please contact support.',
        );

      const activeLoan = await tx.loan.findFirst({
        where: { userId, repaid: false },
      });

      if (activeLoan) {
        throw new BadRequestException(
          'You already have an active loan. Please repay it first.',
        );
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

      const disbursementTxn = await tx.transaction.create({
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

      // Only the principal is disbursed to the wallet — the fee is
      // ZannyPay's revenue on repayment, not money that ever reaches the
      // customer, so it never appears as its own ledger line here (the
      // repayment side below blends principal+fee back into
      // SYSTEM_LOAN_POOL together — see the schema comment on that
      // simplification).
      const loanPoolAccount = await this.ledgerService.getOrCreateSystemAccount(
        LedgerAccountType.SYSTEM_LOAN_POOL,
        tx,
      );
      const walletAccountLoan =
        await this.ledgerService.getOrCreateCustomerAccount(
          LedgerAccountType.CUSTOMER_WALLET,
          userId,
          tx,
        );
      await this.ledgerService.postJournal(
        tx,
        [
          {
            accountId: loanPoolAccount.id,
            direction: LedgerDirection.DEBIT,
            amount,
          },
          {
            accountId: walletAccountLoan.id,
            direction: LedgerDirection.CREDIT,
            amount,
          },
        ],
        {
          transactionId: disbursementTxn.id,
          memo: `Loan disbursement, ${termDays}-day term`,
        },
      );

      return { success: true, loan };
    });

    await this.analyticsService.track(ANALYTICS_EVENTS.LOAN_REQUESTED, {
      userId,
      properties: { amount, termDays },
    });

    return result;
  }

  async repayLoan(userId: string, amount: number) {
    if (amount <= 0)
      throw new BadRequestException('Amount must be greater than zero.');

    const result = await this.prisma.$transaction(async (tx) => {
      const activeLoan = await tx.loan.findFirst({
        where: { userId, repaid: false },
      });

      if (!activeLoan) {
        throw new BadRequestException('No active loan found to repay.');
      }

      const user = await tx.user.findUnique({
        where: { id: userId },
        include: { wallet: true },
      });
      if (!user) throw new NotFoundException('User not found.');

      if (Number(user.wallet.balance) < amount) {
        throw new BadRequestException(
          'Insufficient wallet balance to make this repayment.',
        );
      }

      const remainingBalance =
        Number(activeLoan.totalOwed) - Number(activeLoan.amountRepaid);
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

      const repaymentTxn = await tx.transaction.create({
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

      const walletAccountRepay =
        await this.ledgerService.getOrCreateCustomerAccount(
          LedgerAccountType.CUSTOMER_WALLET,
          userId,
          tx,
        );
      const loanPoolAccountRepay =
        await this.ledgerService.getOrCreateSystemAccount(
          LedgerAccountType.SYSTEM_LOAN_POOL,
          tx,
        );
      await this.ledgerService.postJournal(
        tx,
        [
          {
            accountId: walletAccountRepay.id,
            direction: LedgerDirection.DEBIT,
            amount: paymentAmount,
          },
          {
            accountId: loanPoolAccountRepay.id,
            direction: LedgerDirection.CREDIT,
            amount: paymentAmount,
          },
        ],
        {
          transactionId: repaymentTxn.id,
          memo: isRepaid ? 'Final loan repayment' : 'Loan repayment',
        },
      );

      return { success: true, loan: updatedLoan, isRepaid, paymentAmount };
    });

    await this.analyticsService.track(ANALYTICS_EVENTS.LOAN_REPAID, {
      userId,
      properties: {
        amount: result.paymentAmount,
        isFullyRepaid: result.isRepaid,
      },
    });

    return { success: result.success, loan: result.loan };
  }
}

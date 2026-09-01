import { Injectable, BadRequestException, ForbiddenException, NotFoundException, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { LedgerAccountType, LedgerDirection } from '@prisma/client';
import { AnalyticsService, ANALYTICS_EVENTS } from '../analytics/analytics.service';

@Injectable()
export class SavingsService {
  // Single source of truth for the advertised savings rate. Previously
  // this only existed as a hardcoded, purely cosmetic constant on the
  // mobile client (SAVINGS_APY = 0.15 in WalletContext.js) with no real
  // accrual anywhere on the backend — the "15% p.a." shown on
  // SavingsScreen was never actually credited to anyone. It's real now:
  // accrueDailyInterest() below actually pays this rate out, daily.
  static readonly ANNUAL_INTEREST_RATE = 0.15; // 15% p.a. — matches what the app has always advertised

  private readonly logger = new Logger(SavingsService.name);

  constructor(
    private prisma: PrismaService,
    private ledgerService: LedgerService,
    private analyticsService: AnalyticsService,
  ) {}

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

    await this.analyticsService.track(ANALYTICS_EVENTS.SAVINGS_GOAL_CREATED, { userId, properties: { target } });

    return { success: true, goal };
  }

  async deposit(userId: string, goalId: string, amount: number) {
    if (amount <= 0) throw new BadRequestException('Amount must be greater than zero.');

    const result = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: userId }, include: { wallet: true } });
      if (!user) throw new NotFoundException('User not found.');
      if (user.isFrozen) throw new ForbiddenException('Your account is currently restricted. Please contact support.');

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

      const depositTxn = await tx.transaction.create({
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

      // Both sides of this journal belong to the same user — money moving
      // from their spendable wallet into their own savings account, not
      // to any other party or system account.
      const walletAccount = await this.ledgerService.getOrCreateCustomerAccount(LedgerAccountType.CUSTOMER_WALLET, userId, tx);
      const savingsAccount = await this.ledgerService.getOrCreateCustomerAccount(LedgerAccountType.CUSTOMER_SAVINGS, userId, tx);
      await this.ledgerService.postJournal(
        tx,
        [
          { accountId: walletAccount.id, direction: LedgerDirection.DEBIT, amount },
          { accountId: savingsAccount.id, direction: LedgerDirection.CREDIT, amount },
        ],
        { transactionId: depositTxn.id, memo: `Deposit to savings goal: ${goal.name}` },
      );

      return { success: true, goal: updatedGoal };
    });

    await this.analyticsService.track(ANALYTICS_EVENTS.SAVINGS_DEPOSIT_COMPLETED, { userId, properties: { amount } });

    return result;
  }

  async withdraw(userId: string, goalId: string, amount: number) {
    if (amount <= 0) throw new BadRequestException('Amount must be greater than zero.');

    return await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: userId } });
      if (!user) throw new NotFoundException('User not found.');
      if (user.isFrozen) throw new ForbiddenException('Your account is currently restricted. Please contact support.');

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

      const withdrawTxn = await tx.transaction.create({
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

      const walletAccountWtd = await this.ledgerService.getOrCreateCustomerAccount(LedgerAccountType.CUSTOMER_WALLET, userId, tx);
      const savingsAccountWtd = await this.ledgerService.getOrCreateCustomerAccount(LedgerAccountType.CUSTOMER_SAVINGS, userId, tx);
      await this.ledgerService.postJournal(
        tx,
        [
          { accountId: savingsAccountWtd.id, direction: LedgerDirection.DEBIT, amount },
          { accountId: walletAccountWtd.id, direction: LedgerDirection.CREDIT, amount },
        ],
        { transactionId: withdrawTxn.id, memo: `Withdrawal from savings goal: ${goal.name}` },
      );

      return { success: true, goal: updatedGoal };
    });
  }

  // ==========================================
  // Daily interest accrual — see the class-level doc comment on
  // ANNUAL_INTEREST_RATE for why this exists at all.
  // ==========================================
  @Cron(CronExpression.EVERY_DAY_AT_1AM)
  async accrueDailyInterestScheduled() {
    try {
      const result = await this.accrueDailyInterest();
      this.logger.log(`Daily interest accrual: credited ${result.usersCredited} user(s), total ₦${result.totalAccrued.toFixed(2)}.`);
    } catch (err: any) {
      // Same transient-connectivity handling as the ledger reconciliation
      // and recurring-transfer cron jobs — a DB/pooler blip shouldn't
      // surface as a raw stack trace, and tomorrow's run will retry.
      const isConnectivityIssue = err?.code === 'P1001' || /Can't reach database server/i.test(err?.message || '');
      if (isConnectivityIssue) {
        this.logger.error(`Daily interest accrual could not reach the database — skipping, will retry tomorrow. (${err.message})`);
      } else {
        this.logger.error(`Daily interest accrual failed unexpectedly: ${err.message}`, err.stack);
      }
    }
  }

  /**
   * The actual accrual logic, separated from the @Cron wrapper so it's
   * directly unit-testable and callable on demand. Compounds each user's
   * own total saved balance (grouped across all their goals, since the
   * advertised rate is a platform-wide one, not per-goal), distributes
   * the interest back across their individual goals proportionally, and
   * posts one combined ledger journal + one Transaction row per user —
   * matching how OPay/PalmPay surface a single daily "interest earned"
   * line rather than one per savings goal.
   */
  async accrueDailyInterest(): Promise<{ usersCredited: number; totalAccrued: number }> {
    const dailyRate = SavingsService.ANNUAL_INTEREST_RATE / 365;
    const goalTotals = await this.prisma.savingsGoal.groupBy({ by: ['userId'], _sum: { saved: true } });

    let usersCredited = 0;
    let totalAccrued = 0;

    for (const row of goalTotals) {
      const totalSaved = Number(row._sum.saved || 0);
      if (totalSaved <= 0) continue;

      const interest = Math.round(totalSaved * dailyRate * 100) / 100; // round to the nearest kobo
      if (interest <= 0) continue; // a balance too small to earn even one kobo today — nothing to post

      await this.prisma.$transaction(async (tx) => {
        // Distributed across the user's goals proportionally to how much
        // each contributed to the total — the last goal absorbs whatever
        // rounding remainder is left, a standard way to allocate a
        // rounded total across parts without the shares silently
        // summing to slightly more or less than the whole.
        const goals = await tx.savingsGoal.findMany({ where: { userId: row.userId } });
        let remaining = interest;
        for (let i = 0; i < goals.length; i++) {
          const isLast = i === goals.length - 1;
          const share = isLast ? remaining : Math.round((Number(goals[i].saved) / totalSaved) * interest * 100) / 100;
          if (share <= 0) continue;
          await tx.savingsGoal.update({ where: { id: goals[i].id }, data: { saved: { increment: share } } });
          remaining -= share;
        }

        const interestTxn = await tx.transaction.create({
          data: {
            userId: row.userId,
            type: 'credit',
            category: 'Savings Interest',
            title: 'Savings Interest Earned',
            subtitle: `${(SavingsService.ANNUAL_INTEREST_RATE * 100).toFixed(0)}% p.a.`,
            amount: interest,
            status: 'completed',
            reference: `INT-${Date.now()}-${row.userId.slice(0, 8)}`,
          },
        });

        const savingsAccount = await this.ledgerService.getOrCreateCustomerAccount(LedgerAccountType.CUSTOMER_SAVINGS, row.userId, tx);
        const interestExpenseAccount = await this.ledgerService.getOrCreateSystemAccount(LedgerAccountType.SYSTEM_INTEREST_EXPENSE, tx);
        await this.ledgerService.postJournal(
          tx,
          [
            { accountId: interestExpenseAccount.id, direction: LedgerDirection.DEBIT, amount: interest },
            { accountId: savingsAccount.id, direction: LedgerDirection.CREDIT, amount: interest },
          ],
          { transactionId: interestTxn.id, memo: 'Daily savings interest accrual' },
        );
      });

      usersCredited++;
      totalAccrued += interest;
      // Deliberately no push notification here — a nightly sub-naira
      // interest credit is exactly the kind of expected, recurring event
      // that would turn into notification fatigue if pushed daily. It's
      // still fully visible in-app (Recent Activity, the Home screen's
      // earnings strip, and the transaction itself), just not interruptive.
    }

    return { usersCredited, totalAccrued };
  }

  /** Powers the mobile Home screen's earnings strip — the most recent interest credit, if any. */
  async getLastInterestEarned(userId: string) {
    const last = await this.prisma.transaction.findFirst({
      where: { userId, category: 'Savings Interest' },
      orderBy: { createdAt: 'desc' },
    });
    if (!last) return null;
    return { amount: Number(last.amount), earnedAt: last.createdAt };
  }
}

import { Test, TestingModule } from '@nestjs/testing';
import { SavingsService } from './savings.service';
import { PrismaService } from '../prisma/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { LedgerDirection } from '@prisma/client';

describe('SavingsService', () => {
  let service: SavingsService;
  let prisma: any;
  let ledgerService: any;

  beforeEach(async () => {
    prisma = {
      savingsGoal: {
        groupBy: jest.fn(),
        findMany: jest.fn(),
        update: jest.fn(),
      },
      transaction: { create: jest.fn() },
      $transaction: jest.fn((callback) => callback(prisma)),
    };
    ledgerService = {
      getOrCreateCustomerAccount: jest
        .fn()
        .mockResolvedValue({ id: 'acc-savings' }),
      getOrCreateSystemAccount: jest
        .fn()
        .mockResolvedValue({ id: 'acc-interest-expense' }),
      postJournal: jest.fn().mockResolvedValue('journal-1'),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SavingsService,
        { provide: PrismaService, useValue: prisma },
        { provide: LedgerService, useValue: ledgerService },
        { provide: AnalyticsService, useValue: { track: jest.fn() } },
      ],
    }).compile();

    service = module.get<SavingsService>(SavingsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('accrueDailyInterest', () => {
    it('skips a user with zero total saved', async () => {
      prisma.savingsGoal.groupBy.mockResolvedValue([
        { userId: 'user-1', _sum: { saved: 0 } },
      ]);

      const result = await service.accrueDailyInterest();

      expect(result).toEqual({ usersCredited: 0, totalAccrued: 0 });
      expect(prisma.transaction.create).not.toHaveBeenCalled();
    });

    it('skips a balance too small to earn even one kobo today, without erroring', async () => {
      // 15% p.a. / 365 on a tiny balance rounds to 0.00 — nothing to post.
      prisma.savingsGoal.groupBy.mockResolvedValue([
        { userId: 'user-1', _sum: { saved: 0.5 } },
      ]);

      const result = await service.accrueDailyInterest();

      expect(result.usersCredited).toBe(0);
      expect(prisma.transaction.create).not.toHaveBeenCalled();
    });

    it('credits interest, creates a Transaction row, and posts a balanced ledger journal for a real balance', async () => {
      prisma.savingsGoal.groupBy.mockResolvedValue([
        { userId: 'user-1', _sum: { saved: 100000 } },
      ]);
      prisma.savingsGoal.findMany.mockResolvedValue([
        { id: 'goal-1', userId: 'user-1', saved: 100000 },
      ]);
      prisma.transaction.create.mockResolvedValue({ id: 'txn-interest-1' });

      const result = await service.accrueDailyInterest();

      // 100,000 * (0.15/365) = 41.0958... -> rounds to 41.10
      expect(result.usersCredited).toBe(1);
      expect(result.totalAccrued).toBeCloseTo(41.1, 2);

      expect(prisma.transaction.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            userId: 'user-1',
            category: 'Savings Interest',
            type: 'credit',
          }),
        }),
      );

      const journalCall = ledgerService.postJournal.mock.calls[0];
      const lines = journalCall[1];
      const debit = lines.find(
        (l: any) => l.direction === LedgerDirection.DEBIT,
      );
      const credit = lines.find(
        (l: any) => l.direction === LedgerDirection.CREDIT,
      );
      expect(debit.accountId).toBe('acc-interest-expense');
      expect(credit.accountId).toBe('acc-savings');
      expect(debit.amount).toBeCloseTo(credit.amount, 2); // balanced
    });

    it('distributes interest proportionally across multiple goals, with the last goal absorbing any rounding remainder', async () => {
      // Goal A: 70,000 (70% of total) / Goal B: 30,000 (30% of total), total 100,000
      prisma.savingsGoal.groupBy.mockResolvedValue([
        { userId: 'user-1', _sum: { saved: 100000 } },
      ]);
      prisma.savingsGoal.findMany.mockResolvedValue([
        { id: 'goal-a', userId: 'user-1', saved: 70000 },
        { id: 'goal-b', userId: 'user-1', saved: 30000 },
      ]);
      prisma.transaction.create.mockResolvedValue({ id: 'txn-interest-1' });

      await service.accrueDailyInterest();

      const updateCalls = prisma.savingsGoal.update.mock.calls;
      expect(updateCalls).toHaveLength(2);
      const goalAIncrement = updateCalls.find(
        (c: any) => c[0].where.id === 'goal-a',
      )[0].data.saved.increment;
      const goalBIncrement = updateCalls.find(
        (c: any) => c[0].where.id === 'goal-b',
      )[0].data.saved.increment;
      // Roughly 70/30 split of ~41.10 total — goal A's share should be
      // meaningfully larger than goal B's, not an even split.
      expect(goalAIncrement).toBeGreaterThan(goalBIncrement * 2);
      // The two shares should sum back to the total interest (the whole
      // point of giving the last goal the remainder rather than letting
      // independently-rounded shares drift from the total).
      expect(goalAIncrement + goalBIncrement).toBeCloseTo(41.1, 1);
    });

    it('accrues independently per user — one user having zero savings does not block another from being credited', async () => {
      prisma.savingsGoal.groupBy.mockResolvedValue([
        { userId: 'user-1', _sum: { saved: 0 } },
        { userId: 'user-2', _sum: { saved: 50000 } },
      ]);
      prisma.savingsGoal.findMany.mockResolvedValue([
        { id: 'goal-2', userId: 'user-2', saved: 50000 },
      ]);
      prisma.transaction.create.mockResolvedValue({ id: 'txn-interest-2' });

      const result = await service.accrueDailyInterest();

      expect(result.usersCredited).toBe(1);
      expect(prisma.transaction.create).toHaveBeenCalledTimes(1);
      expect(prisma.transaction.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ userId: 'user-2' }),
        }),
      );
    });
  });

  describe('getLastInterestEarned', () => {
    it('returns null when the user has never earned interest', async () => {
      prisma.transaction = {
        ...prisma.transaction,
        findFirst: jest.fn().mockResolvedValue(null),
      };

      const result = await service.getLastInterestEarned('user-1');

      expect(result).toBeNull();
    });

    it('returns the amount and date of the most recent interest credit', async () => {
      const earnedAt = new Date('2026-08-19T01:00:00Z');
      prisma.transaction = {
        ...prisma.transaction,
        findFirst: jest
          .fn()
          .mockResolvedValue({ amount: 41.1, createdAt: earnedAt }),
      };

      const result = await service.getLastInterestEarned('user-1');

      expect(result).toEqual({ amount: 41.1, earnedAt });
    });
  });
});

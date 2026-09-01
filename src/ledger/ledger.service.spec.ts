import { LedgerService } from './ledger.service';
import { LedgerAccountType, LedgerDirection } from '@prisma/client';

// LedgerService takes only PrismaService in its constructor, so it's
// instantiated directly here rather than through a full Nest
// TestingModule — nothing else it depends on needs DI ceremony to mock.
describe('LedgerService', () => {
  let service: LedgerService;
  let prisma: any;

  beforeEach(() => {
    prisma = {
      ledgerAccount: { upsert: jest.fn() },
      ledgerEntry: { createMany: jest.fn(), findMany: jest.fn(), aggregate: jest.fn(), findFirst: jest.fn() },
      wallet: { findMany: jest.fn() },
      savingsGoal: { groupBy: jest.fn() },
      $transaction: jest.fn((callback) => callback(prisma)),
    };
    service = new LedgerService(prisma as any);
  });

  describe('postJournal — the core double-entry invariant', () => {
    it('rejects a journal where debits and credits do not sum to the same total', async () => {
      const client = { ledgerEntry: { createMany: jest.fn() } } as any;

      await expect(
        service.postJournal(client, [
          { accountId: 'acc-a', direction: LedgerDirection.DEBIT, amount: 100 },
          { accountId: 'acc-b', direction: LedgerDirection.CREDIT, amount: 99 },
        ]),
      ).rejects.toThrow(/Unbalanced journal/);

      expect(client.ledgerEntry.createMany).not.toHaveBeenCalled();
    });

    it('rejects a journal with fewer than two lines', async () => {
      const client = { ledgerEntry: { createMany: jest.fn() } } as any;

      await expect(
        service.postJournal(client, [{ accountId: 'acc-a', direction: LedgerDirection.DEBIT, amount: 100 }]),
      ).rejects.toThrow(/at least two lines/);
    });

    it('rejects a zero or negative amount line even in an otherwise-balanced-looking journal', async () => {
      const client = { ledgerEntry: { createMany: jest.fn() } } as any;

      await expect(
        service.postJournal(client, [
          { accountId: 'acc-a', direction: LedgerDirection.DEBIT, amount: 0 },
          { accountId: 'acc-b', direction: LedgerDirection.CREDIT, amount: 0 },
        ]),
      ).rejects.toThrow(/positive amount/);
    });

    it('accepts a small floating-point rounding difference within tolerance', async () => {
      const client = { ledgerEntry: { createMany: jest.fn().mockResolvedValue({}) } } as any;

      await expect(
        service.postJournal(client, [
          { accountId: 'acc-a', direction: LedgerDirection.DEBIT, amount: 100.001 },
          { accountId: 'acc-b', direction: LedgerDirection.CREDIT, amount: 100.002 },
        ]),
      ).resolves.toBeDefined();
    });

    it('writes every line with the same journalId, and only on a balanced journal', async () => {
      const client = { ledgerEntry: { createMany: jest.fn().mockResolvedValue({}) } } as any;

      await service.postJournal(client, [
        { accountId: 'acc-a', direction: LedgerDirection.DEBIT, amount: 500 },
        { accountId: 'acc-b', direction: LedgerDirection.CREDIT, amount: 500 },
      ]);

      const call = client.ledgerEntry.createMany.mock.calls[0][0];
      expect(call.data).toHaveLength(2);
      expect(call.data[0].journalId).toBe(call.data[1].journalId);
      expect(call.data[0].amount).toBe(500);
      expect(call.data[1].amount).toBe(500);
    });

    it('supports a journal with more than two lines as long as debits still equal credits in total', async () => {
      const client = { ledgerEntry: { createMany: jest.fn().mockResolvedValue({}) } } as any;

      await expect(
        service.postJournal(client, [
          { accountId: 'acc-a', direction: LedgerDirection.DEBIT, amount: 300 },
          { accountId: 'acc-b', direction: LedgerDirection.DEBIT, amount: 200 },
          { accountId: 'acc-c', direction: LedgerDirection.CREDIT, amount: 500 },
        ]),
      ).resolves.toBeDefined();
    });
  });

  describe('getOrCreateSystemAccount', () => {
    it('throws for a customer account type — system accounts and customer accounts are not interchangeable', async () => {
      await expect(service.getOrCreateSystemAccount(LedgerAccountType.CUSTOMER_WALLET)).rejects.toThrow(/customer account type/);
    });

    it('upserts on a fixed, deterministic id per type rather than relying on the (type, userId) unique constraint', async () => {
      prisma.ledgerAccount.upsert.mockResolvedValue({ id: 'sysacct-loan-pool', type: LedgerAccountType.SYSTEM_LOAN_POOL, userId: null });

      const account = await service.getOrCreateSystemAccount(LedgerAccountType.SYSTEM_LOAN_POOL);

      expect(prisma.ledgerAccount.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'sysacct-loan-pool' },
          create: { id: 'sysacct-loan-pool', type: LedgerAccountType.SYSTEM_LOAN_POOL, userId: null },
        }),
      );
      expect(account.id).toBe('sysacct-loan-pool');
    });

    it('resolves to the same fixed id every time for a given type, regardless of how many times it is called', async () => {
      prisma.ledgerAccount.upsert.mockResolvedValue({ id: 'sysacct-biller-clearing' });

      await service.getOrCreateSystemAccount(LedgerAccountType.SYSTEM_BILLER_CLEARING);
      await service.getOrCreateSystemAccount(LedgerAccountType.SYSTEM_BILLER_CLEARING);

      const firstCallId = prisma.ledgerAccount.upsert.mock.calls[0][0].where.id;
      const secondCallId = prisma.ledgerAccount.upsert.mock.calls[1][0].where.id;
      expect(firstCallId).toBe(secondCallId);
    });
  });

  describe('getOrCreateCustomerAccount', () => {
    it('upserts on the composite (type, userId) key', async () => {
      prisma.ledgerAccount.upsert.mockResolvedValue({ id: 'acc-1', type: LedgerAccountType.CUSTOMER_WALLET, userId: 'user-1' });

      await service.getOrCreateCustomerAccount(LedgerAccountType.CUSTOMER_WALLET, 'user-1');

      expect(prisma.ledgerAccount.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { type_userId: { type: LedgerAccountType.CUSTOMER_WALLET, userId: 'user-1' } },
          create: { type: LedgerAccountType.CUSTOMER_WALLET, userId: 'user-1' },
        }),
      );
    });
  });

  describe('reverseJournal', () => {
    it('returns null and does not post anything when the original transaction has no ledger entries', async () => {
      prisma.ledgerEntry.findMany.mockResolvedValue([]);
      const client = { ledgerEntry: { createMany: jest.fn(), findMany: prisma.ledgerEntry.findMany } } as any;

      const result = await service.reverseJournal(client, 'txn-with-no-ledger-history', 'txn-reversal');

      expect(result).toBeNull();
      expect(client.ledgerEntry.createMany).not.toHaveBeenCalled();
    });

    it('inverts every line of the original journal — DEBIT becomes CREDIT and vice versa, same accounts and amounts', async () => {
      const originalEntries = [
        { ledgerAccountId: 'acc-sender', direction: LedgerDirection.DEBIT, amount: 5000 },
        { ledgerAccountId: 'acc-recipient', direction: LedgerDirection.CREDIT, amount: 5000 },
      ];
      const client = {
        ledgerEntry: {
          findMany: jest.fn().mockResolvedValue(originalEntries),
          createMany: jest.fn().mockResolvedValue({}),
        },
      } as any;

      await service.reverseJournal(client, 'original-txn', 'reversal-txn');

      const posted = client.ledgerEntry.createMany.mock.calls[0][0].data;
      const senderLine = posted.find((l: any) => l.ledgerAccountId === 'acc-sender');
      const recipientLine = posted.find((l: any) => l.ledgerAccountId === 'acc-recipient');
      expect(senderLine.direction).toBe(LedgerDirection.CREDIT); // was DEBIT
      expect(recipientLine.direction).toBe(LedgerDirection.DEBIT); // was CREDIT
      expect(senderLine.amount).toBe(5000);
      expect(recipientLine.amount).toBe(5000);
    });
  });

  describe('getAccountBalance', () => {
    it('is credits minus debits, not the other way around', async () => {
      prisma.ledgerEntry.aggregate
        .mockResolvedValueOnce({ _sum: { amount: 8000 } }) // credits
        .mockResolvedValueOnce({ _sum: { amount: 3000 } }); // debits

      const balance = await service.getAccountBalance('acc-1');

      expect(balance).toBe(5000);
    });

    it('treats an account with no entries at all as a zero balance, not an error', async () => {
      prisma.ledgerEntry.aggregate
        .mockResolvedValueOnce({ _sum: { amount: null } })
        .mockResolvedValueOnce({ _sum: { amount: null } });

      const balance = await service.getAccountBalance('acc-never-touched');

      expect(balance).toBe(0);
    });
  });

  describe('seedOpeningBalances', () => {
    // Regression coverage for a real gap: the first version of this
    // method only ever seeded CUSTOMER_WALLET accounts, never
    // CUSTOMER_SAVINGS — so any pre-existing SavingsGoal.saved total
    // showed up as a permanent, unexplained reconciliation discrepancy
    // on every run, for a reason that had nothing to do with a real bug
    // in the money movement itself.
    beforeEach(() => {
      prisma.ledgerAccount.upsert.mockImplementation(({ create }: any) => Promise.resolve({ id: `acc-${create.type}-${create.userId}`, ...create }));
    });

    it('seeds an opening balance for both a wallet and a savings total that predate the ledger', async () => {
      prisma.wallet.findMany.mockResolvedValue([{ userId: 'user-1', balance: 10000 }]);
      prisma.savingsGoal.groupBy.mockResolvedValue([{ userId: 'user-1', _sum: { saved: 4000 } }]);
      prisma.ledgerEntry.findFirst.mockResolvedValue(null); // neither account has entries yet

      const result = await service.seedOpeningBalances();

      expect(result).toEqual({ seeded: 2, skipped: 0 });
      expect(prisma.ledgerEntry.createMany).toHaveBeenCalledTimes(2);
    });

    it('skips a wallet or savings account that already has ledger entries, without posting a duplicate journal', async () => {
      prisma.wallet.findMany.mockResolvedValue([{ userId: 'user-1', balance: 10000 }]);
      prisma.savingsGoal.groupBy.mockResolvedValue([]);
      prisma.ledgerEntry.findFirst.mockResolvedValue({ id: 'existing-entry' }); // already seeded

      const result = await service.seedOpeningBalances();

      expect(result).toEqual({ seeded: 0, skipped: 1 });
      expect(prisma.ledgerEntry.createMany).not.toHaveBeenCalled();
    });

    it('skips a zero-balance wallet without treating it as an error', async () => {
      prisma.wallet.findMany.mockResolvedValue([{ userId: 'user-1', balance: 0 }]);
      prisma.savingsGoal.groupBy.mockResolvedValue([]);
      prisma.ledgerEntry.findFirst.mockResolvedValue(null);

      const result = await service.seedOpeningBalances();

      expect(result).toEqual({ seeded: 0, skipped: 1 });
    });

    it('is safe to run twice in a row — the second run seeds nothing new', async () => {
      prisma.wallet.findMany.mockResolvedValue([{ userId: 'user-1', balance: 10000 }]);
      prisma.savingsGoal.groupBy.mockResolvedValue([]);
      prisma.ledgerEntry.findFirst.mockResolvedValueOnce(null); // first run: not yet seeded

      const first = await service.seedOpeningBalances();
      expect(first).toEqual({ seeded: 1, skipped: 0 });

      prisma.ledgerEntry.findFirst.mockResolvedValue({ id: 'now-exists' }); // second run: already seeded
      const second = await service.seedOpeningBalances();
      expect(second).toEqual({ seeded: 0, skipped: 1 });
    });
  });
});

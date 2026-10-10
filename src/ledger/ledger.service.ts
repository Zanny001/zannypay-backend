import { Injectable, Logger } from '@nestjs/common';
import { LedgerAccountType, LedgerDirection, Prisma } from '@prisma/client';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';

// Postgres unique constraints treat NULL as distinct from every other
// NULL — so @@unique([type, userId]) on LedgerAccount does NOT actually
// stop two rows from being created with the same `type` and
// `userId: null`; that constraint only does real work for customer
// accounts, where userId is always a concrete value. System accounts
// (userId always null) instead get a fixed, deterministic primary key per
// type — "get or create" becomes an upsert on a known id, so uniqueness
// comes from the primary key itself rather than a constraint that can't
// actually see two NULLs as duplicates.
const SYSTEM_ACCOUNT_IDS: Partial<Record<LedgerAccountType, string>> = {
  [LedgerAccountType.SYSTEM_LOAN_POOL]: 'sysacct-loan-pool',
  [LedgerAccountType.SYSTEM_PAYSTACK_CLEARING]: 'sysacct-paystack-clearing',
  [LedgerAccountType.SYSTEM_EXTERNAL_PAYOUT_CLEARING]:
    'sysacct-external-payout-clearing',
  [LedgerAccountType.SYSTEM_BILLER_CLEARING]: 'sysacct-biller-clearing',
  [LedgerAccountType.SYSTEM_OPENING_BALANCE_EQUITY]:
    'sysacct-opening-balance-equity',
  [LedgerAccountType.SYSTEM_ADMIN_ADJUSTMENT]: 'sysacct-admin-adjustment',
  [LedgerAccountType.SYSTEM_INTEREST_EXPENSE]: 'sysacct-interest-expense',
};

export interface JournalLine {
  accountId: string;
  direction: LedgerDirection;
  amount: number;
}

// The full rationale for why this exists at all lives in the schema
// comment above the LedgerAccount model — short version: Wallet.balance
// (and SavingsGoal.saved, Loan.amountRepaid) are cached values that can
// drift from reality with no way to detect it. Every money-moving service
// now posts a balanced journal here in the SAME Prisma $transaction as
// the cache update, so ReconciliationService always has an independent
// source of truth to check the cache against.
//
// Every method that writes MUST be called with `tx` — the Prisma
// transaction client passed into the caller's own `$transaction(async
// (tx) => {...})` callback, never `this.prisma` directly — so a journal
// can never be posted without the cache update it's meant to back (or
// vice versa) surviving a partial failure.
@Injectable()
export class LedgerService {
  private readonly logger = new Logger(LedgerService.name);

  constructor(private readonly prisma: PrismaService) {}

  private tx(client?: Prisma.TransactionClient) {
    return client ?? this.prisma;
  }

  /**
   * Resolves (creating if necessary) the single platform-wide account for
   * a SYSTEM_* type, via a fixed deterministic id per type — see the
   * SYSTEM_ACCOUNT_IDS comment above for why this doesn't rely on the
   * @@unique([type, userId]) constraint the way customer accounts do.
   * upsert() on a known primary key is race-safe on its own: concurrent
   * callers either both no-op into the same existing row, or one creates
   * it and the other's create becomes a no-op update — never two rows.
   */
  async getOrCreateSystemAccount(
    type: LedgerAccountType,
    client?: Prisma.TransactionClient,
  ) {
    const id = SYSTEM_ACCOUNT_IDS[type];
    if (!id) {
      throw new Error(
        `${type} is a customer account type — use getOrCreateCustomerAccount() with a userId instead.`,
      );
    }
    const db = this.tx(client);
    return db.ledgerAccount.upsert({
      where: { id },
      update: {},
      create: { id, type, userId: null },
    });
  }

  /**
   * Same deterministic-primary-key safety as system accounts isn't needed
   * here — userId is never null for a customer account, so
   * @@unique([type, userId]) is a real, DB-enforced constraint in this
   * case, and Prisma's upsert() compiles to a single atomic
   * INSERT ... ON CONFLICT, race-safe without any manual retry logic.
   */
  async getOrCreateCustomerAccount(
    type:
      | typeof LedgerAccountType.CUSTOMER_WALLET
      | typeof LedgerAccountType.CUSTOMER_SAVINGS,
    userId: string,
    client?: Prisma.TransactionClient,
  ) {
    const db = this.tx(client);
    return db.ledgerAccount.upsert({
      where: { type_userId: { type, userId } },
      update: {},
      create: { type, userId },
    });
  }

  /**
   * Posts a balanced journal — throws before writing anything if the
   * debits and credits don't sum to the same amount, which is what makes
   * this a real double-entry ledger rather than just a differently-shaped
   * transaction log. Every line lands with the same journalId, so the
   * whole journal can be found (and, via reverseJournal, undone) as a unit.
   */
  async postJournal(
    client: Prisma.TransactionClient,
    lines: JournalLine[],
    options?: { transactionId?: string; memo?: string },
  ): Promise<string> {
    if (lines.length < 2) {
      throw new Error(
        'A journal needs at least two lines — a single-sided entry is not double-entry bookkeeping.',
      );
    }

    const debitTotal = lines
      .filter((l) => l.direction === LedgerDirection.DEBIT)
      .reduce((sum, l) => sum + l.amount, 0);
    const creditTotal = lines
      .filter((l) => l.direction === LedgerDirection.CREDIT)
      .reduce((sum, l) => sum + l.amount, 0);

    // Cents-level tolerance for floating point — amounts are ultimately
    // stored as Decimal, but this check runs on plain JS numbers before
    // that conversion.
    if (Math.abs(debitTotal - creditTotal) > 0.005) {
      throw new Error(
        `Unbalanced journal: debits ₦${debitTotal.toFixed(2)} != credits ₦${creditTotal.toFixed(2)}. Nothing was written.`,
      );
    }
    if (lines.some((l) => l.amount <= 0)) {
      throw new Error(
        'Every journal line must be a positive amount — a zero or negative line is never valid, even for a reversal (reverseJournal flips direction, not sign).',
      );
    }

    const journalId = crypto.randomUUID();
    await client.ledgerEntry.createMany({
      data: lines.map((line) => ({
        ledgerAccountId: line.accountId,
        direction: line.direction,
        amount: line.amount,
        journalId,
        transactionId: options?.transactionId,
        memo: options?.memo,
      })),
    });

    return journalId;
  }

  /**
   * Posts the mirror image of whatever journal(s) were recorded against
   * `originalTransactionId` — every DEBIT becomes a CREDIT and vice versa,
   * on the same accounts, for the same amounts. This is how an accounting
   * reversal is supposed to work: it never needs to know *which* accounts
   * were involved, only that inverting the original is always correct.
   * Returns null (not an error) if the original transaction predates the
   * ledger and has no entries to invert — AdminService.reverseTransaction
   * already updates Wallet.balance directly in that case and this is a
   * no-op layered on top, not a blocker.
   */
  async reverseJournal(
    client: Prisma.TransactionClient,
    originalTransactionId: string,
    newTransactionId: string,
    memo?: string,
  ): Promise<string | null> {
    const originalEntries = await client.ledgerEntry.findMany({
      where: { transactionId: originalTransactionId },
    });
    if (originalEntries.length === 0) {
      this.logger.warn(
        `reverseJournal: no ledger entries found for transaction ${originalTransactionId} — likely predates the ledger, skipping.`,
      );
      return null;
    }

    const inverted: JournalLine[] = originalEntries.map((entry) => ({
      accountId: entry.ledgerAccountId,
      direction:
        entry.direction === LedgerDirection.DEBIT
          ? LedgerDirection.CREDIT
          : LedgerDirection.DEBIT,
      amount: Number(entry.amount),
    }));

    return this.postJournal(client, inverted, {
      transactionId: newTransactionId,
      memo: memo || 'Reversal',
    });
  }

  /**
   * The source-of-truth balance for one account, derived from its entries
   * — this is what ReconciliationService checks Wallet.balance /
   * SavingsGoal totals against. Deliberately NOT cached; called
   * relatively rarely (reconciliation runs, not the hot request path),
   * so a live aggregate is the right tradeoff over yet another cache that
   * could itself drift.
   */
  async getAccountBalance(accountId: string): Promise<number> {
    const [credits, debits] = await Promise.all([
      this.prisma.ledgerEntry.aggregate({
        where: {
          ledgerAccountId: accountId,
          direction: LedgerDirection.CREDIT,
        },
        _sum: { amount: true },
      }),
      this.prisma.ledgerEntry.aggregate({
        where: { ledgerAccountId: accountId, direction: LedgerDirection.DEBIT },
        _sum: { amount: true },
      }),
    ]);
    return Number(credits._sum.amount || 0) - Number(debits._sum.amount || 0);
  }

  /**
   * One-time, idempotent go-live migration: for every existing Wallet
   * whose CUSTOMER_WALLET ledger account has no entries yet, posts an
   * opening-balance journal (Debit SYSTEM_OPENING_BALANCE_EQUITY, Credit
   * the customer's wallet account) for the wallet's current balance —
   * and does the same for CUSTOMER_SAVINGS, seeded from the sum of each
   * user's SavingsGoal.saved. This is the standard accounting way to
   * bring a pre-existing balance into a ledger that started empty —
   * without it, every wallet or savings total that predates this ledger
   * would show as a reconciliation discrepancy forever, which isn't a
   * real problem, just an artifact of go-live timing.
   * Safe to run more than once — already-seeded accounts are skipped.
   */
  async seedOpeningBalances(): Promise<{ seeded: number; skipped: number }> {
    let seeded = 0;
    let skipped = 0;

    const wallets = await this.prisma.wallet.findMany();
    for (const wallet of wallets) {
      const didSeed = await this.seedOpeningBalanceFor(
        LedgerAccountType.CUSTOMER_WALLET,
        wallet.userId,
        Number(wallet.balance),
      );
      if (didSeed) {
        seeded++;
      } else {
        skipped++;
      }
    }

    // Same gap as wallets, easy to miss the first time around: a
    // SavingsGoal.saved total that predates the ledger needs its own
    // opening-balance journal against CUSTOMER_SAVINGS, or it shows up
    // as a permanent reconciliation discrepancy for no real reason —
    // exactly what a fresh deployment will see if this half is skipped.
    const savingsTotals = await this.prisma.savingsGoal.groupBy({
      by: ['userId'],
      _sum: { saved: true },
    });
    for (const row of savingsTotals) {
      const didSeed = await this.seedOpeningBalanceFor(
        LedgerAccountType.CUSTOMER_SAVINGS,
        row.userId,
        Number(row._sum.saved || 0),
      );
      if (didSeed) {
        seeded++;
      } else {
        skipped++;
      }
    }

    this.logger.log(
      `seedOpeningBalances: seeded ${seeded} account(s), skipped ${skipped} (already seeded or zero balance).`,
    );
    return { seeded, skipped };
  }

  /** Shared by both halves of seedOpeningBalances above — identical logic, different account type and source balance. */
  private async seedOpeningBalanceFor(
    type:
      | typeof LedgerAccountType.CUSTOMER_WALLET
      | typeof LedgerAccountType.CUSTOMER_SAVINGS,
    userId: string,
    balance: number,
  ): Promise<boolean> {
    const account = await this.getOrCreateCustomerAccount(type, userId);
    const alreadyHasEntries = await this.prisma.ledgerEntry.findFirst({
      where: { ledgerAccountId: account.id },
    });

    if (alreadyHasEntries || balance <= 0) return false;

    const equity = await this.getOrCreateSystemAccount(
      LedgerAccountType.SYSTEM_OPENING_BALANCE_EQUITY,
    );
    await this.prisma.$transaction(async (tx) => {
      await this.postJournal(
        tx,
        [
          {
            accountId: equity.id,
            direction: LedgerDirection.DEBIT,
            amount: balance,
          },
          {
            accountId: account.id,
            direction: LedgerDirection.CREDIT,
            amount: balance,
          },
        ],
        { memo: `Opening balance — ledger go-live seed (${type})` },
      );
    });
    return true;
  }
}

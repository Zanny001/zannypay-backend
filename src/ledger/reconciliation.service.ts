import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { LedgerAccountType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LedgerService } from './ledger.service';

const DISCREPANCY_TOLERANCE = 0.01; // one kobo — anything beyond this is a real finding, not float noise

// Exported — LedgerController.reconcileNow() returns ReconciliationService.
// run()'s result type directly (Promise<{ ...; discrepancies: Discrepancy[] }>),
// and TypeScript's declaration emit needs every type reachable from an
// exported class's public method signature to itself be exported, or the
// build fails with TS4053 ("has or is using name 'Discrepancy' ... but
// cannot be named").
export interface Discrepancy {
  userId: string;
  kind: 'wallet' | 'savings';
  cachedValue: number;
  ledgerValue: number;
  difference: number;
}

// Master audit / continuation request: "a periodic reconciliation job
// that alerts on any mismatch" between the cached balance every screen
// reads and the independent ledger that's supposed to back it. This
// service only ever reads and records — it never corrects a discrepancy
// automatically, on purpose. An automatic "fix" risks papering over a
// real bug (or worse, a real incident) with a silent balance change;
// every finding here is meant to be investigated by a human before
// anything is touched.
@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledgerService: LedgerService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async runScheduled() {
    // Same reasoning as RecurringTransfersService.runDueTransfers — a
    // transient DB/pooler connectivity blip (Prisma P1001) shouldn't
    // surface as a raw, uncontextualized stack trace via
    // @nestjs/schedule's generic error handler; log it clearly and let
    // tomorrow's 3am run retry naturally.
    try {
      await this.run();
    } catch (err: any) {
      const isConnectivityIssue =
        err?.code === 'P1001' ||
        /Can't reach database server/i.test(err?.message || '');
      if (isConnectivityIssue) {
        this.logger.error(
          `Scheduled reconciliation could not reach the database — skipping, will retry tomorrow. (${err.message})`,
        );
      } else {
        this.logger.error(
          `Scheduled reconciliation failed unexpectedly: ${err.message}`,
          err.stack,
        );
      }
    }
  }

  /** Also callable on demand — see LedgerController's manual-trigger endpoint for an admin who doesn't want to wait for 3am. */
  async run(): Promise<{
    accountsChecked: number;
    discrepancies: Discrepancy[];
  }> {
    const discrepancies: Discrepancy[] = [];
    let accountsChecked = 0;

    const wallets = await this.prisma.wallet.findMany({
      select: { userId: true, balance: true },
    });
    for (const wallet of wallets) {
      accountsChecked++;
      const account = await this.ledgerService.getOrCreateCustomerAccount(
        LedgerAccountType.CUSTOMER_WALLET,
        wallet.userId,
      );
      const ledgerBalance = await this.ledgerService.getAccountBalance(
        account.id,
      );
      const cachedBalance = Number(wallet.balance);
      const difference = cachedBalance - ledgerBalance;

      if (Math.abs(difference) > DISCREPANCY_TOLERANCE) {
        discrepancies.push({
          userId: wallet.userId,
          kind: 'wallet',
          cachedValue: cachedBalance,
          ledgerValue: ledgerBalance,
          difference,
        });
      }
    }

    // One CUSTOMER_SAVINGS account per user backs the sum of ALL of that
    // user's savings goals (SavingsGoal is per-goal; the ledger tracks
    // total saved funds moved out of the spendable wallet, not a
    // per-goal split — a goal-level ledger would be a reasonable future
    // refinement if per-goal auditability is ever needed).
    const savingsTotals = await this.prisma.savingsGoal.groupBy({
      by: ['userId'],
      _sum: { saved: true },
    });
    for (const row of savingsTotals) {
      const cachedTotal = Number(row._sum.saved || 0);
      if (cachedTotal <= 0) continue;
      accountsChecked++;
      const account = await this.ledgerService.getOrCreateCustomerAccount(
        LedgerAccountType.CUSTOMER_SAVINGS,
        row.userId,
      );
      const ledgerBalance = await this.ledgerService.getAccountBalance(
        account.id,
      );
      const difference = cachedTotal - ledgerBalance;

      if (Math.abs(difference) > DISCREPANCY_TOLERANCE) {
        discrepancies.push({
          userId: row.userId,
          kind: 'savings',
          cachedValue: cachedTotal,
          ledgerValue: ledgerBalance,
          difference,
        });
      }
    }

    await this.prisma.ledgerReconciliationRun.create({
      data: {
        accountsChecked,
        discrepanciesFound: discrepancies.length,
        details: discrepancies as any,
      },
    });

    if (discrepancies.length > 0) {
      // A real deployment should wire this into whatever paging/alerting
      // channel Ops actually watches (PagerDuty, a Slack webhook) — this
      // is deliberately not silent, but it's also not yet routed
      // anywhere beyond the application log and the admin dashboard's
      // reconciliation history.
      this.logger.error(
        `Ledger reconciliation found ${discrepancies.length} discrepanc${discrepancies.length === 1 ? 'y' : 'ies'} out of ${accountsChecked} accounts checked.`,
      );
    } else {
      this.logger.log(
        `Ledger reconciliation clean — ${accountsChecked} accounts checked, 0 discrepancies.`,
      );
    }

    return { accountsChecked, discrepancies };
  }
}

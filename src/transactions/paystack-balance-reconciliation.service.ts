import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';

type PaystackBalanceLedgerRow = {
  id: number;
  currency: string;
  difference: number;
  balance: number;
  reason?: string | null;
  model_responsible?: string | null;
  model_row?: number | string | null;
  createdAt: string;
  updatedAt?: string;
};

@Injectable()
export class PaystackBalanceReconciliationService {
  private readonly logger = new Logger(PaystackBalanceReconciliationService.name);

  constructor(private readonly prisma: PrismaService) {}

  // Import-only reconciliation. It never creates ledger journals or changes
  // customer balances; unmatched provider deductions require finance review.
  @Cron('0 15 * * * *')
  async reconcileRecentBalanceLedger() {
    if (
      process.env.PAYSTACK_TRANSFERS_ENABLED !== 'true' ||
      process.env.PAYSTACK_BALANCE_RECONCILIATION_ENABLED !== 'true' ||
      !process.env.PAYSTACK_SECRET_KEY
    ) {
      return;
    }

    const to = new Date();
    const from = new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);
    const fromDate = from.toISOString().slice(0, 10);
    const toDate = to.toISOString().slice(0, 10);
    const perPage = 100;
    const maxPages = 100;
    let imported = 0;
    let unmatched = 0;

    for (let page = 1; page <= maxPages; page++) {
      const url = new URL('https://api.paystack.co/balance/ledger');
      url.searchParams.set('page', String(page));
      url.searchParams.set('perPage', String(perPage));
      url.searchParams.set('from', fromDate);
      url.searchParams.set('to', toDate);

      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` },
        signal: AbortSignal.timeout(20000),
      });
      if (!response.ok) {
        throw new Error(`Paystack balance ledger returned HTTP ${response.status}`);
      }
      const payload = await response.json();
      if (!payload?.status || !Array.isArray(payload.data) || !payload.meta) {
        throw new Error('Paystack returned an invalid balance-ledger response.');
      }

      const rows = payload.data as PaystackBalanceLedgerRow[];
      const transferRows = rows.filter(
        (row) => row.model_responsible === 'Transfer' && row.model_row != null,
      );
      const transferIds = [...new Set(transferRows.map((row) => String(row.model_row)))];
      const transactions = transferIds.length
        ? await this.prisma.transaction.findMany({
            where: { providerTransferId: { in: transferIds } },
            select: { id: true, providerTransferId: true },
          })
        : [];
      const transactionByProviderId = new Map(
        transactions.map((transaction) => [transaction.providerTransferId, transaction.id]),
      );

      const records = rows.map((row) => {
        if (
          !Number.isSafeInteger(row.id) ||
          !Number.isSafeInteger(row.difference) ||
          !Number.isSafeInteger(row.balance) ||
          !row.currency ||
          !row.createdAt ||
          Number.isNaN(Date.parse(row.createdAt))
        ) {
          throw new Error('Paystack balance ledger contains a malformed entry.');
        }
        const modelRow = row.model_row == null ? null : String(row.model_row);
        const matchedTransactionId =
          row.model_responsible === 'Transfer' && modelRow
            ? transactionByProviderId.get(modelRow) || null
            : null;
        return {
          providerEntryId: String(row.id),
          modelResponsible: row.model_responsible || null,
          modelRow,
          currency: row.currency,
          differenceKobo: BigInt(row.difference),
          balanceKobo: BigInt(row.balance),
          reason: row.reason || null,
          providerCreatedAt: new Date(row.createdAt),
          matchedTransactionId,
          reconciliationStatus: matchedTransactionId ? 'matched_transfer' : 'unmatched',
          raw: {
            id: row.id,
            currency: row.currency,
            difference: row.difference,
            balance: row.balance,
            reason: row.reason ?? null,
            model_responsible: row.model_responsible ?? null,
            model_row: modelRow,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt ?? null,
          },
        };
      });

      if (records.length) {
        await this.prisma.paystackBalanceLedgerEntry.createMany({
          data: records,
          skipDuplicates: true,
        });
        // Re-evaluate existing rows on every overlapping run. A payout's
        // provider transfer ID may arrive after its first ledger import.
        for (const record of records) {
          if (record.matchedTransactionId) {
            await this.prisma.paystackBalanceLedgerEntry.updateMany({
              where: { providerEntryId: record.providerEntryId },
              data: {
                matchedTransactionId: record.matchedTransactionId,
                reconciliationStatus: 'matched_transfer',
              },
            });
          }
        }
        imported += records.length;
        unmatched += records.filter((record) => record.reconciliationStatus === 'unmatched').length;
      }

      const pageCount = Number(payload.meta.pageCount);
      if (!Number.isInteger(pageCount) || pageCount < 0) {
        throw new Error('Paystack balance-ledger pagination metadata is invalid.');
      }
      if (page >= pageCount || rows.length === 0) break;
      if (page === maxPages && pageCount > maxPages) {
        throw new Error('Paystack balance ledger exceeded the safe 100-page reconciliation limit.');
      }
    }

    this.logger.log(
      `Paystack balance-ledger import complete: ${imported} rows scanned, ${unmatched} unmatched (including non-transfer movements). No accounting adjustments were posted.`,
    );
  }
}

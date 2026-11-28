import { PaystackBalanceReconciliationService } from './paystack-balance-reconciliation.service';
import { PrismaService } from '../prisma/prisma.service';

describe('PaystackBalanceReconciliationService', () => {
  const originalTransfers = process.env.PAYSTACK_TRANSFERS_ENABLED;
  const originalReconciliation = process.env.PAYSTACK_BALANCE_RECONCILIATION_ENABLED;
  const originalSecret = process.env.PAYSTACK_SECRET_KEY;
  const originalFetch = global.fetch;
  let prisma: any;
  let service: PaystackBalanceReconciliationService;

  beforeEach(() => {
    process.env.PAYSTACK_TRANSFERS_ENABLED = 'true';
    process.env.PAYSTACK_BALANCE_RECONCILIATION_ENABLED = 'true';
    process.env.PAYSTACK_SECRET_KEY = 'sk_test_fixture';
    prisma = {
      transaction: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'txn-1', providerTransferId: '860703114' },
        ]),
      },
      paystackBalanceLedgerEntry: {
        createMany: jest.fn().mockResolvedValue({ count: 2 }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    service = new PaystackBalanceReconciliationService(prisma as PrismaService);
  });

  afterAll(() => {
    global.fetch = originalFetch;
    if (originalTransfers === undefined) delete process.env.PAYSTACK_TRANSFERS_ENABLED;
    else process.env.PAYSTACK_TRANSFERS_ENABLED = originalTransfers;
    if (originalReconciliation === undefined) delete process.env.PAYSTACK_BALANCE_RECONCILIATION_ENABLED;
    else process.env.PAYSTACK_BALANCE_RECONCILIATION_ENABLED = originalReconciliation;
    if (originalSecret === undefined) delete process.env.PAYSTACK_SECRET_KEY;
    else process.env.PAYSTACK_SECRET_KEY = originalSecret;
  });

  it('imports transfer and non-transfer balance movements and matches only exact provider transfer IDs', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        status: true,
        data: [
          {
            id: 149411613,
            currency: 'NGN',
            difference: -50000,
            balance: 2078224968,
            reason: 'Bank transfer',
            model_responsible: 'Transfer',
            model_row: 860703114,
            createdAt: '2026-11-28T07:00:00.000Z',
          },
          {
            id: 149411614,
            currency: 'NGN',
            difference: -5000,
            balance: 2078219968,
            reason: 'Stamp duty',
            model_responsible: 'TransferFee',
            model_row: 860703114,
            createdAt: '2026-11-28T07:00:01.000Z',
          },
        ],
        meta: { page: 1, pageCount: 1, perPage: 100, total: 2, skipped: 0 },
      }),
    } as any);

    await service.reconcileRecentBalanceLedger();

    expect(prisma.transaction.findMany).toHaveBeenCalledWith({
      where: { providerTransferId: { in: ['860703114'] } },
      select: { id: true, providerTransferId: true },
    });
    const rows = prisma.paystackBalanceLedgerEntry.createMany.mock.calls[0][0].data;
    expect(rows[0]).toEqual(expect.objectContaining({
      providerEntryId: '149411613',
      modelRow: '860703114',
      differenceKobo: BigInt(-50000),
      matchedTransactionId: 'txn-1',
      reconciliationStatus: 'matched_transfer',
    }));
    expect(rows[1]).toEqual(expect.objectContaining({
      providerEntryId: '149411614',
      matchedTransactionId: null,
      reconciliationStatus: 'unmatched',
      reason: 'Stamp duty',
    }));
    expect(prisma.paystackBalanceLedgerEntry.createMany).toHaveBeenCalledWith({
      data: expect.any(Array),
      skipDuplicates: true,
    });
    expect(prisma.paystackBalanceLedgerEntry.updateMany).toHaveBeenCalledWith({
      where: { providerEntryId: '149411613' },
      data: { matchedTransactionId: 'txn-1', reconciliationStatus: 'matched_transfer' },
    });
  });

  it('continues reconciliation when new payouts are disabled', async () => {
    process.env.PAYSTACK_TRANSFERS_ENABLED = 'false';
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        status: true,
        data: [],
        meta: { page: 1, pageCount: 0, perPage: 100, total: 0, skipped: 0 },
      }),
    } as any);

    await service.reconcileRecentBalanceLedger();

    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('does not call Paystack when reconciliation is disabled', async () => {
    process.env.PAYSTACK_BALANCE_RECONCILIATION_ENABLED = 'false';
    global.fetch = jest.fn();
    await service.reconcileRecentBalanceLedger();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(prisma.paystackBalanceLedgerEntry.createMany).not.toHaveBeenCalled();
  });

  it('fails closed on malformed provider ledger data', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        status: true,
        data: [{ id: 'not-a-number', currency: 'NGN', difference: -1, balance: 10, createdAt: '2026-11-28T07:00:00.000Z' }],
        meta: { page: 1, pageCount: 1 },
      }),
    } as any);
    await expect(service.reconcileRecentBalanceLedger()).rejects.toThrow(
      'Paystack balance ledger contains a malformed entry.',
    );
    expect(prisma.paystackBalanceLedgerEntry.createMany).not.toHaveBeenCalled();
  });
});

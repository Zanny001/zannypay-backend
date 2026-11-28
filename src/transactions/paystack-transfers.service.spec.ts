import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { PaystackTransfersService } from './paystack-transfers.service';
import { PrismaService } from '../prisma/prisma.service';
import { LedgerService } from '../ledger/ledger.service';

describe('PaystackTransfersService', () => {
  const originalFlag = process.env.PAYSTACK_TRANSFERS_ENABLED;
  const originalSecret = process.env.PAYSTACK_SECRET_KEY;
  let prisma: any;
  let ledger: any;
  let service: PaystackTransfersService;

  beforeEach(() => {
    prisma = {
      $transaction: jest.fn(async (callback) =>
        callback({
          transaction: {
            findUnique: jest.fn(),
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
            create: jest.fn().mockResolvedValue({ id: 'reversal-1' }),
          },
          wallet: { update: jest.fn() },
        }),
      ),
    };
    ledger = {
      getOrCreateSystemAccount: jest
        .fn()
        .mockResolvedValue({ id: 'system-account' }),
      reverseJournal: jest.fn(),
      postJournal: jest.fn(),
    };
    service = new PaystackTransfersService(
      prisma as PrismaService,
      ledger as LedgerService,
    );
  });

  it('rejects a concurrent idempotency-key replay with a different destination or amount', () => {
    const existing = {
      userId: 'user-1',
      category: 'external_bank_transfer',
      amount: 100,
      recipientAccount: '0123456789',
      subtitle: '058 ••••6789',
    };

    expect(() =>
      (service as any).assertReplayMatches(
        existing,
        'user-1',
        100,
        '0987654321',
        '058',
      ),
    ).toThrow(BadRequestException);
    expect(() =>
      (service as any).assertReplayMatches(
        existing,
        'user-1',
        200,
        '0123456789',
        '058',
      ),
    ).toThrow(BadRequestException);
    expect(() =>
      (service as any).assertReplayMatches(
        existing,
        'user-1',
        100,
        '0123456789',
        '058',
      ),
    ).not.toThrow();
  });

  afterAll(() => {
    if (originalFlag === undefined)
      delete process.env.PAYSTACK_TRANSFERS_ENABLED;
    else process.env.PAYSTACK_TRANSFERS_ENABLED = originalFlag;
    if (originalSecret === undefined) delete process.env.PAYSTACK_SECRET_KEY;
    else process.env.PAYSTACK_SECRET_KEY = originalSecret;
  });

  it('keeps payouts disabled unless the explicit feature flag is enabled', async () => {
    delete process.env.PAYSTACK_TRANSFERS_ENABLED;
    process.env.PAYSTACK_SECRET_KEY = 'sk_test_only';
    await expect(
      service.transfer('user-1', {
        recipientAccount: '0123456789',
        bank: 'Test Bank',
        bankCode: '058',
        amount: 1000,
        pin: '1234',
        idempotencyKey: 'test-key-123',
      } as any),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('settles a confirmed payout once and posts the payout-float journal', async () => {
    const transaction = {
      id: 'txn-1',
      userId: 'user-1',
      category: 'external_bank_transfer',
      type: 'debit',
      status: 'pending',
      amount: 100,
    };
    const tx = {
      transaction: {
        findUnique: jest.fn().mockResolvedValue(transaction),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    prisma.$transaction.mockImplementation(async (callback) => callback(tx));

    const result = await (service as any).settle('zp-reference', 'success', {
      amount: 10000,
      currency: 'NGN',
    });

    expect(result).toEqual({ success: true, status: 'completed' });
    expect(tx.transaction.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'txn-1', status: 'pending' },
        data: expect.objectContaining({
          status: 'completed',
          providerStatus: 'success',
        }),
      }),
    );
    expect(ledger.postJournal).toHaveBeenCalledTimes(1);
  });

  it('refunds a definitively failed payout and reverses its ledger journal', async () => {
    const transaction = {
      id: 'txn-2',
      userId: 'user-2',
      category: 'external_bank_transfer',
      type: 'debit',
      status: 'pending',
      amount: 250,
    };
    const tx = {
      transaction: {
        findUnique: jest.fn().mockResolvedValue(transaction),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        create: jest.fn().mockResolvedValue({ id: 'reversal-2' }),
      },
      wallet: { update: jest.fn() },
    };
    prisma.$transaction.mockImplementation(async (callback) => callback(tx));

    const result = await (service as any).settle('zp-failed', 'failed', {
      amount: 25000,
      currency: 'NGN',
    });

    expect(result).toEqual({ success: true, status: 'failed', refunded: true });
    expect(tx.wallet.update).toHaveBeenCalledWith({
      where: { userId: 'user-2' },
      data: { balance: { increment: 250 } },
    });
    expect(ledger.reverseJournal).toHaveBeenCalledWith(
      tx,
      'txn-2',
      'reversal-2',
      expect.stringContaining('wallet refund'),
    );
  });

  it('does not apply a duplicate success webhook to an already completed payout', async () => {
    const tx = {
      transaction: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'txn-3',
          userId: 'user-3',
          category: 'external_bank_transfer',
          type: 'debit',
          status: 'completed',
          amount: 80,
        }),
        updateMany: jest.fn(),
      },
    };
    prisma.$transaction.mockImplementation(async (callback) => callback(tx));

    const result = await (service as any).settle('zp-completed', 'success', {
      amount: 8000,
      currency: 'NGN',
    });

    expect(result).toEqual({
      success: true,
      status: 'completed',
      alreadyProcessed: true,
    });
    expect(tx.transaction.updateMany).not.toHaveBeenCalled();
    expect(ledger.postJournal).not.toHaveBeenCalled();
  });

  it('rejects a provider amount mismatch without changing wallet state', async () => {
    const tx = {
      transaction: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'txn-4',
          userId: 'user-4',
          category: 'external_bank_transfer',
          type: 'debit',
          status: 'pending',
          amount: 80,
        }),
        updateMany: jest.fn(),
      },
    };
    prisma.$transaction.mockImplementation(async (callback) => callback(tx));

    const result = await (service as any).settle('zp-mismatch', 'success', {
      amount: 8001,
      currency: 'NGN',
    });

    expect(result).toEqual({
      success: false,
      status: 'provider_amount_mismatch',
    });
    expect(tx.transaction.updateMany).not.toHaveBeenCalled();
    expect(ledger.postJournal).not.toHaveBeenCalled();
  });

  it.each([
    ['missing amount', { currency: 'NGN' }],
    ['missing currency', { amount: 8000 }],
    ['missing provider data', undefined],
  ])(
    'fails closed for terminal payout status with %s',
    async (_label, providerData) => {
      const tx = {
        transaction: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'txn-missing-provider-fields',
            userId: 'user-5',
            category: 'external_bank_transfer',
            type: 'debit',
            status: 'pending',
            amount: 80,
          }),
          updateMany: jest.fn(),
        },
      };
      prisma.$transaction.mockImplementation(async (callback) => callback(tx));

      const result = await (service as any).settle(
        'zp-missing-provider-fields',
        'success',
        providerData,
      );

      expect(result).toEqual({
        success: false,
        status: 'provider_amount_mismatch',
      });
      expect(tx.transaction.updateMany).not.toHaveBeenCalled();
      expect(ledger.postJournal).not.toHaveBeenCalled();
      expect(tx.wallet?.update).toBeUndefined();
    },
  );
});

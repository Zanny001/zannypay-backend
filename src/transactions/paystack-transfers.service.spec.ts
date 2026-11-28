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

  it('finalizes business-owner OTP only for an OTP-pending transfer and rechecks provider status', async () => {
    process.env.PAYSTACK_TRANSFERS_ENABLED = 'true';
    process.env.PAYSTACK_SECRET_KEY = 'sk_test_only';
    const transaction = {
      id: 'txn-otp',
      userId: 'customer-1',
      category: 'external_bank_transfer',
      type: 'debit',
      status: 'pending',
      providerStatus: 'otp',
      providerTransactionId: 'TRF_otp123',
      amount: 100,
    };
    prisma.transaction = {
      findFirst: jest.fn().mockResolvedValue(transaction),
    };
    const tx = {
      transaction: {
        findUnique: jest.fn().mockResolvedValue(transaction),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    prisma.$transaction.mockImplementation(async (callback) => callback(tx));
    const originalFetch = global.fetch;
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: true,
          data: {
            reference: 'zp-otp-reference',
            transfer_code: 'TRF_otp123',
            status: 'otp',
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: true, message: 'Transfer has been queued' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: true,
          data: {
            reference: 'zp-otp-reference',
            transfer_code: 'TRF_otp123',
            id: 860703114,
            status: 'pending',
          },
        }),
      });
    global.fetch = fetchMock as any;

    try {
      const result = await service.finalizeBusinessOtp(
        'zp-otp-reference',
        '123456',
        'admin-1',
      );

      expect(result).toEqual({
        success: true,
        status: 'pending',
        approvedBy: 'admin-1',
      });
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(fetchMock.mock.calls[1][0]).toContain('/transfer/finalize_transfer');
      expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
        transfer_code: 'TRF_otp123',
        otp: '123456',
      });
      expect(tx.transaction.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            providerStatus: 'pending',
            providerTransferId: '860703114',
          }),
        }),
      );
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('rejects malformed business OTP before contacting Paystack', async () => {
    process.env.PAYSTACK_TRANSFERS_ENABLED = 'true';
    process.env.PAYSTACK_SECRET_KEY = 'sk_test_only';
    const originalFetch = global.fetch;
    const fetchMock = jest.fn();
    global.fetch = fetchMock as any;
    try {
      await expect(
        service.finalizeBusinessOtp('zp-reference', '12ab', 'admin-1'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('persists the numeric Paystack transfer ID while a payout is pending', async () => {
    const tx = {
      transaction: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'txn-pending-id',
          userId: 'user-pending',
          category: 'external_bank_transfer',
          type: 'debit',
          status: 'pending',
          amount: 100,
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    prisma.$transaction.mockImplementation(async (callback) => callback(tx));

    const result = await (service as any).settle('zp-pending-id', 'pending', {
      transfer_code: 'TRF_test123',
      transfer_id: 860703114,
    });

    expect(result).toEqual({ success: true, status: 'pending' });
    expect(tx.transaction.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'txn-pending-id', status: 'pending' },
        data: expect.objectContaining({
          providerTransactionId: 'TRF_test123',
          providerTransferId: '860703114',
        }),
      }),
    );
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
      fee_charged: 250,
    });

    expect(result).toEqual({ success: true, status: 'completed' });
    expect(tx.transaction.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'txn-1', status: 'pending' },
        data: expect.objectContaining({
          status: 'completed',
          providerStatus: 'success',
          providerFee: 2.5,
        }),
      }),
    );
    expect(ledger.postJournal).toHaveBeenCalledTimes(1);
    const postedLines = ledger.postJournal.mock.calls[0][1];
    expect(postedLines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ direction: 'DEBIT', amount: 2.5 }),
        expect.objectContaining({ direction: 'CREDIT', amount: 102.5 }),
      ]),
    );
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
      fee_charged: 0,
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

  it('retains the provider fee when a previously completed payout is reversed', async () => {
    const tx = {
      transaction: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'txn-reversed',
          userId: 'user-reversed',
          category: 'external_bank_transfer',
          type: 'debit',
          status: 'completed',
          amount: 100,
          providerFee: 2.5,
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        create: jest.fn().mockResolvedValue({ id: 'reversal-fee-1' }),
      },
      wallet: { update: jest.fn() },
    };
    prisma.$transaction.mockImplementation(async (callback) => callback(tx));

    const result = await (service as any).settle('zp-reversed', 'reversed', {
      amount: 10000,
      currency: 'NGN',
      fee_charged: 250,
    });

    expect(result).toEqual({ success: true, status: 'failed', refunded: true });
    expect(ledger.reverseJournal).toHaveBeenCalledWith(
      tx,
      'txn-reversed',
      'reversal-fee-1',
      expect.stringContaining('wallet refund'),
    );
    expect(ledger.postJournal).toHaveBeenCalledWith(
      tx,
      expect.arrayContaining([
        expect.objectContaining({ direction: 'DEBIT', amount: 2.5 }),
        expect.objectContaining({ direction: 'CREDIT', amount: 2.5 }),
      ]),
      expect.objectContaining({
        transactionId: 'reversal-fee-1',
        memo: expect.stringContaining('Retain Paystack provider fee'),
      }),
    );
  });

  it.each(['abandoned', 'blocked', 'rejected'] as const)(
    'refunds a conclusive %s payout status',
    async (status) => {
      const tx = {
        transaction: {
          findUnique: jest.fn().mockResolvedValue({
            id: `txn-${status}`,
            userId: 'user-terminal',
            category: 'external_bank_transfer',
            type: 'debit',
            status: 'pending',
            amount: 75,
          }),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          create: jest.fn().mockResolvedValue({ id: `reversal-${status}` }),
        },
        wallet: { update: jest.fn() },
      };
      prisma.$transaction.mockImplementation(async (callback) => callback(tx));

      const result = await (service as any).settle(
        `zp-${status}`,
        status,
        { amount: 7500, currency: 'NGN', fee_charged: 0 },
      );

      expect(result).toEqual({
        success: true,
        status: 'failed',
        refunded: true,
      });
      expect(tx.wallet.update).toHaveBeenCalledWith({
        where: { userId: 'user-terminal' },
        data: { balance: { increment: 75 } },
      });
    },
  );

  it.each(['failed', 'abandoned', 'blocked', 'rejected'] as const)(
    'does not refund an already completed payout for a stale %s event',
    async (status) => {
      const tx = {
        transaction: {
          findUnique: jest.fn().mockResolvedValue({
            id: `txn-completed-${status}`,
            userId: 'user-completed',
            category: 'external_bank_transfer',
            type: 'debit',
            status: 'completed',
            amount: 80,
          }),
          updateMany: jest.fn(),
        },
        wallet: { update: jest.fn() },
      };
      prisma.$transaction.mockImplementation(async (callback) => callback(tx));

      const result = await (service as any).settle(
        `zp-completed-${status}`,
        status,
        { amount: 8000, currency: 'NGN', fee_charged: 0 },
      );

      expect(result).toEqual({
        success: false,
        status: 'unexpected_provider_transition',
      });
      expect(tx.transaction.updateMany).not.toHaveBeenCalled();
      expect(tx.wallet.update).not.toHaveBeenCalled();
      expect(ledger.reverseJournal).not.toHaveBeenCalled();
    },
  );

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
      fee_charged: 0,
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
    ['missing provider fee', { amount: 8000, currency: 'NGN' }],
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
        status: _label === 'missing provider fee' ? 'provider_fee_missing' : 'provider_amount_mismatch',
      });
      expect(tx.transaction.updateMany).not.toHaveBeenCalled();
      expect(ledger.postJournal).not.toHaveBeenCalled();
      expect(tx.wallet?.update).toBeUndefined();
    },
  );
});

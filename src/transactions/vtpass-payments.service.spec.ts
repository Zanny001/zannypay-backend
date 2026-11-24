import { ServiceUnavailableException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { VtpassClient } from './vtpass.client';
import { VtpassPaymentsService } from './vtpass-payments.service';

describe('VtpassPaymentsService', () => {
  let service: VtpassPaymentsService;
  let vtpass: { getServices: jest.Mock; getServiceVariations: jest.Mock; verifyCustomer: jest.Mock; assertPurchaseConfigured: jest.Mock; createRequestId: jest.Mock; purchase: jest.Mock; requery: jest.Mock };
  let prisma: any;
  let ledger: any;

  beforeEach(() => {
    vtpass = {
      getServices: jest.fn(),
      getServiceVariations: jest.fn(),
      verifyCustomer: jest.fn(),
      assertPurchaseConfigured: jest.fn(),
      createRequestId: jest.fn(),
      purchase: jest.fn(),
      requery: jest.fn(),
    };
    prisma = {};
    ledger = { reverseJournal: jest.fn() };
    service = new VtpassPaymentsService(
      prisma as PrismaService,
      ledger as LedgerService,
      vtpass as unknown as VtpassClient,
    );  });

  it('classifies delivered transactions as completed', () => {
    expect((service as any).responseState({
      code: '000',
      content: { transactions: { status: 'delivered' } },
    })).toBe('completed');
  });

  it.each(['016', '091'])('classifies definitive provider failure code %s as failed', (code) => {
    expect((service as any).responseState({ code })).toBe('failed');
  });

  it.each([
    { code: '099' },
    { code: '000', content: { transactions: { status: 'pending' } } },
    { code: '083' },
    { code: '014' },
  ])('keeps uncertain provider responses pending: %o', (payload) => {
    expect((service as any).responseState(payload)).toBe('pending');
  });

  it('uses provider catalogue price rather than a client-supplied price', async () => {
    vtpass.getServices.mockResolvedValue({
      content: [{
        serviceID: 'test-service',
        name: 'Test Service',
        minimium_amount: '100',
        maximum_amount: '10000',
        product_type: 'fix',
      }],
    });
    vtpass.getServiceVariations.mockResolvedValue({
      content: {
        variations: [{
          variation_code: 'monthly-1',
          variation_amount: '2500.00',
          fixedPrice: 'Yes',
          name: 'Monthly plan',
        }],
      },
    });
    await expect((service as any).resolveProductPrice('data', 'test-service', 'monthly-1', 2500))
      .resolves.toEqual({ amount: 2500, productName: 'Monthly plan' });
    await expect((service as any).resolveProductPrice('data', 'test-service', 'monthly-1', 2000))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('accepts flexible amounts only within provider-published minimum and maximum', async () => {
    vtpass.getServices.mockResolvedValue({
      content: [{
        serviceID: 'mtn',
        name: 'MTN Airtime',
        minimium_amount: '50',
        maximum_amount: '50000',
        product_type: 'fix',
      }],
    });
    await expect((service as any).resolveProductPrice('airtime', 'mtn', undefined, 500))
      .resolves.toEqual({ amount: 500, productName: 'MTN Airtime' });
    await expect((service as any).resolveProductPrice('airtime', 'mtn', undefined, 25))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('requires a variation for electricity and subscription products', async () => {
    vtpass.getServices.mockResolvedValue({
      content: [{
        serviceID: 'ikeja-electric',
        name: 'Ikeja Electric',
        minimium_amount: '100',
        maximum_amount: '100000',
        product_type: 'fix',
      }],
    });
    await expect((service as any).resolveProductPrice('electricity', 'ikeja-electric', undefined, 1000))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects services that are not in the selected provider catalogue', async () => {
    vtpass.getServices.mockResolvedValue({ content: [] });
    await expect((service as any).resolveProductPrice('data', 'unknown-service', undefined, 500))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('keeps pending provider responses pending without refunding the wallet', async () => {
    prisma.transaction = { updateMany: jest.fn().mockResolvedValue({ count: 1 }) };
    await (service as any).applyProviderOutcome('txn-1', {
      code: '099',
      content: { transactions: { status: 'pending' } },
    });
    expect(prisma.transaction.updateMany).toHaveBeenCalledWith({
      where: { id: 'txn-1', status: 'pending' },
      data: expect.objectContaining({ providerStatus: 'pending', providerLastCheckedAt: expect.any(Date) }),
    });
    expect(prisma.wallet).toBeUndefined();
  });

  it('reverses wallet and ledger exactly once for a definitive failure', async () => {
    const tx = {
      transaction: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'txn-1',
          userId: 'user-1',
          amount: 500,
          status: 'pending',
          reference: 'VTP-REQ1',
          providerRequestId: 'REQ1',
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        create: jest.fn().mockResolvedValue({ id: 'reversal-1' }),
      },
      wallet: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    prisma.$transaction = jest.fn(async (callback: any) => callback(tx));

    await (service as any).applyProviderOutcome('txn-1', { code: '016' });

    expect(tx.wallet.updateMany).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      data: { balance: { increment: 500 } },
    });
    expect(ledger.reverseJournal).toHaveBeenCalledWith(
      tx,
      'txn-1',
      'reversal-1',
      expect.stringContaining('VTpass confirmed failure'),
    );
  });

  it('does not create a second reversal when the transaction is no longer pending', async () => {
    const tx = {
      transaction: {
        findUnique: jest.fn().mockResolvedValue({ id: 'txn-1', status: 'completed' }),
        updateMany: jest.fn(),
        create: jest.fn(),
      },
      wallet: { updateMany: jest.fn() },
    };
    prisma.$transaction = jest.fn(async (callback: any) => callback(tx));

    await (service as any).applyProviderOutcome('txn-1', { code: '091' });

    expect(tx.transaction.updateMany).not.toHaveBeenCalled();
    expect(tx.wallet.updateMany).not.toHaveBeenCalled();
    expect(tx.transaction.create).not.toHaveBeenCalled();
  });

  it('keeps purchases disabled unless both sandbox gates are enabled', async () => {
    const previous = process.env.VTPASS_BILL_PAYMENTS_ENABLED;
    const previousVerified = process.env.VTPASS_SANDBOX_VERIFIED;
    delete process.env.VTPASS_BILL_PAYMENTS_ENABLED;
    delete process.env.VTPASS_SANDBOX_VERIFIED;
    try {
      await expect(service.purchase('user-1', {} as any))
        .rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(vtpass.assertPurchaseConfigured).not.toHaveBeenCalled();
      expect(vtpass.purchase).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.VTPASS_BILL_PAYMENTS_ENABLED;
      else process.env.VTPASS_BILL_PAYMENTS_ENABLED = previous;
      if (previousVerified === undefined) delete process.env.VTPASS_SANDBOX_VERIFIED;
      else process.env.VTPASS_SANDBOX_VERIFIED = previousVerified;
    }
  });});

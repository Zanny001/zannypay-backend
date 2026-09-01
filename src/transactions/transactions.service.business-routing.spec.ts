import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { MailerService } from '@nestjs-modules/mailer';
import * as bcrypt from 'bcryptjs';
import { TransactionsService } from './transactions.service';
import { PrismaService } from '../prisma/prisma.service';
import { FraudService } from '../fraud/fraud.service';
import { NotificationsService } from '../notifications/notifications.service';
import { BeneficiariesService } from '../beneficiaries/beneficiaries.service';
import { LedgerService } from '../ledger/ledger.service';
import { AnalyticsService } from '../analytics/analytics.service';

jest.mock('bcryptjs');

// Covers only what changed when ZannyPay Business Phase 1 touched this
// function — recipient resolution via a business account number, tagging
// the credit leg with receivedVia, and the self-transfer guard covering
// the new number. Not a full re-test of transferFunds' existing behavior
// (insufficient funds, external transfers, idempotency replay, etc.) —
// those were already working and untouched by this change.
describe('TransactionsService.transferFunds — business account routing', () => {
  let service: TransactionsService;
  let prisma: any;
  let tx: any;

  const sender = {
    id: 'sender-1', accountNumber: '9011111111', phone: '08011111111',
    businessAccountNumber: null, isFrozen: false, pin: 'hashed', email: 'sender@test.com', name: 'Sender',
    wallet: { balance: 100000 },
  };

  function makeRecipient(overrides: Partial<typeof sender> = {}) {
    return {
      id: 'recipient-1', accountNumber: '9022222222', phone: '08022222222',
      businessAccountNumber: '9133333333', email: 'recipient@test.com', name: 'Recipient',
      wallet: { balance: 5000 },
      ...overrides,
    };
  }

  beforeEach(async () => {
    tx = {
      user: { findUnique: jest.fn(), findFirst: jest.fn() },
      wallet: { update: jest.fn().mockResolvedValue({}) },
      transaction: {
        create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'txn-id', reference: 'TXN-REF', ...data })),
      },
    };
    prisma = {
      transaction: { findFirst: jest.fn().mockResolvedValue(null) }, // no idempotency replay
      $transaction: jest.fn().mockImplementation((callback) => callback(tx)),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TransactionsService,
        { provide: PrismaService, useValue: prisma },
        { provide: MailerService, useValue: { sendMail: jest.fn().mockResolvedValue({}) } },
        { provide: FraudService, useValue: { evaluateTransaction: jest.fn().mockResolvedValue({}) } },
        { provide: NotificationsService, useValue: { create: jest.fn().mockResolvedValue({}) } },
        { provide: BeneficiariesService, useValue: { recordPaymentIfSaved: jest.fn().mockResolvedValue(undefined) } },
        {
          provide: LedgerService,
          useValue: {
            getOrCreateCustomerAccount: jest.fn().mockResolvedValue({ id: 'mock-wallet-account' }),
            getOrCreateSystemAccount: jest.fn().mockResolvedValue({ id: 'mock-system-account' }),
            postJournal: jest.fn().mockResolvedValue('mock-journal-id'),
          },
        },
        { provide: AnalyticsService, useValue: { track: jest.fn().mockResolvedValue(undefined) } },
      ],
    }).compile();

    service = module.get<TransactionsService>(TransactionsService);
    (bcrypt.compare as jest.Mock).mockResolvedValue(true);
  });

  it('resolves the recipient by their business account number, not just personal accountNumber/phone', async () => {
    tx.user.findUnique.mockResolvedValue({ ...sender });
    tx.user.findFirst.mockResolvedValue(makeRecipient());

    await service.transferFunds('sender-1', { recipientAccount: '9133333333', amount: 1000, pin: '1234' } as any);

    expect(tx.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { OR: expect.arrayContaining([{ businessAccountNumber: '9133333333' }]) },
      }),
    );
  });

  it('tags the credit leg as receivedVia "business" when the business number was targeted', async () => {
    tx.user.findUnique.mockResolvedValue({ ...sender });
    tx.user.findFirst.mockResolvedValue(makeRecipient());

    await service.transferFunds('sender-1', { recipientAccount: '9133333333', amount: 1000, pin: '1234' } as any);

    const creditCall = tx.transaction.create.mock.calls.find((c: any) => c[0].data.type === 'credit');
    expect(creditCall[0].data.receivedVia).toBe('business');
  });

  it('tags the credit leg as receivedVia "personal" when the personal account number was targeted, even though the recipient also has a business number', async () => {
    tx.user.findUnique.mockResolvedValue({ ...sender });
    tx.user.findFirst.mockResolvedValue(makeRecipient());

    await service.transferFunds('sender-1', { recipientAccount: '9022222222', amount: 1000, pin: '1234' } as any);

    const creditCall = tx.transaction.create.mock.calls.find((c: any) => c[0].data.type === 'credit');
    expect(creditCall[0].data.receivedVia).toBe('personal');
  });

  it('tags the credit leg as receivedVia "personal" when reached via phone number', async () => {
    tx.user.findUnique.mockResolvedValue({ ...sender });
    tx.user.findFirst.mockResolvedValue(makeRecipient());

    await service.transferFunds('sender-1', { recipientAccount: '08022222222', amount: 1000, pin: '1234' } as any);

    const creditCall = tx.transaction.create.mock.calls.find((c: any) => c[0].data.type === 'credit');
    expect(creditCall[0].data.receivedVia).toBe('personal');
  });

  it('defaults to "personal" for a recipient who has never activated a business account', async () => {
    tx.user.findUnique.mockResolvedValue({ ...sender });
    tx.user.findFirst.mockResolvedValue(makeRecipient({ businessAccountNumber: null }));

    await service.transferFunds('sender-1', { recipientAccount: '9022222222', amount: 1000, pin: '1234' } as any);

    const creditCall = tx.transaction.create.mock.calls.find((c: any) => c[0].data.type === 'credit');
    expect(creditCall[0].data.receivedVia).toBe('personal');
  });

  it('blocks a transfer to your own business account number — the wash-transaction / fake-revenue guard', async () => {
    tx.user.findUnique.mockResolvedValue({ ...sender, businessAccountNumber: '9199999999' });

    await expect(
      service.transferFunds('sender-1', { recipientAccount: '9199999999', amount: 1000, pin: '1234' } as any),
    ).rejects.toThrow(BadRequestException);

    // Confirms this is caught before anything else — no wallet or ledger
    // mutation happens, which is what would make the guard actually matter.
    expect(tx.wallet.update).not.toHaveBeenCalled();
    expect(tx.transaction.create).not.toHaveBeenCalled();
  });
});

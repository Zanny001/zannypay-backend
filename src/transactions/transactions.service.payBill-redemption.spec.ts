import { Test, TestingModule } from '@nestjs/testing';
import { MailerService } from '@nestjs-modules/mailer';
import * as bcrypt from 'bcrypt';
import { TransactionsService } from './transactions.service';
import { PrismaService } from '../prisma/prisma.service';
import { FraudService } from '../fraud/fraud.service';
import { NotificationsService } from '../notifications/notifications.service';
import { BeneficiariesService } from '../beneficiaries/beneficiaries.service';
import { LedgerService } from '../ledger/ledger.service';
import { AnalyticsService } from '../analytics/analytics.service';

jest.mock('bcrypt');

// Confirms the redemption math from resolvePointsRedemption.spec.ts is
// actually wired into payBill's real effects — the wallet debit, the
// points decrement, and what gets recorded on the transaction row — not
// just correct in isolation.
describe('TransactionsService.payBill — points redemption wiring', () => {
  let service: TransactionsService;
  let prisma: any;
  let tx: any;

  const user = {
    id: 'user-1',
    isFrozen: false,
    pin: 'hashed',
    email: 'u@test.com',
    rewardPoints: 1000,
    wallet: { balance: 5000 },
  };

  beforeEach(async () => {
    tx = {
      user: {
        findUnique: jest.fn().mockResolvedValue({ ...user }),
        update: jest.fn().mockResolvedValue({}),
      },
      wallet: { update: jest.fn().mockResolvedValue({}) },
      transaction: {
        create: jest
          .fn()
          .mockImplementation(({ data }) =>
            Promise.resolve({ id: 'txn-id', reference: 'BILL-REF', ...data }),
          ),
      },
    };
    prisma = {
      transaction: { findFirst: jest.fn().mockResolvedValue(null) },
      $transaction: jest.fn().mockImplementation((callback) => callback(tx)),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TransactionsService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: MailerService,
          useValue: { sendMail: jest.fn().mockResolvedValue({}) },
        },
        {
          provide: FraudService,
          useValue: { evaluateTransaction: jest.fn().mockResolvedValue({}) },
        },
        {
          provide: NotificationsService,
          useValue: { create: jest.fn().mockResolvedValue({}) },
        },
        {
          provide: BeneficiariesService,
          useValue: {
            recordPaymentIfSaved: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: LedgerService,
          useValue: {
            getOrCreateCustomerAccount: jest
              .fn()
              .mockResolvedValue({ id: 'mock-wallet-account' }),
            getOrCreateSystemAccount: jest
              .fn()
              .mockResolvedValue({ id: 'mock-biller-account' }),
            postJournal: jest.fn().mockResolvedValue('mock-journal-id'),
          },
        },
        {
          provide: AnalyticsService,
          useValue: { track: jest.fn().mockResolvedValue(undefined) },
        },
      ],
    }).compile();
    service = module.get<TransactionsService>(TransactionsService);
    (bcrypt.compare as jest.Mock).mockResolvedValue(true);
  });

  it('debits the wallet for the reduced amount and decrements reward points when points are redeemed', async () => {
    await service.payBill('user-1', {
      billerName: 'IKEDC',
      category: 'Electricity',
      amount: 2000,
      pin: '1234',
      pointsToRedeem: 500,
    });

    expect(tx.wallet.update).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      data: { balance: { decrement: 1950 } },
    });
    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { rewardPoints: { decrement: 500 } },
    });

    const createCall = tx.transaction.create.mock.calls[0][0];
    expect(createCall.data.amount).toBe(2000); // full purchase value, unchanged
    expect(createCall.data.pointsRedeemed).toBe(500);
  });

  it('debits the full amount and never touches reward points when none are redeemed', async () => {
    await service.payBill('user-1', {
      billerName: 'IKEDC',
      category: 'Electricity',
      amount: 2000,
      pin: '1234',
    });

    expect(tx.wallet.update).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      data: { balance: { decrement: 2000 } },
    });
    expect(tx.user.update).not.toHaveBeenCalled();

    const createCall = tx.transaction.create.mock.calls[0][0];
    expect(createCall.data.pointsRedeemed).toBe(0);
  });
});

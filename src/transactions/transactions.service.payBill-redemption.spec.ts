import { Test, TestingModule } from '@nestjs/testing';
import { ServiceUnavailableException } from '@nestjs/common';
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

// Until a real biller adapter can confirm fulfilment, bill payments must
// fail before PIN validation, wallet debit, points redemption or DB writes.
describe('TransactionsService.payBill — provider safety gate', () => {
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

  it('rejects bill payments before wallet, points or transaction mutation', async () => {
    await expect(
      service.payBill('user-1', {
        billerName: 'IKEDC',
        category: 'Electricity',
        amount: 2000,
        pin: '1234',
        pointsToRedeem: 500,
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.wallet.update).not.toHaveBeenCalled();
    expect(tx.user.update).not.toHaveBeenCalled();
    expect(tx.transaction.create).not.toHaveBeenCalled();
  });

  it('does not redeem reward points while bill payments are disabled', async () => {
    await expect(
      service.payBill('user-1', {
        billerName: 'IKEDC',
        category: 'Electricity',
        amount: 2000,
        pin: '1234',
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.user.update).not.toHaveBeenCalled();
  });
});

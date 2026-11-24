import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { MailerService } from '@nestjs-modules/mailer';
import { TransactionsService } from './transactions.service';
import { PrismaService } from '../prisma/prisma.service';
import { FraudService } from '../fraud/fraud.service';
import { NotificationsService } from '../notifications/notifications.service';
import { BeneficiariesService } from '../beneficiaries/beneficiaries.service';
import { LedgerService } from '../ledger/ledger.service';
import { AnalyticsService } from '../analytics/analytics.service';
import * as bcrypt from 'bcrypt';

jest.mock('bcrypt', () => ({ compare: jest.fn().mockResolvedValue(true) }));

describe('TransactionsService', () => {
  let service: TransactionsService;
  let prisma: { $transaction: jest.Mock; transaction: { findFirst: jest.Mock } };

  beforeEach(async () => {
    prisma = {
      $transaction: jest.fn(),
      transaction: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TransactionsService,
        { provide: PrismaService, useValue: prisma },
        { provide: MailerService, useValue: { sendMail: jest.fn() } },
        { provide: FraudService, useValue: { evaluateTransaction: jest.fn() } },
        { provide: NotificationsService, useValue: { create: jest.fn() } },
        {
          provide: BeneficiariesService,
          useValue: { recordPaymentIfSaved: jest.fn() },
        },
        {
          provide: LedgerService,
          useValue: {
            getOrCreateCustomerAccount: jest.fn(),
            getOrCreateSystemAccount: jest.fn(),
            postJournal: jest.fn(),
          },
        },
        { provide: AnalyticsService, useValue: { track: jest.fn() } },
      ],
    }).compile();

    service = module.get<TransactionsService>(TransactionsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('rejects bill payments before any wallet mutation when no biller adapter exists', async () => {
    await expect(service.payBill('user-1', {} as any)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects airtime/data purchases before any wallet mutation without a provider', async () => {
    await expect(
      service.buyAirtime('user-1', {} as any),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects external bank transfers before any wallet mutation', async () => {
    (bcrypt.compare as jest.Mock).mockResolvedValue(true);
    const tx = {
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-1', isFrozen: false, pin: 'hashed-pin',
          accountNumber: '0000000001', phone: '08000000000',
          businessAccountNumber: null, wallet: { balance: 100000 },
          email: 'user@example.test', name: 'Sender',
        }),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      wallet: { update: jest.fn(), updateMany: jest.fn() },
      transaction: { create: jest.fn() },
    };
    prisma.$transaction.mockImplementation((callback) => callback(tx));
    await expect(
      service.transferFunds('user-1', {
        recipientAccount: '9999999999',
        amount: 1000,
        pin: '1234',
      } as any),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(tx.wallet.update).not.toHaveBeenCalled();
    expect(tx.transaction.create).not.toHaveBeenCalled();
    (bcrypt.compare as jest.Mock).mockReset().mockResolvedValue(true);
  });
  it('rejects malformed bank account numbers before calling Paystack', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    await expect(
      service.resolvePaystackBankAccount('12345', '057'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('returns the verified account name from Paystack', async () => {
    const originalSecret = process.env.PAYSTACK_SECRET_KEY;
    process.env.PAYSTACK_SECRET_KEY = 'sk_test_unit_test_only';
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        status: true,
        data: {
          account_number: '0123456789',
          account_name: 'Example Recipient',
          bank_name: 'Zenith Bank',
        },
      }),
    } as Response);

    try {
      const result = await service.resolvePaystackBankAccount(
        '0123456789',
        '057',
      );
      expect(result).toEqual({
        accountNumber: '0123456789',
        accountName: 'Example Recipient',
        bankCode: '057',
        bankName: 'Zenith Bank',
        verified: true,
      });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      fetchSpy.mockRestore();
      if (originalSecret === undefined) delete process.env.PAYSTACK_SECRET_KEY;
      else process.env.PAYSTACK_SECRET_KEY = originalSecret;
    }
  });

});

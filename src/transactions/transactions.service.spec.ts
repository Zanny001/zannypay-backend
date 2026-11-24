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

describe('TransactionsService', () => {
  let service: TransactionsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TransactionsService,
        { provide: PrismaService, useValue: {} },
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
  it('rejects external bank transfers before any database or wallet mutation', async () => {
    await expect(
      service.transferFunds('user-1', {
        recipientAccount: '0123456789',
        amount: 1000,
        pin: '1234',
        bank: 'GTBank',
        bankCode: '058',
      } as any),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('rejects malformed bank account numbers before contacting Paystack', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    await expect(
      service.resolvePaystackBankAccount('12345', '057'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('returns the verified account name supplied by Paystack', async () => {
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
      expect(result.accountName).toBe('Example Recipient');
      expect(result.bankName).toBe('Zenith Bank');
      expect(result.verified).toBe(true);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      fetchSpy.mockRestore();
      if (originalSecret === undefined) delete process.env.PAYSTACK_SECRET_KEY;
      else process.env.PAYSTACK_SECRET_KEY = originalSecret;
    }
  });

});

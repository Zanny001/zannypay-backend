import { Test, TestingModule } from '@nestjs/testing';
import { ServiceUnavailableException } from '@nestjs/common';
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

  it('rejects external bank transfers before opening a money-movement transaction', async () => {
    await expect(
      service.transferFunds('user-1', { idempotencyKey: undefined } as any),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });
});

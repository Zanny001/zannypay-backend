import { Test, TestingModule } from '@nestjs/testing';
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
});

import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { MailerService } from '@nestjs-modules/mailer';
import { TransactionsService } from './transactions.service';
import { PrismaService } from '../prisma/prisma.service';
import { FraudService } from '../fraud/fraud.service';
import { NotificationsService } from '../notifications/notifications.service';
import { BeneficiariesService } from '../beneficiaries/beneficiaries.service';
import { LedgerService } from '../ledger/ledger.service';
import { AnalyticsService } from '../analytics/analytics.service';

// The one place the actual money-math for point redemption lives — an
// off-by-one or flipped comparison here means either overcharging the
// wallet or effectively giving away free bills, so this gets its own
// dedicated coverage rather than being an afterthought of the bill/airtime
// tests.
describe('TransactionsService.resolvePointsRedemption', () => {
  let service: TransactionsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TransactionsService,
        { provide: PrismaService, useValue: {} },
        { provide: MailerService, useValue: { sendMail: jest.fn() } },
        { provide: FraudService, useValue: { evaluateTransaction: jest.fn() } },
        { provide: NotificationsService, useValue: { create: jest.fn() } },
        { provide: BeneficiariesService, useValue: { recordPaymentIfSaved: jest.fn() } },
        { provide: LedgerService, useValue: { getOrCreateCustomerAccount: jest.fn(), getOrCreateSystemAccount: jest.fn(), postJournal: jest.fn() } },
        { provide: AnalyticsService, useValue: { track: jest.fn() } },
      ],
    }).compile();
    service = module.get<TransactionsService>(TransactionsService);
  });

  const resolve = (rewardPoints: number, amount: number, pointsToRedeem?: number) =>
    (service as any).resolvePointsRedemption({ rewardPoints }, amount, pointsToRedeem);

  it('charges the full amount to the wallet when no points are redeemed', () => {
    expect(resolve(1000, 2000, undefined)).toEqual({ walletCharge: 2000, pointsToRedeem: 0 });
    expect(resolve(1000, 2000, 0)).toEqual({ walletCharge: 2000, pointsToRedeem: 0 });
  });

  it('reduces the wallet charge by the naira value of points redeemed, at 10 points = ₦1', () => {
    // 500 points = ₦50 off a ₦2000 bill
    expect(resolve(1000, 2000, 500)).toEqual({ walletCharge: 1950, pointsToRedeem: 500 });
  });

  it('allows redeeming exactly enough points to cover the entire amount', () => {
    // 20,000 points = ₦2000, exactly the bill
    expect(resolve(25000, 2000, 20000)).toEqual({ walletCharge: 0, pointsToRedeem: 20000 });
  });

  it('rejects redeeming more points than the user actually has', () => {
    expect(() => resolve(100, 2000, 200)).toThrow(BadRequestException);
  });

  it('rejects redeeming more value in points than the purchase is worth', () => {
    // 30,000 points = ₦3000, more than the ₦2000 bill — even though the
    // user has enough points, this should still be rejected.
    expect(() => resolve(50000, 2000, 30000)).toThrow(BadRequestException);
  });

  it('rejects a points amount that is not a multiple of 10', () => {
    expect(() => resolve(1000, 2000, 505)).toThrow(BadRequestException);
  });

  it('never lets the wallet charge go negative', () => {
    // Guarded by the "more value than the purchase is worth" check above,
    // but confirmed directly here since this is the actual invariant that
    // matters — a negative wallet charge would mean crediting the user
    // instead of charging them.
    expect(() => resolve(100000, 1000, 20000)).toThrow(BadRequestException);
  });
});

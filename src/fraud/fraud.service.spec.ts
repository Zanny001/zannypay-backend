import { Test, TestingModule } from '@nestjs/testing';
import { MailerService } from '@nestjs-modules/mailer';
import { FraudService } from './fraud.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { NotificationsService } from '../notifications/notifications.service';

// Focused on the rule logic itself, not the full evaluate-and-persist
// pipeline (which would need a much heavier Prisma mock for little extra
// protection) — the actual thing worth guarding against regression is a
// wrong comparison or a flipped threshold silently letting fraud through
// or blocking legitimate transactions.
describe('FraudService rules', () => {
  let service: FraudService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FraudService,
        { provide: PrismaService, useValue: {} },
        { provide: AuditLogService, useValue: { record: jest.fn() } },
        { provide: MailerService, useValue: { sendMail: jest.fn() } },
        { provide: NotificationsService, useValue: { create: jest.fn() } },
      ],
    }).compile();

    service = module.get<FraudService>(FraudService);
  });

  describe('LARGE_SINGLE_TRANSACTION', () => {
    const runRule = (amount: number, maxAmount: number) =>
      (service as any).ruleLargeSingleTransaction({ amount } as any, {
        maxAmount,
      });

    it('does not trigger for an amount under the threshold', () => {
      expect(runRule(500_000, 1_000_000).triggered).toBe(false);
    });

    it('does not trigger for an amount exactly at the threshold', () => {
      // Strictly greater-than by design — a transaction exactly at the
      // configured limit is not itself "exceeding" it.
      expect(runRule(1_000_000, 1_000_000).triggered).toBe(false);
    });

    it('triggers for an amount over the threshold, with the details a reviewer needs', () => {
      const result = runRule(1_500_000, 1_000_000);
      expect(result.triggered).toBe(true);
      expect(result.details).toEqual({
        maxAmount: 1_000_000,
        actualAmount: 1_500_000,
      });
    });

    it('falls back to the default threshold if config is missing/malformed', () => {
      const result = (service as any).ruleLargeSingleTransaction(
        { amount: 2_000_000 } as any,
        {},
      );
      expect(result.triggered).toBe(true);
      expect(result.details.maxAmount).toBe(1_000_000);
    });
  });
});

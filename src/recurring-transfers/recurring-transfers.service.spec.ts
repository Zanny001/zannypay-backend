import { Test, TestingModule } from '@nestjs/testing';
import { RecurringTransfersService } from './recurring-transfers.service';
import { PrismaService } from '../prisma/prisma.service';
import { FraudService } from '../fraud/fraud.service';
import { NotificationsService } from '../notifications/notifications.service';
import { LedgerService } from '../ledger/ledger.service';
import { AnalyticsService } from '../analytics/analytics.service';
// Default import (not `import * as`) — with esModuleInterop this is the
// mutable module.exports object, which jest.spyOn can redefine; a frozen
// ESM namespace object can't be spied on.
import bcrypt from 'bcrypt';

// Covers the failure/auto-pause path specifically — the piece of this
// feature where a wrong threshold or comparison would either retry a
// broken recurring transfer forever, or pause a healthy one too early.
// The happy-path execution logic mirrors transferFunds' already-tested
// balance/ledger behavior closely enough that it isn't re-covered here.
describe('RecurringTransfersService — failure handling', () => {
  let service: RecurringTransfersService;
  let prisma: any;
  let notifications: { create: jest.Mock };

  const activeTransfer = {
    id: 'rt-1',
    userId: 'user-1',
    status: 'active',
    frequency: 'monthly',
    recipientName: 'Landlord',
    consecutiveFailures: 0,
  };

  beforeEach(async () => {
    prisma = {
      recurringTransfer: {
        findUnique: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    notifications = { create: jest.fn().mockResolvedValue({}) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RecurringTransfersService,
        { provide: PrismaService, useValue: prisma },
        { provide: FraudService, useValue: { evaluateTransaction: jest.fn() } },
        { provide: NotificationsService, useValue: notifications },
        {
          provide: LedgerService,
          useValue: {
            getOrCreateCustomerAccount: jest.fn(),
            postJournal: jest.fn(),
          },
        },
        { provide: AnalyticsService, useValue: { track: jest.fn() } },
      ],
    }).compile();

    service = module.get<RecurringTransfersService>(RecurringTransfersService);
  });

  const handleFailedRun = (id: string, message: string) =>
    (service as any).handleFailedRun(id, message);

  it('records a failed run and stays active below the auto-pause threshold', async () => {
    prisma.recurringTransfer.findUnique.mockResolvedValue({
      ...activeTransfer,
      consecutiveFailures: 1,
    });

    await handleFailedRun('rt-1', 'Insufficient funds.');

    const call = prisma.recurringTransfer.update.mock.calls[0][0];
    expect(call.data.consecutiveFailures).toBe(2);
    expect(call.data.status).toBe('active');
    expect(notifications.create).toHaveBeenCalledWith(
      'user-1',
      'recurring_transfer_failed',
      expect.any(String),
      expect.any(String),
      { recurringTransferId: 'rt-1' },
    );
  });

  it('auto-pauses on exactly the 3rd consecutive failure', async () => {
    prisma.recurringTransfer.findUnique.mockResolvedValue({
      ...activeTransfer,
      consecutiveFailures: 2,
    });

    await handleFailedRun('rt-1', 'Insufficient funds.');

    const call = prisma.recurringTransfer.update.mock.calls[0][0];
    expect(call.data.consecutiveFailures).toBe(3);
    expect(call.data.status).toBe('paused');
    expect(notifications.create).toHaveBeenCalledWith(
      'user-1',
      'recurring_transfer_paused',
      expect.any(String),
      expect.any(String),
      { recurringTransferId: 'rt-1' },
    );
  });

  it('does not re-record a failure for a transfer that is already paused or cancelled', async () => {
    prisma.recurringTransfer.findUnique.mockResolvedValue({
      ...activeTransfer,
      status: 'paused',
    });

    await handleFailedRun('rt-1', 'Insufficient funds.');

    expect(prisma.recurringTransfer.update).not.toHaveBeenCalled();
    expect(notifications.create).not.toHaveBeenCalled();
  });

  it('still advances nextRunAt on a failed run so it does not retry immediately', async () => {
    prisma.recurringTransfer.findUnique.mockResolvedValue({
      ...activeTransfer,
      consecutiveFailures: 0,
    });

    await handleFailedRun('rt-1', 'Insufficient funds.');

    const call = prisma.recurringTransfer.update.mock.calls[0][0];
    expect(call.data.nextRunAt).toBeInstanceOf(Date);
    expect(call.data.nextRunAt.getTime()).toBeGreaterThan(Date.now());
  });
});

describe('computeNextRunAt (via create)', () => {
  // computeNextRunAt itself is a module-private function, exercised here
  // through the public create() path rather than reached into directly.
  let service: RecurringTransfersService;
  let prisma: any;

  beforeEach(async () => {
    prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-1',
          pin: 'hashed',
          isFrozen: false,
          accountNumber: 'A',
          phone: 'P',
          businessAccountNumber: null,
        }),
        findFirst: jest.fn().mockResolvedValue({
          name: 'Bob',
          businessName: null,
          businessAccountNumber: null,
        }),
      },
      recurringTransfer: {
        create: jest
          .fn()
          .mockImplementation(({ data }) => Promise.resolve(data)),
      },
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RecurringTransfersService,
        { provide: PrismaService, useValue: prisma },
        { provide: FraudService, useValue: { evaluateTransaction: jest.fn() } },
        { provide: NotificationsService, useValue: { create: jest.fn() } },
        {
          provide: LedgerService,
          useValue: {
            getOrCreateCustomerAccount: jest.fn(),
            postJournal: jest.fn(),
          },
        },
        { provide: AnalyticsService, useValue: { track: jest.fn() } },
      ],
    }).compile();
    service = module.get<RecurringTransfersService>(RecurringTransfersService);
    jest.spyOn(bcrypt, 'compare').mockResolvedValue(true);
  });

  it('schedules a monthly transfer about 30 days out, not immediately', async () => {
    const result = await service.create('user-1', {
      recipientAccount: 'X',
      amount: 100,
      frequency: 'monthly',
      pin: '1234',
    } as any);
    const daysOut =
      (result.nextRunAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
    expect(daysOut).toBeGreaterThan(25);
    expect(daysOut).toBeLessThan(32);
  });

  it('schedules a daily transfer about 1 day out', async () => {
    const result = await service.create('user-1', {
      recipientAccount: 'X',
      amount: 100,
      frequency: 'daily',
      pin: '1234',
    } as any);
    const hoursOut =
      (result.nextRunAt.getTime() - Date.now()) / (1000 * 60 * 60);
    expect(hoursOut).toBeGreaterThan(23);
    expect(hoursOut).toBeLessThan(25);
  });
});

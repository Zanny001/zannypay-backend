import { Test, TestingModule } from '@nestjs/testing';
import { RecurringTransfersService } from './recurring-transfers.service';
import { PrismaService } from '../prisma/prisma.service';
import { FraudService } from '../fraud/fraud.service';
import { NotificationsService } from '../notifications/notifications.service';
import { LedgerService } from '../ledger/ledger.service';
import { AnalyticsService } from '../analytics/analytics.service';

// The execution path itself — the one place in this entire codebase where
// money moves with no human present. Every check here exists because an
// unattended process failing open (moving money when it shouldn't, or
// silently not recording that it failed) is a materially worse failure
// mode than the same bug in a PIN-confirmed, human-initiated transfer.
describe('RecurringTransfersService.executeOne', () => {
  let service: RecurringTransfersService;
  let prisma: any;
  let tx: any;
  let fraudService: { evaluateTransaction: jest.Mock };
  let notifications: { create: jest.Mock };

  const rt = {
    id: 'rt-1', userId: 'sender-1', status: 'active', frequency: 'monthly',
    recipientAccount: '9022222222', recipientName: 'Landlord', note: 'Rent', amount: 50000,
  };
  const sender = { id: 'sender-1', name: 'Sender', accountNumber: '9011111111', isFrozen: false, wallet: { balance: 100000 } };
  const recipient = { id: 'recipient-1', accountNumber: '9022222222', businessAccountNumber: null, wallet: { balance: 5000 } };

  function freshTxMock() {
    return {
      recurringTransfer: { findUnique: jest.fn().mockResolvedValue({ ...rt }), update: jest.fn().mockResolvedValue({}) },
      user: { findUnique: jest.fn().mockResolvedValue({ ...sender }), findFirst: jest.fn().mockResolvedValue({ ...recipient }) },
      wallet: { update: jest.fn().mockResolvedValue({}) },
      transaction: {
        create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: `txn-${Math.random()}`, createdAt: new Date(), ...data })),
      },
    };
  }

  beforeEach(async () => {
    tx = freshTxMock();
    prisma = {
      recurringTransfer: { findUnique: jest.fn().mockResolvedValue({ ...rt, consecutiveFailures: 0 }), update: jest.fn().mockResolvedValue({}) },
      $transaction: jest.fn().mockImplementation((callback) => callback(tx)),
    };
    fraudService = { evaluateTransaction: jest.fn().mockResolvedValue(undefined) };
    notifications = { create: jest.fn().mockResolvedValue({}) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RecurringTransfersService,
        { provide: PrismaService, useValue: prisma },
        { provide: FraudService, useValue: fraudService },
        { provide: NotificationsService, useValue: notifications },
        {
          provide: LedgerService,
          useValue: {
            getOrCreateCustomerAccount: jest.fn().mockResolvedValue({ id: 'mock-wallet-account' }),
            postJournal: jest.fn().mockResolvedValue('mock-journal-id'),
          },
        },
        { provide: AnalyticsService, useValue: { track: jest.fn().mockResolvedValue(undefined) } },
      ],
    }).compile();
    service = module.get<RecurringTransfersService>(RecurringTransfersService);
  });

  const executeOne = (id: string) => (service as any).executeOne(id);

  it('on success: moves the money, records both legs, advances the schedule, and notifies the sender', async () => {
    await executeOne('rt-1');

    expect(tx.wallet.update).toHaveBeenCalledWith({ where: { userId: 'sender-1' }, data: { balance: { decrement: 50000 } } });
    expect(tx.wallet.update).toHaveBeenCalledWith({ where: { userId: 'recipient-1' }, data: { balance: { increment: 50000 } } });
    expect(tx.transaction.create).toHaveBeenCalledTimes(2);

    const updateCall = tx.recurringTransfer.update.mock.calls[0][0];
    expect(updateCall.data.lastRunStatus).toBe('success');
    expect(updateCall.data.consecutiveFailures).toBe(0);
    expect(updateCall.data.nextRunAt).toBeInstanceOf(Date);

    expect(notifications.create).toHaveBeenCalledWith('sender-1', 'recurring_transfer_sent', expect.any(String), expect.any(String), { recurringTransferId: 'rt-1' });
  });

  it('tags the credit leg as receivedVia "business" when the recipient\'s business account was targeted', async () => {
    tx.user.findFirst.mockResolvedValue({ ...recipient, businessAccountNumber: '9022222222' });

    await executeOne('rt-1');

    const creditCall = tx.transaction.create.mock.calls.find((c: any) => c[0].data.type === 'credit');
    expect(creditCall[0].data.receivedVia).toBe('business');
  });

  it('runs the fraud check against the debit leg with a well-formed EvaluatedTransaction shape', async () => {
    await executeOne('rt-1');

    expect(fraudService.evaluateTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'sender-1', type: 'debit', category: 'transfer', amount: 50000, recipientAccount: '9022222222' }),
    );
    const arg = fraudService.evaluateTransaction.mock.calls[0][0];
    expect(arg.createdAt).toBeInstanceOf(Date);
  });

  it('skips cleanly with no mutation if the transfer was paused between the batch query and execution', async () => {
    tx.recurringTransfer.findUnique.mockResolvedValue({ ...rt, status: 'paused' });

    await executeOne('rt-1');

    expect(tx.wallet.update).not.toHaveBeenCalled();
    expect(tx.transaction.create).not.toHaveBeenCalled();
    expect(notifications.create).not.toHaveBeenCalled();
  });

  it('records a failure and does not move money on insufficient funds', async () => {
    tx.user.findUnique.mockResolvedValue({ ...sender, wallet: { balance: 100 } });

    await executeOne('rt-1');

    expect(tx.wallet.update).not.toHaveBeenCalled();
    expect(tx.transaction.create).not.toHaveBeenCalled();
    // handleFailedRun runs outside the transaction, against `prisma` not `tx`
    const call = prisma.recurringTransfer.update.mock.calls[0][0];
    expect(call.data.lastRunStatus).toBe('failed');
    expect(call.data.lastRunError).toMatch(/insufficient funds/i);
  });

  it('records a failure and does not move money when the sender account is frozen', async () => {
    tx.user.findUnique.mockResolvedValue({ ...sender, isFrozen: true });

    await executeOne('rt-1');

    expect(tx.wallet.update).not.toHaveBeenCalled();
    const call = prisma.recurringTransfer.update.mock.calls[0][0];
    expect(call.data.lastRunStatus).toBe('failed');
  });

  it('records a failure and does not move money when the recipient can no longer be found', async () => {
    tx.user.findFirst.mockResolvedValue(null);

    await executeOne('rt-1');

    expect(tx.wallet.update).not.toHaveBeenCalled();
    const call = prisma.recurringTransfer.update.mock.calls[0][0];
    expect(call.data.lastRunStatus).toBe('failed');
    expect(call.data.lastRunError).toMatch(/recipient account could not be found/i);
  });

  it('the defensive self-transfer re-check actually blocks execution if the recipient resolves to the sender', async () => {
    tx.user.findFirst.mockResolvedValue({ ...recipient, id: 'sender-1' });

    await executeOne('rt-1');

    expect(tx.wallet.update).not.toHaveBeenCalled();
    const call = prisma.recurringTransfer.update.mock.calls[0][0];
    expect(call.data.lastRunStatus).toBe('failed');
    expect(call.data.lastRunError).toMatch(/refusing to execute/i);
  });

  it('does not run the fraud check when the run failed (no debit leg exists)', async () => {
    tx.user.findFirst.mockResolvedValue(null);

    await executeOne('rt-1');

    expect(fraudService.evaluateTransaction).not.toHaveBeenCalled();
  });
});

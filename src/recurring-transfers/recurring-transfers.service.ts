import { Injectable, Logger, NotFoundException, BadRequestException, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { FraudService } from '../fraud/fraud.service';
import { NotificationsService } from '../notifications/notifications.service';
import { LedgerService } from '../ledger/ledger.service';
import { LedgerAccountType, LedgerDirection } from '@prisma/client';
import { AnalyticsService, ANALYTICS_EVENTS } from '../analytics/analytics.service';
import { CreateRecurringTransferDto } from './dto/create-recurring-transfer.dto';
import { formatNaira } from '../common/format-currency.util';
import * as bcrypt from 'bcryptjs';

function computeNextRunAt(from: Date, frequency: string): Date {
  const next = new Date(from);
  if (frequency === 'daily') next.setDate(next.getDate() + 1);
  else if (frequency === 'weekly') next.setDate(next.getDate() + 7);
  else if (frequency === 'monthly') next.setMonth(next.getMonth() + 1);
  else throw new Error(`Unknown recurring transfer frequency: ${frequency}`);
  return next;
}

const MAX_CONSECUTIVE_FAILURES = 3;

@Injectable()
export class RecurringTransfersService {
  private readonly logger = new Logger(RecurringTransfersService.name);

  // Simple in-process reentrancy guard — not a distributed lock. Fine for
  // this app's single-instance deployment; a multi-instance deployment
  // would need a real lock (e.g. a DB advisory lock) before scaling this
  // horizontally, since two instances could otherwise both pick up the
  // same due transfer in the same tick.
  private isRunning = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly fraudService: FraudService,
    private readonly notifications: NotificationsService,
    private readonly ledgerService: LedgerService,
    private readonly analyticsService: AnalyticsService,
  ) {}

  // ==========================================
  // Customer-facing
  // ==========================================

  async create(userId: string, dto: CreateRecurringTransferDto) {
    const sender = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!sender) throw new NotFoundException('User not found.');
    if (sender.isFrozen) throw new ForbiddenException('Your account is currently restricted. Please contact support.');

    const isPinValid = await bcrypt.compare(dto.pin, sender.pin);
    if (!isPinValid) throw new UnauthorizedException('Incorrect PIN.');

    if (sender.accountNumber === dto.recipientAccount || sender.phone === dto.recipientAccount || sender.businessAccountNumber === dto.recipientAccount) {
      throw new BadRequestException('Cannot set up a recurring transfer to yourself.');
    }

    const recipient = await this.prisma.user.findFirst({
      where: { OR: [{ accountNumber: dto.recipientAccount }, { phone: dto.recipientAccount }, { businessAccountNumber: dto.recipientAccount }] },
      select: { name: true, businessName: true, businessAccountNumber: true },
    });
    if (!recipient) throw new NotFoundException('No ZannyPay user found with that account number or phone number.');

    const displayName = recipient.businessAccountNumber === dto.recipientAccount ? recipient.businessName || recipient.name : recipient.name;

    return this.prisma.recurringTransfer.create({
      data: {
        userId,
        recipientAccount: dto.recipientAccount,
        recipientName: displayName,
        amount: dto.amount,
        note: dto.note,
        frequency: dto.frequency,
        nextRunAt: computeNextRunAt(new Date(), dto.frequency),
      },
    });
  }

  async list(userId: string) {
    return this.prisma.recurringTransfer.findMany({ where: { userId }, orderBy: { createdAt: 'desc' } });
  }

  private async findOwned(userId: string, id: string) {
    const rt = await this.prisma.recurringTransfer.findUnique({ where: { id } });
    if (!rt || rt.userId !== userId) throw new NotFoundException('Recurring transfer not found.');
    return rt;
  }

  async pause(userId: string, id: string) {
    await this.findOwned(userId, id);
    return this.prisma.recurringTransfer.update({ where: { id }, data: { status: 'paused' } });
  }

  async resume(userId: string, id: string) {
    const rt = await this.findOwned(userId, id);
    // Resuming also resets the failure count and reschedules from now,
    // rather than immediately re-attempting whatever made it fail (or
    // auto-pause) last time.
    return this.prisma.recurringTransfer.update({
      where: { id },
      data: { status: 'active', consecutiveFailures: 0, nextRunAt: computeNextRunAt(new Date(), rt.frequency) },
    });
  }

  async cancel(userId: string, id: string) {
    await this.findOwned(userId, id);
    return this.prisma.recurringTransfer.update({ where: { id }, data: { status: 'cancelled' } });
  }

  // ==========================================
  // Internal execution — never reachable via HTTP. Only this class's own
  // @Cron handler calls runDueTransfers/executeOne.
  // ==========================================

  @Cron(CronExpression.EVERY_HOUR)
  async runDueTransfers() {
    if (this.isRunning) {
      this.logger.warn('runDueTransfers skipped — previous run still in progress.');
      return;
    }
    this.isRunning = true;
    try {
      const due = await this.prisma.recurringTransfer.findMany({
        where: { status: 'active', nextRunAt: { lte: new Date() } },
      });
      // Sequential, not Promise.all — the DB connection pool here is sized
      // small (see .env.example's connection_limit), and this runs at most
      // hourly, so there's no real time pressure to parallelize.
      for (const rt of due) {
        await this.executeOne(rt.id).catch((err) => {
          // executeOne already handles its own expected failure modes
          // (insufficient funds, frozen account, etc.) by recording them
          // on the row — reaching this catch means something unexpected
          // happened, and it should not take down the rest of the batch.
          this.logger.error(`Unexpected error executing recurring transfer ${rt.id}: ${err.message}`, err.stack);
        });
      }
    } catch (err: any) {
      // Reaching here means even the initial findMany() failed — most
      // commonly a transient DB/pooler connectivity issue (Prisma error
      // code P1001), not a bug in this service. Logged through this
      // class's own logger with a clear, actionable message rather than
      // letting it fall through to @nestjs/schedule's generic Scheduler
      // error handler, which only prints the raw stack with no context on
      // what was running or that the next hourly tick will simply retry.
      const isConnectivityIssue = err?.code === 'P1001' || /Can't reach database server/i.test(err?.message || '');
      if (isConnectivityIssue) {
        this.logger.error(
          `runDueTransfers could not reach the database this run — skipping, will retry on the next hourly tick. (${err.message})`,
        );
      } else {
        this.logger.error(`runDueTransfers failed unexpectedly: ${err.message}`, err.stack);
      }
    } finally {
      this.isRunning = false;
    }
  }

  private async executeOne(recurringTransferId: string) {
    let debitTxn: any = null;

    try {
      const outcome = await this.prisma.$transaction(async (tx) => {
        const rt = await tx.recurringTransfer.findUnique({ where: { id: recurringTransferId } });
        // Re-check status inside the transaction — it may have been
        // paused/cancelled by the user between the batch query and now.
        if (!rt || rt.status !== 'active') return { skipped: true };

        const sender = await tx.user.findUnique({ where: { id: rt.userId }, include: { wallet: true } });
        if (!sender) throw new Error('Sender account no longer exists.');
        if (sender.isFrozen) throw new Error('Account is restricted.');

        // Re-resolve the recipient fresh rather than trusting anything
        // cached from creation time — the identifier is stable, but the
        // underlying account's state (frozen, deleted) is not.
        const recipient = await tx.user.findFirst({
          where: { OR: [{ accountNumber: rt.recipientAccount }, { phone: rt.recipientAccount }, { businessAccountNumber: rt.recipientAccount }] },
          include: { wallet: true },
        });
        if (!recipient) throw new Error('Recipient account could not be found.');
        if (recipient.id === sender.id) throw new Error('Recipient resolved to the sender — refusing to execute.');

        const amount = Number(rt.amount);
        if (Number(sender.wallet.balance) < amount) throw new Error('Insufficient funds.');

        await tx.wallet.update({ where: { userId: sender.id }, data: { balance: { decrement: amount } } });
        await tx.wallet.update({ where: { userId: recipient.id }, data: { balance: { increment: amount } } });

        const receivedVia = recipient.businessAccountNumber === rt.recipientAccount ? 'business' : 'personal';

        const senderTx = await tx.transaction.create({
          data: {
            userId: sender.id, type: 'debit', category: 'transfer',
            title: `Recurring transfer to ${rt.recipientName}`, subtitle: rt.note || rt.recipientAccount,
            amount, status: 'completed', reference: `RECUR-${Date.now()}-D`, recipientAccount: rt.recipientAccount,
          },
        });
        await tx.transaction.create({
          data: {
            userId: recipient.id, type: 'credit', category: 'transfer',
            title: `Recurring transfer from ${sender.name}`, subtitle: rt.note || sender.accountNumber,
            amount, status: 'completed', reference: `RECUR-${Date.now()}-C`, recipientAccount: sender.accountNumber, receivedVia,
          },
        });

        // Same shape as TransactionsService.transferFunds' internal
        // branch — both real customer accounts, linked to senderTx (what
        // a reversal would target).
        const senderWalletAccountRt = await this.ledgerService.getOrCreateCustomerAccount(LedgerAccountType.CUSTOMER_WALLET, sender.id, tx);
        const recipientWalletAccountRt = await this.ledgerService.getOrCreateCustomerAccount(LedgerAccountType.CUSTOMER_WALLET, recipient.id, tx);
        await this.ledgerService.postJournal(
          tx,
          [
            { accountId: senderWalletAccountRt.id, direction: LedgerDirection.DEBIT, amount },
            { accountId: recipientWalletAccountRt.id, direction: LedgerDirection.CREDIT, amount },
          ],
          { transactionId: senderTx.id, memo: `Recurring transfer to ${rt.recipientName}` },
        );

        await tx.recurringTransfer.update({
          where: { id: rt.id },
          data: {
            lastRunAt: new Date(), lastRunStatus: 'success', lastRunError: null, consecutiveFailures: 0,
            nextRunAt: computeNextRunAt(new Date(), rt.frequency),
          },
        });

        return { skipped: false, rt, senderTx, senderId: sender.id };
      });

      if (!outcome.skipped) {
        debitTxn = outcome.senderTx;
        await this.notifications.create(
          outcome.senderId, 'recurring_transfer_sent', 'Recurring transfer sent',
          `Your recurring transfer of ${formatNaira(Number(outcome.rt.amount))} to ${outcome.rt.recipientName} was sent.`,
          { recurringTransferId },
        );
        await this.analyticsService.track(ANALYTICS_EVENTS.TRANSFER_COMPLETED, {
          userId: outcome.senderId,
          properties: { amount: Number(outcome.rt.amount), isInternal: true, isRecurring: true },
        });
      }
    } catch (error) {
      await this.handleFailedRun(recurringTransferId, error.message);
    }

    // Outside the DB transaction, same pattern as every other money-
    // movement path in this app — a fraud check failing to run should
    // never roll back a transfer that already committed. evaluateTransaction
    // catches its own errors internally, so this can't throw, but the
    // wrapper stays for defense-in-depth consistency with the rest of the app.
    if (debitTxn) {
      await this.fraudService.evaluateTransaction({
        id: debitTxn.id,
        userId: debitTxn.userId,
        type: debitTxn.type,
        category: debitTxn.category,
        amount: Number(debitTxn.amount),
        recipientAccount: debitTxn.recipientAccount,
        createdAt: debitTxn.createdAt,
      }).catch((err) => this.logger.error(`Fraud check failed for recurring transfer debit ${debitTxn.id}: ${err.message}`));
    }
  }

  private async handleFailedRun(recurringTransferId: string, errorMessage: string) {
    const rt = await this.prisma.recurringTransfer.findUnique({ where: { id: recurringTransferId } });
    if (!rt || rt.status !== 'active') return; // already paused/cancelled — nothing to record

    const consecutiveFailures = rt.consecutiveFailures + 1;
    const shouldAutoPause = consecutiveFailures >= MAX_CONSECUTIVE_FAILURES;

    await this.prisma.recurringTransfer.update({
      where: { id: recurringTransferId },
      data: {
        lastRunAt: new Date(), lastRunStatus: 'failed', lastRunError: errorMessage, consecutiveFailures,
        status: shouldAutoPause ? 'paused' : 'active',
        // Still advance nextRunAt even when not auto-pausing — a failed
        // occurrence is skipped, not retried immediately, so one bad day
        // doesn't turn into a retry storm.
        nextRunAt: computeNextRunAt(new Date(), rt.frequency),
      },
    });

    await this.notifications.create(
      rt.userId,
      shouldAutoPause ? 'recurring_transfer_paused' : 'recurring_transfer_failed',
      shouldAutoPause ? 'Recurring transfer paused' : 'Recurring transfer failed',
      shouldAutoPause
        ? `Your recurring transfer to ${rt.recipientName} failed ${MAX_CONSECUTIVE_FAILURES} times in a row and has been paused. Reason: ${errorMessage}`
        : `Your recurring transfer to ${rt.recipientName} could not be sent this time. Reason: ${errorMessage}`,
      { recurringTransferId },
    );
  }

}

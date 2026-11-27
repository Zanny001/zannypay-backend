import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { LedgerAccountType, LedgerDirection } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { TransferDto } from './dto/transfer.dto';

type PaystackTransferStatus = 'pending' | 'otp' | 'success' | 'failed' | 'reversed';

@Injectable()
export class PaystackTransfersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
  ) {}

  private enabled() {
    if (process.env.PAYSTACK_TRANSFERS_ENABLED !== 'true') {
      throw new ServiceUnavailableException(
        'External bank transfers are not enabled yet. Please use ZannyPay transfers or try again later.',
      );
    }
    if (!process.env.PAYSTACK_SECRET_KEY) {
      throw new ServiceUnavailableException(
        'Bank payouts are not configured. Please try again later.',
      );
    }
  }

  private headers() {
    return {
      Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
      'Content-Type': 'application/json',
    };
  }

  private async paystack(path: string, init?: RequestInit) {
    let response: Response;
    let payload: any;
    try {
      response = await fetch(`https://api.paystack.co${path}`, {
        ...init,
        headers: { ...this.headers(), ...(init?.headers || {}) },
        signal: init?.signal || AbortSignal.timeout(15000),
      });
      payload = await response.json();
    } catch {
      // A timeout after POST /transfer is ambiguous. The caller must retain
      // the pending reference and verify it; it must never submit a new payout.
      throw new ServiceUnavailableException(
        'Paystack could not be reached. The transfer status will remain pending while it is checked.',
      );
    }
    return { response, payload };
  }

  private async settle(
    reference: string,
    status: PaystackTransferStatus,
    providerData?: { amount?: number; currency?: string; transfer_code?: string },
  ) {
    return this.prisma.$transaction(async (tx) => {
      const txn = await tx.transaction.findUnique({ where: { reference } });
      if (
        !txn ||
        txn.category !== 'external_bank_transfer' ||
        txn.type !== 'debit'
      ) {
        return { success: false, status: 'not_found' };
      }

      // Terminal provider states must be bound to the exact transfer
      // amount and currency. Missing fields are not evidence of a payout.
      // pending/otp may legitimately omit amount/currency in some Paystack
      // responses, but success/failed/reversed must fail closed.
      if (['success', 'failed', 'reversed'].includes(status)) {
        if (
          !providerData ||
          providerData.currency !== 'NGN' ||
          !Number.isSafeInteger(providerData.amount) ||
          providerData.amount !== Math.round(Number(txn.amount) * 100)
        ) {
          return { success: false, status: 'provider_amount_mismatch' };
        }
      }

      if (txn.status === 'completed' && status !== 'failed' && status !== 'reversed') {
        return { success: true, status: 'completed', alreadyProcessed: true };
      }
      if (txn.status === 'failed') {
        return { success: status === 'failed' || status === 'reversed', status: 'failed', alreadyProcessed: true };
      }
      if (txn.status !== 'pending' && txn.status !== 'completed') {
        return { success: false, status: txn.status };
      }

      if (status === 'pending' || status === 'otp') {
        await tx.transaction.updateMany({
          where: { id: txn.id, status: 'pending' },
          data: {
            providerStatus: status,
            providerLastCheckedAt: new Date(),
            ...(providerData?.transfer_code
              ? { providerTransactionId: providerData.transfer_code }
              : {}),
          },
        });
        return { success: true, status };
      }

      if (status === 'success') {
        const updated = await tx.transaction.updateMany({
          where: { id: txn.id, status: 'pending' },
          data: {
            status: 'completed',
            providerStatus: 'success',
            providerLastCheckedAt: new Date(),
            ...(providerData?.transfer_code
              ? { providerTransactionId: providerData.transfer_code }
              : {}),
          },
        });
        if (updated.count !== 1) {
          return { success: false, status: 'already_settled' };
        }
        const payoutClearing = await this.ledger.getOrCreateSystemAccount(
          LedgerAccountType.SYSTEM_EXTERNAL_PAYOUT_CLEARING,
          tx,
        );
        const paystackClearing = await this.ledger.getOrCreateSystemAccount(
          LedgerAccountType.SYSTEM_PAYSTACK_CLEARING,
          tx,
        );
        await this.ledger.postJournal(
          tx,
          [
            { accountId: payoutClearing.id, direction: LedgerDirection.DEBIT, amount: Number(txn.amount) },
            { accountId: paystackClearing.id, direction: LedgerDirection.CREDIT, amount: Number(txn.amount) },
          ],
          { transactionId: txn.id, memo: 'Paystack payout confirmed — reduce payout float' },
        );
        return { success: true, status: 'completed' };
      }

      // A definitive failed/reversed provider result returns the reserved
      // customer funds exactly once and mirrors the original journal.
      const claimed = await tx.transaction.updateMany({
        where: { id: txn.id, status: { in: ['pending', 'completed'] } },
        data: {
          status: 'failed',
          providerStatus: status,
          providerLastCheckedAt: new Date(),
        },
      });
      if (claimed.count !== 1) {
        return { success: false, status: 'already_settled' };
      }

      await tx.wallet.update({
        where: { userId: txn.userId },
        data: { balance: { increment: txn.amount } },
      });
      const reversal = await tx.transaction.create({
        data: {
          userId: txn.userId,
          type: 'credit',
          category: 'transfer_reversal',
          title: 'Bank transfer reversal',
          subtitle: `Reversal for ${reference}`,
          amount: txn.amount,
          status: 'completed',
          reference: `REV-${randomUUID()}`,
          reversedTransactionId: txn.id,
          reversalReason: `Paystack transfer ${status}`,
        },
      });
      // reverseJournal inverts both the initial wallet reservation and the
      // payout-float settlement (when already completed), restoring the
      // customer's wallet and the Paystack clearing asset in one journal.
      await this.ledger.reverseJournal(
        tx,
        txn.id,
        reversal.id,
        `Paystack bank transfer ${status} — wallet refund`,
      );
      return { success: true, status: 'failed', refunded: true };
    });
  }

  async transfer(userId: string, dto: TransferDto) {
    this.enabled();

    const accountNumber = String(dto.recipientAccount || '').trim();
    const bankCode = String(dto.bankCode || '').trim();
    const amount = Number(dto.amount);
    const amountInKobo = Math.round(amount * 100);
    if (!/^\d{10}$/.test(accountNumber)) {
      throw new BadRequestException('Enter a valid 10-digit bank account number.');
    }
    if (!/^\d{2,8}$/.test(bankCode)) {
      throw new BadRequestException('Select a valid destination bank.');
    }
    if (
      !Number.isFinite(amount) ||
      amount < 1 ||
      amount > 10000000 ||
      !Number.isSafeInteger(amountInKobo) ||
      Math.abs(amountInKobo / 100 - amount) > 0.000001
    ) {
      throw new BadRequestException('Enter a valid transfer amount with up to two decimal places.');
    }

    if (!dto.idempotencyKey || dto.idempotencyKey.trim().length < 8) {
      throw new BadRequestException('A unique idempotency key is required for bank transfers. Please update the app and try again.');
    }

    if (dto.idempotencyKey) {
      const existing = await this.prisma.transaction.findUnique({
        where: { idempotencyKey: dto.idempotencyKey },
      });
      if (existing) {
        if (
          existing.userId !== userId ||
          existing.category !== 'external_bank_transfer' ||
          Number(existing.amount) !== amount ||
          existing.recipientAccount !== accountNumber ||
          existing.subtitle !== `${bankCode} ••••${accountNumber.slice(-4)}`
        ) {
          throw new BadRequestException('This transfer key is already associated with another request.');
        }
        return {
          success: existing.status === 'completed',
          status: existing.status,
          transactionId: existing.id,
          reference: existing.reference,
          replayed: true,
        };
      }
    }

    const sender = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { wallet: true },
    });
    if (!sender) throw new NotFoundException('Sender account not found.');
    if (sender.isFrozen) {
      throw new ForbiddenException('Your account is currently restricted. Please contact support.');
    }
    if (!(await bcrypt.compare(dto.pin, sender.pin))) {
      throw new UnauthorizedException('Incorrect PIN.');
    }
    if (Number(sender.wallet.balance) < amount) {
      throw new BadRequestException('Insufficient funds.');
    }

    // Resolve the account again server-side; client-supplied names are never
    // trusted as the payout destination identity.
    const resolve = await this.paystack(
      `/bank/resolve?account_number=${encodeURIComponent(accountNumber)}&bank_code=${encodeURIComponent(bankCode)}`,
    );
    const resolvedName = String(resolve.payload?.data?.account_name || '').trim();
    if (!resolve.response.ok || !resolve.payload?.status || !resolvedName) {
      throw new BadRequestException(
        resolve.payload?.message || 'We could not verify this account at the selected bank.',
      );
    }
    const resolvedAccount = String(resolve.payload.data.account_number || accountNumber);
    if (resolvedAccount !== accountNumber) {
      throw new BadRequestException('The verified account number does not match the entered account number.');
    }

    const recipient = await this.paystack('/transferrecipient', {
      method: 'POST',
      body: JSON.stringify({
        type: 'nuban',
        name: resolvedName,
        account_number: accountNumber,
        bank_code: bankCode,
        currency: 'NGN',
      }),
    });
    const recipientCode = recipient.payload?.data?.recipient_code;
    if (!recipient.response.ok || !recipient.payload?.status || typeof recipientCode !== 'string') {
      throw new ServiceUnavailableException(
        recipient.payload?.message || 'Paystack could not prepare this bank recipient.',
      );
    }

    const reference = `zp-${randomUUID()}`;
    let txn;
    try {
      txn = await this.prisma.$transaction(async (tx) => {
        const freshSender = await tx.user.findUnique({
          where: { id: userId },
          include: { wallet: true },
        });
        if (!freshSender) throw new NotFoundException('Sender account not found.');
        if (freshSender.isFrozen) {
          throw new ForbiddenException('Your account is currently restricted. Please contact support.');
        }
        if (!(await bcrypt.compare(dto.pin, freshSender.pin))) {
          throw new UnauthorizedException('Incorrect PIN.');
        }

        const debit = await tx.wallet.updateMany({
          where: { userId, balance: { gte: amount } },
          data: { balance: { decrement: amount } },
        });
        if (debit.count !== 1) throw new BadRequestException('Insufficient funds.');

        const transaction = await tx.transaction.create({
          data: {
            userId,
            type: 'debit',
            category: 'external_bank_transfer',
            title: `Bank transfer to ${resolvedName}`,
            subtitle: `${bankCode} ••••${accountNumber.slice(-4)}`,
            amount,
            bank: dto.bank || resolve.payload.data.bank_name || null,
            recipientAccount: accountNumber,
            status: 'pending',
            reference,
            ...(dto.idempotencyKey ? { idempotencyKey: dto.idempotencyKey } : {}),
            providerStatus: 'initiating',
          },
        });

        const walletAccount = await this.ledger.getOrCreateCustomerAccount(
          LedgerAccountType.CUSTOMER_WALLET,
          userId,
          tx,
        );
        const payoutClearing = await this.ledger.getOrCreateSystemAccount(
          LedgerAccountType.SYSTEM_EXTERNAL_PAYOUT_CLEARING,
          tx,
        );
        await this.ledger.postJournal(
          tx,
          [
            { accountId: walletAccount.id, direction: LedgerDirection.DEBIT, amount },
            { accountId: payoutClearing.id, direction: LedgerDirection.CREDIT, amount },
          ],
          { transactionId: transaction.id, memo: `External bank transfer to ${resolvedName}` },
        );
        return transaction;
      });
    } catch (error: any) {
      if (error?.code === 'P2002' && dto.idempotencyKey) {
        const existing = await this.prisma.transaction.findUnique({
          where: { idempotencyKey: dto.idempotencyKey },
        });
        if (existing && existing.userId === userId) {
          return {
            success: existing.status === 'completed',
            status: existing.status,
            transactionId: existing.id,
            reference: existing.reference,
            replayed: true,
          };
        }
      }
      throw error;
    }

    let initiated;
    try {
      initiated = await this.paystack('/transfer', {
        method: 'POST',
        body: JSON.stringify({
          source: 'balance',
          amount: amountInKobo,
          recipient: recipientCode,
          reference,
          currency: 'NGN',
          reason: String(dto.note || `ZannyPay transfer to ${resolvedName}`).slice(0, 100),
        }),
      });
    } catch {
      // Do not refund or retry an ambiguous POST. A status check/webhook must
      // establish whether Paystack accepted the instruction.
      return {
        success: false,
        status: 'pending',
        transactionId: txn.id,
        reference,
        recipientName: resolvedName,
        message: 'Your transfer is being confirmed. Do not submit it again.',
      };
    }

    if (!initiated.response.ok || !initiated.payload?.status) {
      // A 5xx/429 response can still hide an accepted provider instruction.
      // Preserve the debit as pending until verify/webhook gives a final answer.
      if (initiated.response.status >= 500 || initiated.response.status === 429) {
        return {
          success: false,
          status: 'pending',
          transactionId: txn.id,
          reference,
          recipientName: resolvedName,
          message: 'Paystack is still confirming this transfer. Do not submit it again.',
        };
      }
      // A definitive provider-side validation/funding rejection is safe to refund.
      // This is a definitive synchronous Paystack validation rejection
      // (not a webhook/verification result), so refund against the exact
      // locally-created amount and NGN currency.
      await this.settle(reference, 'failed', {
        amount: amountInKobo,
        currency: 'NGN',
      });
      throw new BadRequestException(
        initiated.payload?.message || 'Paystack rejected this transfer instruction.',
      );
    }

    const providerStatus = String(initiated.payload?.data?.status || 'pending') as PaystackTransferStatus;
    const transferCode = initiated.payload?.data?.transfer_code;
    const acceptedStatus: PaystackTransferStatus =
      ['success', 'failed', 'reversed', 'otp'].includes(providerStatus)
        ? providerStatus
        : 'pending';
    const settled = await this.settle(reference, acceptedStatus, {
      ...(Number.isSafeInteger(initiated.payload?.data?.amount) ? { amount: initiated.payload.data.amount } : {}),
      ...(initiated.payload?.data?.currency ? { currency: initiated.payload.data.currency } : {}),
      ...(transferCode ? { transfer_code: String(transferCode) } : {}),
    });
    return {
      success: settled.status === 'completed',
      status: settled.status,
      transactionId: txn.id,
      reference,
      recipientName: resolvedName,
      message:
        acceptedStatus === 'otp'
          ? 'The payout is awaiting Paystack business-owner authorization.'
          : settled.status === 'pending'
            ? 'Your transfer is being processed. Do not submit it again.'
            : undefined,
    };
  }

  async handleWebhook(
    event: string,
    data: { reference?: string; amount?: number; currency?: string; transfer_code?: string },
  ) {
    if (!data?.reference) return { success: false, status: 'missing_reference' };
    const eventStatus: Record<string, PaystackTransferStatus> = {
      'transfer.success': 'success',
      'transfer.failed': 'failed',
      'transfer.reversed': 'reversed',
      'transfer.otp': 'otp',
    };
    const status = eventStatus[event];
    if (!status) return { success: true, status: 'ignored' };
    return this.settle(data.reference, status, data);
  }

  async verify(userId: string, reference: string) {
    if (!process.env.PAYSTACK_SECRET_KEY) {
      throw new ServiceUnavailableException('Paystack transfer verification is not configured.');
    }
    const txn = await this.prisma.transaction.findFirst({
      where: { reference, userId, category: 'external_bank_transfer' },
    });
    if (!txn) throw new NotFoundException('Bank transfer not found.');
    if (txn.status === 'completed') return { success: true, status: 'completed' };
    if (txn.status === 'failed') return { success: false, status: 'failed' };

    const result = await this.paystack(
      `/transfer/verify/${encodeURIComponent(reference)}`,
    );
    if (!result.response.ok || !result.payload?.status) {
      return { success: false, status: txn.providerStatus || 'pending' };
    }
    const data = result.payload.data || {};
    if (data.reference !== reference) {
      return { success: false, status: 'provider_reference_mismatch' };
    }
    const status = String(data.status || 'pending') as PaystackTransferStatus;
    const normalized: PaystackTransferStatus =
      ['success', 'failed', 'reversed', 'otp'].includes(status) ? status : 'pending';
    const settled = await this.settle(reference, normalized, {
      amount: data.amount,
      currency: data.currency,
      ...(data.transfer_code ? { transfer_code: data.transfer_code } : {}),
    });
    return { success: settled.status === 'completed', status: settled.status };
  }
}

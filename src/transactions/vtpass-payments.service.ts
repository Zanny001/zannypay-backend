import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { LedgerAccountType, LedgerDirection } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { VtpassClient } from './vtpass.client';
import { VtpassBillPurchaseDto } from './dto/vtpass-bill-purchase.dto';

type ProviderState = 'completed' | 'failed' | 'pending';

@Injectable()
export class VtpassPaymentsService {
  private readonly logger = new Logger(VtpassPaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly vtpass: VtpassClient,
  ) {}

  private responseState(payload: any): ProviderState {
    const code = String(payload?.code ?? '');
    const status = String(
      payload?.content?.transactions?.status ?? payload?.transactions?.status ?? '',
    ).toLowerCase();

    if (['000', '001'].includes(code) && status === 'delivered') return 'completed';
    if (
      (['000', '001'].includes(code) && ['failed', 'reversed'].includes(status)) ||
      code === '016' ||
      code === '091'
    ) {
      return 'failed';
    }
    // VTpass explicitly instructs integrators to requery every unrecognised,
    // pending, timeout or unclear response. Unknown is never treated as failure.
    return 'pending';
  }

  private variationList(payload: any): any[] {
    const list =
      payload?.content?.variations ??
      payload?.content?.data?.variations ??
      payload?.data?.variations ??
      payload?.content;
    return Array.isArray(list) ? list : [];
  }

  private async resolveFixedPrice(serviceID: string, variationCode: string, amount?: number) {
    const response = await this.vtpass.getServiceVariations(serviceID);
    const variation = this.variationList(response).find(
      (item) => String(item?.variation_code) === variationCode,
    );
    if (!variation) {
      throw new BadRequestException('The selected bill product is no longer available. Refresh the product list.');
    }

    const fixed = variation.fixedPrice === true || String(variation.fixedPrice).toLowerCase() === 'true';
    const catalogueAmount = Number(variation.variation_amount);
    if (!fixed || !Number.isFinite(catalogueAmount) || catalogueAmount <= 0) {
      throw new BadRequestException(
        'This product does not have a verified fixed catalogue price and is not enabled for wallet payment yet.',
      );
    }
    if (amount !== undefined && Math.abs(Number(amount) - catalogueAmount) > 0.001) {
      throw new BadRequestException('The bill amount does not match the current provider price. Refresh and try again.');
    }
    return {
      amount: Math.round(catalogueAmount * 100) / 100,
      productName: String(variation.name || variation.variation_name || variationCode),
    };
  }

  private requiresMerchantVerification(serviceID: string) {
    return /(electric|dstv|gotv|startimes)/i.test(serviceID);
  }

  private async verifyRequiredCustomer(dto: VtpassBillPurchaseDto) {
    if (!this.requiresMerchantVerification(dto.serviceID)) return;
    if (/electric/i.test(dto.serviceID) && !dto.customerType) {
      throw new BadRequestException('Select prepaid or postpaid before verifying this electricity meter.');
    }
    const verified = await this.vtpass.verifyCustomer({
      serviceID: dto.serviceID,
      billersCode: dto.billersCode.trim(),
      ...(dto.customerType ? { type: dto.customerType.trim() } : {}),
    });
    // VTpass documents 020 as BILLER CONFIRMED. No debit occurs unless this
    // explicit verification result is returned for services that require it.
    if (String(verified?.code) !== '020') {
      throw new BadRequestException(
        verified?.response_description || 'We could not verify this customer account. Check the details and try again.',
      );
    }
  }

  async purchase(userId: string, dto: VtpassBillPurchaseDto) {
    if (process.env.VTPASS_BILL_PAYMENTS_ENABLED !== 'true' || process.env.VTPASS_SANDBOX_VERIFIED !== 'true') {
      throw new ServiceUnavailableException(
        'VTpass bill purchases are not enabled yet. The sandbox catalogue and verification endpoints are available.',
      );
    }
    // Fail before reserving customer funds if POST credentials are absent.
    this.vtpass.assertPurchaseConfigured();

    const serviceID = dto.serviceID.trim();
    const variationCode = dto.variation_code.trim();
    const billersCode = dto.billersCode.trim();
    const idempotencyKey = `${userId}:${dto.idempotencyKey}`;
    const existing = await this.prisma.transaction.findFirst({
      where: { userId, idempotencyKey },
    });
    if (existing) {
      const maskedIdentifier = `••••${billersCode.slice(-4)}`;
      if (
        existing.providerServiceId !== serviceID ||
        existing.providerVariationCode !== variationCode ||
        existing.customerIdentifier !== maskedIdentifier ||
        (dto.amount !== undefined && Math.abs(Number(existing.amount) - Number(dto.amount)) > 0.001)
      ) {
        throw new BadRequestException('This idempotency key was already used for a different bill purchase.');
      }
      return this.receipt(existing);
    }

    const { amount, productName } = await this.resolveFixedPrice(serviceID, variationCode, dto.amount);
    await this.verifyRequiredCustomer(dto);
    const requestId = this.vtpass.createRequestId();
    let reserved: any;
    try {
      reserved = await this.prisma.$transaction(async (tx) => {
        const user = await tx.user.findUnique({
          where: { id: userId },
          include: { wallet: true },
        });
        if (!user) throw new NotFoundException('User not found.');
        if (user.isFrozen) {
          throw new ForbiddenException('Your account is currently restricted. Please contact support.');
        }
        if (!(await bcrypt.compare(dto.pin, user.pin))) {
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
            category: 'bill_payment',
            title: productName,
            subtitle: `Account ending ${billersCode.slice(-4)}`,
            amount,
            status: 'pending',
            reference: `VTP-${requestId}`,
            idempotencyKey,
            providerRequestId: requestId,
            providerStatus: 'initiated',
            providerServiceId: serviceID,
            providerVariationCode: variationCode,
            customerIdentifier: `••••${billersCode.slice(-4)}`,
          },
        });

        const walletAccount = await this.ledger.getOrCreateCustomerAccount(
          LedgerAccountType.CUSTOMER_WALLET,
          userId,
          tx,
        );
        const billerClearing = await this.ledger.getOrCreateSystemAccount(
          LedgerAccountType.SYSTEM_BILLER_CLEARING,
          tx,
        );
        await this.ledger.postJournal(
          tx,
          [
            { accountId: walletAccount.id, direction: LedgerDirection.DEBIT, amount },
            { accountId: billerClearing.id, direction: LedgerDirection.CREDIT, amount },
          ],
          { transactionId: transaction.id, memo: `VTpass reservation: ${serviceID}/${variationCode}` },
        );
        return { transaction, user };
      });
    } catch (error: any) {
      if (error?.code === 'P2002') {
        const replay = await this.prisma.transaction.findFirst({
          where: { userId, idempotencyKey },
        });
        if (replay) return this.receipt(replay);
      }
      throw error;
    }

    // Once a request ID has been reserved, never issue another /pay for it.
    // A timeout or network error is an unknown outcome and remains pending.
    let providerResponse: any;
    try {
      providerResponse = await this.vtpass.purchase({
        request_id: requestId,
        serviceID,
        billersCode,
        variation_code: variationCode,
        amount,
        phone: dto.phone || reserved.user.phone,
        ...(dto.customerType ? { type: dto.customerType } : {}),
      });
    } catch (error: any) {
      this.logger.warn(`VTpass purchase outcome uncertain for ${requestId}; transaction left pending for requery.`);
      const current = await this.prisma.transaction.findUnique({
        where: { id: reserved.transaction.id },
      });
      return { ...this.receipt(current), message: 'Payment is processing. Check the transaction status; do not submit a new purchase.' };
    }

    await this.applyProviderOutcome(reserved.transaction.id, providerResponse);
    const current = await this.prisma.transaction.findUnique({
      where: { id: reserved.transaction.id },
    });
    return this.receipt(current);
  }

  private receipt(transaction: any) {
    if (!transaction) return null;
    return {
      success: transaction.status === 'completed',
      transactionId: transaction.id,
      reference: transaction.reference,
      requestId: transaction.providerRequestId,
      status: transaction.status,
      providerStatus: transaction.providerStatus,
      amount: Number(transaction.amount),
      product: transaction.title,
      customer: transaction.customerIdentifier,
      providerTransactionId: transaction.providerTransactionId,
      purchasedCode: transaction.purchasedCode,
      createdAt: transaction.createdAt,
      message:
        transaction.status === 'pending'
          ? 'Payment is processing. We are checking the provider status.'
          : transaction.status === 'failed'
            ? 'The provider confirmed that this payment failed. Your wallet has been refunded.'
            : 'Payment completed successfully.',
    };
  }

  private async applyProviderOutcome(transactionId: string, payload: any) {
    const state = this.responseState(payload);
    const providerStatus = String(
      payload?.content?.transactions?.status ?? payload?.transactions?.status ?? payload?.code ?? 'unknown',
    ).slice(0, 64);
    const providerTransactionId = payload?.content?.transactions?.transactionId
      ? String(payload.content.transactions.transactionId).slice(0, 128)
      : null;
    const purchasedCode = payload?.purchased_code
      ? String(payload.purchased_code).slice(0, 512)
      : null;

    if (state === 'pending') {
      await this.prisma.transaction.updateMany({
        where: { id: transactionId, status: 'pending' },
        data: { providerStatus, providerLastCheckedAt: new Date() },
      });
      return;
    }
    if (state === 'completed') {
      await this.prisma.transaction.updateMany({
        where: { id: transactionId, status: 'pending' },
        data: {
          status: 'completed',
          providerStatus,
          providerTransactionId,
          purchasedCode,\n          providerLastCheckedAt: new Date(),
        },
      });
      return;
    }

    await this.prisma.$transaction(async (tx) => {
      const original = await tx.transaction.findUnique({ where: { id: transactionId } });
      if (!original || original.status !== 'pending') return;
      const claimed = await tx.transaction.updateMany({
        where: { id: transactionId, status: 'pending' },
        data: { status: 'failed', providerStatus, providerLastCheckedAt: new Date() },
      });
      if (claimed.count !== 1) return;

      const wallet = await tx.wallet.updateMany({
        where: { userId: original.userId },
        data: { balance: { increment: Number(original.amount) } },
      });
      if (wallet.count !== 1) throw new Error('Wallet missing during VTpass reversal.');

      const reversal = await tx.transaction.create({
        data: {
          userId: original.userId,
          type: 'credit',
          category: 'bill_reversal',
          title: 'Bill payment reversal',
          subtitle: original.reference,
          amount: original.amount,
          status: 'completed',
          reference: `VTP-REV-${original.providerRequestId}`,
          reversedTransactionId: original.id,
          reversalReason: `VTpass confirmed failure (${providerStatus})`,
        },
      });
      await this.ledger.reverseJournal(
        tx,
        original.id,
        reversal.id,
        `VTpass confirmed failure — reverse ${original.reference}`,
      );
    });
  }

  async getTransaction(userId: string, transactionId: string) {
    const transaction = await this.prisma.transaction.findFirst({
      where: { id: transactionId, userId, providerRequestId: { not: null } },
    });
    if (!transaction) throw new NotFoundException('Bill transaction not found.');
    return this.receipt(transaction);
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async reconcilePending() {
    const staleBefore = new Date(Date.now() - 30_000);
    const pending = await this.prisma.transaction.findMany({
      where: {
        category: 'bill_payment',
        status: 'pending',
        providerRequestId: { not: null },
        createdAt: { lt: staleBefore },
      },
      orderBy: { createdAt: 'asc' },
      take: 50,
    });
    for (const transaction of pending) {
      try {
        const response = await this.vtpass.requery(transaction.providerRequestId!);
        await this.applyProviderOutcome(transaction.id, response);
      } catch (error: any) {
        this.logger.warn(`VTpass requery failed for transaction ${transaction.id}; it remains pending.`);\n        await this.prisma.transaction.updateMany({ where: { id: transaction.id, status: 'pending' }, data: { providerStatus: 'requery_unavailable', providerLastCheckedAt: new Date() } });
      }
    }
  }
}

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
import { createHmac } from 'crypto';
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
      payload?.content?.varations ??
      payload?.content?.data?.variations ??
      payload?.data?.variations ??
      payload?.content;
    return Array.isArray(list) ? list : [];
  }

  private serviceList(payload: any): any[] {
    return Array.isArray(payload?.content) ? payload.content : [];
  }

  private async resolveProductPrice(
    identifier: string,
    serviceID: string,
    variationCode?: string,
    requestedAmount?: number,
  ) {
    const catalogue = await this.vtpass.getServices(identifier);
    const service = this.serviceList(catalogue).find(
      (item) => String(item?.serviceID) === serviceID,
    );
    if (!service) {
      throw new BadRequestException('The selected bill provider is not available in the current VTpass catalogue.');
    }

    const minimum = Number(service.minimium_amount ?? service.minimum_amount);
    const maximum = Number(service.maximum_amount);
    if (!Number.isFinite(minimum) || !Number.isFinite(maximum) || minimum <= 0 || maximum < minimum) {
      throw new BadRequestException('VTpass has not published safe amount limits for this product.');
    }

    const productType = String(service.product_type || '').toLowerCase();
    const variationCategories = ['data', 'tv', 'tv-subscription', 'internet', 'education', 'insurance'];
    if (!variationCode && (this.requiresMerchantVerification(serviceID) || variationCategories.includes(identifier.toLowerCase()) || productType === 'variation')) {
      throw new BadRequestException('Select a product variation before continuing.');
    }

    let variation: any = null;
    if (variationCode) {
      const response = await this.vtpass.getServiceVariations(serviceID);
      variation = this.variationList(response).find(
        (item) => String(item?.variation_code) === variationCode,
      );
      if (!variation) {
        throw new BadRequestException('The selected bill product is no longer available. Refresh the product list.');
      }
    }

    const fixed = variation
      ? variation.fixedPrice === true || ['yes', 'true'].includes(String(variation.fixedPrice).toLowerCase())
      : false;
    const catalogueAmount = variation ? Number(variation.variation_amount) : 0;
    let amount: number;

    if (fixed && Number.isFinite(catalogueAmount) && catalogueAmount > 0) {
      amount = Math.round(catalogueAmount * 100) / 100;
      if (requestedAmount !== undefined && Math.abs(Number(requestedAmount) - amount) > 0.001) {
        throw new BadRequestException('The bill amount does not match the current provider price. Refresh and try again.');
      }
    } else {
      if (requestedAmount === undefined || !Number.isFinite(Number(requestedAmount))) {
        throw new BadRequestException('Enter an amount for this flexible-price product.');
      }
      amount = Math.round(Number(requestedAmount) * 100) / 100;
      if (amount < minimum || amount > maximum) {
        throw new BadRequestException(
          `Enter an amount between ₦${minimum.toLocaleString('en-NG')} and ₦${maximum.toLocaleString('en-NG')}.`,
        );
      }
    }

    return {
      amount,
      productName: String(variation?.name || variation?.variation_name || service.name || serviceID),
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
    const variationCode = dto.variation_code?.trim() || '';
    const billersCode = dto.billersCode.trim();
    const idempotencyKey = `${userId}:${dto.idempotencyKey}`;
    const hmacSecret = process.env.JWT_SECRET;
    if (!hmacSecret) {
      throw new ServiceUnavailableException('Bill payment security configuration is incomplete.');
    }
    const customerIdentifierHash = createHmac('sha256', hmacSecret).update(billersCode).digest('hex');
    const existing = await this.prisma.transaction.findFirst({
      where: { userId, idempotencyKey },
    });
    if (existing) {
      const maskedIdentifier = `••••${billersCode.slice(-4)}`;
      if (
        existing.providerServiceId !== serviceID ||
        existing.providerVariationCode !== (variationCode || null) ||
        existing.customerIdentifier !== maskedIdentifier ||
        existing.customerIdentifierHash !== customerIdentifierHash ||
        Math.abs(Number(existing.amount) - Number(dto.amount)) > 0.001
      ) {
        throw new BadRequestException('This idempotency key was already used for a different bill purchase.');
      }
      return this.receipt(existing);
    }

    const { amount, productName } = await this.resolveProductPrice(dto.identifier, serviceID, variationCode || undefined, dto.amount);
    await this.verifyRequiredCustomer(dto);
    const requestId = this.vtpass.createRequestId();
    let reserved: any;
    try {
      reserved = await this.prisma.$transaction(async (tx) => {
        const user = await tx.user.findUnique({
          where: { id: userId },
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
            providerVariationCode: variationCode || null,
            customerIdentifier: `••••${billersCode.slice(-4)}`,
            customerIdentifierHash,
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
        ...(variationCode ? { variation_code: variationCode } : {}),
        amount,
        phone: dto.phone || reserved.user.phone,
        ...(dto.customerType ? { type: dto.customerType } : {}),
      });
    } catch {
      this.logger.warn(`VTpass purchase outcome uncertain for ${requestId}; transaction left pending for requery.`);
      await this.prisma.transaction.updateMany({ where: { id: reserved.transaction.id, status: 'pending' }, data: { providerStatus: 'purchase_response_unknown', providerLastCheckedAt: new Date() } });
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
    const purchasedCodeValue = payload?.purchased_code || payload?.token || payload?.mainToken || payload?.main_token;
    const purchasedCode = purchasedCodeValue ? String(purchasedCodeValue).slice(0, 512) : null;

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
          purchasedCode,
          providerLastCheckedAt: new Date(),
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

    // A customer opening a pending receipt can request a fresh status check.
    // Rate-limit this per transaction using the same checkpoint as the cron
    // worker; requery is read-only and never sends a second purchase.
    const shouldRequery =
      transaction.status === 'pending' &&
      (!transaction.providerLastCheckedAt ||
        transaction.providerLastCheckedAt.getTime() < Date.now() - 30_000);
    if (shouldRequery) {
      try {
        const response = await this.vtpass.requery(transaction.providerRequestId!);
        await this.applyProviderOutcome(transaction.id, response);
      } catch {
        await this.prisma.transaction.updateMany({
          where: { id: transaction.id, status: 'pending' },
          data: {
            providerStatus: 'requery_unavailable',
            providerLastCheckedAt: new Date(),
          },
        });
      }
    }
    const current = await this.prisma.transaction.findUnique({
      where: { id: transaction.id },
    });
    return this.receipt(current);
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
        OR: [
          { providerLastCheckedAt: null },
          { providerLastCheckedAt: { lt: staleBefore } },
        ],
      },
      orderBy: [\n        { providerLastCheckedAt: { sort: 'asc', nulls: 'first' } },\n        { createdAt: 'asc' },\n      ],
      take: 50,
    });
    for (const transaction of pending) {
      try {
        const response = await this.vtpass.requery(transaction.providerRequestId!);
        await this.applyProviderOutcome(transaction.id, response);
      } catch {
        this.logger.warn(`VTpass requery failed for transaction ${transaction.id}; it remains pending.`);
        await this.prisma.transaction.updateMany({ where: { id: transaction.id, status: 'pending' }, data: { providerStatus: 'requery_unavailable', providerLastCheckedAt: new Date() } });
      }
    }
  }
}

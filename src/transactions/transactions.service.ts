import { Injectable, BadRequestException, UnauthorizedException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MailerService } from '@nestjs-modules/mailer';
import { TransferDto } from './dto/transfer.dto';
import { FundDto } from './dto/fund.dto';
import { BillDto } from './dto/bill.dto';
import { AirtimeDto } from './dto/airtime.dto';
import { FraudService } from '../fraud/fraud.service';
import { NotificationsService } from '../notifications/notifications.service';
import { BeneficiariesService } from '../beneficiaries/beneficiaries.service';
import { LedgerService } from '../ledger/ledger.service';
import { LedgerAccountType, LedgerDirection } from '@prisma/client';
import { AnalyticsService, ANALYTICS_EVENTS } from '../analytics/analytics.service';
import { formatNaira } from '../common/format-currency.util';
import * as bcrypt from 'bcryptjs';

@Injectable()
export class TransactionsService {
  // Reward points → naira conversion for bill/airtime purchases. Kept as a
  // single constant here rather than DB-configurable for now — it's a
  // conservative, low-stakes rate (a maximally engaged daily-check-in user
  // earns on the order of a few hundred naira of redeemable value per
  // year), not a funded cash-payout program like referrals or a business
  // commission scheme would be. Mirrored on the mobile client for display;
  // this constant is what actually governs the money.
  static readonly POINTS_PER_NAIRA = 10;

  constructor(
    private prisma: PrismaService,
    private mailerService: MailerService,
    private fraudService: FraudService,
    private notifications: NotificationsService,
    private beneficiariesService: BeneficiariesService,
    private ledgerService: LedgerService,
    private analyticsService: AnalyticsService,
  ) {}

  // Shared by payBill and buyAirtime. Validates a redemption request
  // against both the user's real point balance and the purchase amount,
  // and returns how much of the purchase should actually be charged to
  // the wallet. Throws rather than silently clamping — a client asking to
  // redeem more than it should is either a bug or stale UI state, and
  // either way deserves a clear error, not quietly-wrong behavior.
  private resolvePointsRedemption(user: { rewardPoints: number }, amount: number, pointsToRedeem?: number) {
    const points = pointsToRedeem || 0;
    if (points === 0) return { walletCharge: amount, pointsToRedeem: 0 };

    if (points % TransactionsService.POINTS_PER_NAIRA !== 0) {
      throw new BadRequestException(`pointsToRedeem must be a multiple of ${TransactionsService.POINTS_PER_NAIRA}.`);
    }
    if (points > user.rewardPoints) {
      throw new BadRequestException('You do not have enough reward points.');
    }

    const pointsValueInNaira = points / TransactionsService.POINTS_PER_NAIRA;
    if (pointsValueInNaira > amount) {
      throw new BadRequestException('Cannot redeem more points than the purchase is worth.');
    }

    return { walletCharge: amount - pointsValueInNaira, pointsToRedeem: points };
  }

  // Runs the automated fraud/velocity rules against a just-created
  // transaction, after the DB transaction that created it has committed.
  // This is intentionally called outside of any `$transaction(...)` block:
  // the fraud engine's own queries read committed data on the main
  // connection pool, and its work (several extra SELECTs, possibly an
  // email) must never hold open the interactive transaction that just
  // moved a customer's money. It never throws back into the caller —
  // FraudService.evaluateTransaction already catches its own errors — so a
  // fraud-engine problem can never turn into a failed transfer/bill/airtime
  // purchase for the customer.
  private async runFraudCheck(record: { id: string; userId: string; type: string; category: string; amount: any; recipientAccount?: string | null; createdAt: Date }) {
    await this.fraudService.evaluateTransaction({
      id: record.id,
      userId: record.userId,
      type: record.type,
      category: record.category,
      amount: Number(record.amount),
      recipientAccount: record.recipientAccount,
      createdAt: record.createdAt,
    });
  }

  // Idempotency check: if the caller already sent this exact key before
  // (a network retry, or the mobile app's offline-sync queue replaying a
  // queued request), return the transaction that request already created
  // instead of processing the money movement a second time. Belongs to
  // the SAME user only — one user's key can never short-circuit into
  // returning a different user's transaction.
  private async findExistingByIdempotencyKey(userId: string, idempotencyKey?: string) {
    if (!idempotencyKey) return null;
    return this.prisma.transaction.findFirst({ where: { userId, idempotencyKey } });
  }

  // The unique constraint on idempotencyKey is the real safety net for the
  // race where two requests with the same key arrive concurrently and both
  // pass the pre-check above before either has committed. Whichever loses
  // the race gets a Prisma P2002 unique-violation on create — caught here
  // and turned into "return what the winner created" instead of a 500.
  private async recoverFromDuplicateIdempotencyKey(userId: string, idempotencyKey: string) {
    const existing = await this.prisma.transaction.findFirst({ where: { userId, idempotencyKey } });
    if (existing) return existing;
    throw new BadRequestException('Duplicate request could not be reconciled. Please try again.');
  }

  async transferFunds(userId: string, transferDto: TransferDto) {
    const { recipientAccount, amount, pin, bank, note, recipientName, idempotencyKey } = transferDto;

    const existing = await this.findExistingByIdempotencyKey(userId, idempotencyKey);
    if (existing) return { success: true, transactionId: existing.id, replayed: true };

    let result;
    try {
      result = await this.prisma.$transaction(async (tx) => {
      const sender = await tx.user.findUnique({ where: { id: userId }, include: { wallet: true } });
      if (!sender) throw new NotFoundException('Sender account not found.');
      if (sender.isFrozen) throw new ForbiddenException('Your account is currently restricted. Please contact support.');

      const isPinValid = await bcrypt.compare(pin, sender.pin);
      if (!isPinValid) throw new UnauthorizedException('Incorrect PIN.');

      if (sender.accountNumber === recipientAccount || sender.phone === recipientAccount || sender.businessAccountNumber === recipientAccount) {
        throw new BadRequestException('Cannot transfer to yourself.');
      }
      if (Number(sender.wallet.balance) < amount) throw new BadRequestException('Insufficient funds.');

      // The recipient identifier can be their personal ZannyPay account
      // number, their registered phone number, or (new) their ZannyPay
      // Business account number if they've activated one — all three
      // resolve to the same underlying user and wallet.
      const recipient = await tx.user.findFirst({
        where: { OR: [{ accountNumber: recipientAccount }, { phone: recipientAccount }, { businessAccountNumber: recipientAccount }] },
        include: { wallet: true },
      });

      if (recipient) {
        // --- INTERNAL TRANSFER ---
        await tx.wallet.update({ where: { userId: sender.id }, data: { balance: { decrement: amount } } });
        await tx.wallet.update({ where: { userId: recipient.id }, data: { balance: { increment: amount } } });

        const senderTx = await tx.transaction.create({
          data: { userId: sender.id, type: 'debit', category: 'transfer', title: `Transfer to ${recipient.name}`, subtitle: note || recipientAccount, amount, status: 'completed', reference: `TXN-${Date.now()}-D`, recipientAccount, idempotencyKey },
        });

        await tx.transaction.create({
          data: {
            userId: recipient.id, type: 'credit', category: 'transfer', title: `Transfer from ${sender.name}`,
            subtitle: note || sender.accountNumber, amount, status: 'completed', reference: `TXN-${Date.now()}-C`,
            recipientAccount: sender.accountNumber,
            receivedVia: recipient.businessAccountNumber && recipient.businessAccountNumber === recipientAccount ? 'business' : 'personal',
          },
        });

        // Double-entry: sender's wallet account is debited, recipient's
        // wallet account is credited, both real customer accounts — the
        // simplest possible journal shape, and linked to senderTx (the
        // transaction a reversal would actually target) rather than the
        // recipient's separate credit-side Transaction row.
        const senderWalletAccount = await this.ledgerService.getOrCreateCustomerAccount(LedgerAccountType.CUSTOMER_WALLET, sender.id, tx);
        const recipientWalletAccount = await this.ledgerService.getOrCreateCustomerAccount(LedgerAccountType.CUSTOMER_WALLET, recipient.id, tx);
        await this.ledgerService.postJournal(
          tx,
          [
            { accountId: senderWalletAccount.id, direction: LedgerDirection.DEBIT, amount },
            { accountId: recipientWalletAccount.id, direction: LedgerDirection.CREDIT, amount },
          ],
          { transactionId: senderTx.id, memo: `Internal transfer to ${recipient.name}` },
        );

        this.mailerService.sendMail({
          to: sender.email,
          subject: 'Debit Alert: ZannyPay Transfer 💸',
          html: `<div style="font-family:sans-serif; padding: 20px;"><h2>Transfer Successful</h2><p>You sent <strong>NGN ${amount}</strong> to ${recipient.name} (${recipientAccount}).</p><p>Note: ${note || 'None'}</p><p>Reference: ${senderTx.reference}</p></div>`,
        }).catch(console.error);
        
        this.mailerService.sendMail({
          to: recipient.email,
          subject: 'Credit Alert: ZannyPay Transfer 🎉',
          html: `<div style="font-family:sans-serif; padding: 20px;"><h2>Funds Received!</h2><p>You received <strong>NGN ${amount}</strong> from ${sender.name}.</p><p>Note: ${note || 'None'}</p></div>`,
        }).catch(console.error);
        
        return { success: true, transactionId: senderTx.id, senderTx, isInternal: true, recipientId: recipient.id, recipientName: recipient.name, senderName: sender.name };

      } else {
        // --- EXTERNAL TRANSFER ---
        await tx.wallet.update({ where: { userId: sender.id }, data: { balance: { decrement: amount } } });
        
        const senderTx = await tx.transaction.create({
          data: { userId: sender.id, type: 'debit', category: 'transfer', title: `Transfer to ${recipientName || recipientAccount}`, subtitle: bank || 'External Bank', amount, bank, status: 'completed', reference: `TXN-${Date.now()}-EXT`, recipientAccount, idempotencyKey },
        });

        // The other side of this journal is a system clearing account,
        // not a second customer — the actual payout to the external bank
        // happens through a real payment rail this codebase doesn't
        // integrate with yet (see the mock-integration notes elsewhere in
        // this file); this clearing account is where that integration
        // would settle against once it exists.
        const senderWalletAccountExt = await this.ledgerService.getOrCreateCustomerAccount(LedgerAccountType.CUSTOMER_WALLET, sender.id, tx);
        const externalClearingAccount = await this.ledgerService.getOrCreateSystemAccount(LedgerAccountType.SYSTEM_EXTERNAL_PAYOUT_CLEARING, tx);
        await this.ledgerService.postJournal(
          tx,
          [
            { accountId: senderWalletAccountExt.id, direction: LedgerDirection.DEBIT, amount },
            { accountId: externalClearingAccount.id, direction: LedgerDirection.CREDIT, amount },
          ],
          { transactionId: senderTx.id, memo: `External transfer to ${recipientAccount}` },
        );

        this.mailerService.sendMail({
          to: sender.email,
          subject: 'Debit Alert: External Transfer 💸',
          html: `<div style="font-family:sans-serif; padding: 20px;"><h2>Transfer Processing</h2><p>You sent <strong>NGN ${amount}</strong> to account ${recipientAccount} at ${bank || 'an external bank'}.</p><p>Reference: ${senderTx.reference}</p></div>`,
        }).catch(console.error);
        
        return { success: true, transactionId: senderTx.id, senderTx, isInternal: false, recipientName: recipientName || recipientAccount };
      }
      });
    } catch (error) {
      if (error.code === 'P2002' && idempotencyKey) {
        const recovered = await this.recoverFromDuplicateIdempotencyKey(userId, idempotencyKey);
        return { success: true, transactionId: recovered.id, replayed: true };
      }
      throw error;
    }

    // Fraud/velocity rules run against the sender's debit leg, after the
    // transfer has committed — see runFraudCheck() above for why this sits
    // outside the $transaction block.
    await this.runFraudCheck(result.senderTx);

    // Same principle as runFraudCheck: notifications/push and the
    // beneficiary "last paid" bookkeeping are both best-effort side
    // effects that must never hold open, or roll back, the transaction
    // that already committed — so they run out here too, after the fact,
    // each wrapped so a failure in one never blocks the other or the
    // response back to the client.
    await this.notifications.create(
      userId,
      'transfer_sent',
      'Money sent',
      `You sent ${formatNaira(amount)} to ${result.recipientName}.`,
      { transactionId: result.transactionId, amount },
    );
    if (result.isInternal && result.recipientId) {
      await this.notifications.create(
        result.recipientId,
        'transfer_received',
        'Money received',
        `You received ${formatNaira(amount)} from ${result.senderName}.`,
        { transactionId: result.transactionId, amount },
      );
    }
    await this.beneficiariesService.recordPaymentIfSaved(userId, recipientAccount);

    await this.analyticsService.track(ANALYTICS_EVENTS.TRANSFER_COMPLETED, {
      userId,
      properties: { amount, isInternal: result.isInternal },
    });

    return { success: true, transactionId: result.transactionId };
  }

  async fundWallet(userId: string, fundDto: FundDto) {
    const { amount } = fundDto;
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found.');
    if (user.isFrozen) throw new ForbiddenException('Your account is currently restricted. Please contact support.');

    const reference = `FND-${Date.now()}`;
    try {
      const paystackResponse = await fetch('https://api.paystack.co/transaction/initialize', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: user.email,
          amount: Math.round(amount * 100),
          reference,
          callback_url: `${process.env.BACKEND_URL || 'http://localhost:4000'}/wallet/payment-success`,
        }),
      });

      const resData = await paystackResponse.json();
      if (!paystackResponse.ok || !resData.status) throw new BadRequestException(resData.message);

      const txn = await this.prisma.transaction.create({
        data: { userId, type: 'credit', category: 'funding', title: 'Wallet Top-up', subtitle: 'Paystack Checkout', amount, status: 'pending', reference },
      });

      return { success: true, transactionId: txn.id, authorizationUrl: resData.data.authorization_url, reference };
    } catch (error) {
      throw new BadRequestException(error.message || 'Payment gateway unavailable.');
    }
  }

  async payBill(userId: string, billDto: BillDto) {
    const { billerName, category, amount, reference, pin, idempotencyKey, pointsToRedeem } = billDto as any;

    const existing = await this.findExistingByIdempotencyKey(userId, idempotencyKey);
    if (existing) return { success: true, transactionId: existing.id, replayed: true };

    let result;
    try {
      result = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: userId }, include: { wallet: true } });
      if (!user) throw new NotFoundException('User not found.');
      if (user.isFrozen) throw new ForbiddenException('Your account is currently restricted. Please contact support.');
      
      const isPinValid = await bcrypt.compare(pin, user.pin);
      if (!isPinValid) throw new UnauthorizedException('Incorrect PIN.');

      const { walletCharge, pointsToRedeem: redeemed } = this.resolvePointsRedemption(user, amount, pointsToRedeem);
      if (Number(user.wallet.balance) < walletCharge) throw new BadRequestException('Insufficient funds.');

      await tx.wallet.update({ where: { userId: user.id }, data: { balance: { decrement: walletCharge } } });
      if (redeemed > 0) {
        await tx.user.update({ where: { id: user.id }, data: { rewardPoints: { decrement: redeemed } } });
      }

      const txn = await tx.transaction.create({
        data: { userId: user.id, type: 'debit', category: category || 'Bill Payment', title: billerName, subtitle: reference ? `Ref: ${reference}` : 'Bill Payment', amount, status: 'completed', reference: `BILL-${Date.now()}`, idempotencyKey, pointsRedeemed: redeemed }
      });

      // Ledger amount is walletCharge, not the full bill amount — any
      // portion covered by redeemed reward points never actually moved
      // through the wallet (rewardPoints is a separate loyalty balance on
      // User, not part of this money ledger), so only the real cash
      // movement gets a journal. A bill paid entirely by points has
      // walletCharge === 0 and posts nothing — postJournal rejects a
      // zero-amount line on purpose, and a journal with no real money
      // movement isn't one.
      if (walletCharge > 0) {
        const walletAccountBill = await this.ledgerService.getOrCreateCustomerAccount(LedgerAccountType.CUSTOMER_WALLET, user.id, tx);
        const billerClearingAccount = await this.ledgerService.getOrCreateSystemAccount(LedgerAccountType.SYSTEM_BILLER_CLEARING, tx);
        await this.ledgerService.postJournal(
          tx,
          [
            { accountId: walletAccountBill.id, direction: LedgerDirection.DEBIT, amount: walletCharge },
            { accountId: billerClearingAccount.id, direction: LedgerDirection.CREDIT, amount: walletCharge },
          ],
          { transactionId: txn.id, memo: `Bill payment: ${billerName}` },
        );
      }

      this.mailerService.sendMail({
        to: user.email,
        subject: `Bill Payment Receipt: ${billerName} 🧾`,
        html: `<div style="font-family:sans-serif; padding: 20px;"><h2>Payment Successful</h2><p>You paid <strong>NGN ${amount}</strong> for ${billerName}.</p><p>Reference: ${txn.reference}</p></div>`,
      }).catch(console.error);

      return { success: true, transactionId: txn.id, txn };
      });
    } catch (error) {
      if (error.code === 'P2002' && idempotencyKey) {
        const recovered = await this.recoverFromDuplicateIdempotencyKey(userId, idempotencyKey);
        return { success: true, transactionId: recovered.id, replayed: true };
      }
      throw error;
    }

    await this.runFraudCheck(result.txn);
    await this.notifications.create(
      userId,
      'bill_paid',
      'Bill payment successful',
      `You paid ${formatNaira(amount)} for ${billerName}.`,
      { transactionId: result.transactionId, amount },
    );
    await this.analyticsService.track(ANALYTICS_EVENTS.BILL_PAYMENT_COMPLETED, { userId, properties: { amount, category } });
    return { success: true, transactionId: result.transactionId };
  }

  async buyAirtime(userId: string, airtimeDto: AirtimeDto) {
    const { phone, amount, provider, pin, type, idempotencyKey, pointsToRedeem } = airtimeDto;
    const isData = type === 'data';

    const existing = await this.findExistingByIdempotencyKey(userId, idempotencyKey);
    if (existing) return { success: true, transactionId: existing.id, replayed: true };

    let result;
    try {
      result = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: userId }, include: { wallet: true } });
      if (!user) throw new NotFoundException('User not found.');
      if (user.isFrozen) throw new ForbiddenException('Your account is currently restricted. Please contact support.');

      // This was previously missing — every other money-movement endpoint
      // (transfer, bills) verifies the transaction PIN before debiting the
      // wallet, but airtime purchases did not.
      const isPinValid = await bcrypt.compare(pin, user.pin);
      if (!isPinValid) throw new UnauthorizedException('Incorrect PIN.');

      const { walletCharge, pointsToRedeem: redeemed } = this.resolvePointsRedemption(user, amount, pointsToRedeem);
      if (Number(user.wallet.balance) < walletCharge) throw new BadRequestException('Insufficient funds.');

      // 1. Deduct user balance
      await tx.wallet.update({ where: { userId: user.id }, data: { balance: { decrement: walletCharge } } });
      if (redeemed > 0) {
        await tx.user.update({ where: { id: user.id }, data: { rewardPoints: { decrement: redeemed } } });
      }

      // 2. TODO: Call VTPass / Reloadly API here. 
      // If the API call fails, throw an error to trigger a rollback of the deduction!
      
      // 3. Record transaction — `type` from the DTO was previously read but
      // never used, so every purchase (data or airtime) was mislabeled as
      // "Airtime" in the receipt/history. Now it reflects what was bought.
      const txn = await tx.transaction.create({
        data: { userId: user.id, type: 'debit', category: isData ? 'data' : 'airtime', title: `${provider.toUpperCase()} ${isData ? 'Data' : 'Airtime'}`, subtitle: phone, amount, status: 'completed', reference: `AIR-${Date.now()}`, idempotencyKey, pointsRedeemed: redeemed }
      });

      // Same walletCharge-not-amount reasoning as payBill above.
      if (walletCharge > 0) {
        const walletAccountAirtime = await this.ledgerService.getOrCreateCustomerAccount(LedgerAccountType.CUSTOMER_WALLET, user.id, tx);
        const billerClearingAccountAirtime = await this.ledgerService.getOrCreateSystemAccount(LedgerAccountType.SYSTEM_BILLER_CLEARING, tx);
        await this.ledgerService.postJournal(
          tx,
          [
            { accountId: walletAccountAirtime.id, direction: LedgerDirection.DEBIT, amount: walletCharge },
            { accountId: billerClearingAccountAirtime.id, direction: LedgerDirection.CREDIT, amount: walletCharge },
          ],
          { transactionId: txn.id, memo: `${provider.toUpperCase()} ${isData ? 'data' : 'airtime'} purchase` },
        );
      }

      return { success: true, transactionId: txn.id, txn };
      });
    } catch (error) {
      if (error.code === 'P2002' && idempotencyKey) {
        const recovered = await this.recoverFromDuplicateIdempotencyKey(userId, idempotencyKey);
        return { success: true, transactionId: recovered.id, replayed: true };
      }
      throw error;
    }

    await this.runFraudCheck(result.txn);
    await this.notifications.create(
      userId,
      'airtime_purchased',
      isData ? 'Data purchase successful' : 'Airtime purchase successful',
      `You bought ${formatNaira(amount)} of ${provider.toUpperCase()} ${isData ? 'data' : 'airtime'} for ${phone}.`,
      { transactionId: result.transactionId, amount },
    );
    await this.analyticsService.track(ANALYTICS_EVENTS.AIRTIME_PURCHASE_COMPLETED, { userId, properties: { amount, provider, isData } });
    return { success: true, transactionId: result.transactionId };
  }
  // whichever one fires first completes the transaction; the other is a
  // no-op thanks to the status check, so a payment is never credited twice.
  private async completeFundingTransaction(reference: string) {
    const result = await this.prisma.$transaction(async (tx) => {
      const transaction = await tx.transaction.findUnique({ where: { reference }, include: { user: true } });

      if (!transaction) return { success: false, status: 'not_found' as const };
      if (transaction.status === 'completed') return { success: true, status: 'completed' as const, alreadyProcessed: true };

      await tx.transaction.update({ where: { reference }, data: { status: 'completed' } });
      await tx.wallet.update({ where: { userId: transaction.userId }, data: { balance: { increment: transaction.amount } } });

      // Debit the Paystack clearing account (funds ZannyPay is holding
      // pending settlement to its own bank account — that settlement leg
      // is outside this ledger's scope), credit the customer's wallet.
      const walletAccount = await this.ledgerService.getOrCreateCustomerAccount(LedgerAccountType.CUSTOMER_WALLET, transaction.userId, tx);
      const paystackClearingAccount = await this.ledgerService.getOrCreateSystemAccount(LedgerAccountType.SYSTEM_PAYSTACK_CLEARING, tx);
      await this.ledgerService.postJournal(
        tx,
        [
          { accountId: paystackClearingAccount.id, direction: LedgerDirection.DEBIT, amount: Number(transaction.amount) },
          { accountId: walletAccount.id, direction: LedgerDirection.CREDIT, amount: Number(transaction.amount) },
        ],
        { transactionId: transaction.id, memo: 'Paystack wallet top-up' },
      );

      this.mailerService.sendMail({
        to: transaction.user.email,
        subject: 'Wallet Funded Successfully 🚀',
        html: `<div style="font-family:sans-serif; padding: 20px;"><h2>Wallet Top-Up Successful</h2><p>Your wallet was credited with <strong>NGN ${transaction.amount}</strong> via Paystack.</p><p>Reference: ${reference}</p></div>`,
      }).catch(console.error);

      return { success: true, status: 'completed' as const, transaction };
    });

    // Only run the fraud engine on the actual credit event, not on a
    // replayed webhook/verify call for a top-up that was already completed
    // (the webhook and the manual verify-on-return-from-checkout path can
    // both fire for the same payment; only the first one is a real event).
    if (result.success && !result.alreadyProcessed && 'transaction' in result && result.transaction) {
      await this.runFraudCheck(result.transaction);
      await this.analyticsService.track(ANALYTICS_EVENTS.WALLET_FUNDED, {
        userId: result.transaction.userId,
        properties: { amount: Number(result.transaction.amount) },
      });
    }

    return { success: result.success, status: result.status, alreadyProcessed: (result as any).alreadyProcessed };
  }

  async handlePaystackWebhook(reference: string) {
    const result = await this.completeFundingTransaction(reference);
    return { handled: true, ...result };
  }

  // Called by the frontend right after the Paystack checkout browser
  // session returns. Asks Paystack directly whether the payment actually
  // succeeded, and if so, completes it immediately rather than waiting on
  // a webhook that may be delayed or never arrive at all (very common in
  // local/dev environments without a public HTTPS callback URL registered).
  async verifyFunding(userId: string, reference: string) {
    const localTxn = await this.prisma.transaction.findFirst({ where: { reference, userId } });
    if (!localTxn) throw new NotFoundException('Transaction not found.');

    if (localTxn.status === 'completed') {
      return { success: true, status: 'completed' };
    }

    try {
      const verifyResponse = await fetch(`https://api.paystack.co/transaction/verify/${reference}`, {
        headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` },
      });
      const verifyData = await verifyResponse.json();

      if (verifyResponse.ok && verifyData.status && verifyData.data?.status === 'success') {
        const result = await this.completeFundingTransaction(reference);
        return { success: true, status: result.status };
      }

      // Paystack hasn't confirmed success yet (still processing, or the
      // user actually abandoned/failed the checkout) — report the real
      // state back rather than pretending it worked.
      return { success: false, status: verifyData.data?.status || 'pending' };
    } catch (error) {
      return { success: false, status: 'pending', error: 'Could not reach Paystack to confirm this payment yet.' };
    }
  }
}

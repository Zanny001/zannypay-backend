import { Injectable, BadRequestException, UnauthorizedException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TransferDto } from './dto/transfer.dto';
import { FundDto } from './dto/fund.dto';
import { BillDto } from './dto/bill.dto';
import * as bcrypt from 'bcrypt';

@Injectable()
export class TransactionsService {
  constructor(private prisma: PrismaService) {}

  async transferFunds(userId: string, transferDto: TransferDto) {
    const { recipientAccount, amount, pin } = transferDto;
    return await this.prisma.$transaction(async (tx) => {
      const sender = await tx.user.findUnique({ where: { id: userId }, include: { wallet: true } });
      if (!sender) throw new NotFoundException('Sender account not found.');

      const isPinValid = await bcrypt.compare(pin, sender.pin);
      if (!isPinValid) throw new UnauthorizedException('Incorrect PIN.');

      if (sender.accountNumber === recipientAccount) throw new BadRequestException('Cannot transfer to yourself.');

      const recipient = await tx.user.findUnique({ where: { accountNumber: recipientAccount }, include: { wallet: true } });
      if (!recipient) throw new NotFoundException('Recipient not found.');

      if (Number(sender.wallet.balance) < amount) throw new BadRequestException('Insufficient funds.');

      await tx.wallet.update({ where: { userId: sender.id }, data: { balance: { decrement: amount } } });
      await tx.wallet.update({ where: { userId: recipient.id }, data: { balance: { increment: amount } } });

      const senderTx = await tx.transaction.create({
        data: { userId: sender.id, type: 'debit', category: 'transfer', title: `Transfer to ${recipient.name}`, subtitle: recipientAccount, amount, status: 'completed', reference: `TXN-${Date.now()}-D` },
      });

      await tx.transaction.create({
        data: { userId: recipient.id, type: 'credit', category: 'transfer', title: `Transfer from ${sender.name}`, subtitle: sender.accountNumber, amount, status: 'completed', reference: `TXN-${Date.now()}-C` },
      });

      return { success: true, transactionId: senderTx.id };
    });
  }

  async fundWallet(userId: string, fundDto: FundDto) {
    const { amount } = fundDto;
    
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found.');

    const reference = `FND-${Date.now()}`;

    try {
      // Paystack accepts amount in Kobo/Cents (Multiply by 100)
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
          callback_url: 'zannypay://payment-complete', // Deep link back to mobile app
        }),
      });

      const resData = await paystackResponse.json();
      if (!paystackResponse.ok || !resData.status) {
        throw new BadRequestException(resData.message || 'Paystack initialization failed');
      }

      // Log the transaction as 'pending' in the database
      const txn = await this.prisma.transaction.create({
        data: {
          userId,
          type: 'credit',
          category: 'funding',
          title: 'Wallet Top-up',
          subtitle: 'Paystack Card Checkout',
          amount,
          status: 'pending',
          reference,
        },
      });

      return {
        success: true,
        transactionId: txn.id,
        authorizationUrl: resData.data.authorization_url,
        reference,
      };
    } catch (error) {
      throw new BadRequestException(error.message || 'Unable to process payment gateway right now.');
    }
  }

  async payBill(userId: string, billDto: BillDto) {
    const { billerName, category, amount, reference, pin } = billDto;
    return await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: userId }, include: { wallet: true } });
      if (!user) throw new NotFoundException('User not found.');

      const isPinValid = await bcrypt.compare(pin, user.pin);
      if (!isPinValid) throw new UnauthorizedException('Incorrect PIN.');

      if (Number(user.wallet.balance) < amount) throw new BadRequestException('Insufficient funds.');

      await tx.wallet.update({ where: { userId }, data: { balance: { decrement: amount } } });

      const txn = await tx.transaction.create({
        data: { userId, type: 'debit', category, title: billerName, subtitle: reference || 'Bill Payment', amount, status: 'completed', reference: `BIL-${Date.now()}` },
      });

      return { success: true, transactionId: txn.id };
    });
  }

  // Webhook handler to settle money securely when Paystack signals success
  async handlePaystackWebhook(reference: string) {
    return await this.prisma.$transaction(async (tx) => {
      const transaction = await tx.transaction.findUnique({ where: { reference } });
      
      // If transaction doesn't exist or is already finalized, skip to protect ledger integrity
      if (!transaction || transaction.status === 'completed') {
        return { handled: true };
      }

      // 1. Move the transaction status out of pending into completed
      await tx.transaction.update({
        where: { reference },
        data: { status: 'completed' },
      });

      // 2. Fund the customer's actual wallet balance
      await tx.wallet.update({
        where: { userId: transaction.userId },
        data: { balance: { increment: transaction.amount } },
      });

      return { success: true };
    });
  }
}

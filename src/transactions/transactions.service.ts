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
    return await this.prisma.$transaction(async (tx) => {
      await tx.wallet.update({ where: { userId }, data: { balance: { increment: amount } } });

      const txn = await tx.transaction.create({
        data: { userId, type: 'credit', category: 'funding', title: 'Wallet Top-up', subtitle: 'Card/Bank Funding', amount, status: 'completed', reference: `FND-${Date.now()}` },
      });

      return { success: true, transactionId: txn.id };
    });
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
}

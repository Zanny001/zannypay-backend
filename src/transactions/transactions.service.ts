import { Injectable, BadRequestException, UnauthorizedException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TransferDto } from './dto/transfer.dto';
import * as bcrypt from 'bcrypt';

@Injectable()
export class TransactionsService {
  constructor(private prisma: PrismaService) {}

  async transferFunds(userId: string, transferDto: TransferDto) {
    const { recipientAccount, amount, pin } = transferDto;

    // Prisma $transaction ensures that if ANY step fails, ALL steps are rolled back instantly.
    return await this.prisma.$transaction(async (tx) => {
      
      // 1. Identify Sender and Verify PIN
      const sender = await tx.user.findUnique({ where: { id: userId }, include: { wallet: true } });
      if (!sender) throw new NotFoundException('Sender account not found.');

      const isPinValid = await bcrypt.compare(pin, sender.pin);
      if (!isPinValid) throw new UnauthorizedException('Incorrect PIN. Transfer denied.');

      if (sender.accountNumber === recipientAccount) {
        throw new BadRequestException('You cannot transfer money to yourself.');
      }

      // 2. Identify Recipient
      const recipient = await tx.user.findUnique({ where: { accountNumber: recipientAccount }, include: { wallet: true } });
      if (!recipient) throw new NotFoundException('Recipient account not found.');

      // 3. Verify Sufficient Funds
      if (Number(sender.wallet.balance) < amount) {
        throw new BadRequestException('Insufficient funds.');
      }

      // 4. Deduct Funds from Sender
      await tx.wallet.update({
        where: { userId: sender.id },
        data: { balance: { decrement: amount } },
      });

      // 5. Add Funds to Recipient
      await tx.wallet.update({
        where: { userId: recipient.id },
        data: { balance: { increment: amount } },
      });

      // 6. Generate Immutable Receipt for Sender (Debit)
      const senderTx = await tx.transaction.create({
        data: {
          userId: sender.id,
          type: 'debit',
          category: 'transfer',
          title: `Transfer to ${recipient.name}`,
          subtitle: recipientAccount,
          amount: amount,
          status: 'completed',
          reference: `TXN-${Date.now()}-D`,
        },
      });

      // 7. Generate Immutable Receipt for Recipient (Credit)
      await tx.transaction.create({
        data: {
          userId: recipient.id,
          type: 'credit',
          category: 'transfer',
          title: `Transfer from ${sender.name}`,
          subtitle: sender.accountNumber,
          amount: amount,
          status: 'completed',
          reference: `TXN-${Date.now()}-C`,
        },
      });

      return { 
        success: true, 
        message: 'Transfer successful', 
        transactionId: senderTx.id 
      };
    });
  }
}

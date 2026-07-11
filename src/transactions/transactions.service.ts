import { Injectable, BadRequestException, UnauthorizedException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MailerService } from '@nestjs-modules/mailer';
import { TransferDto } from './dto/transfer.dto';
import { FundDto } from './dto/fund.dto';
import { BillDto } from './dto/bill.dto';
import { AirtimeDto } from './dto/airtime.dto';
import * as bcrypt from 'bcrypt';

@Injectable()
export class TransactionsService {
  constructor(
    private prisma: PrismaService,
    private mailerService: MailerService
  ) {}

  async transferFunds(userId: string, transferDto: TransferDto) {
    const { recipientAccount, amount, pin, bank, note, recipientName } = transferDto;
    
    return await this.prisma.$transaction(async (tx) => {
      const sender = await tx.user.findUnique({ where: { id: userId }, include: { wallet: true } });
      if (!sender) throw new NotFoundException('Sender account not found.');

      const isPinValid = await bcrypt.compare(pin, sender.pin);
      if (!isPinValid) throw new UnauthorizedException('Incorrect PIN.');

      if (sender.accountNumber === recipientAccount) throw new BadRequestException('Cannot transfer to yourself.');
      if (Number(sender.wallet.balance) < amount) throw new BadRequestException('Insufficient funds.');

      const recipient = await tx.user.findUnique({ where: { accountNumber: recipientAccount }, include: { wallet: true } });

      if (recipient) {
        // --- INTERNAL TRANSFER ---
        await tx.wallet.update({ where: { userId: sender.id }, data: { balance: { decrement: amount } } });
        await tx.wallet.update({ where: { userId: recipient.id }, data: { balance: { increment: amount } } });

        const senderTx = await tx.transaction.create({
          data: { userId: sender.id, type: 'debit', category: 'transfer', title: `Transfer to ${recipient.name}`, subtitle: note || recipientAccount, amount, status: 'completed', reference: `TXN-${Date.now()}-D` },
        });

        await tx.transaction.create({
          data: { userId: recipient.id, type: 'credit', category: 'transfer', title: `Transfer from ${sender.name}`, subtitle: note || sender.accountNumber, amount, status: 'completed', reference: `TXN-${Date.now()}-C` },
        });

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
        
        return { success: true, transactionId: senderTx.id };

      } else {
        // --- EXTERNAL TRANSFER ---
        await tx.wallet.update({ where: { userId: sender.id }, data: { balance: { decrement: amount } } });
        
        const senderTx = await tx.transaction.create({
          data: { userId: sender.id, type: 'debit', category: 'transfer', title: `Transfer to ${recipientName || recipientAccount}`, subtitle: bank || 'External Bank', amount, bank, status: 'completed', reference: `TXN-${Date.now()}-EXT` },
        });

        this.mailerService.sendMail({
          to: sender.email,
          subject: 'Debit Alert: External Transfer 💸',
          html: `<div style="font-family:sans-serif; padding: 20px;"><h2>Transfer Processing</h2><p>You sent <strong>NGN ${amount}</strong> to account ${recipientAccount} at ${bank || 'an external bank'}.</p><p>Reference: ${senderTx.reference}</p></div>`,
        }).catch(console.error);
        
        return { success: true, transactionId: senderTx.id };
      }
    });
  }

  async fundWallet(userId: string, fundDto: FundDto) {
    const { amount } = fundDto;
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found.');

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
          callback_url: 'zannypay://payment-complete',
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
    const { billerName, category, amount, reference, pin } = billDto as any;
    return await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: userId }, include: { wallet: true } });
      if (!user) throw new NotFoundException('User not found.');
      
      const isPinValid = await bcrypt.compare(pin, user.pin);
      if (!isPinValid) throw new UnauthorizedException('Incorrect PIN.');
      
      if (Number(user.wallet.balance) < amount) throw new BadRequestException('Insufficient funds.');

      await tx.wallet.update({ where: { userId: user.id }, data: { balance: { decrement: amount } } });

      const txn = await tx.transaction.create({
        data: { userId: user.id, type: 'debit', category: category || 'Bill Payment', title: billerName, subtitle: reference ? `Ref: ${reference}` : 'Bill Payment', amount, status: 'completed', reference: `BILL-${Date.now()}` }
      });

      this.mailerService.sendMail({
        to: user.email,
        subject: `Bill Payment Receipt: ${billerName} 🧾`,
        html: `<div style="font-family:sans-serif; padding: 20px;"><h2>Payment Successful</h2><p>You paid <strong>NGN ${amount}</strong> for ${billerName}.</p><p>Reference: ${txn.reference}</p></div>`,
      }).catch(console.error);

      return { success: true, transactionId: txn.id };
    });
  }

  async buyAirtime(userId: string, airtimeDto: AirtimeDto) {
    const { phone, amount, provider } = airtimeDto;
    
    return await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: userId }, include: { wallet: true } });
      if (!user) throw new NotFoundException('User not found.');

      if (Number(user.wallet.balance) < amount) throw new BadRequestException('Insufficient funds.');

      // 1. Deduct user balance
      await tx.wallet.update({ where: { userId: user.id }, data: { balance: { decrement: amount } } });

      // 2. TODO: Call VTPass / Reloadly API here. 
      // If the API call fails, throw an error to trigger a rollback of the deduction!
      
      // 3. Record transaction
      const txn = await tx.transaction.create({
        data: { userId: user.id, type: 'debit', category: 'airtime', title: `${provider.toUpperCase()} Airtime`, subtitle: phone, amount, status: 'completed', reference: `AIR-${Date.now()}` }
      });

      return { success: true, transactionId: txn.id };
    });
  }

  async handlePaystackWebhook(reference: string) {
    return await this.prisma.$transaction(async (tx) => {
      const transaction = await tx.transaction.findUnique({ where: { reference }, include: { user: true } });

      if (!transaction || transaction.status === 'completed') return { handled: true };

      await tx.transaction.update({ where: { reference }, data: { status: 'completed' } });
      await tx.wallet.update({ where: { userId: transaction.userId }, data: { balance: { increment: transaction.amount } } });

      this.mailerService.sendMail({
        to: transaction.user.email,
        subject: 'Wallet Funded Successfully 🚀',
        html: `<div style="font-family:sans-serif; padding: 20px;"><h2>Wallet Top-Up Successful</h2><p>Your wallet was credited with <strong>NGN ${transaction.amount}</strong> via Paystack.</p><p>Reference: ${reference}</p></div>`,
      }).catch(console.error);

      return { success: true };
    });
  }
}

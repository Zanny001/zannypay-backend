import { Controller, Post, Body, Req, UseGuards, HttpCode, HttpStatus } from '@nestjs/common';
import { TransactionsService } from './transactions.service';
import { TransferDto } from './dto/transfer.dto';
import { FundDto } from './dto/fund.dto';
import { BillDto } from './dto/bill.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@Controller('transactions')
export class TransactionsController {
  constructor(private readonly transactionsService: TransactionsService) {}

  @UseGuards(JwtAuthGuard)
  @Post('transfer')
  async transferFunds(@Req() req, @Body() transferDto: TransferDto) {
    const userId = req.user.sub || req.user.userId;
    return this.transactionsService.transferFunds(userId, transferDto);
  }

  @UseGuards(JwtAuthGuard)
  @Post('fund')
  async fundWallet(@Req() req, @Body() fundDto: FundDto) {
    const userId = req.user.sub || req.user.userId;
    return this.transactionsService.fundWallet(userId, fundDto);
  }

  @UseGuards(JwtAuthGuard)
  @Post('bills')
  async payBill(@Req() req, @Body() billDto: BillDto) {
    const userId = req.user.sub || req.user.userId;
    return this.transactionsService.payBill(userId, billDto);
  }

  // PUBLIC ROUTE: No JWT Guard here so Paystack can access it!
  @Post('paystack/webhook')
  @HttpCode(HttpStatus.OK) // Paystack requires an immediate 200 OK response
  async handlePaystackWebhook(@Body() body: any) {
    // Only process successful charges
    if (body.event === 'charge.success' && body.data) {
      const reference = body.data.reference;
      return this.transactionsService.handlePaystackWebhook(reference);
    }
    
    // If it's a different event type, just acknowledge receipt
    return { handled: true };
  }
}

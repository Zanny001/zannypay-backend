import { Controller, Get, Post, Body, Param, Req, UseGuards, HttpCode, HttpStatus } from '@nestjs/common';
import { TransactionsService } from './transactions.service';
import { TransferDto } from './dto/transfer.dto';
import { FundDto } from './dto/fund.dto';
import { BillDto } from './dto/bill.dto';
import { AirtimeDto } from './dto/airtime.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

// Changed from 'transactions' to 'wallet' to match frontend WalletContext
@Controller('wallet')
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

  // Changed from 'bills' to 'billpay' to match frontend
  @UseGuards(JwtAuthGuard)
  @Post('billpay')
  async payBill(@Req() req, @Body() billDto: BillDto) {
    const userId = req.user.sub || req.user.userId;
    return this.transactionsService.payBill(userId, billDto);
  }

  // NEW: Airtime endpoint
  @UseGuards(JwtAuthGuard)
  @Post('airtime')
  async buyAirtime(@Req() req, @Body() airtimeDto: AirtimeDto) {
    const userId = req.user.sub || req.user.userId;
    return this.transactionsService.buyAirtime(userId, airtimeDto);
  }

  // Fallback confirmation path — Paystack webhooks can be slow, unconfigured
  // in dev/sandbox, or simply never reach an unpublished/local backend. The
  // frontend calls this right after the checkout browser session returns so
  // funding doesn't get stuck "Pending" waiting on a webhook that may never
  // arrive.
  @UseGuards(JwtAuthGuard)
  @Get('verify/:reference')
  async verifyFunding(@Req() req, @Param('reference') reference: string) {
    const userId = req.user.sub || req.user.userId;
    return this.transactionsService.verifyFunding(userId, reference);
  }

  // PUBLIC ROUTE: Paystack Webhook
  @Post('paystack/webhook')
  @HttpCode(HttpStatus.OK)
  async handlePaystackWebhook(@Body() body: any) {
    if (body.event === 'charge.success' && body.data) {
      const reference = body.data.reference;
      return this.transactionsService.handlePaystackWebhook(reference);
    }
    return { handled: true };
  }
}

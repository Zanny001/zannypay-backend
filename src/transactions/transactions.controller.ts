import { Controller, Get, Post, Body, Param, Req, UseGuards } from '@nestjs/common';
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
  @Post('transfer')                                                             async transferFunds(@Req() req, @Body() transferDto: TransferDto) {
    const userId = req.user.sub || req.user.userId;                               return this.transactionsService.transferFunds(userId, transferDto);
  }
                                                                                @UseGuards(JwtAuthGuard)
  @Post('fund')
  async fundWallet(@Req() req, @Body() fundDto: FundDto) {                        const userId = req.user.sub || req.user.userId;
    return this.transactionsService.fundWallet(userId, fundDto);                }
                                                                                // Changed from 'bills' to 'billpay' to match frontend
  @UseGuards(JwtAuthGuard)                                                      @Post('billpay')
  async payBill(@Req() req, @Body() billDto: BillDto) {                           const userId = req.user.sub || req.user.userId;
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

  // NOTE: The actual Paystack webhook lives at POST /paystack/webhook
  // (see paystack-webhook.controller.ts), which verifies the HMAC              // signature on every request. A second, unsigned webhook route used to
  // exist here at /wallet/paystack/webhook — it accepted a bare
  // {event: 'charge.success', data: {reference}} from anyone, with no auth
  // and no signature check, meaning any caller could mark any pending          // transaction "completed" and get their wallet credited without ever
  // paying. It's been removed. If your Paystack Dashboard webhook URL was
  // pointed at /wallet/paystack/webhook, update it to /paystack/webhook.
}

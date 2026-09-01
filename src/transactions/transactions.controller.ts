
import { Controller, Get, Post, Body, Param, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
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

  // Serves the HTML success screen inside the mobile in-app browser/WebView
  // instructing the user to click the top-left "X" button to return to the app.
  @Get('payment-success')
  showPaymentSuccess(@Res() res: Response) {
    const html = `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Payment Successful</title>
      </head>
      <body style="display:flex; flex-direction:column; align-items:center; justify-content:center; height:100vh; font-family:sans-serif; text-align:center; background-color:#f4f4f9; padding:20px; margin:0;">
        <div style="background:white; padding:40px 20px; border-radius:12px; box-shadow:0 4px 15px rgba(0,0,0,0.05); max-width:400px; width:100%;">
          <div style="font-size:50px; margin-bottom:10px;">✅</div>
          <h1 style="color:#2e7d32; margin-bottom:10px; font-size:24px;">Payment Successful!</h1>
          <p style="font-size:15px; color:#555; margin-bottom:30px; line-height:1.4;">Your transaction has been processed and your wallet is being credited.</p>
          
          <div style="padding:15px; background-color:#e8f4fd; border-left:5px solid #1976d2; border-radius:6px;">
            <p style="font-size:15px; font-weight:bold; color:#1976d2; margin:0; line-height:1.4;">
              Please tap the "X" button at the top left to close this page and return to your app dashboard.
            </p>
          </div>
        </div>
      </body>
      </html>
    `;
    return res.status(200).send(html);
  }

  // NOTE: The actual Paystack webhook lives at POST /paystack/webhook
  // (see paystack-webhook.controller.ts), which verifies the HMAC
  // signature on every request. A second, unsigned webhook route used to
  // exist here at /wallet/paystack/webhook — it accepted a bare
  // {event: 'charge.success', data: {reference}} from anyone, with no auth
  // and no signature check, meaning any caller could mark any pending
  // transaction "completed" and get their wallet credited without ever
  // paying. It's been removed. If your Paystack Dashboard webhook URL was
  // pointed at /wallet/paystack/webhook, update it to /paystack/webhook.
}


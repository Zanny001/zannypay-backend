import { Controller, Post, Body, Req, Res, BadRequestException } from '@nestjs/common';
import { TransactionsService } from './transactions.service';
import * as crypto from 'crypto';

@Controller('paystack')
export class PaystackWebhookController {
  constructor(private readonly transactionsService: TransactionsService) {}

  @Post('webhook')
  async handleWebhook(@Req() req, @Body() body: any, @Res() res) {
    const signature = req.headers['x-paystack-signature'];
    
    // Crypto validation: ensures the payload came genuinely from Paystack
    const hash = crypto
      .createHmac('sha512', process.env.PAYSTACK_SECRET_KEY || '')
      .update(JSON.stringify(body))
      .digest('hex');

    if (hash !== signature) {
      throw new BadRequestException('Invalid transaction signature signature token.');
    }

    // Process only successful events
    if (body.event === 'charge.success') {
      const { reference } = body.data;
      await this.transactionsService.handlePaystackWebhook(reference);
    }

    // Always respond with a 200 OK to tell Paystack you processed the packet successfully
    return res.status(200).send('Event Acknowledged');
  }
}

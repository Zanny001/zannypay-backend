import {
  Controller,
  Post,
  Body,
  Req,
  Res,
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { TransactionsService } from './transactions.service';
import { verifyPaystackSignature } from './paystack-signature';

@Controller('paystack')
export class PaystackWebhookController {
  constructor(private readonly transactionsService: TransactionsService) {}

  @Post('webhook')
  async handleWebhook(@Req() req, @Body() body: any, @Res() res) {
    const secret = process.env.PAYSTACK_SECRET_KEY;
    if (!secret) {
      throw new ServiceUnavailableException(
        'Paystack webhook verification is not configured.',
      );
    }

    // Verify the original bytes Paystack signed. Re-serializing parsed JSON
    // can change whitespace/escaping and is not a valid signature input.
    const rawBody: unknown = req.rawBody;
    if (!Buffer.isBuffer(rawBody)) {
      throw new BadRequestException('Raw webhook payload is unavailable.');
    }

    const signature = req.headers['x-paystack-signature'];
    if (!verifyPaystackSignature(rawBody, signature, secret)) {
      throw new BadRequestException('Invalid Paystack webhook signature.');
    }

    // Process only successful events. The transaction handler must remain
    // idempotent because payment providers retry webhook delivery.
    if (body.event === 'charge.success') {
      const reference = body.data?.reference;
      if (typeof reference !== 'string' || reference.length === 0) {
        throw new BadRequestException('Paystack charge reference is missing.');
      }
      const amount = body.data?.amount;\n      const currency = body.data?.currency;\n      if (!Number.isSafeInteger(amount) || amount <= 0 || currency !== 'NGN') {\n        throw new BadRequestException('Paystack charge amount or currency is invalid.');\n      }\n      await this.transactionsService.handlePaystackWebhook(reference, { amount, currency });
    }

    return res.status(200).send('Event Acknowledged');
  }
}

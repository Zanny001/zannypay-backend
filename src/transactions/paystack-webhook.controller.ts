import {
  BadRequestException,
  Controller,
  Post,
  Req,
  Res,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { TransactionsService } from './transactions.service';
import { verifyPaystackSignature } from './paystack-signature';

@Controller('paystack')
export class PaystackWebhookController {
  constructor(private readonly transactionsService: TransactionsService) {}

  @Post('webhook')
  async handleWebhook(@Req() req, @Res() res) {
    const secret = process.env.PAYSTACK_SECRET_KEY;
    if (!secret) {
      throw new ServiceUnavailableException(
        'Paystack webhook verification is not configured.',
      );
    }

    const rawBody: unknown = req.rawBody;
    if (!Buffer.isBuffer(rawBody)) {
      throw new BadRequestException('Raw webhook payload is unavailable.');
    }

    const signature = req.headers['x-paystack-signature'];
    if (!verifyPaystackSignature(rawBody, signature, secret)) {
      throw new BadRequestException('Invalid Paystack webhook signature.');
    }

    const body = req.body;
    if (body?.event === 'charge.success') {
      const reference = body.data?.reference;
      const amount = body.data?.amount;
      const currency = body.data?.currency;
      if (typeof reference !== 'string' || reference.length === 0) {
        throw new BadRequestException('Paystack charge reference is missing.');
      }
      if (!Number.isSafeInteger(amount) || amount <= 0 || currency !== 'NGN') {
        throw new BadRequestException('Paystack charge amount or currency is invalid.');
      }

      const result = await this.transactionsService.handlePaystackWebhook(
        reference,
        { amount, currency },
      );
      if (!result.success) {
        throw new UnprocessableEntityException(
          `Paystack funding event was not applied: ${result.status}.`,
        );
      }
    }

    return res.status(200).send('Event Acknowledged');
  }
}

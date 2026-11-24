import {
  BadRequestException,
  UnauthorizedException,
  Controller,
  Post,
  Req,
  Res,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { TransactionsService } from './transactions.service';
import { verifyPaystackSignature, verifyPaystackSigningSecret } from './paystack-signature';

@Controller('paystack')
export class PaystackWebhookController {
  constructor(private readonly transactionsService: TransactionsService) {}

  @Post('webhook')
  async handleWebhook(@Req() req, @Res() res) {
    const rawBody: unknown = req.rawBody;
    if (!Buffer.isBuffer(rawBody)) {
      throw new BadRequestException('Raw webhook payload is unavailable.');
    }

    const signingHeader = req.headers['paystack-signature'];
    if (signingHeader !== undefined) {
      const signingSecret = process.env.PAYSTACK_WEBHOOK_SECRET;
      if (!signingSecret) {
        throw new ServiceUnavailableException(
          'Paystack webhook signing secret is not configured. Add PAYSTACK_WEBHOOK_SECRET from the Paystack dashboard.',
        );
      }
      if (!verifyPaystackSigningSecret(rawBody, signingHeader, signingSecret)) {
        throw new UnauthorizedException('Invalid Paystack webhook signature.');
      }
    } else {
      // Backward compatibility only while Paystack still sends the legacy
      // header. Do not remove PAYSTACK_SECRET_KEY until the new header is
      // observed and verified in both test and live environments.
      const secret = process.env.PAYSTACK_SECRET_KEY;
      if (!secret) {
        throw new ServiceUnavailableException(
          'Paystack webhook verification is not configured.',
        );
      }
      const legacySignature = req.headers['x-paystack-signature'];
      if (!verifyPaystackSignature(rawBody, legacySignature, secret)) {
        throw new UnauthorizedException('Invalid Paystack webhook signature.');
      }
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

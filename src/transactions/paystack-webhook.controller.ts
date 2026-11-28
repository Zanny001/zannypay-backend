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
import { PaystackTransfersService } from './paystack-transfers.service';
import {
  verifyPaystackSignature,
  verifyPaystackSigningSecret,
} from './paystack-signature';

@Controller('paystack')
export class PaystackWebhookController {
  constructor(
    private readonly transactionsService: TransactionsService,
    private readonly paystackTransfers: PaystackTransfersService,
  ) {}

  @Post('webhook')
  async handleWebhook(@Req() req, @Res() res) {
    const rawBody: unknown = req.rawBody;
    if (!Buffer.isBuffer(rawBody)) {
      throw new BadRequestException('Raw webhook payload is unavailable.');
    }

    const signingHeader = req.headers['paystack-signature'];
    const signingSecret = process.env.PAYSTACK_WEBHOOK_SECRET;
    if (signingHeader !== undefined && signingSecret) {
      if (!verifyPaystackSigningSecret(rawBody, signingHeader, signingSecret)) {
        throw new UnauthorizedException('Invalid Paystack webhook signature.');
      }
    } else {
      // Until the whsec_ secret is configured (or before Paystack has enabled
      // the new header for this environment), retain legacy verification.
      // Paystack sends both headers while the API secret remains active.
      const secret = process.env.PAYSTACK_SECRET_KEY;
      if (!secret) {
        throw new ServiceUnavailableException(
          signingHeader !== undefined
            ? 'Configure PAYSTACK_WEBHOOK_SECRET to verify Paystack-Signature.'
            : 'Paystack webhook verification is not configured.',
        );
      }
      const legacySignature = req.headers['x-paystack-signature'];
      if (!verifyPaystackSignature(rawBody, legacySignature, secret)) {
        throw new UnauthorizedException('Invalid Paystack webhook signature.');
      }
    }

    const body = req.body;
    if (typeof body?.event === 'string' && body.event.startsWith('transfer.')) {
      const transferData = body.data || {};
      if (
        typeof transferData.reference !== 'string' ||
        !transferData.reference ||
        !Number.isSafeInteger(transferData.amount) ||
        transferData.amount <= 0 ||
        transferData.currency !== 'NGN'
      ) {
        throw new BadRequestException(
          'Paystack transfer reference, amount or currency is invalid.',
        );
      }
      const result = await this.paystackTransfers.handleWebhook(
        body.event,
        transferData,
      );
      if (!result.success && result.status !== 'not_found') {
        throw new UnprocessableEntityException(
          `Paystack transfer event was not applied: ${result.status}.`,
        );
      }
    }
    if (body?.event === 'charge.success') {
      const reference = body.data?.reference;
      const amount = body.data?.amount;
      const currency = body.data?.currency;
      if (typeof reference !== 'string' || reference.length === 0) {
        throw new BadRequestException('Paystack charge reference is missing.');
      }
      if (!Number.isSafeInteger(amount) || amount <= 0 || currency !== 'NGN') {
        throw new BadRequestException(
          'Paystack charge amount or currency is invalid.',
        );
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

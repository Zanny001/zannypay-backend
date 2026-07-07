import { Module } from '@nestjs/common';
import { TransactionsController } from './transactions.controller';
import { PaystackWebhookController } from './paystack-webhook.controller';
import { TransactionsService } from './transactions.service';

@Module({
  controllers: [TransactionsController, PaystackWebhookController],
  providers: [TransactionsService]
})
export class TransactionsModule {}

import { Module } from '@nestjs/common';
import { TransactionsController } from './transactions.controller';
import { PaystackWebhookController } from './paystack-webhook.controller';
import { TransactionsService } from './transactions.service';
import { FraudModule } from '../fraud/fraud.module';
import { BeneficiariesModule } from '../beneficiaries/beneficiaries.module';

@Module({
  imports: [FraudModule, BeneficiariesModule],
  controllers: [TransactionsController, PaystackWebhookController],
  providers: [TransactionsService],
})
export class TransactionsModule {}

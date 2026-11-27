import { Module } from '@nestjs/common';
import { TransactionsController } from './transactions.controller';
import { PaystackWebhookController } from './paystack-webhook.controller';
import { TransactionsService } from './transactions.service';
import { FraudModule } from '../fraud/fraud.module';
import { BeneficiariesModule } from '../beneficiaries/beneficiaries.module';
import { VtpassClient } from './vtpass.client';
import { VtpassPaymentsService } from './vtpass-payments.service';
import { PaystackTransfersService } from './paystack-transfers.service';

@Module({
  imports: [FraudModule, BeneficiariesModule],
  controllers: [TransactionsController, PaystackWebhookController],
  providers: [TransactionsService, VtpassClient, VtpassPaymentsService, PaystackTransfersService],
})
export class TransactionsModule {}

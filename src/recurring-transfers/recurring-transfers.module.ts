import { Module } from '@nestjs/common';
import { RecurringTransfersController } from './recurring-transfers.controller';
import { RecurringTransfersService } from './recurring-transfers.service';
import { FraudModule } from '../fraud/fraud.module';

// Pre-existing gap, not something introduced by the world-class upgrade
// pass: RecurringTransfersService has always taken FraudService as a
// constructor dependency (its @Cron job runs each due transfer through
// fraud/velocity rules before executing it — see the service), but this
// module never imported FraudModule to make FraudService available,
// so Nest couldn't resolve it at boot.
@Module({
  imports: [FraudModule],
  controllers: [RecurringTransfersController],
  providers: [RecurringTransfersService],
})
export class RecurringTransfersModule {}

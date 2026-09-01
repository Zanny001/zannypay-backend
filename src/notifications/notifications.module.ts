import { Global, Module } from '@nestjs/common';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';

// @Global, same pattern as AuditLogModule — needed by AdminModule (KYC/
// dispute/freeze actions), FraudModule (fraud alerts on the customer's own
// account), and SupportModule (chat replies). Import once in AppModule;
// every other module can then inject NotificationsService directly.
@Global()
@Module({
  controllers: [NotificationsController],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}

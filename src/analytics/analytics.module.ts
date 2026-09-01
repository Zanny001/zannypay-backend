import { Global, Module } from '@nestjs/common';
import { AnalyticsController, AdminAnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';
import { AdminSecurityModule } from '../admin-security/admin-security.module';

// @Global — auth, admin, transactions, savings, cards, loans, and support
// all fire analytics events; importing it once here avoids repeating
// that import in every one of those modules.
@Global()
@Module({
  imports: [AdminSecurityModule], // for AdminIpAllowlistGuard on AdminAnalyticsController
  controllers: [AnalyticsController, AdminAnalyticsController],
  providers: [AnalyticsService],
  exports: [AnalyticsService],
})
export class AnalyticsModule {}

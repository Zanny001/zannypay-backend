import { Module } from '@nestjs/common';
import { FraudController } from './fraud.controller';
import { FraudService } from './fraud.service';
import { AdminSecurityModule } from '../admin-security/admin-security.module';
import { AdminAuthModule } from '../admin-auth/admin-auth.module';

@Module({
  imports: [AdminSecurityModule, AdminAuthModule], // AdminIpAllowlistGuard and Require2faGuard respectively
  controllers: [FraudController],
  providers: [FraudService],
  exports: [FraudService], // TransactionsModule imports this to call evaluateTransaction()
})
export class FraudModule {}

import { Module } from '@nestjs/common';
import { SavingsService } from './savings.service';
import { SavingsController } from './savings.controller';

@Module({
  providers: [SavingsService],
  controllers: [SavingsController],
  exports: [SavingsService], // UserModule needs this for getUserDashboard's savingsApy/lastInterestEarned fields
})
export class SavingsModule {}

import { Module } from '@nestjs/common';
import { SavingsService } from './savings.service';
import { SavingsController } from './savings.controller';

@Module({
  providers: [SavingsService],
  controllers: [SavingsController]
})
export class SavingsModule {}

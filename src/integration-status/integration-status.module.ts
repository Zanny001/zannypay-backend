import { Module } from '@nestjs/common';
import { IntegrationStatusController } from './integration-status.controller';
import { IntegrationStatusService } from './integration-status.service';

@Module({
  controllers: [IntegrationStatusController],
  providers: [IntegrationStatusService],
})
export class IntegrationStatusModule {}

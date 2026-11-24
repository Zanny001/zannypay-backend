import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { IntegrationStatusService } from './integration-status.service';

@UseGuards(JwtAuthGuard)
@Controller('system/integrations')
export class IntegrationStatusController {
  constructor(private readonly integrationStatus: IntegrationStatusService) {}

  @Get('status')
  getStatus() {
    return this.integrationStatus.getStatus();
  }
}

import { Module } from '@nestjs/common';
import { ComplianceExportController } from './compliance-export.controller';
import { ComplianceExportService } from './compliance-export.service';
import { AdminSecurityModule } from '../admin-security/admin-security.module';

@Module({
  imports: [AdminSecurityModule], // for AdminIpAllowlistGuard
  controllers: [ComplianceExportController],
  providers: [ComplianceExportService],
})
export class ComplianceExportModule {}

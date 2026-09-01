import { Controller, Get, Param, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { AdminJwtAuthGuard } from '../admin-auth/admin-jwt-auth.guard';
import { RolesGuard } from '../admin-auth/roles.guard';
import { Roles } from '../admin-auth/roles.decorator';
import { AdminIpAllowlistGuard } from '../admin-security/admin-ip-allowlist.guard';
import { ComplianceExportService } from './compliance-export.service';

@Controller('admin/compliance-export')
@UseGuards(AdminIpAllowlistGuard, AdminJwtAuthGuard, RolesGuard)
@Roles('SUPER_ADMIN', 'COMPLIANCE_OFFICER')
export class ComplianceExportController {
  constructor(private readonly complianceExportService: ComplianceExportService) {}

  @Get('users/:id/kyc-record.pdf')
  async kycRecord(@Param('id') id: string, @Res() res: Response) {
    const buffer = await this.complianceExportService.generateKycDecisionPdf(id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="zannypay-kyc-record-${id}.pdf"`);
    res.send(buffer);
  }
}

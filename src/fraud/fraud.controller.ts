import { Controller, Get, Patch, Body, Param, Query, Req, UseGuards } from '@nestjs/common';
import { FraudService } from './fraud.service';
import { AdminIpAllowlistGuard } from '../admin-security/admin-ip-allowlist.guard';
import { AdminJwtAuthGuard } from '../admin-auth/admin-jwt-auth.guard';
import { RolesGuard } from '../admin-auth/roles.guard';
import { Require2faGuard } from '../admin-auth/require-2fa.guard';
import { Roles } from '../admin-auth/roles.decorator';
import { ReviewFraudAlertDto } from './dto/review-fraud-alert.dto';
import { UpdateFraudRuleDto } from './dto/update-fraud-rule.dto';

@Controller('admin/fraud')
@UseGuards(AdminIpAllowlistGuard, AdminJwtAuthGuard, RolesGuard, Require2faGuard)
export class FraudController {
  constructor(private readonly fraudService: FraudService) {}

  @Roles('SUPER_ADMIN', 'COMPLIANCE_OFFICER', 'FINANCE_OFFICER')
  @Get('alerts')
  async listAlerts(
    @Query('status') status?: string,
    @Query('severity') severity?: string,
    @Query('userId') userId?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.fraudService.listAlerts({
      status,
      severity,
      userId,
      page: page ? Number(page) : 1,
      pageSize: pageSize ? Number(pageSize) : 50,
    });
  }

  @Roles('SUPER_ADMIN', 'COMPLIANCE_OFFICER', 'FINANCE_OFFICER')
  @Patch('alerts/:id')
  async reviewAlert(@Req() req, @Param('id') id: string, @Body() dto: ReviewFraudAlertDto) {
    return this.fraudService.reviewAlert(req.user.adminId, id, dto.decision, dto.note, dto.unfreezeIfDismissed, req.ip);
  }

  @Roles('SUPER_ADMIN', 'COMPLIANCE_OFFICER')
  @Get('rules')
  async listRules() {
    return this.fraudService.listRules();
  }

  // Only SUPER_ADMIN can change what actually triggers automated action
  // (including auto-freezing real customer accounts) — COMPLIANCE_OFFICER
  // can view and tune the review queue above, but not the rule definitions.
  @Roles('SUPER_ADMIN')
  @Patch('rules/:id')
  async updateRule(@Req() req, @Param('id') id: string, @Body() dto: UpdateFraudRuleDto) {
    return this.fraudService.updateRule(req.user.adminId, id, dto, req.ip);
  }
}

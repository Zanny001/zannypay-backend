import { Controller, Get, Post, Delete, Body, Param, Req, UseGuards } from '@nestjs/common';
import { IpAllowlistService } from './ip-allowlist.service';
import { AdminIpAllowlistGuard } from './admin-ip-allowlist.guard';
import { AdminJwtAuthGuard } from '../admin-auth/admin-jwt-auth.guard';
import { RolesGuard } from '../admin-auth/roles.guard';
import { Require2faGuard } from '../admin-auth/require-2fa.guard';
import { Roles } from '../admin-auth/roles.decorator';
import { CreateIpAllowlistEntryDto } from './dto/create-ip-allowlist-entry.dto';

// SUPER_ADMIN only — this list controls who can reach the rest of the
// admin API, so managing it is itself one of the most sensitive actions
// in the system. Require2faGuard added here for the same reason it's on
// AdminController/FraudController: SUPER_ADMIN is in ROLES_REQUIRING_2FA,
// so this was already an enforcement gap identical in shape to the
// COMPLIANCE_OFFICER one the master audit caught elsewhere.
@Controller('admin/security/ip-allowlist')
@UseGuards(AdminIpAllowlistGuard, AdminJwtAuthGuard, RolesGuard, Require2faGuard)
@Roles('SUPER_ADMIN')
export class IpAllowlistController {
  constructor(private readonly ipAllowlistService: IpAllowlistService) {}

  @Get()
  async list() {
    return this.ipAllowlistService.list();
  }

  @Post()
  async create(@Req() req, @Body() dto: CreateIpAllowlistEntryDto) {
    return this.ipAllowlistService.create(req.user.adminId, dto.cidr, dto.label, req.ip);
  }

  @Delete(':id')
  async remove(@Req() req, @Param('id') id: string) {
    return this.ipAllowlistService.remove(req.user.adminId, id, req.ip);
  }
}

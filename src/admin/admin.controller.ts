import { Controller, Get, Post, Patch, Body, Param, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { AdminService } from './admin.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AdminJwtAuthGuard } from '../admin-auth/admin-jwt-auth.guard';
import { RolesGuard } from '../admin-auth/roles.guard';
import { AdminIpAllowlistGuard } from '../admin-security/admin-ip-allowlist.guard';
import { Require2faGuard } from '../admin-auth/require-2fa.guard';
import { StepUpGuard } from '../admin-auth/step-up.guard';
import { Roles } from '../admin-auth/roles.decorator';
import { CreateAdminDto } from './dto/create-admin.dto';
import { FreezeUserDto } from './dto/freeze-user.dto';
import { KycDecisionDto } from './dto/kyc-decision.dto';
import { UpdateDisputeDto } from './dto/update-dispute.dto';
import { ReverseTransactionDto } from './dto/reverse-transaction.dto';
import { toCsv } from '../common/csv.util';

@Controller('admin')
@UseGuards(AdminIpAllowlistGuard, AdminJwtAuthGuard, RolesGuard, Require2faGuard) // network gate first (cheapest check), then session, then role, then the 2FA-for-privileged-roles policy
export class AdminController {
  constructor(
    private readonly adminService: AdminService,
    private readonly auditLogService: AuditLogService,
  ) {}

  // ---------- Admin account management (SUPER_ADMIN only) ----------
  @Roles('SUPER_ADMIN')
  @Get('admins')
  async listAdmins() {
    return this.adminService.listAdmins();
  }

  @Roles('SUPER_ADMIN')
  @Post('admins')
  async createAdmin(@Req() req, @Body() dto: CreateAdminDto) {
    return this.adminService.createAdmin(req.user.adminId, dto, req.ip);
  }

  @Roles('SUPER_ADMIN')
  @Patch('admins/:id/deactivate')
  @UseGuards(StepUpGuard) // deactivating another admin's access is exactly the kind of action a hijacked session shouldn't be able to do unchallenged
  async deactivateAdmin(@Req() req, @Param('id') id: string) {
    return this.adminService.deactivateAdmin(req.user.adminId, id, req.ip);
  }

  // ---------- Platform users (any admin can search/view; only
  // COMPLIANCE_OFFICER/SUPER_ADMIN can freeze) ----------
  @Get('users')
  async searchUsers(@Query('q') query: string, @Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    return this.adminService.searchUsers(query, Number(page) || 1, Number(pageSize) || 25);
  }

  @Get('users/:id')
  async getUserDetail(@Param('id') id: string) {
    return this.adminService.getUserDetail(id);
  }

  @Roles('SUPER_ADMIN', 'COMPLIANCE_OFFICER')
  @Patch('users/:id/freeze')
  @UseGuards(StepUpGuard) // master audit, Section 8 — freezing (or unfreezing) an account is exactly the "stolen session shouldn't be enough on its own" case
  async setUserFrozen(@Req() req, @Param('id') id: string, @Body() dto: FreezeUserDto) {
    return this.adminService.setUserFrozen(req.user.adminId, id, dto.isFrozen, dto.reason, req.ip);
  }

  // ---------- KYC review queue (COMPLIANCE_OFFICER/SUPER_ADMIN only) ----------
  @Roles('SUPER_ADMIN', 'COMPLIANCE_OFFICER')
  @Get('kyc/queue')
  async getKycQueue() {
    return this.adminService.getKycQueue();
  }

  @Roles('SUPER_ADMIN', 'COMPLIANCE_OFFICER')
  @Post('kyc/:userId/decide')
  async decideKyc(@Req() req, @Param('userId') userId: string, @Body() dto: KycDecisionDto) {
    return this.adminService.decideKyc(req.user.adminId, userId, dto.decision, dto.reason, req.ip);
  }

  // ---------- Transactions (any admin can view; flag/reverse restricted
  // to FINANCE_OFFICER/SUPER_ADMIN) ----------
  @Get('transactions')
  async searchTransactions(
    @Query('userId') userId?: string,
    @Query('status') status?: string,
    @Query('flagged') flagged?: string,
    @Query('type') type?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.adminService.searchTransactions({
      userId,
      status,
      flagged: flagged !== undefined ? flagged === 'true' : undefined,
      type,
      page: Number(page) || 1,
      pageSize: Number(pageSize) || 50,
    });
  }

  @Roles('SUPER_ADMIN', 'FINANCE_OFFICER', 'COMPLIANCE_OFFICER')
  @Patch('transactions/:id/flag')
  async flagTransaction(@Req() req, @Param('id') id: string, @Body('flagged') flagged: boolean) {
    return this.adminService.flagTransaction(req.user.adminId, id, flagged, req.ip);
  }

  @Roles('SUPER_ADMIN', 'FINANCE_OFFICER')
  @Post('transactions/:id/reverse')
  @UseGuards(StepUpGuard) // reversing money is the single most irreversible-feeling action in this admin surface
  async reverseTransaction(@Req() req, @Param('id') id: string, @Body() dto: ReverseTransactionDto) {
    return this.adminService.reverseTransaction(req.user.adminId, id, dto.reason, req.ip);
  }

  // CSV export — same filters as the paginated search above, capped at
  // 10,000 rows server-side (see AdminService.exportTransactionsCsv).
  @Get('transactions/export')
  async exportTransactions(
    @Res() res: Response,
    @Query('userId') userId?: string,
    @Query('status') status?: string,
    @Query('flagged') flagged?: string,
    @Query('type') type?: string,
  ) {
    const rows = await this.adminService.exportTransactionsCsv({
      userId,
      status,
      flagged: flagged !== undefined ? flagged === 'true' : undefined,
      type,
    });
    const csv = toCsv(
      [
        { key: 'id', header: 'Transaction ID' },
        { key: 'reference', header: 'Reference' },
        { key: 'createdAt', header: 'Date' },
        { key: 'userName', header: 'Customer' },
        { key: 'userAccountNumber', header: 'Account Number' },
        { key: 'type', header: 'Type' },
        { key: 'category', header: 'Category' },
        { key: 'title', header: 'Description' },
        { key: 'amount', header: 'Amount (NGN)' },
        { key: 'status', header: 'Status' },
        { key: 'flagged', header: 'Flagged' },
        { key: 'reversedTransactionId', header: 'Reversed Txn ID' },
        { key: 'reversalReason', header: 'Reversal Reason' },
      ],
      rows,
    );
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="zannypay-transactions-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
  }

  // Registered AFTER the literal 'transactions/export' route above —
  // Nest/Express matches routes in declaration order, so a ':id' route
  // declared first would swallow '/transactions/export' as if "export"
  // were an id and return a 404, silently breaking the CSV download.
  @Get('transactions/:id')
  async getTransactionDetail(@Param('id') id: string) {
    return this.adminService.getTransactionDetail(id);
  }

  // ---------- Disputes (any admin can view/update — SUPPORT_AGENT
  // typically handles the day-to-day queue) ----------
  @Get('disputes')
  async listDisputes(@Query('status') status?: string) {
    return this.adminService.listDisputes(status);
  }

  @Patch('disputes/:id')
  async updateDispute(@Req() req, @Param('id') id: string, @Body() dto: UpdateDisputeDto) {
    return this.adminService.updateDispute(req.user.adminId, id, dto.status, dto.resolutionNote, req.ip);
  }

  // ---------- Loans ----------
  @Get('loans')
  async listLoans(@Query('status') status?: 'active' | 'repaid') {
    return this.adminService.listLoans(status);
  }

  // ---------- Dashboard ----------
  @Get('dashboard')
  async getDashboardStats() {
    return this.adminService.getDashboardStats();
  }

  // Powers the "Wallet Volume" trend chart and the Transactions page's
  // multi-series chart — see AdminService.getDashboardTrend for why this
  // didn't exist before (getDashboardStats only ever returned one
  // 30-day aggregate total, nothing per-day).
  @Get('analytics/trend')
  async getDashboardTrend(@Query('days') days?: string) {
    return this.adminService.getDashboardTrend(Number(days) || 30);
  }

  @Get('analytics/category-breakdown')
  async getCategoryBreakdown(@Query('days') days?: string) {
    return this.adminService.getCategoryBreakdown(Number(days) || 30);
  }

  // ---------- Audit trail (SUPER_ADMIN only — this is the log of
  // everyone else's actions, including other admins') ----------
  @Roles('SUPER_ADMIN')
  @Get('audit-logs')
  async getAuditLogs(
    @Query('adminId') adminId?: string,
    @Query('targetType') targetType?: string,
    @Query('targetId') targetId?: string,
    @Query('limit') limit?: string,
  ) {
    return this.auditLogService.list({ adminId, targetType, targetId, limit: Number(limit) || 100 });
  }

  @Roles('SUPER_ADMIN')
  @Get('audit-logs/export')
  async exportAuditLogs(
    @Res() res: Response,
    @Query('adminId') adminId?: string,
    @Query('targetType') targetType?: string,
    @Query('targetId') targetId?: string,
  ) {
    const rows = await this.adminService.exportAuditLogsCsv({ adminId, targetType, targetId });
    const csv = toCsv(
      [
        { key: 'id', header: 'Log ID' },
        { key: 'createdAt', header: 'Timestamp' },
        { key: 'adminId', header: 'Admin ID' },
        { key: 'action', header: 'Action' },
        { key: 'targetType', header: 'Target Type' },
        { key: 'targetId', header: 'Target ID' },
        { key: 'ipAddress', header: 'IP Address' },
      ],
      rows as any,
    );
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="zannypay-audit-log-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
  }
}

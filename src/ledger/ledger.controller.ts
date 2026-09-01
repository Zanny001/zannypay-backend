import { Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { AdminJwtAuthGuard } from '../admin-auth/admin-jwt-auth.guard';
import { RolesGuard } from '../admin-auth/roles.guard';
import { Roles } from '../admin-auth/roles.decorator';
import { AdminIpAllowlistGuard } from '../admin-security/admin-ip-allowlist.guard';
import { LedgerService } from './ledger.service';
import { ReconciliationService } from './reconciliation.service';
import { PrismaService } from '../prisma/prisma.service';

// SUPER_ADMIN/FINANCE_OFFICER only — this surfaces the platform's real
// money-movement integrity checks, not customer-facing data.
@Controller('admin/ledger')
@UseGuards(AdminIpAllowlistGuard, AdminJwtAuthGuard, RolesGuard)
@Roles('SUPER_ADMIN', 'FINANCE_OFFICER')
export class LedgerController {
  constructor(
    private readonly ledgerService: LedgerService,
    private readonly reconciliationService: ReconciliationService,
    private readonly prisma: PrismaService,
  ) {}

  // One-time go-live migration — see LedgerService.seedOpeningBalances for
  // why this is needed and why it's safe to call more than once.
  @Post('seed-opening-balances')
  async seedOpeningBalances() {
    return this.ledgerService.seedOpeningBalances();
  }

  // Runs reconciliation immediately rather than waiting for the 3am cron
  // — useful right after a deploy, or when investigating a specific
  // report of a wrong balance.
  @Post('reconcile')
  async reconcileNow() {
    return this.reconciliationService.run();
  }

  @Get('reconciliation-runs')
  async listRuns(@Query('limit') limit?: string) {
    return this.prisma.ledgerReconciliationRun.findMany({
      orderBy: { runAt: 'desc' },
      take: Number(limit) || 30,
    });
  }
}

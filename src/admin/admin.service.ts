import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SanctionsScreeningService } from '../screening/sanctions-screening.provider';
import { LedgerService } from '../ledger/ledger.service';
import { LedgerAccountType, LedgerDirection } from '@prisma/client';
import {
  AnalyticsService,
  ANALYTICS_EVENTS,
} from '../analytics/analytics.service';
import { formatNaira } from '../common/format-currency.util';
import * as bcrypt from 'bcrypt';

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly notifications: NotificationsService,
    private readonly sanctionsScreening: SanctionsScreeningService,
    private readonly analyticsService: AnalyticsService,
    private readonly ledgerService: LedgerService,
  ) {}

  // ==========================================
  // Admin account management
  // ==========================================
  async listAdmins() {
    return this.prisma.adminUser.findMany({
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        isActive: true,
        lastLoginAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async createAdmin(
    actingAdminId: string,
    dto: { name: string; email: string; password: string; role: string },
    ip?: string,
  ) {
    const existing = await this.prisma.adminUser.findUnique({
      where: { email: dto.email },
    });
    if (existing)
      throw new ConflictException('An admin with this email already exists.');

    const hashedPassword = await bcrypt.hash(dto.password, 10);
    const admin = await this.prisma.adminUser.create({
      data: {
        name: dto.name,
        email: dto.email,
        password: hashedPassword,
        role: dto.role as any,
      },
    });

    await this.auditLog.record({
      adminId: actingAdminId,
      action: 'CREATE_ADMIN',
      targetType: 'AdminUser',
      targetId: admin.id,
      metadata: { name: dto.name, email: dto.email, role: dto.role },
      ipAddress: ip,
    });

    return {
      success: true,
      admin: {
        id: admin.id,
        name: admin.name,
        email: admin.email,
        role: admin.role,
      },
    };
  }

  async deactivateAdmin(
    actingAdminId: string,
    targetAdminId: string,
    ip?: string,
  ) {
    if (actingAdminId === targetAdminId) {
      throw new BadRequestException(
        'You cannot deactivate your own admin account.',
      );
    }
    const admin = await this.prisma.adminUser.update({
      where: { id: targetAdminId },
      data: { isActive: false },
    });

    await this.auditLog.record({
      adminId: actingAdminId,
      action: 'DEACTIVATE_ADMIN',
      targetType: 'AdminUser',
      targetId: targetAdminId,
      ipAddress: ip,
    });

    return { success: true, admin: { id: admin.id, isActive: admin.isActive } };
  }

  // ==========================================
  // Platform Users
  // ==========================================
  async searchUsers(query: string, page = 1, pageSize = 25) {
    const where = query
      ? {
          OR: [
            { name: { contains: query, mode: 'insensitive' as const } },
            { email: { contains: query, mode: 'insensitive' as const } },
            { phone: { contains: query } },
            { accountNumber: { contains: query } },
          ],
        }
      : {};

    // Independent reads (the page of results, and the total count) — no
    // shared write state between them, so Promise.all lets them run
    // concurrently across the pool instead of serializing onto one
    // connection via $transaction, which only buys atomicity neither of
    // these needs.
    const [users, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        select: {
          id: true,
          name: true,
          email: true,
          phone: true,
          accountNumber: true,
          kycTier: true,
          kycStatus: true,
          isFrozen: true,
          createdAt: true,
          wallet: { select: { balance: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.user.count({ where }),
    ]);

    return { users, total, page, pageSize };
  }

  async getUserDetail(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        wallet: true,
        savingsGoals: true,
        loans: true,
        cards: true,
        disputes: true,
        transactions: { orderBy: { createdAt: 'desc' }, take: 50 },
      },
    });
    if (!user) throw new NotFoundException('User not found.');
    const {
      pin,
      bvnEncrypted,
      ninEncrypted,
      kycRevealFailedAttempts,
      kycRevealLockedUntil,
      ...safeUser
    } = user;
    return safeUser;
  }

  async setUserFrozen(
    actingAdminId: string,
    userId: string,
    isFrozen: boolean,
    reason: string,
    ip?: string,
  ) {
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: { isFrozen },
    });

    await this.auditLog.record({
      adminId: actingAdminId,
      action: isFrozen ? 'FREEZE_USER' : 'UNFREEZE_USER',
      targetType: 'User',
      targetId: userId,
      metadata: { reason },
      ipAddress: ip,
    });

    await this.notifications.create(
      userId,
      isFrozen ? 'account_frozen' : 'account_unfrozen',
      isFrozen
        ? 'Your account has been restricted'
        : 'Your account has been reactivated',
      isFrozen
        ? `Your account was restricted. Reason: ${reason}. Contact support if you believe this is a mistake.`
        : 'Your account is fully active again.',
      { reason },
    );

    return { success: true, user: { id: user.id, isFrozen: user.isFrozen } };
  }

  // ==========================================
  // KYC Review Queue
  // ==========================================
  async getKycQueue() {
    return this.prisma.user.findMany({
      where: { kycStatus: 'pending' },
      select: {
        id: true,
        name: true,
        phone: true,
        email: true,
        bvnLast4: true,
        ninLast4: true,
        nextOfKinName: true,
        nextOfKinPhone: true,
        dateOfBirth: true,
        nationality: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  async decideKyc(
    actingAdminId: string,
    userId: string,
    decision: 'approve' | 'reject',
    reason?: string,
    ip?: string,
  ) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found.');
    if (user.kycStatus !== 'pending') {
      throw new BadRequestException(
        'This user has no pending KYC submission to review.',
      );
    }

    if (decision === 'reject' && !reason) {
      throw new BadRequestException(
        'A reason is required when rejecting a KYC submission.',
      );
    }

    // Master audit: sanctions/PEP screening was entirely absent from the
    // KYC flow. Screened at the moment of decision (not continuously —
    // there's no ongoing-monitoring job yet, a real deployment should add
    // one) and recorded either way, so an approval has a screening result
    // attached to it in the audit trail rather than being a bare
    // approve/reject with nothing behind it. Does NOT auto-block the
    // decision on a match — see SanctionsScreeningProvider's doc comment
    // on why the mock provider's verdict isn't safe to treat as a real
    // compliance signal; a real provider integration is what should decide
    // whether a match becomes a hard stop.
    const screening = await this.sanctionsScreening.screenAndRecord(
      userId,
      user.name,
      user.dateOfBirth?.toISOString?.() ?? null,
      user.nationality,
    );

    const updated = await this.prisma.user.update({
      where: { id: userId },
      data:
        decision === 'approve'
          ? {
              kycStatus: 'approved',
              kycTier: 2,
              kycRejectionReason: null,
              rewardPoints: { increment: 100 },
            }
          : { kycStatus: 'rejected', kycRejectionReason: reason },
    });

    await this.auditLog.record({
      adminId: actingAdminId,
      action: decision === 'approve' ? 'APPROVE_KYC' : 'REJECT_KYC',
      targetType: 'User',
      targetId: userId,
      metadata: { reason, sanctionsScreeningMatch: screening.isMatch },
      ipAddress: ip,
    });

    await this.notifications.create(
      userId,
      decision === 'approve' ? 'kyc_approved' : 'kyc_rejected',
      decision === 'approve'
        ? 'Your ID verification was approved'
        : 'Your ID verification needs attention',
      decision === 'approve'
        ? "You're now verified at Tier 2 — higher limits and more features are unlocked."
        : `Your submission couldn't be approved. Reason: ${reason}. You can review and resubmit from the KYC screen.`,
      { reason },
    );

    await this.analyticsService.track(
      decision === 'approve'
        ? ANALYTICS_EVENTS.KYC_APPROVED
        : ANALYTICS_EVENTS.KYC_REJECTED,
      { userId, properties: { sanctionsScreeningMatch: screening.isMatch } },
    );

    return {
      success: true,
      user: {
        id: updated.id,
        kycStatus: updated.kycStatus,
        kycTier: updated.kycTier,
      },
      sanctionsScreening: screening,
    };
  }

  // ==========================================
  // Transactions
  // ==========================================
  async searchTransactions(filters: {
    userId?: string;
    status?: string;
    flagged?: boolean;
    type?: string;
    page?: number;
    pageSize?: number;
  }) {
    const page = filters.page || 1;
    const pageSize = filters.pageSize || 50;
    const where = {
      ...(filters.userId && { userId: filters.userId }),
      ...(filters.status && { status: filters.status }),
      ...(filters.flagged !== undefined && { flagged: filters.flagged }),
      ...(filters.type && { type: filters.type }),
    };

    const [transactions, total] = await Promise.all([
      this.prisma.transaction.findMany({
        where,
        include: {
          user: { select: { name: true, accountNumber: true, phone: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.transaction.count({ where }),
    ]);

    return { transactions, total, page, pageSize };
  }

  // Powers the Transactions page's detail drawer — a single transaction
  // plus its full reversal chain (either direction: the original
  // transaction this one reversed, or the reversal transaction created
  // from this one, if any) and internal notes left against it. Previously
  // there was no detail view at all — the row itself, and its two action
  // buttons, was the entire surface a compliance/finance officer had to
  // investigate a transaction with.
  async getTransactionDetail(transactionId: string) {
    const transaction = await this.prisma.transaction.findUnique({
      where: { id: transactionId },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            accountNumber: true,
            phone: true,
            email: true,
          },
        },
      },
    });
    if (!transaction) throw new NotFoundException('Transaction not found.');

    const [reversalOf, reversedBy] = await Promise.all([
      transaction.reversedTransactionId
        ? this.prisma.transaction.findUnique({
            where: { id: transaction.reversedTransactionId },
          })
        : Promise.resolve(null),
      this.prisma.transaction.findFirst({
        where: { reversedTransactionId: transactionId },
      }),
    ]);

    return { transaction, reversalOf, reversedBy };
  }

  async flagTransaction(
    actingAdminId: string,
    transactionId: string,
    flagged: boolean,
    ip?: string,
  ) {
    const txn = await this.prisma.transaction.update({
      where: { id: transactionId },
      data: { flagged },
    });
    await this.auditLog.record({
      adminId: actingAdminId,
      action: flagged ? 'FLAG_TRANSACTION' : 'UNFLAG_TRANSACTION',
      targetType: 'Transaction',
      targetId: transactionId,
      ipAddress: ip,
    });
    return { success: true, transaction: { id: txn.id, flagged: txn.flagged } };
  }

  async reverseTransaction(
    actingAdminId: string,
    transactionId: string,
    reason: string,
    ip?: string,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const original = await tx.transaction.findUnique({
        where: { id: transactionId },
      });
      if (!original) throw new NotFoundException('Transaction not found.');
      if (original.status === 'reversed')
        throw new BadRequestException(
          'This transaction has already been reversed.',
        );

      const wallet = await tx.wallet.findUnique({
        where: { userId: original.userId },
      });
      if (!wallet)
        throw new NotFoundException("The user's wallet could not be found.");

      const isReversingADebit = original.type === 'debit';
      await tx.wallet.update({
        where: { userId: original.userId },
        data: {
          balance: isReversingADebit
            ? { increment: original.amount }
            : { decrement: original.amount },
        },
      });

      // Deliberately a one-sided adjustment against SYSTEM_ADMIN_ADJUSTMENT
      // rather than LedgerService.reverseJournal() inverting whatever the
      // original journal contained: the wallet update two lines above only
      // ever touches original.userId's own balance, even when the
      // original transaction was one side of an internal transfer between
      // two customers. Symmetrically inverting that original journal would
      // also move the *other* customer's ledger balance — which nothing
      // here touches in their actual Wallet.balance, so the two would
      // immediately disagree and ReconciliationService would flag it. This
      // posts exactly the one movement this method actually makes, no more.
      const adjustmentAmount = Number(original.amount);
      const originalUserWalletAccount =
        await this.ledgerService.getOrCreateCustomerAccount(
          LedgerAccountType.CUSTOMER_WALLET,
          original.userId,
          tx,
        );
      const adminAdjustmentAccount =
        await this.ledgerService.getOrCreateSystemAccount(
          LedgerAccountType.SYSTEM_ADMIN_ADJUSTMENT,
          tx,
        );

      await tx.transaction.update({
        where: { id: transactionId },
        data: { status: 'reversed', reversalReason: reason },
      });

      const reversal = await tx.transaction.create({
        data: {
          userId: original.userId,
          type: isReversingADebit ? 'credit' : 'debit',
          category: original.category,
          title: `Reversal: ${original.title}`,
          subtitle: reason,
          amount: original.amount,
          status: 'completed',
          reference: `REV-${Date.now()}`,
          reversedTransactionId: original.id,
        },
      });

      await this.ledgerService.postJournal(
        tx,
        isReversingADebit
          ? [
              {
                accountId: originalUserWalletAccount.id,
                direction: LedgerDirection.CREDIT,
                amount: adjustmentAmount,
              },
              {
                accountId: adminAdjustmentAccount.id,
                direction: LedgerDirection.DEBIT,
                amount: adjustmentAmount,
              },
            ]
          : [
              {
                accountId: originalUserWalletAccount.id,
                direction: LedgerDirection.DEBIT,
                amount: adjustmentAmount,
              },
              {
                accountId: adminAdjustmentAccount.id,
                direction: LedgerDirection.CREDIT,
                amount: adjustmentAmount,
              },
            ],
        { transactionId: reversal.id, memo: `Admin reversal: ${reason}` },
      );

      await this.auditLog.record({
        adminId: actingAdminId,
        action: 'REVERSE_TRANSACTION',
        targetType: 'Transaction',
        targetId: transactionId,
        metadata: { reason, reversalTransactionId: reversal.id },
        ipAddress: ip,
      });

      // Previously the only customer-facing trace of a reversal was the
      // reversal transaction itself showing up next time they opened
      // History — nothing told them it happened. An admin unilaterally
      // moving money back out of (or into) a customer's wallet is exactly
      // the kind of event that shouldn't wait to be discovered.
      await this.notifications.create(
        original.userId,
        'transaction_reversed',
        'A transaction was reversed',
        `"${original.title}" (${formatNaira(Number(original.amount))}) was reversed. Reason: ${reason}.`,
        { transactionId, reversalTransactionId: reversal.id, reason },
      );

      return { success: true, reversal };
    });
  }

  // ==========================================
  // Disputes
  // ==========================================
  async listDisputes(status?: string) {
    return this.prisma.dispute.findMany({
      where: status ? { status } : {},
      include: {
        user: { select: { name: true, accountNumber: true, phone: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async updateDispute(
    actingAdminId: string,
    disputeId: string,
    status: string,
    resolutionNote?: string,
    ip?: string,
  ) {
    const dispute = await this.prisma.dispute.update({
      where: { id: disputeId },
      data: { status, resolutionNote, resolvedByAdminId: actingAdminId },
    });

    await this.auditLog.record({
      adminId: actingAdminId,
      action: 'UPDATE_DISPUTE',
      targetType: 'Dispute',
      targetId: disputeId,
      metadata: { status, resolutionNote },
      ipAddress: ip,
    });

    // Only notify once there's an actual outcome — not on interim status
    // moves like "open" -> "under_review", which aren't news to the
    // customer yet.
    if (['resolved', 'rejected'].includes(status)) {
      await this.notifications.create(
        dispute.userId,
        'dispute_resolved',
        status === 'resolved'
          ? 'Your dispute has been resolved'
          : 'Update on your dispute',
        resolutionNote ||
          (status === 'resolved'
            ? 'Your dispute has been resolved.'
            : 'Your dispute was reviewed and closed.'),
        { disputeId, status },
      );
    }

    return { success: true, dispute };
  }

  // ==========================================
  // Loans
  // ==========================================
  async listLoans(status?: 'active' | 'repaid') {
    return this.prisma.loan.findMany({
      where: status ? { repaid: status === 'repaid' } : {},
      include: {
        user: { select: { name: true, accountNumber: true, phone: true } },
      },
      orderBy: { issuedAt: 'desc' },
    });
  }

  // ==========================================
  // Dashboard
  // ==========================================
  // NOTE: this previously used $transaction([...]) in an attempt to fix a
  // "Can't reach database server" (Prisma P1001) error. That didn't fix
  // it — P1001 is a TCP-level failure to reach the pooler, which happens
  // before any query runs, so wrapping queries in a transaction has no
  // effect on it. What it did do was force these 7 independent, read-only
  // counts to run sequentially on a single held connection instead of
  // fanning out, which is strictly worse for this endpoint's latency. The
  // actual fix for P1001-style errors is the DATABASE_URL/DIRECT_URL split
  // + pgbouncer connection pooling params (see .env.example) — that's a
  // connection-string/infra fix, not a query-shape one.
  async getDashboardStats() {
    const [
      totalUsers,
      frozenUsers,
      pendingKyc,
      totalWalletBalanceResult,
      activeLoans,
      openDisputes,
      flaggedTransactions,
    ] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.user.count({ where: { isFrozen: true } }),
      this.prisma.user.count({ where: { kycStatus: 'pending' } }),
      this.prisma.wallet.aggregate({ _sum: { balance: true } }),
      this.prisma.loan.count({ where: { repaid: false } }),
      this.prisma.dispute.count({
        where: { status: { in: ['open', 'under_review'] } },
      }),
      this.prisma.transaction.count({ where: { flagged: true } }),
    ]);

    const last30Days = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const recentTransactionVolume = await this.prisma.transaction.aggregate({
      _sum: { amount: true },
      _count: true,
      where: { createdAt: { gte: last30Days }, status: 'completed' },
    });

    return {
      totalUsers,
      frozenUsers,
      pendingKycReviews: pendingKyc,
      totalWalletFloat: totalWalletBalanceResult._sum.balance || 0,
      activeLoans,
      openDisputes,
      flaggedTransactions,
      last30Days: {
        transactionCount: recentTransactionVolume._count,
        transactionVolume: recentTransactionVolume._sum.amount || 0,
      },
    };
  }

  // Same filter shape as searchTransactions, but unpaginated (capped at
  // EXPORT_ROW_CAP as a safety valve) — a compliance officer pulling a
  // month-end export needs the whole matching set, not one page at a
  // time. Master audit, Section 8: "a formal, exportable record — CSV
  // today, a formatted PDF/audit-log excerpt as a near-term follow-up —
  // is the kind of thing a compliance officer will ask for in week one of
  // actually using this."
  async exportTransactionsCsv(filters: {
    userId?: string;
    status?: string;
    flagged?: boolean;
    type?: string;
  }) {
    const EXPORT_ROW_CAP = 10000;
    const where = {
      ...(filters.userId && { userId: filters.userId }),
      ...(filters.status && { status: filters.status }),
      ...(filters.flagged !== undefined && { flagged: filters.flagged }),
      ...(filters.type && { type: filters.type }),
    };

    const transactions = await this.prisma.transaction.findMany({
      where,
      include: {
        user: { select: { name: true, accountNumber: true, phone: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: EXPORT_ROW_CAP,
    });

    return transactions.map((t) => ({
      id: t.id,
      reference: t.reference,
      createdAt: t.createdAt.toISOString(),
      userName: t.user?.name || '',
      userAccountNumber: t.user?.accountNumber || '',
      type: t.type,
      category: t.category,
      title: t.title,
      amount: Number(t.amount).toFixed(2),
      status: t.status,
      flagged: t.flagged,
      reversedTransactionId: t.reversedTransactionId || '',
      reversalReason: t.reversalReason || '',
    }));
  }

  async exportAuditLogsCsv(filters: {
    adminId?: string;
    targetType?: string;
    targetId?: string;
  }) {
    return this.auditLog.list({ ...filters, limit: 10000 });
  }

  // ==========================================
  // Analytics — dashboard trend + category breakdown
  // ==========================================
  // Master audit / ZannyPay_Master_Audit_v2, Section 6: the actual admin
  // dashboard screenshot shows a "Wallet Volume — Last 8 Weeks" bar chart
  // — but getDashboardStats() above only ever returned one 30-day
  // aggregate total, nothing chartable. That bar chart's data is
  // necessarily either hardcoded or randomized on the frontend today.
  // This gives it a real, queryable time series to render instead.
  //
  // date_trunc via $queryRaw rather than Prisma's query API: grouping by
  // calendar day is not something groupBy can express (it only groups by
  // exact column equality, not a truncated/derived value), so a raw
  // aggregate query is the standard, correct tool here — not a workaround.
  async getDashboardTrend(days = 30) {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const daily = await this.prisma.$queryRaw<
      { day: Date; count: bigint; volume: string | null }[]
    >`
      SELECT date_trunc('day', "createdAt") AS day, COUNT(*)::bigint AS count, SUM("amount")::text AS volume
      FROM "Transaction"
      WHERE "createdAt" >= ${since} AND "status" = 'completed'
      GROUP BY day
      ORDER BY day ASC
    `;

    // Postgres won't invent rows for days with zero transactions — filled
    // in here so the chart doesn't silently skip a quiet Sunday and
    // misrepresent the x-axis as continuous when it isn't.
    const byDay = new Map(
      daily.map((row) => [row.day.toISOString().slice(0, 10), row]),
    );
    const series: { date: string; count: number; volume: number }[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const date = new Date(Date.now() - i * 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10);
      const row = byDay.get(date);
      series.push({
        date,
        count: row ? Number(row.count) : 0,
        volume: row ? Number(row.volume || 0) : 0,
      });
    }
    return series;
  }

  async getCategoryBreakdown(days = 30) {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const grouped = await this.prisma.transaction.groupBy({
      by: ['category'],
      where: { createdAt: { gte: since }, status: 'completed' },
      _sum: { amount: true },
      _count: true,
    });
    return grouped
      .map((g) => ({
        category: g.category,
        count: g._count,
        volume: Number(g._sum.amount || 0),
      }))
      .sort((a, b) => b.volume - a.volume);
  }
}

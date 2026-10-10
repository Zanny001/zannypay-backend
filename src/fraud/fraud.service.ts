import { Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { MailerService } from '@nestjs-modules/mailer';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { NotificationsService } from '../notifications/notifications.service';

// The shape of a just-created Transaction row, as passed in from
// TransactionsService right after a `$transaction(...)` commits. Only the
// fields the rules actually need — keeps this engine decoupled from the
// full Prisma Transaction type so it's easy to call from any money-movement
// code path.
export interface EvaluatedTransaction {
  id: string;
  userId: string;
  type: string; // 'debit' | 'credit'
  category: string;
  amount: number;
  recipientAccount?: string | null;
  createdAt: Date;
}

interface RuleResult {
  triggered: boolean;
  details?: Record<string, any>;
}

@Injectable()
export class FraudService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly mailerService: MailerService,
    private readonly notifications: NotificationsService,
  ) {}

  // Seeds a sane default rule set exactly once, the first time the app
  // boots against a fresh database. After that, every threshold lives in
  // the FraudRule table and is tunable by a SUPER_ADMIN without a
  // redeploy — that's the difference between "flagging is manual" and
  // "a mature system runs rules automatically."
  async onModuleInit() {
    const existingCount = await this.prisma.fraudRule.count();
    if (existingCount > 0) return;

    await this.prisma.fraudRule.createMany({
      data: [
        {
          name: 'VELOCITY_COUNT',
          description:
            'More than N debit transactions from one user within a short window.',
          severity: 'MEDIUM',
          config: { windowMinutes: 10, maxDebitCount: 5 },
          autoFreeze: false,
        },
        {
          name: 'VELOCITY_AMOUNT',
          description:
            'Total debit volume from one user exceeds a threshold within a window.',
          severity: 'HIGH',
          config: { windowMinutes: 60, maxDebitAmount: 500000 },
          autoFreeze: false,
        },
        {
          name: 'LARGE_SINGLE_TRANSACTION',
          description:
            'A single transaction exceeds an absolute amount threshold.',
          severity: 'HIGH',
          config: { maxAmount: 1000000 },
          autoFreeze: false,
        },
        {
          name: 'NEW_RECIPIENT_LARGE_TRANSFER',
          description:
            'A large transfer to a recipient this sender has never sent to before.',
          severity: 'MEDIUM',
          config: { maxAmount: 300000 },
          autoFreeze: false,
        },
        {
          name: 'STRUCTURING_PATTERN',
          description:
            'Multiple transfers just under a round threshold in a short window — a classic structuring/"smurfing" signature.',
          severity: 'CRITICAL',
          config: {
            windowMinutes: 60,
            minOccurrences: 3,
            thresholdAmount: 500000,
            bandPercentage: 10,
          },
          autoFreeze: true,
        },
        {
          name: 'RAPID_FUND_AND_DRAIN',
          description:
            'A large wallet top-up immediately followed by draining most of it back out — a mule-account signature.',
          severity: 'CRITICAL',
          config: {
            windowMinutes: 30,
            minFundingAmount: 200000,
            minDrainPercentage: 80,
          },
          autoFreeze: true,
        },
      ],
    });
    console.log('[FraudEngine] Seeded default fraud rules.');
  }

  // ==========================================
  // Automated evaluation — called from TransactionsService right after a
  // transaction commits. Never blocks or reverses the transaction itself;
  // this detects and responds (flag, alert, optionally auto-freeze), it
  // does not gate the money movement in-line. Best-effort: a failure here
  // must never surface as a failure of the underlying customer action.
  // ==========================================
  async evaluateTransaction(transaction: EvaluatedTransaction) {
    try {
      const rules = await this.prisma.fraudRule.findMany({
        where: { isEnabled: true },
      });
      for (const rule of rules) {
        const result = await this.runRule(
          rule.name,
          rule.config as Record<string, any>,
          transaction,
        );
        if (result.triggered) {
          await this.raiseAlert(rule, transaction, result.details || {});
        }
      }
    } catch (error) {
      console.error(
        '[FraudEngine] Evaluation failed for transaction',
        transaction.id,
        error,
      );
    }
  }

  private async runRule(
    ruleName: string,
    config: Record<string, any>,
    transaction: EvaluatedTransaction,
  ): Promise<RuleResult> {
    switch (ruleName) {
      case 'VELOCITY_COUNT':
        return this.ruleVelocityCount(transaction.userId, config);
      case 'VELOCITY_AMOUNT':
        return this.ruleVelocityAmount(transaction.userId, config);
      case 'LARGE_SINGLE_TRANSACTION':
        return this.ruleLargeSingleTransaction(transaction, config);
      case 'NEW_RECIPIENT_LARGE_TRANSFER':
        return this.ruleNewRecipientLargeTransfer(transaction, config);
      case 'STRUCTURING_PATTERN':
        return this.ruleStructuringPattern(transaction.userId, config);
      case 'RAPID_FUND_AND_DRAIN':
        return this.ruleRapidFundAndDrain(transaction.userId, config);
      default:
        // An unrecognized rule name (e.g. a typo introduced through the
        // rule-editing API) is treated as inert rather than an error — a
        // SUPER_ADMIN can only tune the 6 implemented strategies above,
        // not invent new rule logic through the API.
        return { triggered: false };
    }
  }

  private async ruleVelocityCount(
    userId: string,
    config: Record<string, any>,
  ): Promise<RuleResult> {
    const windowMinutes = Number(config.windowMinutes) || 10;
    const maxDebitCount = Number(config.maxDebitCount) || 5;
    const since = new Date(Date.now() - windowMinutes * 60 * 1000);

    const actualCount = await this.prisma.transaction.count({
      where: { userId, type: 'debit', createdAt: { gte: since } },
    });

    if (actualCount > maxDebitCount) {
      return {
        triggered: true,
        details: { windowMinutes, maxDebitCount, actualCount },
      };
    }
    return { triggered: false };
  }

  private async ruleVelocityAmount(
    userId: string,
    config: Record<string, any>,
  ): Promise<RuleResult> {
    const windowMinutes = Number(config.windowMinutes) || 60;
    const maxDebitAmount = Number(config.maxDebitAmount) || 500000;
    const since = new Date(Date.now() - windowMinutes * 60 * 1000);

    const agg = await this.prisma.transaction.aggregate({
      _sum: { amount: true },
      where: { userId, type: 'debit', createdAt: { gte: since } },
    });
    const actualTotal = Number(agg._sum.amount || 0);

    if (actualTotal > maxDebitAmount) {
      return {
        triggered: true,
        details: { windowMinutes, maxDebitAmount, actualTotal },
      };
    }
    return { triggered: false };
  }

  private ruleLargeSingleTransaction(
    transaction: EvaluatedTransaction,
    config: Record<string, any>,
  ): RuleResult {
    const maxAmount = Number(config.maxAmount) || 1000000;
    const actualAmount = Number(transaction.amount);

    if (actualAmount > maxAmount) {
      return { triggered: true, details: { maxAmount, actualAmount } };
    }
    return { triggered: false };
  }

  private async ruleNewRecipientLargeTransfer(
    transaction: EvaluatedTransaction,
    config: Record<string, any>,
  ): Promise<RuleResult> {
    if (
      transaction.type !== 'debit' ||
      transaction.category !== 'transfer' ||
      !transaction.recipientAccount
    ) {
      return { triggered: false };
    }
    const maxAmount = Number(config.maxAmount) || 300000;
    const actualAmount = Number(transaction.amount);
    if (actualAmount <= maxAmount) return { triggered: false };

    const priorTransferCount = await this.prisma.transaction.count({
      where: {
        userId: transaction.userId,
        recipientAccount: transaction.recipientAccount,
        type: 'debit',
        category: 'transfer',
        id: { not: transaction.id },
        createdAt: { lt: transaction.createdAt },
      },
    });

    if (priorTransferCount === 0) {
      return {
        triggered: true,
        details: {
          maxAmount,
          actualAmount,
          recipientAccount: transaction.recipientAccount,
          note: 'First-ever transfer to this recipient',
        },
      };
    }
    return { triggered: false };
  }

  private async ruleStructuringPattern(
    userId: string,
    config: Record<string, any>,
  ): Promise<RuleResult> {
    const windowMinutes = Number(config.windowMinutes) || 60;
    const minOccurrences = Number(config.minOccurrences) || 3;
    const thresholdAmount = Number(config.thresholdAmount) || 500000;
    const bandPercentage = Number(config.bandPercentage) || 10;
    const lowerBound = thresholdAmount * (1 - bandPercentage / 100);
    const since = new Date(Date.now() - windowMinutes * 60 * 1000);

    const candidates = await this.prisma.transaction.findMany({
      where: {
        userId,
        type: 'debit',
        category: 'transfer',
        createdAt: { gte: since },
        amount: { gte: lowerBound, lt: thresholdAmount },
      },
      select: { id: true, amount: true },
    });

    if (candidates.length >= minOccurrences) {
      return {
        triggered: true,
        details: {
          windowMinutes,
          thresholdAmount,
          bandPercentage,
          minOccurrences,
          matchingTransactionCount: candidates.length,
          relatedTransactionIds: candidates.map((c) => c.id),
          totalAmount: candidates.reduce((sum, c) => sum + Number(c.amount), 0),
        },
      };
    }
    return { triggered: false };
  }

  private async ruleRapidFundAndDrain(
    userId: string,
    config: Record<string, any>,
  ): Promise<RuleResult> {
    const windowMinutes = Number(config.windowMinutes) || 30;
    const minFundingAmount = Number(config.minFundingAmount) || 200000;
    const minDrainPercentage = Number(config.minDrainPercentage) || 80;
    const since = new Date(Date.now() - windowMinutes * 60 * 1000);

    const recentFunding = await this.prisma.transaction.findFirst({
      where: {
        userId,
        type: 'credit',
        category: 'funding',
        status: 'completed',
        amount: { gte: minFundingAmount },
        createdAt: { gte: since },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!recentFunding) return { triggered: false };

    const drainAgg = await this.prisma.transaction.aggregate({
      _sum: { amount: true },
      where: {
        userId,
        type: 'debit',
        createdAt: { gte: recentFunding.createdAt },
      },
    });
    const drained = Number(drainAgg._sum.amount || 0);
    const fundedAmount = Number(recentFunding.amount);
    const drainPercentage =
      fundedAmount > 0 ? (drained / fundedAmount) * 100 : 0;

    if (drainPercentage >= minDrainPercentage) {
      return {
        triggered: true,
        details: {
          windowMinutes,
          fundedAmount,
          drained,
          drainPercentage: Math.round(drainPercentage),
          fundingTransactionId: recentFunding.id,
        },
      };
    }
    return { triggered: false };
  }

  private async raiseAlert(
    rule: { id: string; name: string; severity: string; autoFreeze: boolean },
    transaction: EvaluatedTransaction,
    details: Record<string, any>,
  ) {
    const alert = await this.prisma.fraudAlert.create({
      data: {
        userId: transaction.userId,
        transactionId: transaction.id,
        ruleName: rule.name,
        severity: rule.severity as any,
        details,
      },
    });

    await this.prisma.transaction
      .update({ where: { id: transaction.id }, data: { flagged: true } })
      .catch(() => {});

    let autoFroze = false;
    if (rule.autoFreeze) {
      await this.prisma.user.update({
        where: { id: transaction.userId },
        data: { isFrozen: true },
      });
      await this.prisma.fraudAlert.update({
        where: { id: alert.id },
        data: { autoFrozeAccount: true },
      });
      autoFroze = true;

      // Deliberately generic — never names the rule or exposes `details`
      // to the customer. Telling someone exactly which pattern tripped a
      // fraud control is a roadmap for evading it next time; the account-
      // level "why" (contact support) is all they need, and all any admin
      // reviewing the alert queue needs is already in FraudAlert/audit log.
      await this.notifications.create(
        transaction.userId,
        'fraud_alert',
        'Your account has been temporarily restricted',
        'We noticed unusual activity and paused your account as a precaution. Please contact support to resolve this.',
        { alertId: alert.id },
      );
    }

    await this.auditLog.record({
      actorType: 'SYSTEM',
      action: 'FRAUD_RULE_TRIGGERED',
      targetType: 'User',
      targetId: transaction.userId,
      metadata: {
        ruleName: rule.name,
        severity: rule.severity,
        details,
        autoFroze,
        alertId: alert.id,
      },
    });

    if (
      ['HIGH', 'CRITICAL'].includes(rule.severity) &&
      process.env.COMPLIANCE_ALERT_EMAIL
    ) {
      this.mailerService
        .sendMail({
          to: process.env.COMPLIANCE_ALERT_EMAIL,
          subject: `🚨 Fraud alert (${rule.severity}): ${rule.name}`,
          html: `<div style="font-family:sans-serif; padding:20px;">
            <h2>Fraud rule triggered</h2>
            <p><strong>Rule:</strong> ${rule.name} (${rule.severity})</p>
            <p><strong>User:</strong> ${transaction.userId}</p>
            <p><strong>Transaction:</strong> ${transaction.id}</p>
            <p><strong>Account auto-frozen:</strong> ${autoFroze ? 'Yes' : 'No'}</p>
            <pre>${JSON.stringify(details, null, 2)}</pre>
          </div>`,
        })
        .catch(console.error);
    }
  }

  // ==========================================
  // Admin-facing: alert review queue
  // ==========================================
  async listAlerts(filters: {
    status?: string;
    severity?: string;
    userId?: string;
    page?: number;
    pageSize?: number;
  }) {
    const page = filters.page || 1;
    const pageSize = filters.pageSize || 50;
    const where = {
      ...(filters.status && { status: filters.status }),
      ...(filters.severity && { severity: filters.severity as any }),
      ...(filters.userId && { userId: filters.userId }),
    };

    const [alerts, total] = await Promise.all([
      this.prisma.fraudAlert.findMany({
        where,
        include: {
          user: { select: { name: true, accountNumber: true, phone: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.fraudAlert.count({ where }),
    ]);

    return { alerts, total, page, pageSize };
  }

  async reviewAlert(
    actingAdminId: string,
    alertId: string,
    decision: 'confirmed' | 'dismissed',
    note?: string,
    unfreezeIfDismissed?: boolean,
    ip?: string,
  ) {
    const alert = await this.prisma.fraudAlert.findUnique({
      where: { id: alertId },
    });
    if (!alert) throw new NotFoundException('Fraud alert not found.');

    const updated = await this.prisma.fraudAlert.update({
      where: { id: alertId },
      data: {
        status: decision,
        reviewedByAdminId: actingAdminId,
        reviewNote: note,
      },
    });

    if (
      decision === 'dismissed' &&
      alert.autoFrozeAccount &&
      unfreezeIfDismissed
    ) {
      await this.prisma.user.update({
        where: { id: alert.userId },
        data: { isFrozen: false },
      });
    }

    await this.auditLog.record({
      adminId: actingAdminId,
      action:
        decision === 'confirmed'
          ? 'CONFIRM_FRAUD_ALERT'
          : 'DISMISS_FRAUD_ALERT',
      targetType: 'FraudAlert',
      targetId: alertId,
      metadata: { note, unfreezeIfDismissed },
      ipAddress: ip,
    });

    return { success: true, alert: updated };
  }

  // ==========================================
  // Admin-facing: rule configuration (SUPER_ADMIN only, enforced at the
  // controller)
  // ==========================================
  async listRules() {
    return this.prisma.fraudRule.findMany({ orderBy: { name: 'asc' } });
  }

  async updateRule(
    actingAdminId: string,
    ruleId: string,
    dto: {
      isEnabled?: boolean;
      severity?: string;
      config?: Record<string, any>;
      autoFreeze?: boolean;
    },
    ip?: string,
  ) {
    const rule = await this.prisma.fraudRule.update({
      where: { id: ruleId },
      data: {
        ...(dto.isEnabled !== undefined && { isEnabled: dto.isEnabled }),
        ...(dto.severity !== undefined && { severity: dto.severity as any }),
        ...(dto.config !== undefined && { config: dto.config }),
        ...(dto.autoFreeze !== undefined && { autoFreeze: dto.autoFreeze }),
      },
    });

    await this.auditLog.record({
      adminId: actingAdminId,
      action: 'UPDATE_FRAUD_RULE',
      targetType: 'FraudRule',
      targetId: ruleId,
      metadata: dto,
      ipAddress: ip,
    });

    return { success: true, rule };
  }
}

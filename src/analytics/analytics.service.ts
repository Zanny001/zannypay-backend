import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

// ==========================================
// A curated event taxonomy, not "track everything." Every name here maps
// to one of the KPIs a real product team would actually look at
// (activation, transaction success rate, product adoption) — adding a
// new event should mean adding a new line here first, not sprinkling
// ad-hoc strings through the codebase where a typo silently fragments a
// funnel into two events that were meant to be one.
// ==========================================
export const ANALYTICS_EVENTS = {
  SIGNUP_COMPLETED: 'signup_completed',
  PIN_RESET_COMPLETED: 'pin_reset_completed',
  DATA_EXPORT_COMPLETED: 'data_export_completed',
  ACCOUNT_DELETED: 'account_deleted',
  KYC_SUBMITTED: 'kyc_submitted',
  KYC_APPROVED: 'kyc_approved',
  KYC_REJECTED: 'kyc_rejected',
  WALLET_FUNDED: 'wallet_funded',
  TRANSFER_COMPLETED: 'transfer_completed',
  TRANSFER_FAILED: 'transfer_failed',
  BILL_PAYMENT_COMPLETED: 'bill_payment_completed',
  AIRTIME_PURCHASE_COMPLETED: 'airtime_purchase_completed',
  SAVINGS_GOAL_CREATED: 'savings_goal_created',
  SAVINGS_DEPOSIT_COMPLETED: 'savings_deposit_completed',
  CARD_CREATED: 'card_created',
  CARD_LINKED: 'card_linked',
  LOAN_REQUESTED: 'loan_requested',
  LOAN_REPAID: 'loan_repaid',
  REFERRAL_SIGNUP: 'referral_signup',
  SUPPORT_CONVERSATION_STARTED: 'support_conversation_started',
} as const;

export type AnalyticsEventName =
  (typeof ANALYTICS_EVENTS)[keyof typeof ANALYTICS_EVENTS];

@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Fire-and-forget by design: a failure to record an analytics event
   * must never break the money-movement (or any other) operation it's
   * attached to, so every failure is caught and logged here rather than
   * thrown back at the caller. Callers should still `await` this (so the
   * write is attempted before the request ends) but never need their own
   * try/catch around it.
   *
   * Forwarding to a real third-party provider (Mixpanel/Amplitude/
   * Segment) once one is chosen is a small addition here — a second
   * write (or queued call) alongside the Prisma insert below, gated by
   * an env var like the pattern already used for CARD_LINKING_PROVIDER —
   * not a redesign of anything that calls track().
   */
  async track(
    name: AnalyticsEventName,
    options?: {
      userId?: string;
      platform?: 'mobile' | 'admin' | 'backend';
      properties?: Record<string, any>;
    },
  ) {
    try {
      await this.prisma.analyticsEvent.create({
        data: {
          name,
          userId: options?.userId,
          platform: options?.platform || 'backend',
          properties: options?.properties || {},
        },
      });
    } catch (err: any) {
      this.logger.warn(
        `Failed to record analytics event "${name}": ${err.message}`,
      );
    }
  }

  /** Powers the admin Analytics page — counts per event name over the window, most-fired first. */
  async getEventSummary(days = 30) {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const grouped = await this.prisma.analyticsEvent.groupBy({
      by: ['name'],
      where: { createdAt: { gte: since } },
      _count: { _all: true },
    });
    return grouped
      .map((g) => ({ name: g.name, count: g._count._all }))
      .sort((a, b) => b.count - a.count);
  }

  /** A raw recent-events feed — for spot-checking that instrumentation is actually firing, not a full analytics UI. */
  async getRecentEvents(limit = 100) {
    return this.prisma.analyticsEvent.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: { user: { select: { name: true, email: true } } },
    });
  }

  /**
   * Distinct users who fired a given event at least once in the window —
   * the building block for activation-style metrics ("how many users
   * completed their first transfer this month") without needing a
   * separate "is this their first one" check at the call site for every
   * single money-movement event.
   */
  async getUniqueUserCount(name: AnalyticsEventName, days = 30) {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const rows = await this.prisma.analyticsEvent.findMany({
      where: { name, createdAt: { gte: since }, userId: { not: null } },
      select: { userId: true },
      distinct: ['userId'],
    });
    return rows.length;
  }
}

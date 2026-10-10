import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PushService } from '../push/push.service';

export type NotificationType =
  | 'kyc_approved'
  | 'kyc_rejected'
  | 'dispute_resolved'
  | 'account_frozen'
  | 'account_unfrozen'
  | 'chat_reply'
  | 'fraud_alert'
  | 'recurring_transfer_sent'
  | 'recurring_transfer_failed'
  | 'recurring_transfer_paused'
  | 'transfer_sent'
  | 'transfer_received'
  | 'bill_paid'
  | 'airtime_purchased'
  | 'transaction_reversed'
  | 'card_frozen'
  | 'card_funded'
  | 'loan_disbursed'
  | 'loan_repayment_due';

@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pushService: PushService,
  ) {}

  // Called from other services — never from a customer-facing endpoint
  // directly. Already wired (before this pass) into admin freeze/unfreeze,
  // KYC decisions, dispute resolution, the fraud engine, recurring-transfer
  // events, and support chat replies. NOT previously wired into the
  // highest-frequency actions of all — a direct transfer, a bill payment,
  // an airtime purchase, or an admin reversing a transaction — which only
  // ever sent an email (see TransactionsService) or nothing customer-
  // facing at all (AdminService.reverseTransaction). Call sites for those
  // are added as part of this pass.
  //
  // Master audit: "NotificationsScreen only shows what's already loaded
  // when the screen is open... a fraud hold a user doesn't find out about
  // for six hours is a support ticket and a trust problem." The gap this
  // closes now is push, not the in-app row itself (that part was already
  // real, just narrower in coverage than it should be): this method wrote
  // a Notification row for the app to poll for, but never pushed anything
  // to the device — so an event still sat silent until the user happened
  // to open the app. Push now fires from this same choke point,
  // best-effort, so every future notification type gets it automatically
  // instead of each call site having to remember to add it separately.
  async create(
    userId: string,
    type: NotificationType,
    title: string,
    body: string,
    metadata?: Record<string, any>,
  ) {
    let notification;
    try {
      notification = await this.prisma.notification.create({
        data: { userId, type, title, body, metadata: metadata || {} },
      });
    } catch (error) {
      // Best-effort, same principle as AuditLogService: a notification
      // failing to write should never roll back or block the actual
      // action (freezing an account, resolving a dispute) that triggered it.
      console.error(
        '[Notifications] Failed to create notification:',
        type,
        error,
      );
      return null;
    }

    // Fire-and-forget — sendToUser() never throws, but this is still kept
    // off the await chain of the money-moving action that called create(),
    // matching the mailerService.sendMail(...).catch(...) pattern already
    // used elsewhere in this codebase for non-critical side effects.
    this.pushService
      .sendToUser(userId, title, body, { type, ...(metadata || {}) })
      .catch(() => undefined);

    return notification;
  }

  async list(userId: string, limit = 50) {
    return this.prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  async unreadCount(userId: string) {
    const count = await this.prisma.notification.count({
      where: { userId, isRead: false },
    });
    return { count };
  }

  async markRead(userId: string, ids: string[]) {
    await this.prisma.notification.updateMany({
      where: { userId, id: { in: ids } },
      data: { isRead: true },
    });
    return { success: true };
  }

  async markAllRead(userId: string) {
    await this.prisma.notification.updateMany({
      where: { userId, isRead: false },
      data: { isRead: true },
    });
    return { success: true };
  }
}

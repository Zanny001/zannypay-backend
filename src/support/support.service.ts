import { Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { StorageService } from '../storage/storage.service';
import { AnalyticsService, ANALYTICS_EVENTS } from '../analytics/analytics.service';

// Sent automatically the moment a customer's first message in a
// conversation lands — before any human agent has seen it — so the chat
// never just sits silent after someone hits send. Deliberately a single,
// honest acknowledgment (not pretending to be a real agent, not trying
// to answer the question) — see senderType: 'AUTO' below, a distinct
// value from 'ADMIN' specifically so this never gets attributed to a
// human who didn't actually reply.
const AUTO_REPLY_BODY =
  "Thanks for reaching out to ZannyPay Support! We've received your message and a member of our team will respond as soon as possible. In the meantime, feel free to add any more details that might help us assist you faster.";

@Injectable()
export class SupportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly auditLog: AuditLogService,
    private readonly storageService: StorageService,
    private readonly analyticsService: AnalyticsService,
  ) {}

  // ==========================================
  // Customer-facing
  // ==========================================
  async getOrCreateOpenConversation(userId: string) {
    let conversation = await this.prisma.conversation.findFirst({
      where: { userId, status: 'open' },
      orderBy: { createdAt: 'desc' },
    });
    if (!conversation) {
      conversation = await this.prisma.conversation.create({ data: { userId } });
    }
    const messages = await this.prisma.chatMessage.findMany({
      where: { conversationId: conversation.id },
      orderBy: { createdAt: 'asc' },
    });
    return { conversation, messages };
  }

  async sendCustomerMessage(userId: string, body?: string, attachmentData?: string, attachmentMimeType?: string) {
    if (!body?.trim() && !attachmentData) {
      throw new BadRequestException('Message cannot be empty.');
    }
    const { conversation, messages: existingMessages } = await this.getOrCreateOpenConversation(userId);

    // The signal for "this is genuinely their first message" is zero
    // prior ChatMessage rows — NOT whether the Conversation record was
    // just created. The mobile chat screen polls GET /support/conversation
    // while it's open, which can (and routinely does) create an empty
    // Conversation before the customer ever types anything; checking
    // "just created" would miss the real first message entirely once
    // that polling has already happened, which is the common case.
    const isFirstMessageInConversation = existingMessages.length === 0;

    // Same object-storage migration as User.profileImage (master audit,
    // Critical #2) — a chat photo is exactly the kind of attachment that
    // should never live as base64 in the primary database.
    const resolvedAttachment = attachmentData
      ? await this.storageService.storeImage(attachmentData, `chat-attachments/${conversation.id}`)
      : attachmentData;

    const message = await this.prisma.chatMessage.create({
      data: { conversationId: conversation.id, senderType: 'CUSTOMER', body, attachmentData: resolvedAttachment, attachmentMimeType },
    });
    await this.prisma.conversation.update({ where: { id: conversation.id }, data: { updatedAt: new Date() } });

    let autoReply: any = null;
    if (isFirstMessageInConversation) {
      autoReply = await this.prisma.chatMessage.create({
        data: { conversationId: conversation.id, senderType: 'AUTO', body: AUTO_REPLY_BODY },
      });
      await this.prisma.conversation.update({ where: { id: conversation.id }, data: { updatedAt: new Date() } });
      // No push/notification for this one — the customer is already
      // looking at the chat screen in the same request cycle that
      // produced it, unlike a real admin reply which can arrive minutes
      // or hours later while they're off doing something else.
      await this.analyticsService.track(ANALYTICS_EVENTS.SUPPORT_CONVERSATION_STARTED, { userId });
    }

    return { success: true, message, autoReply };
  }

  // ==========================================
  // Admin/support-agent-facing
  // ==========================================
  async listConversations(status?: string) {
    return this.prisma.conversation.findMany({
      where: status ? { status } : {},
      include: {
        user: { select: { name: true, phone: true, accountNumber: true } },
        messages: { orderBy: { createdAt: 'desc' }, take: 2 }, // latest 2, not 1 — lets the list view's preview skip over an AUTO acknowledgment and show the customer's actual message instead
      },
      orderBy: { updatedAt: 'desc' },
    });
  }

  async getConversation(conversationId: string) {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      include: {
        user: { select: { name: true, phone: true, email: true, accountNumber: true } },
        messages: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!conversation) throw new NotFoundException('Conversation not found.');
    return conversation;
  }

  async sendAdminReply(actingAdminId: string, conversationId: string, body?: string, ip?: string, attachmentData?: string, attachmentMimeType?: string) {
    if (!body?.trim() && !attachmentData) {
      throw new BadRequestException('Message cannot be empty.');
    }
    const conversation = await this.prisma.conversation.findUnique({ where: { id: conversationId } });
    if (!conversation) throw new NotFoundException('Conversation not found.');

    const resolvedAttachment = attachmentData
      ? await this.storageService.storeImage(attachmentData, `chat-attachments/${conversationId}`)
      : attachmentData;

    const message = await this.prisma.chatMessage.create({
      data: { conversationId, senderType: 'ADMIN', senderAdminId: actingAdminId, body, attachmentData: resolvedAttachment, attachmentMimeType },
    });
    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: { updatedAt: new Date(), assignedAdminId: actingAdminId },
    });

    // The customer finds out a reply is waiting even if they've left the
    // chat screen — this is exactly the kind of event the notification
    // system exists for.
    const previewText = body ? (body.length > 100 ? `${body.slice(0, 100)}…` : body) : '📷 Sent an image';
    await this.notifications.create(
      conversation.userId,
      'chat_reply',
      'New reply from support',
      previewText,
      { conversationId },
    );

    await this.auditLog.record({
      adminId: actingAdminId,
      action: 'SUPPORT_REPLY_SENT',
      targetType: 'Conversation',
      targetId: conversationId,
      ipAddress: ip,
    });

    return { success: true, message };
  }

  async resolveConversation(actingAdminId: string, conversationId: string, ip?: string) {
    const conversation = await this.prisma.conversation.update({
      where: { id: conversationId },
      data: { status: 'resolved' },
    });

    await this.auditLog.record({
      adminId: actingAdminId,
      action: 'SUPPORT_CONVERSATION_RESOLVED',
      targetType: 'Conversation',
      targetId: conversationId,
      ipAddress: ip,
    });

    return { success: true, conversation };
  }
}

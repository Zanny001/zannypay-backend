import { BadRequestException } from '@nestjs/common';
import { SupportService } from './support.service';

describe('SupportService.sendCustomerMessage — auto-reply', () => {
  let service: SupportService;
  let prisma: any;
  let storageService: { storeImage: jest.Mock };

  const conversation = { id: 'conv-1', userId: 'user-1', status: 'open' };

  beforeEach(() => {
    prisma = {
      conversation: {
        findFirst: jest.fn().mockResolvedValue(conversation),
        create: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
      },
      chatMessage: { findMany: jest.fn(), create: jest.fn() },
    };
    storageService = { storeImage: jest.fn() };
    service = new SupportService(
      prisma,
      { create: jest.fn() } as any, // NotificationsService
      { record: jest.fn() } as any, // AuditLogService
      storageService as any,
      { track: jest.fn() } as any, // AnalyticsService
    );
  });

  it('rejects an empty message with no attachment', async () => {
    await expect(service.sendCustomerMessage('user-1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('sends the automatic acknowledgment when this is genuinely the first message in the conversation', async () => {
    prisma.chatMessage.findMany.mockResolvedValue([]); // no prior messages at all
    prisma.chatMessage.create
      .mockResolvedValueOnce({
        id: 'msg-1',
        senderType: 'CUSTOMER',
        body: 'Hi, I need help',
      })
      .mockResolvedValueOnce({
        id: 'msg-2',
        senderType: 'AUTO',
        body: 'Thanks for reaching out to ZannyPay Support!',
      });

    const result = await service.sendCustomerMessage(
      'user-1',
      'Hi, I need help',
    );

    expect(result.autoReply).not.toBeNull();
    expect(prisma.chatMessage.create).toHaveBeenCalledTimes(2);
    expect(prisma.chatMessage.create.mock.calls[1][0].data.senderType).toBe(
      'AUTO',
    );
  });

  it('does NOT send another acknowledgment on a follow-up message in the same open conversation', async () => {
    prisma.chatMessage.findMany.mockResolvedValue([
      { id: 'msg-1', senderType: 'CUSTOMER', body: 'Hi' },
      { id: 'msg-2', senderType: 'AUTO', body: 'Thanks for reaching out...' },
    ]);
    prisma.chatMessage.create.mockResolvedValue({
      id: 'msg-3',
      senderType: 'CUSTOMER',
      body: 'Any update?',
    });

    const result = await service.sendCustomerMessage('user-1', 'Any update?');

    expect(result.autoReply).toBeNull();
    expect(prisma.chatMessage.create).toHaveBeenCalledTimes(1);
  });

  it('does NOT send an acknowledgment once a real admin has actually replied', async () => {
    prisma.chatMessage.findMany.mockResolvedValue([
      { id: 'msg-1', senderType: 'CUSTOMER', body: 'Hi' },
      { id: 'msg-2', senderType: 'AUTO', body: 'Thanks for reaching out...' },
      {
        id: 'msg-3',
        senderType: 'ADMIN',
        senderAdminId: 'admin-1',
        body: 'Hi, how can I help?',
      },
    ]);
    prisma.chatMessage.create.mockResolvedValue({
      id: 'msg-4',
      senderType: 'CUSTOMER',
      body: 'One more thing',
    });

    const result = await service.sendCustomerMessage(
      'user-1',
      'One more thing',
    );

    expect(result.autoReply).toBeNull();
    expect(prisma.chatMessage.create).toHaveBeenCalledTimes(1);
  });

  // The specific bug this test guards against: the mobile chat screen
  // polls GET /support/conversation while open, which calls the same
  // getOrCreateOpenConversation() and can create an empty Conversation
  // row before the customer ever sends anything. If the trigger were
  // "was the Conversation just created" instead of "are there zero
  // messages", the auto-reply would silently never fire in this — the
  // most common — case, because the conversation already exists by the
  // time sendCustomerMessage runs.
  it('still fires the acknowledgment when the conversation record already existed from a prior GET poll, as long as no message has been sent yet', async () => {
    // findFirst (not create) resolves the conversation — it was already
    // there — but chatMessage.findMany correctly still returns empty.
    prisma.conversation.findFirst.mockResolvedValue(conversation);
    prisma.chatMessage.findMany.mockResolvedValue([]);
    prisma.chatMessage.create
      .mockResolvedValueOnce({
        id: 'msg-1',
        senderType: 'CUSTOMER',
        body: 'First real message',
      })
      .mockResolvedValueOnce({ id: 'msg-2', senderType: 'AUTO' });

    const result = await service.sendCustomerMessage(
      'user-1',
      'First real message',
    );

    expect(prisma.conversation.create).not.toHaveBeenCalled(); // confirms this is the pre-created-by-polling scenario
    expect(result.autoReply).not.toBeNull();
  });
});

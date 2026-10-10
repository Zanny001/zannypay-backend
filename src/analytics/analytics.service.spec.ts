import { AnalyticsService, ANALYTICS_EVENTS } from './analytics.service';

describe('AnalyticsService', () => {
  let service: AnalyticsService;
  let prisma: any;

  beforeEach(() => {
    prisma = {
      analyticsEvent: {
        create: jest.fn(),
        groupBy: jest.fn(),
        findMany: jest.fn(),
      },
    };
    service = new AnalyticsService(prisma);
  });

  describe('track', () => {
    it('writes an event with the given name, userId, platform, and properties', async () => {
      prisma.analyticsEvent.create.mockResolvedValue({});

      await service.track(ANALYTICS_EVENTS.TRANSFER_COMPLETED, {
        userId: 'user-1',
        platform: 'backend',
        properties: { amount: 5000 },
      });

      expect(prisma.analyticsEvent.create).toHaveBeenCalledWith({
        data: {
          name: 'transfer_completed',
          userId: 'user-1',
          platform: 'backend',
          properties: { amount: 5000 },
        },
      });
    });

    it('defaults platform to "backend" and properties to {} when not provided', async () => {
      prisma.analyticsEvent.create.mockResolvedValue({});

      await service.track(ANALYTICS_EVENTS.SIGNUP_COMPLETED, {
        userId: 'user-1',
      });

      expect(prisma.analyticsEvent.create).toHaveBeenCalledWith({
        data: {
          name: 'signup_completed',
          userId: 'user-1',
          platform: 'backend',
          properties: {},
        },
      });
    });

    // The single most important behavior of this whole service: every
    // caller across transactions, savings, cards, loans, auth, and
    // support fires track() without wrapping it in their own try/catch,
    // on the assumption that a tracking failure can never break the real
    // operation it's attached to. If this test ever fails, every one of
    // those call sites is at risk of a dropped analytics write turning
    // into a failed transfer.
    it('never throws, even when the database write fails', async () => {
      prisma.analyticsEvent.create.mockRejectedValue(
        new Error('connection lost'),
      );

      await expect(
        service.track(ANALYTICS_EVENTS.TRANSFER_COMPLETED, {
          userId: 'user-1',
        }),
      ).resolves.toBeUndefined();
    });
  });

  describe('getEventSummary', () => {
    it('returns counts sorted most-fired first', async () => {
      prisma.analyticsEvent.groupBy.mockResolvedValue([
        { name: 'signup_completed', _count: { _all: 5 } },
        { name: 'transfer_completed', _count: { _all: 42 } },
        { name: 'card_created', _count: { _all: 12 } },
      ]);

      const result = await service.getEventSummary(30);

      expect(result).toEqual([
        { name: 'transfer_completed', count: 42 },
        { name: 'card_created', count: 12 },
        { name: 'signup_completed', count: 5 },
      ]);
    });

    it('returns an empty array rather than erroring when nothing has fired yet', async () => {
      prisma.analyticsEvent.groupBy.mockResolvedValue([]);
      const result = await service.getEventSummary(30);
      expect(result).toEqual([]);
    });
  });

  describe('getUniqueUserCount', () => {
    it('counts distinct users, not total events', async () => {
      // Same user fired the event twice — should still count once.
      prisma.analyticsEvent.findMany.mockResolvedValue([
        { userId: 'user-1' },
        { userId: 'user-2' },
      ]);

      const count = await service.getUniqueUserCount(
        ANALYTICS_EVENTS.TRANSFER_COMPLETED,
        30,
      );

      expect(count).toBe(2);
      expect(prisma.analyticsEvent.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ distinct: ['userId'] }),
      );
    });
  });
});

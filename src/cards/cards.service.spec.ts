import { NotFoundException, BadRequestException, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { CardsService } from './cards.service';

jest.mock('bcryptjs');

describe('CardsService', () => {
  let service: CardsService;
  let prisma: any;
  let issuingProvider: { issueCard: jest.Mock; setFrozen: jest.Mock };
  let linkingProvider: { linkCard: jest.Mock };

  beforeEach(() => {
    prisma = {
      card: {
        findFirst: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
        delete: jest.fn(),
      },
      user: {
        findUnique: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
      },
      $transaction: jest.fn((callback) => callback(prisma)),
    };
    issuingProvider = {
      issueCard: jest.fn().mockResolvedValue({ cardNumber: '4532000000001234', last4: '1234', expiry: '01/30', providerRef: null }),
      setFrozen: jest.fn().mockResolvedValue(undefined),
    };
    linkingProvider = { linkCard: jest.fn() };
    const analyticsService = { track: jest.fn().mockResolvedValue(undefined) };
    service = new CardsService(prisma as any, issuingProvider as any, linkingProvider as any, analyticsService as any);
    jest.clearAllMocks();
  });

  describe('ownership checks', () => {
    it('throws NotFoundException rather than exposing another user\u2019s card when the id/userId pair does not match', async () => {
      prisma.card.findFirst.mockResolvedValue(null);
      await expect(service.toggleFreeze('user-1', 'someone-elses-card', true)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('createCard — the first-card-becomes-default rule', () => {
    it('makes the very first card a user gets their default', async () => {
      prisma.card.count.mockResolvedValue(0);
      prisma.card.create.mockImplementation(({ data }: any) => Promise.resolve({ id: 'card-1', ...data }));

      const card = await service.createCard('user-1', 'VISA');

      expect(card.isDefault).toBe(true);
      expect(prisma.card.create.mock.calls[0][0].data.isDefault).toBe(true);
    });

    it('does NOT make a second card the default — adding a card should never silently change which one bills charge to', async () => {
      prisma.card.count.mockResolvedValue(1); // user already has one card
      prisma.card.create.mockImplementation(({ data }: any) => Promise.resolve({ id: 'card-2', ...data }));

      const card = await service.createCard('user-1', 'VISA');

      expect(card.isDefault).toBe(false);
    });

    it('falls back to the ZANNYPAY network for an unrecognized network string rather than rejecting it outright', async () => {
      prisma.card.count.mockResolvedValue(0);
      prisma.card.create.mockImplementation(({ data }: any) => Promise.resolve({ id: 'card-1', ...data }));

      await service.createCard('user-1', 'NOT-A-REAL-NETWORK');

      expect(issuingProvider.issueCard).toHaveBeenCalledWith({ userId: 'user-1', network: 'ZANNYPAY' });
    });
  });

  describe('setDefault — exactly one default per user', () => {
    it('clears every existing default before setting the new one, inside a single transaction', async () => {
      prisma.card.findFirst.mockResolvedValue({ id: 'card-2', userId: 'user-1' });
      prisma.card.updateMany.mockResolvedValue({ count: 1 });
      prisma.card.update.mockResolvedValue({ id: 'card-2', isDefault: true });

      await service.setDefault('user-1', 'card-2');

      expect(prisma.$transaction).toHaveBeenCalled();
      expect(prisma.card.updateMany).toHaveBeenCalledWith({ where: { userId: 'user-1', isDefault: true }, data: { isDefault: false } });
      expect(prisma.card.update).toHaveBeenCalledWith({ where: { id: 'card-2' }, data: { isDefault: true } });
    });

    it('refuses to set a card as default if it does not belong to the calling user', async () => {
      prisma.card.findFirst.mockResolvedValue(null);
      await expect(service.setDefault('user-1', 'not-their-card')).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('removeCard — never leaves a user with cards but no default', () => {
    it('promotes the oldest remaining card to default when the removed card was the default', async () => {
      prisma.card.delete.mockResolvedValue({});
      prisma.card.findFirst.mockResolvedValueOnce({ id: 'card-1', userId: 'user-1', isDefault: true }); // ownership check
      const nextCard = { id: 'card-2', userId: 'user-1', isDefault: false };
      prisma.card.findFirst.mockResolvedValueOnce(nextCard); // "find the next oldest" call after delete

      await service.removeCard('user-1', 'card-1');

      expect(prisma.card.update).toHaveBeenCalledWith({ where: { id: 'card-2' }, data: { isDefault: true } });
    });

    it('does not touch any other card when the removed card was not the default', async () => {
      prisma.card.findFirst.mockResolvedValue({ id: 'card-2', userId: 'user-1', isDefault: false });
      prisma.card.delete.mockResolvedValue({});

      await service.removeCard('user-1', 'card-2');

      expect(prisma.card.update).not.toHaveBeenCalled();
    });

    it('does not crash when the removed default card was the user\u2019s only card', async () => {
      prisma.card.delete.mockResolvedValue({});
      prisma.card.findFirst.mockResolvedValueOnce({ id: 'card-1', userId: 'user-1', isDefault: true }); // ownership check
      prisma.card.findFirst.mockResolvedValueOnce(null); // no remaining cards

      await expect(service.removeCard('user-1', 'card-1')).resolves.toEqual({ success: true });
      expect(prisma.card.update).not.toHaveBeenCalled();
    });
  });

  describe('updateLimits — validation', () => {
    beforeEach(() => {
      prisma.card.findFirst.mockResolvedValue({ id: 'card-1', userId: 'user-1' });
    });

    it('rejects a daily limit that exceeds the monthly limit', async () => {
      await expect(service.updateLimits('user-1', 'card-1', 500000, 100000)).rejects.toThrow(/cannot exceed the monthly limit/);
    });

    it('rejects a zero or negative limit', async () => {
      await expect(service.updateLimits('user-1', 'card-1', 0, 100000)).rejects.toThrow(/greater than zero/);
      await expect(service.updateLimits('user-1', 'card-1', -500, 100000)).rejects.toThrow(/greater than zero/);
    });

    it('accepts a valid daily/monthly pair', async () => {
      prisma.card.update.mockResolvedValue({ id: 'card-1', dailyLimit: 50000, monthlyLimit: 200000 });
      await expect(service.updateLimits('user-1', 'card-1', 50000, 200000)).resolves.toBeDefined();
    });
  });

  describe('revealCardNumber — PIN-gated, mirrors UserService.revealKycField', () => {
    const ownedCard = { id: 'card-1', userId: 'user-1', cardNumber: '4532000000001234', expiry: '01/30', isLinkedExternal: false };
    const userRow = { id: 'user-1', pin: 'hashed-pin', kycRevealFailedAttempts: 0, kycRevealLockedUntil: null };

    it('rejects a linked external card — ZannyPay never stores its PAN, so PIN cannot unlock what was never saved', async () => {
      prisma.card.findFirst.mockResolvedValue({ ...ownedCard, isLinkedExternal: true, cardNumber: null });

      await expect(service.revealCardNumber('user-1', 'card-1', '1234')).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
    });

    it('refuses to reveal a card that does not belong to the caller', async () => {
      prisma.card.findFirst.mockResolvedValue(null);
      await expect(service.revealCardNumber('user-1', 'not-their-card', '1234')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rejects when the account is already locked out, without even checking the PIN', async () => {
      prisma.card.findFirst.mockResolvedValue(ownedCard);
      prisma.user.findUnique.mockResolvedValue({ ...userRow, kycRevealLockedUntil: new Date(Date.now() + 5 * 60 * 1000) });

      await expect(service.revealCardNumber('user-1', 'card-1', '1234')).rejects.toBeInstanceOf(UnauthorizedException);
      expect(bcrypt.compare).not.toHaveBeenCalled();
    });

    it('rejects an incorrect PIN and increments the shared failed-attempt counter', async () => {
      prisma.card.findFirst.mockResolvedValue(ownedCard);
      prisma.user.findUnique.mockResolvedValue(userRow);
      (bcrypt.compare as jest.Mock).mockResolvedValue(false);

      await expect(service.revealCardNumber('user-1', 'card-1', 'wrong')).rejects.toBeInstanceOf(UnauthorizedException);
      expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: 'user-1' }, data: { kycRevealFailedAttempts: 1 } });
    });

    it('locks the account out once the failed-attempt threshold is reached', async () => {
      prisma.card.findFirst.mockResolvedValue(ownedCard);
      prisma.user.findUnique.mockResolvedValue({ ...userRow, kycRevealFailedAttempts: 4 }); // this attempt is the 5th
      (bcrypt.compare as jest.Mock).mockResolvedValue(false);

      await expect(service.revealCardNumber('user-1', 'card-1', 'wrong')).rejects.toBeInstanceOf(UnauthorizedException);
      const updateCall = prisma.user.update.mock.calls[0][0];
      expect(updateCall.data.kycRevealFailedAttempts).toBe(5);
      expect(updateCall.data.kycRevealLockedUntil).toBeInstanceOf(Date);
    });

    it('returns the full card number and expiry on a correct PIN, and clears any prior failed attempts', async () => {
      prisma.card.findFirst.mockResolvedValue(ownedCard);
      prisma.user.findUnique.mockResolvedValue({ ...userRow, kycRevealFailedAttempts: 2 });
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);

      const result = await service.revealCardNumber('user-1', 'card-1', '1234');

      expect(result).toEqual({ success: true, cardNumber: '4532000000001234', expiry: '01/30' });
      expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: 'user-1' }, data: { kycRevealFailedAttempts: 0, kycRevealLockedUntil: null } });
    });

    it('does not bother resetting attempts on success if there was nothing to reset', async () => {
      prisma.card.findFirst.mockResolvedValue(ownedCard);
      prisma.user.findUnique.mockResolvedValue(userRow); // already 0 attempts, no lock
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);

      await service.revealCardNumber('user-1', 'card-1', '1234');

      expect(prisma.user.update).not.toHaveBeenCalled();
    });
  });
});

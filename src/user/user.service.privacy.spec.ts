import { Test } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { MailerService } from '@nestjs-modules/mailer';
import { UserService } from './user.service';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { SavingsService } from '../savings/savings.service';
import { AnalyticsService } from '../analytics/analytics.service';

const baseUser = {
  id: 'user-1',
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  phone: '08030000000',
  pin: 'hashed-pin',
  accountNumber: '9012345678',
  referralCode: 'ADA123',
  bvnEncrypted: 'enc-bvn',
  bvnLast4: '1234',
  ninEncrypted: null,
  ninLast4: null,
  deletedAt: null,
  isFrozen: false,
  wallet: { balance: 0 },
  loans: [],
  transactions: [],
  savingsGoals: [],
  cards: [],
  invoices: [],
  budgets: [],
  disputes: [],
  recurringTransfers: [],
  beneficiaries: [],
};

function makeModule(user: any) {
  const prisma = {
    user: {
      findUnique: jest.fn().mockResolvedValue(user),
      update: jest.fn().mockResolvedValue({}),
    },
    pushToken: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    otpCode: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    $transaction: jest.fn(async (ops: Promise<any>[]) => Promise.all(ops)),
  };
  const mailer = { sendMail: jest.fn().mockResolvedValue({}) };
  const analytics = { track: jest.fn().mockResolvedValue(undefined) };

  return Test.createTestingModule({
    providers: [
      UserService,
      { provide: PrismaService, useValue: prisma },
      {
        provide: StorageService,
        useValue: { storeImage: jest.fn(), isDataUri: jest.fn() },
      },
      {
        provide: SavingsService,
        useValue: { getLastInterestEarned: jest.fn() },
      },
      { provide: MailerService, useValue: mailer },
      { provide: AnalyticsService, useValue: analytics },
    ],
  })
    .compile()
    .then((module) => ({ module, prisma, mailer, analytics }));
}

describe('UserService — Privacy & Account', () => {
  describe('exportMyData', () => {
    it('emails the export and never includes the PIN hash or encrypted PII blobs', async () => {
      const { module, mailer } = await makeModule({ ...baseUser });
      const service = module.get<UserService>(UserService);

      const result = await service.exportMyData('user-1');

      expect(result).toEqual({ delivered: 'email' });
      expect(mailer.sendMail).toHaveBeenCalledTimes(1);
      const sent = mailer.sendMail.mock.calls[0][0];
      expect(sent.to).toBe('ada@example.com');
      const payload = JSON.parse(sent.attachments[0].content);
      expect(payload.profile.pin).toBeUndefined();
      expect(payload.profile.bvnEncrypted).toBeUndefined();
      expect(payload.profile.ninEncrypted).toBeUndefined();
      expect(payload.profile.bvnLast4).toBe('1234'); // hint fields are fine
    });

    it('falls back to returning the export inline when email fails', async () => {
      const { module, mailer } = await makeModule({ ...baseUser });
      mailer.sendMail.mockRejectedValue(new Error('SMTP down'));
      const service = module.get<UserService>(UserService);

      const result = await service.exportMyData('user-1');

      expect(result.delivered).toBe('inline');
      expect((result as any).data.profile.email).toBe('ada@example.com');
    });

    it('refuses to export a deleted account', async () => {
      const { module } = await makeModule({
        ...baseUser,
        deletedAt: new Date(),
      });
      const service = module.get<UserService>(UserService);
      await expect(service.exportMyData('user-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('deleteMyAccount', () => {
    it('anonymizes the account in place — never hard-deletes the row', async () => {
      const { module, prisma } = await makeModule({ ...baseUser });
      const service = module.get<UserService>(UserService);

      const result = await service.deleteMyAccount('user-1');

      expect(result).toEqual({ deleted: true });
      const update = prisma.user.update.mock.calls[0][0];
      expect(update.data.name).toBe('Deleted User');
      expect(update.data.phone).toBe('deleted-user-1');
      expect(update.data.email).toBe('deleted-user-1@deleted.zannypay.local');
      expect(update.data.pin).not.toBe(baseUser.pin);
      expect(update.data.bvnEncrypted).toBeNull();
      expect(update.data.bvnLast4).toBeNull();
      expect(update.data.referralCode).toBeNull();
      expect(update.data.isFrozen).toBe(true);
      expect(update.data.deletedAt).toBeInstanceOf(Date);
    });

    it('refuses while the wallet still holds a balance', async () => {
      const { module, prisma } = await makeModule({
        ...baseUser,
        wallet: { balance: 5000 },
      });
      const service = module.get<UserService>(UserService);

      await expect(service.deleteMyAccount('user-1')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('refuses while a loan is outstanding', async () => {
      const { module, prisma } = await makeModule({
        ...baseUser,
        loans: [{ repaid: false }],
      });
      const service = module.get<UserService>(UserService);

      await expect(service.deleteMyAccount('user-1')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('is idempotent-safe: an already-deleted account 404s', async () => {
      const { module } = await makeModule({
        ...baseUser,
        deletedAt: new Date(),
      });
      const service = module.get<UserService>(UserService);
      await expect(service.deleteMyAccount('user-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});

import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException, BadRequestException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { UserService } from './user.service';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { SavingsService } from '../savings/savings.service';
import { MailerService } from '@nestjs-modules/mailer';
import { AnalyticsService } from '../analytics/analytics.service';

// Mocked rather than exercised for real: real encryption needs
// CUSTOMER_PII_ENCRYPTION_KEY set, which this test environment has no
// reason to configure — the thing worth testing here is the PIN-check and
// lockout logic, not AES-GCM itself (crypto.util's own correctness is a
// separate concern).
jest.mock('../common/crypto.util', () => ({
  decryptCustomerPII: jest.fn((v: string) => `decrypted:${v}`),
}));
jest.mock('bcrypt');

// Covers the one piece of this session's BVN/NIN work that had no
// executable verification when it was written: the brute-force lockout
// guarding the reveal endpoint. A silent regression here (e.g. the
// threshold check flipped, or the lockout never actually getting set)
// would mean this national-ID-number protection quietly stops working.
describe('UserService.revealKycField', () => {
  let service: UserService;
  let prisma: { user: { findUnique: jest.Mock; update: jest.Mock } };

  const baseUser = {
    id: 'user-1',
    pin: 'hashed-pin',
    bvnEncrypted: 'enc-bvn-payload',
    ninEncrypted: 'enc-nin-payload',
    kycRevealFailedAttempts: 0,
    kycRevealLockedUntil: null as Date | null,
  };

  beforeEach(async () => {
    prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue({ ...baseUser }),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UserService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: StorageService,
          useValue: {
            storeImage: jest.fn(),
            isDataUri: jest.fn().mockReturnValue(false),
          },
        },
        {
          provide: SavingsService,
          useValue: {
            getLastInterestEarned: jest.fn().mockResolvedValue(null),
          },
        },
        { provide: MailerService, useValue: { sendMail: jest.fn() } },
        { provide: AnalyticsService, useValue: { track: jest.fn() } },
      ],
    }).compile();
    service = module.get<UserService>(UserService);
    jest.clearAllMocks();
    prisma.user.findUnique.mockResolvedValue({ ...baseUser });
  });

  it('returns the decrypted value on a correct PIN', async () => {
    (bcrypt.compare as jest.Mock).mockResolvedValue(true);
    const result = await service.revealKycField('user-1', {
      field: 'bvn',
      pin: '1234',
    });
    expect(result.value).toBe('decrypted:enc-bvn-payload');
  });

  it('resets any prior failed-attempt count after a correct PIN', async () => {
    prisma.user.findUnique.mockResolvedValue({
      ...baseUser,
      kycRevealFailedAttempts: 3,
    });
    (bcrypt.compare as jest.Mock).mockResolvedValue(true);
    await service.revealKycField('user-1', { field: 'bvn', pin: '1234' });
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { kycRevealFailedAttempts: 0, kycRevealLockedUntil: null },
    });
  });

  it('throws and increments the counter on a wrong PIN', async () => {
    prisma.user.findUnique.mockResolvedValue({
      ...baseUser,
      kycRevealFailedAttempts: 1,
    });
    (bcrypt.compare as jest.Mock).mockResolvedValue(false);
    await expect(
      service.revealKycField('user-1', { field: 'bvn', pin: '0000' }),
    ).rejects.toThrow(UnauthorizedException);
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { kycRevealFailedAttempts: 2 },
    });
  });

  it('locks the account on the 5th consecutive wrong PIN', async () => {
    prisma.user.findUnique.mockResolvedValue({
      ...baseUser,
      kycRevealFailedAttempts: 4,
    });
    (bcrypt.compare as jest.Mock).mockResolvedValue(false);
    await expect(
      service.revealKycField('user-1', { field: 'bvn', pin: '0000' }),
    ).rejects.toThrow(UnauthorizedException);
    const call = prisma.user.update.mock.calls[0][0];
    expect(call.data.kycRevealFailedAttempts).toBe(5);
    expect(call.data.kycRevealLockedUntil).toBeInstanceOf(Date);
    expect(call.data.kycRevealLockedUntil.getTime()).toBeGreaterThan(
      Date.now(),
    );
  });

  it('rejects immediately while locked out, without checking the PIN at all', async () => {
    prisma.user.findUnique.mockResolvedValue({
      ...baseUser,
      kycRevealLockedUntil: new Date(Date.now() + 60_000),
    });
    await expect(
      service.revealKycField('user-1', { field: 'bvn', pin: '1234' }),
    ).rejects.toThrow(UnauthorizedException);
    expect(bcrypt.compare).not.toHaveBeenCalled();
  });

  it('allows a reveal again once the lockout window has passed', async () => {
    prisma.user.findUnique.mockResolvedValue({
      ...baseUser,
      kycRevealLockedUntil: new Date(Date.now() - 1000),
    });
    (bcrypt.compare as jest.Mock).mockResolvedValue(true);
    const result = await service.revealKycField('user-1', {
      field: 'bvn',
      pin: '1234',
    });
    expect(result.value).toBe('decrypted:enc-bvn-payload');
  });

  it('throws BadRequest when the requested field was never submitted', async () => {
    prisma.user.findUnique.mockResolvedValue({
      ...baseUser,
      ninEncrypted: null,
    });
    (bcrypt.compare as jest.Mock).mockResolvedValue(true);
    await expect(
      service.revealKycField('user-1', { field: 'nin', pin: '1234' }),
    ).rejects.toThrow(BadRequestException);
  });
});

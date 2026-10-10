import { BadRequestException } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { Test, TestingModule } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import { OtpService, OTP_PURPOSES } from './otp.service';
import { PrismaService } from '../prisma/prisma.service';
import { OTP_DELIVERY_PROVIDER } from './otp.tokens';

// In-memory stand-in for the OtpCode table — the tests exercise the
// service's security rules (hashing, expiry, attempt lockout, single
// live code, purpose scoping), not Prisma itself.
function makePrismaMock() {
  const rows: any[] = [];
  let idSeq = 0;
  return {
    _rows: rows,
    otpCode: {
      create: jest.fn(async ({ data }: any) => {
        const row = {
          id: `otp-${++idSeq}`,
          attempts: 0,
          verified: false,
          createdAt: new Date(),
          ...data,
        };
        rows.push(row);
        return row;
      }),
      findFirst: jest.fn(async ({ where, orderBy }: any) => {
        const matches = rows.filter((r) =>
          Object.entries(where).every(([k, v]) => r[k] === v),
        );
        matches.sort((a, b) =>
          orderBy?.createdAt === 'desc'
            ? b.createdAt.getTime() - a.createdAt.getTime()
            : a.createdAt.getTime() - b.createdAt.getTime(),
        );
        return matches[0] ?? null;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = rows.find((r) => r.id === where.id);
        if (!row) throw new Error('not found');
        if (data.attempts?.increment) row.attempts += data.attempts.increment;
        if (data.verified !== undefined) row.verified = data.verified;
        return row;
      }),
      delete: jest.fn(async ({ where }: any) => {
        const idx = rows.findIndex((r) => r.id === where.id);
        if (idx === -1) throw new Error('not found');
        return rows.splice(idx, 1)[0];
      }),
      deleteMany: jest.fn(async ({ where }: any) => {
        const before = rows.length;
        for (let i = rows.length - 1; i >= 0; i--) {
          const r = rows[i];
          if (Object.entries(where).every(([k, v]) => r[k] === v))
            rows.splice(i, 1);
        }
        return { count: before - rows.length };
      }),
    },
  };
}

describe('OtpService', () => {
  let service: OtpService;
  let prisma: ReturnType<typeof makePrismaMock>;
  let delivery: { send: jest.Mock; name: string };

  beforeEach(async () => {
    prisma = makePrismaMock();
    delivery = { name: 'mock', send: jest.fn(async () => undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OtpService,
        { provide: PrismaService, useValue: prisma },
        { provide: OTP_DELIVERY_PROVIDER, useValue: delivery },
      ],
    }).compile();

    service = module.get<OtpService>(OtpService);
  });

  const requestFresh = async (
    target = '08030000000',
    purpose = OTP_PURPOSES.PIN_RESET,
  ) => service.requestCode(target, purpose);

  it('issues a 6-digit code, stores only a bcrypt hash, and delivers the plaintext once', async () => {
    await requestFresh();

    expect(delivery.send).toHaveBeenCalledTimes(1);
    const [target, code, purpose] = delivery.send.mock.calls[0];
    expect(target).toBe('08030000000');
    expect(purpose).toBe(OTP_PURPOSES.PIN_RESET);
    expect(code).toMatch(/^\d{6}$/);

    const stored = prisma._rows[0];
    expect(stored.codeHash).not.toBe(code);
    expect(await bcrypt.compare(code, stored.codeHash)).toBe(true);
  });

  it('enforces a 60-second resend cooldown per target+purpose', async () => {
    await requestFresh();
    await expect(requestFresh()).rejects.toBeInstanceOf(ThrottlerException);
    expect(delivery.send).toHaveBeenCalledTimes(1);
  });

  it('invalidates the previous code when a new one is issued', async () => {
    await requestFresh();
    const firstCode = delivery.send.mock.calls[0][1];

    // Move the first code outside the cooldown window, then re-request.
    prisma._rows[0].createdAt = new Date(Date.now() - 61 * 1000);
    await requestFresh();

    await expect(
      service.verifyCode('08030000000', OTP_PURPOSES.PIN_RESET, firstCode),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('verifies a correct code and marks it verified', async () => {
    await requestFresh();
    const code = delivery.send.mock.calls[0][1];

    await expect(
      service.verifyCode('08030000000', OTP_PURPOSES.PIN_RESET, code),
    ).resolves.toBe(true);
    expect(prisma._rows[0].verified).toBe(true);
  });

  it('locks the code after 5 wrong attempts', async () => {
    await requestFresh();
    const code = delivery.send.mock.calls[0][1];
    const wrong = code === '000000' ? '000001' : '000000';

    for (let i = 0; i < 5; i++) {
      await expect(
        service.verifyCode('08030000000', OTP_PURPOSES.PIN_RESET, wrong),
      ).rejects.toThrow('Incorrect code.');
    }
    // 6th attempt — even with the CORRECT code — is refused.
    await expect(
      service.verifyCode('08030000000', OTP_PURPOSES.PIN_RESET, code),
    ).rejects.toThrow('Too many wrong attempts');
  });

  it('rejects an expired code', async () => {
    await requestFresh();
    const code = delivery.send.mock.calls[0][1];
    prisma._rows[0].expiresAt = new Date(Date.now() - 1000);

    await expect(
      service.verifyCode('08030000000', OTP_PURPOSES.PIN_RESET, code),
    ).rejects.toThrow('expired');
  });

  it('scopes verification to the purpose — a SIGNUP code cannot authorize a PIN_RESET', async () => {
    await service.requestCode('08030000000', OTP_PURPOSES.SIGNUP_VERIFICATION);
    const signupCode = delivery.send.mock.calls[0][1];

    await expect(
      service.verifyCode('08030000000', OTP_PURPOSES.PIN_RESET, signupCode),
    ).rejects.toThrow('No pending code');
  });

  it('consumeVerifiedCode succeeds once after verification, then refuses reuse', async () => {
    await requestFresh();
    const code = delivery.send.mock.calls[0][1];
    await service.verifyCode('08030000000', OTP_PURPOSES.PIN_RESET, code);

    await expect(
      service.consumeVerifiedCode('08030000000', OTP_PURPOSES.PIN_RESET),
    ).resolves.toBeUndefined();
    await expect(
      service.consumeVerifiedCode('08030000000', OTP_PURPOSES.PIN_RESET),
    ).rejects.toThrow('Phone verification is required first');
  });

  it('consumeVerifiedCode refuses an unverified code', async () => {
    await requestFresh();
    await expect(
      service.consumeVerifiedCode('08030000000', OTP_PURPOSES.PIN_RESET),
    ).rejects.toThrow('Phone verification is required first');
  });
});

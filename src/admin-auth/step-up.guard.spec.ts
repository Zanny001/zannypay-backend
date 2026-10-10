import {
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { StepUpGuard } from './step-up.guard';
import { decryptSecret } from '../common/crypto.util';
import { verifyTotpToken, matchRecoveryCode } from '../common/totp.util';

jest.mock('bcrypt');
jest.mock('../common/crypto.util', () => ({ decryptSecret: jest.fn() }));
jest.mock('../common/totp.util', () => ({
  verifyTotpToken: jest.fn(),
  matchRecoveryCode: jest.fn(),
}));

function makeContext(request: any): ExecutionContext {
  return { switchToHttp: () => ({ getRequest: () => request }) } as any;
}

describe('StepUpGuard', () => {
  let guard: StepUpGuard;
  let prisma: { adminUser: { findUnique: jest.Mock } };

  const adminWith2fa = {
    id: 'admin-1',
    isActive: true,
    twoFactorEnabled: true,
    twoFactorSecret: 'encrypted-secret',
    twoFactorRecoveryCodes: ['hashed-code-1'],
    password: 'hashed-password',
  };
  const adminWithout2fa = {
    id: 'admin-1',
    isActive: true,
    twoFactorEnabled: false,
    twoFactorSecret: null,
    twoFactorRecoveryCodes: [],
    password: 'hashed-password',
  };

  beforeEach(() => {
    prisma = { adminUser: { findUnique: jest.fn() } };
    guard = new StepUpGuard(prisma as any);
    jest.clearAllMocks();
  });

  it('rejects with no adminId on the request at all — this guard only ever runs after AdminJwtAuthGuard has already populated it', async () => {
    const context = makeContext({ user: {}, body: {} });
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects if the admin account no longer exists or was deactivated since the token was issued', async () => {
    prisma.adminUser.findUnique.mockResolvedValue(null);
    const context = makeContext({
      user: { adminId: 'admin-1' },
      body: { stepUpPassword: 'x' },
    });
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );

    prisma.adminUser.findUnique.mockResolvedValue({
      ...adminWithout2fa,
      isActive: false,
    });
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  describe('admin with 2FA enabled', () => {
    beforeEach(() => {
      prisma.adminUser.findUnique.mockResolvedValue(adminWith2fa);
      (decryptSecret as jest.Mock).mockReturnValue('decrypted-secret');
    });

    it('rejects with no stepUpCode in the body — a password alone is not enough once 2FA is on', async () => {
      const context = makeContext({ user: { adminId: 'admin-1' }, body: {} });
      await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('accepts a valid TOTP code and strips it from the request body afterward', async () => {
      (verifyTotpToken as jest.Mock).mockReturnValue(true);
      const body: any = { stepUpCode: '123456', reason: 'fraud' };
      const context = makeContext({ user: { adminId: 'admin-1' }, body });

      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(body.stepUpCode).toBeUndefined();
      expect(body.reason).toBe('fraud'); // the actual route payload is untouched
    });

    it('falls back to a valid recovery code when the TOTP check fails', async () => {
      (verifyTotpToken as jest.Mock).mockReturnValue(false);
      (matchRecoveryCode as jest.Mock).mockResolvedValue(0); // matched at index 0
      const context = makeContext({
        user: { adminId: 'admin-1' },
        body: { stepUpCode: 'RECOVERY-CODE' },
      });

      await expect(guard.canActivate(context)).resolves.toBe(true);
    });

    it('rejects when neither the TOTP code nor any recovery code matches', async () => {
      (verifyTotpToken as jest.Mock).mockReturnValue(false);
      (matchRecoveryCode as jest.Mock).mockResolvedValue(-1); // no match
      const context = makeContext({
        user: { adminId: 'admin-1' },
        body: { stepUpCode: 'wrong' },
      });

      await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('never falls through to a password check, even if one happens to be present in the body', async () => {
      (verifyTotpToken as jest.Mock).mockReturnValue(false);
      (matchRecoveryCode as jest.Mock).mockResolvedValue(-1);
      const context = makeContext({
        user: { adminId: 'admin-1' },
        body: {
          stepUpCode: 'wrong',
          stepUpPassword: 'correct-horse-battery-staple',
        },
      });

      await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(bcrypt.compare).not.toHaveBeenCalled();
    });
  });

  describe('admin without 2FA enabled', () => {
    beforeEach(() => {
      prisma.adminUser.findUnique.mockResolvedValue(adminWithout2fa);
    });

    it('rejects with no stepUpPassword in the body', async () => {
      const context = makeContext({ user: { adminId: 'admin-1' }, body: {} });
      await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('accepts the correct password and strips it from the request body afterward', async () => {
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);
      const body: any = { stepUpPassword: 'correct-horse-battery-staple' };
      const context = makeContext({ user: { adminId: 'admin-1' }, body });

      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(body.stepUpPassword).toBeUndefined();
    });

    it('rejects an incorrect password', async () => {
      (bcrypt.compare as jest.Mock).mockResolvedValue(false);
      const context = makeContext({
        user: { adminId: 'admin-1' },
        body: { stepUpPassword: 'wrong' },
      });

      await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });
  });
});

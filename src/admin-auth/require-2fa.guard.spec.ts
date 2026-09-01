import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Require2faGuard } from './require-2fa.guard';

function makeContext(request: any): ExecutionContext {
  return { switchToHttp: () => ({ getRequest: () => request }) } as any;
}

describe('Require2faGuard', () => {
  let guard: Require2faGuard;
  let prisma: { adminUser: { findUnique: jest.Mock } };

  beforeEach(() => {
    prisma = { adminUser: { findUnique: jest.fn() } };
    guard = new Require2faGuard(prisma as any);
  });

  it('allows the request through untouched when there is no authenticated user on it', async () => {
    const context = makeContext({});
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(prisma.adminUser.findUnique).not.toHaveBeenCalled();
  });

  it('allows a SUPPORT_AGENT through without ever checking 2FA — money-moving/compliance roles only', async () => {
    const context = makeContext({ user: { adminId: 'admin-1', role: 'SUPPORT_AGENT' } });
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(prisma.adminUser.findUnique).not.toHaveBeenCalled();
  });

  it.each(['SUPER_ADMIN', 'FINANCE_OFFICER', 'COMPLIANCE_OFFICER'])(
    'blocks a %s with 2FA not enabled',
    async (role) => {
      prisma.adminUser.findUnique.mockResolvedValue({ twoFactorEnabled: false });
      const context = makeContext({ user: { adminId: 'admin-1', role } });

      await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
    },
  );

  it.each(['SUPER_ADMIN', 'FINANCE_OFFICER', 'COMPLIANCE_OFFICER'])(
    'allows a %s through once 2FA is enabled',
    async (role) => {
      prisma.adminUser.findUnique.mockResolvedValue({ twoFactorEnabled: true });
      const context = makeContext({ user: { adminId: 'admin-1', role } });

      await expect(guard.canActivate(context)).resolves.toBe(true);
    },
  );

  // The specific regression this guard's rewrite fixed — COMPLIANCE_OFFICER
  // was previously missing from ROLES_REQUIRING_2FA despite this guard
  // already being wired onto AdminController's KYC-decision routes, so a
  // COMPLIANCE_OFFICER without 2FA sailed straight through undetected.
  it('specifically blocks COMPLIANCE_OFFICER — the role this guard previously missed', async () => {
    prisma.adminUser.findUnique.mockResolvedValue({ twoFactorEnabled: false });
    const context = makeContext({ user: { adminId: 'compliance-1', role: 'COMPLIANCE_OFFICER' } });

    await expect(guard.canActivate(context)).rejects.toThrow(/Two-factor authentication is required/);
  });

  it('treats a missing admin record (deleted or not yet found) as 2FA not enabled, not as a pass-through', async () => {
    prisma.adminUser.findUnique.mockResolvedValue(null);
    const context = makeContext({ user: { adminId: 'ghost-admin', role: 'SUPER_ADMIN' } });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
  });
});

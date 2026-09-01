import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

// Applied to AdminController, FraudController, and IpAllowlistController —
// the controllers that move money, decide KYC/compliance outcomes, or
// change the network perimeter the rest of the admin API sits behind.
// Deliberately NOT applied to AdminAuthController — if this were checked
// on every authenticated route (e.g. inside AdminJwtStrategy.validate()),
// a SUPER_ADMIN/FINANCE_OFFICER/COMPLIANCE_OFFICER who hasn't enabled 2FA
// yet would be locked out of the very endpoints (/admin-auth/2fa/setup,
// /2fa/enable) that let them enable it. Scoping this to a separate guard
// on separate controllers avoids that chicken-and-egg lockout entirely.
//
// Master audit, Critical #5: "2FA is opt-in for roles that can move money
// or approve KYC... nothing forces SUPER_ADMIN, FINANCE_OFFICER, or
// COMPLIANCE_OFFICER to turn it on." COMPLIANCE_OFFICER — the role that
// approves/rejects KYC and can freeze an account — was missing from this
// list even though this guard was already wired onto AdminController's
// KYC-decision routes; a COMPLIANCE_OFFICER without 2FA enabled sailed
// straight through. Fixed below.
const ROLES_REQUIRING_2FA = ['SUPER_ADMIN', 'FINANCE_OFFICER', 'COMPLIANCE_OFFICER'];

@Injectable()
export class Require2faGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const user = req.user; // populated by AdminJwtAuthGuard, which must run before this guard in the @UseGuards(...) list

    if (!user || !ROLES_REQUIRING_2FA.includes(user.role)) return true;

    const admin = await this.prisma.adminUser.findUnique({ where: { id: user.adminId }, select: { twoFactorEnabled: true } });
    if (!admin?.twoFactorEnabled) {
      throw new ForbiddenException(
        'Two-factor authentication is required for your role before you can do this. Enable it under Security settings.',
      );
    }
    return true;
  }
}

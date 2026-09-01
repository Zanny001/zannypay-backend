import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { decryptSecret } from '../common/crypto.util';
import { verifyTotpToken, matchRecoveryCode } from '../common/totp.util';

// Master audit, Section 8: "Reversing a transaction and freezing an
// account both execute on the same click that opened the confirmation —
// a session token, once stolen (an unattended admin laptop, a hijacked
// browser tab), is then sufficient on its own to move money or lock a
// customer out. Nothing re-checks *who's actually at the keyboard* right
// before the irreversible step, the way a bank re-prompts for a card PIN
// at the ATM even though you already inserted the card."
//
// Applied per-route (not globally) to the small set of actions where an
// admin session being stolen/left unattended has real, hard-to-undo money
// or account-access consequences: reversing a transaction, freezing an
// account, and deactivating another admin. Requires the caller to include
// EITHER `stepUpCode` (a fresh TOTP code, or a recovery code, for an admin
// with 2FA enabled) OR `stepUpPassword` (current login password, for an
// admin who hasn't enabled 2FA — see Require2faGuard for why
// SUPER_ADMIN/FINANCE_OFFICER/COMPLIANCE_OFFICER shouldn't reach this
// state in practice, but the guard doesn't assume that's already
// enforced everywhere it might itself be reused) in the request body,
// verified fresh against the database — never against the JWT payload,
// which only proves who logged in originally, not that they're still the
// one holding the session now.
@Injectable()
export class StepUpGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const adminId = request.user?.adminId;
    if (!adminId) throw new UnauthorizedException();

    const admin = await this.prisma.adminUser.findUnique({ where: { id: adminId } });
    if (!admin || !admin.isActive) throw new UnauthorizedException();

    const { stepUpCode, stepUpPassword } = request.body || {};

    if (admin.twoFactorEnabled) {
      if (!stepUpCode) {
        throw new ForbiddenException('This action requires you to re-enter your 6-digit authenticator code (stepUpCode).');
      }
      const secret = admin.twoFactorSecret ? decryptSecret(admin.twoFactorSecret) : null;
      const validTotp = secret ? verifyTotpToken(stepUpCode, secret) : false;
      const validRecovery = !validTotp && (await matchRecoveryCode(stepUpCode, admin.twoFactorRecoveryCodes)) >= 0;
      if (!validTotp && !validRecovery) {
        throw new ForbiddenException('Invalid or expired authenticator code.');
      }
    } else {
      if (!stepUpPassword) {
        throw new ForbiddenException('This action requires you to re-enter your password (stepUpPassword).');
      }
      const validPassword = await bcrypt.compare(stepUpPassword, admin.password);
      if (!validPassword) {
        throw new ForbiddenException('Incorrect password.');
      }
    }

    // Strip re-auth fields from the body before they reach the route's DTO
    // — ReverseTransactionDto/FreezeUserDto don't declare them, and
    // leaving them in place is harmless either way under a whitelisting
    // ValidationPipe, but removing them here keeps the DTO the single
    // source of truth for "what this endpoint's real payload looks like."
    if (request.body) {
      delete request.body.stepUpCode;
      delete request.body.stepUpPassword;
    }

    return true;
  }
}

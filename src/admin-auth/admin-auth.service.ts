import { Injectable, UnauthorizedException, BadRequestException, NotFoundException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { StorageService } from '../storage/storage.service';
import { AdminLoginDto } from './dto/admin-login.dto';
import { BootstrapAdminDto } from './dto/bootstrap-admin.dto';
import { Verify2faDto } from './dto/verify-2fa.dto';
import { Enable2faDto } from './dto/enable-2fa.dto';
import { Disable2faDto } from './dto/disable-2fa.dto';
import { RegenerateRecoveryCodesDto } from './dto/regenerate-recovery-codes.dto';
import { UpdateAdminProfileDto } from './dto/update-admin-profile.dto';
import { ChangeAdminPasswordDto } from './dto/change-admin-password.dto';
import { encryptSecret, decryptSecret } from '../common/crypto.util';
import { generateTotpSecret, buildOtpAuthUrl, verifyTotpToken, generateRecoveryCodes, hashRecoveryCodes, matchRecoveryCode } from '../common/totp.util';
import * as QRCode from 'qrcode';
import * as bcrypt from 'bcryptjs';

const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8h — matches the JWT's own expiry
const MFA_PENDING_TTL = '5m'; // window to complete the 2FA step after a correct password
const LOCKOUT_THRESHOLD = 5; // failed attempts before a temporary lock
const LOCKOUT_MINUTES = 15;

@Injectable()
export class AdminAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly auditLog: AuditLogService,
    private readonly storageService: StorageService,
  ) {}

  // One-time setup path for the very first admin account. Only works when:
  //   1. the caller supplies ADMIN_BOOTSTRAP_SECRET (an env var only the
  //      person deploying the backend knows), AND
  //   2. zero AdminUser rows currently exist.
  // Once any admin exists, this endpoint always refuses — even with a
  // correct secret — so a leaked secret can't be used to mint a second
  // rogue SuperAdmin later.
  async bootstrapFirstAdmin(dto: BootstrapAdminDto) {
    const expectedSecret = process.env.ADMIN_BOOTSTRAP_SECRET;
    if (!expectedSecret || dto.bootstrapSecret !== expectedSecret) {
      throw new UnauthorizedException('Invalid bootstrap secret.');
    }

    const existingAdminCount = await this.prisma.adminUser.count();
    if (existingAdminCount > 0) {
      throw new BadRequestException('An admin account already exists. Ask a SuperAdmin to create your account instead.');
    }

    const hashedPassword = await bcrypt.hash(dto.password, 10);
    const admin = await this.prisma.adminUser.create({
      data: {
        name: dto.name,
        email: dto.email,
        password: hashedPassword,
        role: 'SUPER_ADMIN',
      },
    });

    return { success: true, admin: { id: admin.id, name: admin.name, email: admin.email, role: admin.role } };
  }

  async login(dto: AdminLoginDto, ip?: string, userAgent?: string) {
    const admin = await this.prisma.adminUser.findUnique({ where: { email: dto.email } });
    if (!admin || !admin.isActive) {
      throw new UnauthorizedException('Invalid credentials.');
    }

    if (admin.lockedUntil && admin.lockedUntil.getTime() > Date.now()) {
      const minutesLeft = Math.ceil((admin.lockedUntil.getTime() - Date.now()) / 60000);
      throw new UnauthorizedException(`Too many failed attempts. Try again in ${minutesLeft} minute(s).`);
    }

    const isPasswordValid = await bcrypt.compare(dto.password, admin.password);
    if (!isPasswordValid) {
      await this.registerFailedLogin(admin.id, admin.failedLoginAttempts);
      throw new UnauthorizedException('Invalid credentials.');
    }

    if (admin.failedLoginAttempts > 0 || admin.lockedUntil) {
      await this.prisma.adminUser.update({ where: { id: admin.id }, data: { failedLoginAttempts: 0, lockedUntil: null } });
    }

    if (admin.twoFactorEnabled) {
      const mfaToken = await this.jwtService.signAsync(
        { sub: admin.id, mfaPending: true },
        { secret: process.env.ADMIN_JWT_SECRET, expiresIn: MFA_PENDING_TTL },
      );
      return { twoFactorRequired: true, mfaToken };
    }

    return this.issueSession(admin.id, ip, userAgent);
  }

  async verifyTwoFactor(dto: Verify2faDto, ip?: string, userAgent?: string) {
    let payload: any;
    try {
      payload = await this.jwtService.verifyAsync(dto.mfaToken, { secret: process.env.ADMIN_JWT_SECRET });
    } catch {
      throw new UnauthorizedException('This login attempt has expired. Please log in again.');
    }
    if (!payload.mfaPending) {
      throw new UnauthorizedException('Invalid verification token.');
    }

    const admin = await this.prisma.adminUser.findUnique({ where: { id: payload.sub } });
    if (!admin || !admin.isActive || !admin.twoFactorEnabled) {
      throw new UnauthorizedException('Invalid verification token.');
    }

    const secret = admin.twoFactorSecret ? decryptSecret(admin.twoFactorSecret) : null;
    const isValidTotp = secret ? verifyTotpToken(dto.code, secret) : false;

    if (isValidTotp) {
      await this.auditLog.record({ adminId: admin.id, action: 'ADMIN_2FA_VERIFIED', targetType: 'AdminUser', targetId: admin.id, ipAddress: ip });
      return this.issueSession(admin.id, ip, userAgent);
    }

    const matchIndex = await matchRecoveryCode(dto.code, admin.twoFactorRecoveryCodes);
    if (matchIndex >= 0) {
      const remainingCodes = [...admin.twoFactorRecoveryCodes];
      remainingCodes.splice(matchIndex, 1);
      await this.prisma.adminUser.update({ where: { id: admin.id }, data: { twoFactorRecoveryCodes: remainingCodes } });
      await this.auditLog.record({
        adminId: admin.id,
        action: 'ADMIN_2FA_RECOVERY_CODE_USED',
        targetType: 'AdminUser',
        targetId: admin.id,
        metadata: { remainingCodes: remainingCodes.length },
        ipAddress: ip,
      });
      return this.issueSession(admin.id, ip, userAgent);
    }

    throw new UnauthorizedException('Invalid verification code.');
  }

  // ==========================================
  // 2FA setup/management — all require an already-authenticated FULL
  // session (never an mfaPending token; the AdminJwtStrategy rejects those
  // on every guarded route including these).
  // ==========================================
  async setupTwoFactor(adminId: string) {
    const admin = await this.prisma.adminUser.findUnique({ where: { id: adminId } });
    if (!admin) throw new NotFoundException('Admin not found.');
    if (admin.twoFactorEnabled) {
      throw new BadRequestException('Two-factor authentication is already enabled. Disable it first to generate a new QR code.');
    }

    const secret = generateTotpSecret();
    await this.prisma.adminUser.update({ where: { id: adminId }, data: { twoFactorSecret: encryptSecret(secret) } });

    const otpAuthUrl = buildOtpAuthUrl(admin.email, secret);
    const qrCodeDataUrl = await QRCode.toDataURL(otpAuthUrl);

    // `secret` is also returned in plain text as a manual-entry fallback
    // for admins whose authenticator app can't scan a QR code.
    return { secret, qrCodeDataUrl };
  }

  async enableTwoFactor(adminId: string, dto: Enable2faDto, ip?: string) {
    const admin = await this.prisma.adminUser.findUnique({ where: { id: adminId } });
    if (!admin) throw new NotFoundException('Admin not found.');
    if (admin.twoFactorEnabled) throw new BadRequestException('Two-factor authentication is already enabled.');
    if (!admin.twoFactorSecret) throw new BadRequestException('Call /admin-auth/2fa/setup first to generate a secret.');

    const secret = decryptSecret(admin.twoFactorSecret);
    if (!verifyTotpToken(dto.code, secret)) {
      throw new UnauthorizedException('Invalid code. Check your authenticator app and try again.');
    }

    const recoveryCodes = generateRecoveryCodes();
    const hashedRecoveryCodes = await hashRecoveryCodes(recoveryCodes);

    await this.prisma.adminUser.update({
      where: { id: adminId },
      data: { twoFactorEnabled: true, twoFactorRecoveryCodes: hashedRecoveryCodes },
    });
    await this.auditLog.record({ adminId, action: 'ADMIN_2FA_ENABLED', targetType: 'AdminUser', targetId: adminId, ipAddress: ip });

    // Shown exactly once — only bcrypt hashes are kept from here on.
    return { success: true, recoveryCodes };
  }

  async disableTwoFactor(adminId: string, dto: Disable2faDto, ip?: string) {
    const admin = await this.prisma.adminUser.findUnique({ where: { id: adminId } });
    if (!admin) throw new NotFoundException('Admin not found.');
    if (!admin.twoFactorEnabled) throw new BadRequestException('Two-factor authentication is not enabled.');

    const isPasswordValid = await bcrypt.compare(dto.password, admin.password);
    if (!isPasswordValid) throw new UnauthorizedException('Incorrect password.');

    const secret = admin.twoFactorSecret ? decryptSecret(admin.twoFactorSecret) : null;
    const isValidTotp = secret ? verifyTotpToken(dto.code, secret) : false;
    const matchIndex = isValidTotp ? -1 : await matchRecoveryCode(dto.code, admin.twoFactorRecoveryCodes);

    if (!isValidTotp && matchIndex < 0) {
      throw new UnauthorizedException('Invalid verification code.');
    }

    await this.prisma.adminUser.update({
      where: { id: adminId },
      data: { twoFactorEnabled: false, twoFactorSecret: null, twoFactorRecoveryCodes: [] },
    });
    await this.auditLog.record({ adminId, action: 'ADMIN_2FA_DISABLED', targetType: 'AdminUser', targetId: adminId, ipAddress: ip });

    return { success: true };
  }

  async regenerateRecoveryCodes(adminId: string, dto: RegenerateRecoveryCodesDto, ip?: string) {
    const admin = await this.prisma.adminUser.findUnique({ where: { id: adminId } });
    if (!admin || !admin.twoFactorEnabled || !admin.twoFactorSecret) {
      throw new BadRequestException('Two-factor authentication is not enabled.');
    }

    const secret = decryptSecret(admin.twoFactorSecret);
    if (!verifyTotpToken(dto.code, secret)) throw new UnauthorizedException('Invalid code.');

    const recoveryCodes = generateRecoveryCodes();
    const hashedRecoveryCodes = await hashRecoveryCodes(recoveryCodes);
    await this.prisma.adminUser.update({ where: { id: adminId }, data: { twoFactorRecoveryCodes: hashedRecoveryCodes } });
    await this.auditLog.record({ adminId, action: 'ADMIN_2FA_RECOVERY_CODES_REGENERATED', targetType: 'AdminUser', targetId: adminId, ipAddress: ip });

    return { success: true, recoveryCodes };
  }

  // ==========================================
  // Sessions — lets an admin see and revoke their own active logins, and
  // gives every session a natural "log out" that actually invalidates the
  // token server-side rather than just discarding it client-side.
  // ==========================================
  async listSessions(adminId: string) {
    const sessions = await this.prisma.adminSession.findMany({
      where: { adminId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    return sessions.map((s) => ({ id: s.id, ipAddress: s.ipAddress, userAgent: s.userAgent, createdAt: s.createdAt, expiresAt: s.expiresAt }));
  }

  async revokeSession(adminId: string, sessionId: string, ip?: string) {
    const session = await this.prisma.adminSession.findUnique({ where: { id: sessionId } });
    if (!session || session.adminId !== adminId) throw new NotFoundException('Session not found.');

    await this.prisma.adminSession.update({ where: { id: sessionId }, data: { revokedAt: new Date() } });
    await this.auditLog.record({ adminId, action: 'ADMIN_SESSION_REVOKED', targetType: 'AdminSession', targetId: sessionId, ipAddress: ip });
    return { success: true };
  }

  async logout(adminId: string, jti: string | undefined, ip?: string) {
    if (jti) {
      const session = await this.prisma.adminSession.findUnique({ where: { jti } });
      if (session && session.adminId === adminId) {
        await this.prisma.adminSession.update({ where: { id: session.id }, data: { revokedAt: new Date() } });
      }
    }
    await this.auditLog.record({ adminId, action: 'ADMIN_LOGOUT', targetType: 'AdminUser', targetId: adminId, ipAddress: ip });
    return { success: true };
  }

  private async registerFailedLogin(adminId: string, currentAttempts: number) {
    const attempts = currentAttempts + 1;
    const data: { failedLoginAttempts: number; lockedUntil?: Date } = { failedLoginAttempts: attempts };
    if (attempts >= LOCKOUT_THRESHOLD) {
      data.lockedUntil = new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000);
    }
    await this.prisma.adminUser.update({ where: { id: adminId }, data });
  }

  private async issueSession(adminId: string, ip?: string, userAgent?: string) {
    const admin = await this.prisma.adminUser.findUnique({ where: { id: adminId } });
    if (!admin) throw new UnauthorizedException('Invalid credentials.');

    const jti = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await this.prisma.adminSession.create({ data: { adminId: admin.id, jti, ipAddress: ip, userAgent, expiresAt } });
    await this.prisma.adminUser.update({ where: { id: admin.id }, data: { lastLoginAt: new Date() } });

    const payload = { sub: admin.id, email: admin.email, role: admin.role, jti };
    const accessToken = await this.jwtService.signAsync(payload, {
      secret: process.env.ADMIN_JWT_SECRET,
      expiresIn: '8h', // short-lived — admin sessions should not persist for days like customer sessions do
    });

    await this.auditLog.record({ adminId: admin.id, action: 'ADMIN_LOGIN', targetType: 'AdminUser', targetId: admin.id, ipAddress: ip });

    return {
      access_token: accessToken,
      admin: { id: admin.id, name: admin.name, email: admin.email, role: admin.role },
    };
  }

  // ==========================================
  // Admin's own identity — master audit, Section 6: "An admin's own
  // identity has no representation anywhere in this product. There's no
  // photo, no editable name/phone/bio, no self-service password change.
  // The only way to know who's logged in is the name/email printed next
  // to the logout link." All of that previously had no backend surface at
  // all — these two methods, plus the schema's photoUrl/phone/bio
  // columns, are that surface.
  // ==========================================
  async getFullProfile(adminId: string) {
    const admin = await this.prisma.adminUser.findUnique({ where: { id: adminId } });
    if (!admin) throw new NotFoundException('Admin not found.');
    return {
      id: admin.id,
      adminId: admin.id, // alias — the admin dashboard's existing auth context reads `adminId` from the pre-upgrade shape of this endpoint; kept so that call site doesn't need to change in lockstep with this one
      name: admin.name,
      email: admin.email,
      role: admin.role,
      photoUrl: admin.photoUrl,
      phone: admin.phone,
      bio: admin.bio,
      twoFactorEnabled: admin.twoFactorEnabled,
      lastLoginAt: admin.lastLoginAt,
      createdAt: admin.createdAt,
    };
  }

  async updateProfile(adminId: string, dto: UpdateAdminProfileDto, ip?: string) {
    const resolvedPhotoUrl = dto.photo !== undefined ? await this.storageService.storeImage(dto.photo, `admin-avatars/${adminId}`) : undefined;

    const updated = await this.prisma.adminUser.update({
      where: { id: adminId },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.phone !== undefined && { phone: dto.phone }),
        ...(dto.bio !== undefined && { bio: dto.bio }),
        ...(resolvedPhotoUrl !== undefined && { photoUrl: resolvedPhotoUrl }),
      },
    });

    await this.auditLog.record({ adminId, action: 'ADMIN_UPDATE_OWN_PROFILE', targetType: 'AdminUser', targetId: adminId, ipAddress: ip });

    return this.getFullProfile(updated.id);
  }

  async changePassword(adminId: string, dto: ChangeAdminPasswordDto, currentJti?: string, ip?: string) {
    const admin = await this.prisma.adminUser.findUnique({ where: { id: adminId } });
    if (!admin) throw new NotFoundException('Admin not found.');

    const currentValid = await bcrypt.compare(dto.currentPassword, admin.password);
    if (!currentValid) throw new UnauthorizedException('Current password is incorrect.');

    const newHash = await bcrypt.hash(dto.newPassword, 12);
    await this.prisma.adminUser.update({ where: { id: adminId }, data: { password: newHash } });

    await this.auditLog.record({ adminId, action: 'ADMIN_CHANGE_OWN_PASSWORD', targetType: 'AdminUser', targetId: adminId, ipAddress: ip });

    // Every OTHER active session for this admin is revoked (current
    // session, identified by currentJti, is deliberately spared) — a
    // password change is exactly the moment a legitimate owner is trying
    // to lock out a session they no longer trust (a shared/public
    // machine, a suspicion their old password leaked), but shouldn't also
    // log them out of the device they're sitting at right now.
    await this.prisma.adminSession.updateMany({
      where: { adminId, revokedAt: null, ...(currentJti && { jti: { not: currentJti } }) },
      data: { revokedAt: new Date() },
    });

    return { success: true };
  }
}

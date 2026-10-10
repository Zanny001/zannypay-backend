import {
  Controller,
  Post,
  Get,
  Patch,
  Delete,
  Body,
  Param,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AdminAuthService } from './admin-auth.service';
import { AdminJwtAuthGuard } from './admin-jwt-auth.guard';
import { AdminIpAllowlistGuard } from '../admin-security/admin-ip-allowlist.guard';
import { AdminLoginDto } from './dto/admin-login.dto';
import { BootstrapAdminDto } from './dto/bootstrap-admin.dto';
import { Verify2faDto } from './dto/verify-2fa.dto';
import { Enable2faDto } from './dto/enable-2fa.dto';
import { Disable2faDto } from './dto/disable-2fa.dto';
import { RegenerateRecoveryCodesDto } from './dto/regenerate-recovery-codes.dto';
import { UpdateAdminProfileDto } from './dto/update-admin-profile.dto';
import { ChangeAdminPasswordDto } from './dto/change-admin-password.dto';

@Controller('admin-auth')
@UseGuards(AdminIpAllowlistGuard) // network-level gate applies even before a session exists (login, bootstrap)
export class AdminAuthController {
  constructor(private readonly adminAuthService: AdminAuthService) {}

  @Post('bootstrap')
  async bootstrap(@Body() dto: BootstrapAdminDto) {
    return this.adminAuthService.bootstrapFirstAdmin(dto);
  }

  // Master audit, High-priority #4 — admin credentials guard money-moving
  // and compliance actions, so this is the single highest-value login
  // endpoint in the system to rate-limit tightly.
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('login')
  async login(@Req() req, @Body() dto: AdminLoginDto) {
    return this.adminAuthService.login(dto, req.ip, req.headers['user-agent']);
  }

  // Second step of login when the account has 2FA enabled — exchanges the
  // short-lived mfaToken from login() plus a TOTP/recovery code for a real
  // access_token.
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Post('2fa/verify')
  async verifyTwoFactor(@Req() req, @Body() dto: Verify2faDto) {
    return this.adminAuthService.verifyTwoFactor(
      dto,
      req.ip,
      req.headers['user-agent'],
    );
  }

  // ---- Everything below requires an already-authenticated full session ----

  @UseGuards(AdminJwtAuthGuard)
  @Post('2fa/setup')
  async setupTwoFactor(@Req() req) {
    return this.adminAuthService.setupTwoFactor(req.user.adminId);
  }

  @UseGuards(AdminJwtAuthGuard)
  @Post('2fa/enable')
  async enableTwoFactor(@Req() req, @Body() dto: Enable2faDto) {
    return this.adminAuthService.enableTwoFactor(req.user.adminId, dto, req.ip);
  }

  @UseGuards(AdminJwtAuthGuard)
  @Post('2fa/disable')
  async disableTwoFactor(@Req() req, @Body() dto: Disable2faDto) {
    return this.adminAuthService.disableTwoFactor(
      req.user.adminId,
      dto,
      req.ip,
    );
  }

  @UseGuards(AdminJwtAuthGuard)
  @Post('2fa/recovery-codes/regenerate')
  async regenerateRecoveryCodes(
    @Req() req,
    @Body() dto: RegenerateRecoveryCodesDto,
  ) {
    return this.adminAuthService.regenerateRecoveryCodes(
      req.user.adminId,
      dto,
      req.ip,
    );
  }

  @UseGuards(AdminJwtAuthGuard)
  @Get('sessions')
  async listSessions(@Req() req) {
    return this.adminAuthService.listSessions(req.user.adminId);
  }

  @UseGuards(AdminJwtAuthGuard)
  @Delete('sessions/:id')
  async revokeSession(@Req() req, @Param('id') id: string) {
    return this.adminAuthService.revokeSession(req.user.adminId, id, req.ip);
  }

  @UseGuards(AdminJwtAuthGuard)
  @Post('logout')
  async logout(@Req() req) {
    return this.adminAuthService.logout(req.user.adminId, req.user.jti, req.ip);
  }

  // So the frontend can hydrate "who am I" from a cookie it can't read
  // client-side — see the admin dashboard's BFF auth pattern. Fetches
  // fresh from the database (rather than trusting only the JWT payload)
  // so photoUrl/phone/bio/twoFactorEnabled — none of which are in the
  // token claims — are always current, e.g. right after a profile update.
  @UseGuards(AdminJwtAuthGuard)
  @Get('me')
  async me(@Req() req) {
    return this.adminAuthService.getFullProfile(req.user.adminId);
  }

  // ---------- Admin's own identity (master audit, Section 6) ----------
  @UseGuards(AdminJwtAuthGuard)
  @Patch('profile')
  async updateProfile(@Req() req, @Body() dto: UpdateAdminProfileDto) {
    return this.adminAuthService.updateProfile(req.user.adminId, dto, req.ip);
  }

  @UseGuards(AdminJwtAuthGuard)
  @Patch('password')
  async changePassword(@Req() req, @Body() dto: ChangeAdminPasswordDto) {
    return this.adminAuthService.changePassword(
      req.user.adminId,
      dto,
      req.user.jti,
      req.ip,
    );
  }
}

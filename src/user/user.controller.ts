import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  UseGuards,
  Req,
  Param,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { UserService } from './user.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { ChangePinDto } from './dto/change-pin.dto';
import { RevealKycFieldDto } from './dto/reveal-kyc-field.dto';

@Controller('user')
@UseGuards(JwtAuthGuard)
export class UserController {
  constructor(private readonly userService: UserService) {}

  @Get('me')
  async getProfileAndWallet(@Req() req) {
    const userId = req.user.sub || req.user.userId;
    return this.userService.getUserDashboard(userId);
  }

  // NDPR/GDPR data portability — see UserService.exportMyData. The full
  // export is emailed to the address on file (or returned inline when no
  // SMTP is configured); it never includes the PIN hash or encrypted
  // BVN/NIN blobs.
  @Get('me/export')
  async exportMyData(@Req() req) {
    const userId = req.user.sub || req.user.userId;
    return this.userService.exportMyData(userId);
  }

  // Self-serve account erasure (App Store / Play policy + NDPR/GDPR).
  // Anonymizes in place rather than hard-deleting — see
  // UserService.deleteMyAccount for why. Tight throttle: irreversible.
  @Throttle({ default: { limit: 3, ttl: 60000 } })
  @Delete('me')
  async deleteMyAccount(@Req() req) {
    const userId = req.user.sub || req.user.userId;
    return this.userService.deleteMyAccount(userId);
  }

  @Patch('profile')
  async updateProfile(@Req() req, @Body() dto: UpdateProfileDto) {
    const userId = req.user.sub || req.user.userId;
    return this.userService.updateProfile(userId, dto);
  }

  // Master audit, High-priority #4 — changing the PIN is a natural target
  // for an attacker who's already stolen a session token; a tighter ceiling
  // here limits how many guesses of the *current* PIN they get per minute.
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Patch('pin')
  async changePin(@Req() req, @Body() dto: ChangePinDto) {
    const userId = req.user.sub || req.user.userId;
    return this.userService.changePin(userId, dto);
  }

  @Post('checkin')
  async dailyCheckIn(@Req() req) {
    const userId = req.user.sub || req.user.userId;
    return this.userService.dailyCheckIn(userId);
  }

  // Requires the transaction PIN — see UserService.revealKycField for why.
  // Returns the full plaintext value exactly once per call; the client is
  // expected to display it briefly and re-mask, not cache it.
  // UserService already tracks its own per-user lockout counter
  // (kycRevealFailedAttempts); this per-IP throttle closes the adjacent
  // gap where one IP spreads guesses across many different accounts.
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Post('kyc/reveal')
  async revealKycField(@Req() req, @Body() dto: RevealKycFieldDto) {
    const userId = req.user.sub || req.user.userId;
    return this.userService.revealKycField(userId, dto);
  }

  // Resolves a beneficiary's display name from an account number OR phone
  // number, so the Transfer screen can show "Sending to: Jane Doe" before
  // the user confirms — same UX real bank apps use for beneficiary lookup.
  @Get('resolve/:identifier')
  async resolveRecipient(@Req() req, @Param('identifier') identifier: string) {
    const userId = req.user.sub || req.user.userId;
    return this.userService.resolveRecipient(identifier, userId);
  }
}

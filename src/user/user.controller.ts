import { Controller, Get, Post, Patch, Body, UseGuards, Req, Param } from '@nestjs/common';
import { UserService } from './user.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { ChangePinDto } from './dto/change-pin.dto';

@Controller('user')
@UseGuards(JwtAuthGuard)
export class UserController {
  constructor(private readonly userService: UserService) {}

  @Get('me')
  async getProfileAndWallet(@Req() req) {
    const userId = req.user.sub || req.user.userId;
    return this.userService.getUserDashboard(userId);
  }

  @Patch('profile')
  async updateProfile(@Req() req, @Body() dto: UpdateProfileDto) {
    const userId = req.user.sub || req.user.userId;
    return this.userService.updateProfile(userId, dto);
  }

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

  // Resolves a beneficiary's display name from an account number OR phone
  // number, so the Transfer screen can show "Sending to: Jane Doe" before
  // the user confirms — same UX real bank apps use for beneficiary lookup.
  @Get('resolve/:identifier')
  async resolveRecipient(@Req() req, @Param('identifier') identifier: string) {
    const userId = req.user.sub || req.user.userId;
    return this.userService.resolveRecipient(identifier, userId);
  }
}

import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { ReferralsService } from './referrals.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@Controller('referrals')
@UseGuards(JwtAuthGuard)
export class ReferralsController {
  constructor(private readonly referralsService: ReferralsService) {}

  @Get('me')
  async getMyReferrals(@Req() req) {
    const userId = req.user.sub || req.user.userId;
    return this.referralsService.getMyReferrals(userId);
  }
}

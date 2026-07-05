import { Controller, Get, UseGuards, Req } from '@nestjs/common';
import { UserService } from './user.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@Controller('user')
@UseGuards(JwtAuthGuard)
export class UserController {
  constructor(private readonly userService: UserService) {}

  @Get('me')
  async getProfileAndWallet(@Req() req) {
    const userId = req.user.sub || req.user.userId; 
    return this.userService.getUserDashboard(userId);
  }
}

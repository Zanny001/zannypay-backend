import { Body, Controller, Delete, Param, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PushService } from './push.service';

@Controller('push')
@UseGuards(JwtAuthGuard)
export class PushController {
  constructor(private readonly pushService: PushService) {}

  @Post('register')
  async register(@Req() req, @Body() body: { token: string; platform?: string }) {
    const userId = req.user.sub || req.user.userId;
    return this.pushService.registerToken(userId, body.token, body.platform);
  }

  @Delete('unregister/:token')
  async unregister(@Param('token') token: string) {
    return this.pushService.unregisterToken(token);
  }
}

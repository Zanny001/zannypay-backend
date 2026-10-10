import { Controller, Get, Post, Body, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { SupportService } from './support.service';
import { SendMessageDto } from './dto/send-message.dto';

@Controller('support')
@UseGuards(JwtAuthGuard)
export class SupportController {
  constructor(private readonly supportService: SupportService) {}

  // Polled by the mobile chat screen while it's open (a plain GET is
  // simplest and safest to ship without a websocket layer — see the
  // screen's own polling interval for how often).
  @Get('conversation')
  async getConversation(@Req() req) {
    return this.supportService.getOrCreateOpenConversation(req.user.userId);
  }

  @Post('messages')
  async sendMessage(@Req() req, @Body() dto: SendMessageDto) {
    return this.supportService.sendCustomerMessage(
      req.user.userId,
      dto.body,
      dto.attachmentData,
      dto.attachmentMimeType,
    );
  }
}

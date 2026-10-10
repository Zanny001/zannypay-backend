import {
  Controller,
  Get,
  Patch,
  Param,
  Query,
  Body,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AdminIpAllowlistGuard } from '../admin-security/admin-ip-allowlist.guard';
import { AdminJwtAuthGuard } from '../admin-auth/admin-jwt-auth.guard';
import { RolesGuard } from '../admin-auth/roles.guard';
import { SupportService } from './support.service';
import { SendMessageDto } from './dto/send-message.dto';

// No @Roles restriction on this controller — every admin role, including
// SUPPORT_AGENT (whose whole purpose is customer support), can view and
// reply to conversations. Nothing here moves money or touches compliance
// data, so it doesn't need the tighter role gating those do.
@Controller('admin/support')
@UseGuards(AdminIpAllowlistGuard, AdminJwtAuthGuard, RolesGuard)
export class AdminSupportController {
  constructor(private readonly supportService: SupportService) {}

  @Get('conversations')
  async listConversations(@Query('status') status?: string) {
    return this.supportService.listConversations(status);
  }

  @Get('conversations/:id')
  async getConversation(@Param('id') id: string) {
    return this.supportService.getConversation(id);
  }

  @Patch('conversations/:id/reply')
  async reply(
    @Req() req,
    @Param('id') id: string,
    @Body() dto: SendMessageDto,
  ) {
    return this.supportService.sendAdminReply(
      req.user.adminId,
      id,
      dto.body,
      req.ip,
      dto.attachmentData,
      dto.attachmentMimeType,
    );
  }

  @Patch('conversations/:id/resolve')
  async resolve(@Req() req, @Param('id') id: string) {
    return this.supportService.resolveConversation(
      req.user.adminId,
      id,
      req.ip,
    );
  }
}

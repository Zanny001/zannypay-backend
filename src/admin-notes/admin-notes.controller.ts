import { Body, Controller, Get, Post, Query, Req, UseGuards, BadRequestException } from '@nestjs/common';
import { AdminJwtAuthGuard } from '../admin-auth/admin-jwt-auth.guard';
import { AdminIpAllowlistGuard } from '../admin-security/admin-ip-allowlist.guard';
import { AdminNotesService } from './admin-notes.service';
import { CreateInternalNoteDto, INTERNAL_NOTE_TARGET_TYPES } from './dto/create-internal-note.dto';

// Any authenticated admin can read/leave a note — this is the internal
// day-to-day collaboration layer, not a privileged action, so it's
// deliberately not gated by RolesGuard or Require2faGuard the way
// money-moving/compliance-decision endpoints are.
@Controller('admin/notes')
@UseGuards(AdminIpAllowlistGuard, AdminJwtAuthGuard)
export class AdminNotesController {
  constructor(private readonly adminNotesService: AdminNotesService) {}

  @Get()
  async list(@Query('targetType') targetType: string, @Query('targetId') targetId: string) {
    if (!targetType || !targetId || !INTERNAL_NOTE_TARGET_TYPES.includes(targetType as any)) {
      throw new BadRequestException('targetType and targetId are required.');
    }
    return this.adminNotesService.listForTarget(targetType, targetId);
  }

  @Post()
  async create(@Req() req, @Body() dto: CreateInternalNoteDto) {
    return this.adminNotesService.create(req.user.adminId, dto);
  }
}

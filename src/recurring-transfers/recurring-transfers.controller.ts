import { Controller, Get, Post, Patch, Param, Body, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RecurringTransfersService } from './recurring-transfers.service';
import { CreateRecurringTransferDto } from './dto/create-recurring-transfer.dto';

// Deliberately no endpoint here triggers an actual transfer — execution
// only ever happens from RecurringTransfersService's internal @Cron
// handler. See the schema comment on RecurringTransfer for why.
@Controller('recurring-transfers')
@UseGuards(JwtAuthGuard)
export class RecurringTransfersController {
  constructor(private readonly recurringTransfersService: RecurringTransfersService) {}

  @Post()
  async create(@Req() req, @Body() dto: CreateRecurringTransferDto) {
    const userId = req.user.sub || req.user.userId;
    return this.recurringTransfersService.create(userId, dto);
  }

  @Get()
  async list(@Req() req) {
    const userId = req.user.sub || req.user.userId;
    return this.recurringTransfersService.list(userId);
  }

  @Patch(':id/pause')
  async pause(@Req() req, @Param('id') id: string) {
    const userId = req.user.sub || req.user.userId;
    return this.recurringTransfersService.pause(userId, id);
  }

  @Patch(':id/resume')
  async resume(@Req() req, @Param('id') id: string) {
    const userId = req.user.sub || req.user.userId;
    return this.recurringTransfersService.resume(userId, id);
  }

  @Patch(':id/cancel')
  async cancel(@Req() req, @Param('id') id: string) {
    const userId = req.user.sub || req.user.userId;
    return this.recurringTransfersService.cancel(userId, id);
  }
}

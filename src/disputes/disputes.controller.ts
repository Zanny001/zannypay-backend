import { Controller, Get, Post, Body, Req, UseGuards } from '@nestjs/common';
import { DisputesService } from './disputes.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CreateDisputeDto } from './dto/create-dispute.dto';

@Controller('disputes')
@UseGuards(JwtAuthGuard)
export class DisputesController {
  constructor(private readonly disputesService: DisputesService) {}

  @Get()
  async getMyDisputes(@Req() req) {
    const userId = req.user.sub || req.user.userId;
    return this.disputesService.getMyDisputes(userId);
  }

  @Post()
  async createDispute(@Req() req, @Body() dto: CreateDisputeDto) {
    const userId = req.user.sub || req.user.userId;
    return this.disputesService.createDispute(userId, dto.transactionId, dto.reason, dto.details);
  }
}

import { Controller, Get, Post, Body, Req, UseGuards, Param } from '@nestjs/common';
import { CardsService } from './cards.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@Controller('cards')
@UseGuards(JwtAuthGuard)
export class CardsController {
  constructor(private readonly cardsService: CardsService) {}

  @Get()
  async getCards(@Req() req) {
    const userId = req.user.sub || req.user.userId;
    return this.cardsService.getCards(userId);
  }

  @Post('request')
  async createCard(@Req() req) {
    const userId = req.user.sub || req.user.userId;
    return this.cardsService.createCard(userId);
  }

  // Changed to @Post so frontend apiPost() works flawlessly
  @Post(':id/freeze')
  async toggleFreeze(
    @Req() req,
    @Param('id') cardId: string,
    @Body('isFrozen') isFrozen: boolean,
  ) {
    const userId = req.user.sub || req.user.userId;
    return this.cardsService.toggleFreeze(userId, cardId, isFrozen);
  }
}

import { Controller, Get, Post, Patch, Delete, Body, Req, UseGuards, Param } from '@nestjs/common';
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
  async createCard(@Req() req, @Body('network') network?: string) {
    const userId = req.user.sub || req.user.userId;
    return this.cardsService.createCard(userId, network);
  }

  // Master audit, Section 5 — linking an existing external card as an
  // alternative to requesting a new ZannyPay-issued one.
  @Post('link')
  async linkExternalCard(@Req() req, @Body('authorizationCode') authorizationCode: string) {
    const userId = req.user.sub || req.user.userId;
    return this.cardsService.linkExternalCard(userId, authorizationCode);
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

  @Post(':id/default')
  async setDefault(@Req() req, @Param('id') cardId: string) {
    const userId = req.user.sub || req.user.userId;
    return this.cardsService.setDefault(userId, cardId);
  }

  @Patch(':id/limits')
  async updateLimits(
    @Req() req,
    @Param('id') cardId: string,
    @Body('dailyLimit') dailyLimit?: number,
    @Body('monthlyLimit') monthlyLimit?: number,
  ) {
    const userId = req.user.sub || req.user.userId;
    return this.cardsService.updateLimits(userId, cardId, dailyLimit, monthlyLimit);
  }

  @Get(':id/activity')
  async getCardActivity(@Req() req, @Param('id') cardId: string) {
    const userId = req.user.sub || req.user.userId;
    return this.cardsService.getCardActivity(userId, cardId);
  }

  // PIN-gated — see CardsService.revealCardNumber's doc comment for why
  // the full PAN was moved behind an explicit reveal action instead of
  // riding along on every GET /cards response.
  @Post(':id/reveal')
  async revealCardNumber(@Req() req, @Param('id') cardId: string, @Body('pin') pin: string) {
    const userId = req.user.sub || req.user.userId;
    return this.cardsService.revealCardNumber(userId, cardId, pin);
  }

  @Delete(':id')
  async removeCard(@Req() req, @Param('id') cardId: string) {
    const userId = req.user.sub || req.user.userId;
    return this.cardsService.removeCard(userId, cardId);
  }
}

import { Controller, Post, Body, Req, UseGuards } from '@nestjs/common';
import { SavingsService } from './savings.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@UseGuards(JwtAuthGuard)
@Controller('savings')
export class SavingsController {
  constructor(private readonly savingsService: SavingsService) {}

  @Post('goal')
  async createGoal(@Req() req, @Body() body: { name: string; target: number }) {
    const userId = req.user.sub || req.user.userId;
    return this.savingsService.createGoal(userId, body.name, Number(body.target));
  }

  @Post('deposit')
  async deposit(@Req() req, @Body() body: { goalId: string; amount: number }) {
    const userId = req.user.sub || req.user.userId;
    return this.savingsService.deposit(userId, body.goalId, Number(body.amount));
  }

  @Post('withdraw')
  async withdraw(@Req() req, @Body() body: { goalId: string; amount: number }) {
    const userId = req.user.sub || req.user.userId;
    return this.savingsService.withdraw(userId, body.goalId, Number(body.amount));
  }
}

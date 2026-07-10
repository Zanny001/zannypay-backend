import { Controller, Post, Body, Req, UseGuards } from '@nestjs/common';
import { LoansService } from './loans.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@UseGuards(JwtAuthGuard)
@Controller('loans')
export class LoansController {
  constructor(private readonly loansService: LoansService) {}

  @Post('request')
  async requestLoan(@Req() req, @Body() body: { amount: number; termDays?: number }) {
    const userId = req.user.sub || req.user.userId;
    return this.loansService.requestLoan(userId, Number(body.amount), body.termDays);
  }

  @Post('repay')
  async repayLoan(@Req() req, @Body() body: { amount: number }) {
    const userId = req.user.sub || req.user.userId;
    return this.loansService.repayLoan(userId, Number(body.amount));
  }
}

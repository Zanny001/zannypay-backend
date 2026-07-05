import { Controller, Post, Body, Req, UseGuards } from '@nestjs/common';
import { TransactionsService } from './transactions.service';
import { TransferDto } from './dto/transfer.dto';
import { FundDto } from './dto/fund.dto';
import { BillDto } from './dto/bill.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@Controller('transactions')
@UseGuards(JwtAuthGuard)
export class TransactionsController {
  constructor(private readonly transactionsService: TransactionsService) {}

  @Post('transfer')
  async transferFunds(@Req() req, @Body() transferDto: TransferDto) {
    const userId = req.user.sub || req.user.userId;
    return this.transactionsService.transferFunds(userId, transferDto);
  }

  @Post('fund')
  async fundWallet(@Req() req, @Body() fundDto: FundDto) {
    const userId = req.user.sub || req.user.userId;
    return this.transactionsService.fundWallet(userId, fundDto);
  }

  @Post('bills')
  async payBill(@Req() req, @Body() billDto: BillDto) {
    const userId = req.user.sub || req.user.userId;
    return this.transactionsService.payBill(userId, billDto);
  }
}

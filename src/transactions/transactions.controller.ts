import { Controller, Post, Body, Req, UseGuards } from '@nestjs/common';
import { TransactionsService } from './transactions.service';
import { TransferDto } from './dto/transfer.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@Controller('transactions')
@UseGuards(JwtAuthGuard) // <--- THIS LOCKS THE DOOR
export class TransactionsController {
  constructor(private readonly transactionsService: TransactionsService) {}

  @Post('transfer')
  async transferFunds(@Req() req, @Body() transferDto: TransferDto) {
    // The JwtAuthGuard decodes the token and places the user ID right here safely
    const userId = req.user.userId; 
    return this.transactionsService.transferFunds(userId, transferDto);
  }
}

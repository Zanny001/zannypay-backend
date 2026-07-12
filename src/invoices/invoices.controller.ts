import { Controller, Get, Post, Body, Req, UseGuards } from '@nestjs/common';
import { InvoicesService } from './invoices.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@Controller('invoices')
@UseGuards(JwtAuthGuard)
export class InvoicesController {
  constructor(private readonly invoicesService: InvoicesService) {}

  @Get()
  async getInvoices(@Req() req) {
    const userId = req.user.sub || req.user.userId;
    return this.invoicesService.getInvoices(userId);
  }

  @Post()
  async createInvoice(
    @Req() req,
    @Body() body: { clientName: string; amount: number; description: string },
  ) {
    const userId = req.user.sub || req.user.userId;
    return this.invoicesService.createInvoice(userId, body);
  }
}

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class InvoicesService {
  constructor(private prisma: PrismaService) {}

  async getInvoices(userId: string) {
    return this.prisma.invoice.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async createInvoice(userId: string, body: { clientName: string; amount: number; description: string }) {
    return this.prisma.invoice.create({
      data: {
        userId,
        clientName: body.clientName,
        amount: body.amount,
        description: body.description,
        status: 'issued',
      },
    });
  }
}

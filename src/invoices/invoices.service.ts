import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
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

  async getInvoice(userId: string, invoiceId: string) {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
    });
    if (!invoice) throw new NotFoundException('Invoice not found.');
    if (invoice.userId !== userId)
      throw new ForbiddenException('This invoice does not belong to you.');
    return invoice;
  }

  async createInvoice(
    userId: string,
    body: { clientName: string; amount: number; description: string },
  ) {
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

  // Deliberately a manual, owner-initiated action rather than
  // auto-detected from a matching incoming transfer — matching by amount
  // alone is unreliable (two clients could owe the same amount) and
  // matching by payer identity assumes the payer is even a ZannyPay user,
  // which an invoice recipient may not be. A clear "I confirmed this was
  // paid" action is honest about what the system actually knows.
  async markPaid(userId: string, invoiceId: string) {
    const invoice = await this.getInvoice(userId, invoiceId);
    if (invoice.status === 'paid') return invoice;
    return this.prisma.invoice.update({
      where: { id: invoiceId },
      data: { status: 'paid', paidAt: new Date() },
    });
  }
}

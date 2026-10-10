import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateBeneficiaryDto } from './dto/create-beneficiary.dto';
import { UpdateBeneficiaryDto } from './dto/update-beneficiary.dto';

// Master audit, Section 5 (mobile gap): "BeneficiariesScreen.js reads and
// writes through utils/storage — there's no Beneficiary model in the
// schema at all. Every saved recipient lives only on the device that
// saved it. A reinstall, or a new phone, silently loses the whole list,
// on what's likely the highest-frequency screen in the app for a repeat
// user paying the same few people." This module is the backend-persisted
// replacement; TransferScreen/BeneficiariesScreen on mobile now read/write
// through here instead of AsyncStorage.
@Injectable()
export class BeneficiariesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(userId: string) {
    return this.prisma.beneficiary.findMany({
      where: { userId },
      orderBy: [
        { isFavorite: 'desc' },
        { lastPaidAt: 'desc' },
        { createdAt: 'desc' },
      ],
    });
  }

  async create(userId: string, dto: CreateBeneficiaryDto) {
    // Upsert on (userId, accountNumber) rather than erroring on a repeat
    // save — "save this recipient" from the transfer-confirmation screen
    // should feel idempotent, not throw a 409 the second time someone
    // pays the same person.
    return this.prisma.beneficiary.upsert({
      where: {
        userId_accountNumber: { userId, accountNumber: dto.accountNumber },
      },
      update: {
        name: dto.name,
        bank: dto.bank,
        ...(dto.nickname !== undefined && { nickname: dto.nickname }),
        ...(dto.isFavorite !== undefined && { isFavorite: dto.isFavorite }),
      },
      create: {
        userId,
        accountNumber: dto.accountNumber,
        name: dto.name,
        bank: dto.bank,
        nickname: dto.nickname,
        isFavorite: dto.isFavorite ?? false,
      },
    });
  }

  async update(userId: string, id: string, dto: UpdateBeneficiaryDto) {
    const beneficiary = await this.prisma.beneficiary.findUnique({
      where: { id },
    });
    if (!beneficiary) throw new NotFoundException('Beneficiary not found.');
    if (beneficiary.userId !== userId) throw new ForbiddenException();

    return this.prisma.beneficiary.update({
      where: { id },
      data: {
        ...(dto.nickname !== undefined && { nickname: dto.nickname }),
        ...(dto.isFavorite !== undefined && { isFavorite: dto.isFavorite }),
      },
    });
  }

  async remove(userId: string, id: string) {
    const beneficiary = await this.prisma.beneficiary.findUnique({
      where: { id },
    });
    if (!beneficiary) throw new NotFoundException('Beneficiary not found.');
    if (beneficiary.userId !== userId) throw new ForbiddenException();

    await this.prisma.beneficiary.delete({ where: { id } });
    return { success: true };
  }

  /**
   * Called from TransactionsService.transferFunds() after a successful
   * transfer, not directly from a controller — bumps lastPaidAt so "most
   * recently paid" sort order stays accurate, and silently no-ops if the
   * recipient was never saved as a beneficiary in the first place (most
   * transfers won't be).
   */
  async recordPaymentIfSaved(userId: string, accountNumber: string) {
    await this.prisma.beneficiary
      .updateMany({
        where: { userId, accountNumber },
        data: { lastPaidAt: new Date() },
      })
      .catch(() => undefined); // best-effort bookkeeping — must never fail a transfer that already succeeded
  }
}

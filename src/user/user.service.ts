import { Injectable, NotFoundException, ConflictException, UnauthorizedException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { ChangePinDto } from './dto/change-pin.dto';
import * as bcrypt from 'bcrypt';

@Injectable()
export class UserService {
  constructor(private readonly prisma: PrismaService) {}

  async getUserDashboard(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        wallet: true,
        savingsGoals: true,
        loans: true,
        cards: true,
        invoices: true,
        transactions: {
          orderBy: { createdAt: 'desc' },
          take: 50,
        },
      },
    });

    if (!user) {
      throw new NotFoundException('User profile not found.');
    }

    const { pin, ...safeUserData } = user;

    return {
      user: safeUserData,
      balance: user.wallet?.balance ? Number(user.wallet.balance) : 0,
      transactions: user.transactions || [],
    };
  }

  async updateProfile(userId: string, dto: UpdateProfileDto) {
    if (!dto.name && !dto.email && !dto.address && !dto.profileImage) {
      throw new BadRequestException('Nothing to update.');
    }

    try {
      const updated = await this.prisma.user.update({
        where: { id: userId },
        data: {
          ...(dto.name !== undefined && { name: dto.name }),
          ...(dto.email !== undefined && { email: dto.email }),
          ...(dto.address !== undefined && { address: dto.address }),
          ...(dto.profileImage !== undefined && { profileImage: dto.profileImage }),
        },
      });

      const { pin, ...safeUser } = updated;
      return { success: true, user: safeUser };
    } catch (error) {
      // Prisma unique constraint violation (email already taken by another account)
      if (error.code === 'P2002') {
        throw new ConflictException('That email address is already in use.');
      }
      throw error;
    }
  }

  async changePin(userId: string, dto: ChangePinDto) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found.');

    const isOldPinValid = await bcrypt.compare(dto.oldPin, user.pin);
    if (!isOldPinValid) throw new UnauthorizedException('Your current PIN is incorrect.');

    const hashedNewPin = await bcrypt.hash(dto.newPin, 10);
    await this.prisma.user.update({ where: { id: userId }, data: { pin: hashedNewPin } });

    return { success: true };
  }

  // Looks up a user by either their accountNumber OR their phone number —
  // phone doubles as a second, more convenient "account number" for P2P
  // transfers. Returns only what's safe to show a would-be sender before
  // they commit to sending money (name + how they're identified), same as
  // real banking apps resolving a beneficiary name before confirming.
  async resolveRecipient(identifier: string, requestingUserId: string) {
    const cleanIdentifier = (identifier || '').trim();
    if (!cleanIdentifier) throw new BadRequestException('Provide an account number or phone number.');

    const recipient = await this.prisma.user.findFirst({
      where: {
        OR: [{ accountNumber: cleanIdentifier }, { phone: cleanIdentifier }],
      },
      select: { id: true, name: true, accountNumber: true, phone: true, profileImage: true },
    });

    if (!recipient) {
      throw new NotFoundException('No Zannypay user found with that account number or phone number.');
    }

    if (recipient.id === requestingUserId) {
      throw new BadRequestException('That identifier belongs to your own account.');
    }

    return { found: true, recipient };
  }
}

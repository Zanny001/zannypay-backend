import { Injectable, NotFoundException, ConflictException, UnauthorizedException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { ChangePinDto } from './dto/change-pin.dto';
import { ensureReferralCode } from '../common/referral-code.util';
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
        budgets: true,
        disputes: true,
        transactions: {
          orderBy: { createdAt: 'desc' },
          take: 50,
        },
      },
    });

    if (!user) {
      throw new NotFoundException('User profile not found.');
    }

    // Self-heals any legacy row still missing a referral code.
    if (!user.referralCode) {
      user.referralCode = await ensureReferralCode(this.prisma, user);
    }

    const { pin, ...safeUserData } = user;

    return {
      user: safeUserData,
      balance: user.wallet?.balance ? Number(user.wallet.balance) : 0,
      transactions: user.transactions || [],
    };
  }

  async updateProfile(userId: string, dto: UpdateProfileDto) {
    const hasAnyField = Object.values(dto).some((v) => v !== undefined);
    if (!hasAnyField) {
      throw new BadRequestException('Nothing to update.');
    }

    try {
      const currentUser = await this.prisma.user.findUnique({ where: { id: userId } });

      // Mock, self-reported KYC tier upgrade — there's no real BVN/NIN
      // verification provider wired up, so completing these fields is
      // treated as a good-faith Tier 2 upgrade rather than a verified one.
      const completingIdentityFields =
        (dto.bvn || currentUser?.bvn) && (dto.nextOfKinName || currentUser?.nextOfKinName) && (dto.nextOfKinPhone || currentUser?.nextOfKinPhone);
      const shouldUpgradeTier = completingIdentityFields && (currentUser?.kycTier || 1) < 2;

      const updated = await this.prisma.user.update({
        where: { id: userId },
        data: {
          ...(dto.name !== undefined && { name: dto.name }),
          ...(dto.email !== undefined && { email: dto.email }),
          ...(dto.address !== undefined && { address: dto.address }),
          ...(dto.profileImage !== undefined && { profileImage: dto.profileImage }),
          ...(dto.dateOfBirth !== undefined && { dateOfBirth: new Date(dto.dateOfBirth) }),
          ...(dto.gender !== undefined && { gender: dto.gender }),
          ...(dto.occupation !== undefined && { occupation: dto.occupation }),
          ...(dto.nationality !== undefined && { nationality: dto.nationality }),
          ...(dto.maritalStatus !== undefined && { maritalStatus: dto.maritalStatus }),
          ...(dto.nextOfKinName !== undefined && { nextOfKinName: dto.nextOfKinName }),
          ...(dto.nextOfKinPhone !== undefined && { nextOfKinPhone: dto.nextOfKinPhone }),
          ...(dto.bvn !== undefined && { bvn: dto.bvn }),
          ...(shouldUpgradeTier && { kycTier: 2, rewardPoints: { increment: 100 } }),
        },
      });

      const { pin, ...safeUser } = updated;
      return { success: true, user: safeUser, tierUpgraded: !!shouldUpgradeTier };
    } catch (error) {
      // Prisma unique constraint violation (email already taken by another account)
      if (error.code === 'P2002') {
        throw new ConflictException('That email address is already in use.');
      }
      throw error;
    }
  }

  // A real, backend-tracked daily check-in — one credit per calendar day,
  // not a client-side AsyncStorage counter that resets on reinstall.
  async dailyCheckIn(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found.');

    const now = new Date();
    const isSameDay = (a: Date, b: Date) =>
      a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

    if (user.lastCheckIn && isSameDay(new Date(user.lastCheckIn), now)) {
      return { success: false, alreadyCheckedIn: true, rewardPoints: user.rewardPoints };
    }

    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { rewardPoints: { increment: 10 }, lastCheckIn: now },
    });

    return { success: true, alreadyCheckedIn: false, rewardPoints: updated.rewardPoints };
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

import { Injectable, NotFoundException, ConflictException, UnauthorizedException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { ChangePinDto } from './dto/change-pin.dto';
import { RevealKycFieldDto } from './dto/reveal-kyc-field.dto';
import { ensureReferralCode } from '../common/referral-code.util';
import { encryptCustomerPII, decryptCustomerPII } from '../common/crypto.util';
import { StorageService } from '../storage/storage.service';
import { SavingsService } from '../savings/savings.service';
import * as bcrypt from 'bcryptjs';

@Injectable()
export class UserService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storageService: StorageService,
    private readonly savingsService: SavingsService,
  ) {}

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

    return {
      user: this.sanitizeUser(user),
      balance: user.wallet?.balance ? Number(user.wallet.balance) : 0,
      transactions: user.transactions || [],
      // Powers the mobile Home screen's earnings strip — see
      // SavingsService.ANNUAL_INTEREST_RATE for why savingsApy is now a
      // real, backend-sourced value instead of the hardcoded mobile
      // constant it used to silently fall back to.
      savingsApy: SavingsService.ANNUAL_INTEREST_RATE,
      lastInterestEarned: await this.savingsService.getLastInterestEarned(userId),
    };
  }

  async updateProfile(userId: string, dto: UpdateProfileDto) {
    const hasAnyField = Object.values(dto).some((v) => v !== undefined);
    if (!hasAnyField) {
      throw new BadRequestException('Nothing to update.');
    }

    try {
      const currentUser = await this.prisma.user.findUnique({ where: { id: userId } });

      // Submitting identity fields moves the user into the KYC review
      // queue — it no longer auto-grants Tier 2. An admin (Compliance
      // Officer or SuperAdmin) makes the actual approve/reject decision
      // via POST /admin/kyc/:userId/decide, which is what awards the
      // Tier 2 upgrade and the +100 reward points.
      const completingIdentityFields =
        (dto.bvn || currentUser?.bvnEncrypted) && (dto.nextOfKinName || currentUser?.nextOfKinName) && (dto.nextOfKinPhone || currentUser?.nextOfKinPhone);
      const shouldSubmitForReview =
        completingIdentityFields && currentUser?.kycStatus !== 'approved' && currentUser?.kycStatus !== 'pending';

      // Master audit, Critical #2: profile images were base64 data-URIs
      // stored directly in Postgres. storeImage() uploads to object
      // storage (or local disk in dev) and hands back a URL instead —
      // transparently, so the DTO/column shape never has to change and no
      // other consumer of `profileImage` (mobile Avatar, admin dashboard)
      // needs to know or care whether it's looking at a legacy base64 row
      // or a freshly-migrated URL; both are valid <Image source={{uri}}>
      // values. If no STORAGE_DRIVER is configured, storeImage() safely
      // falls back to returning the base64 unchanged.
      const resolvedProfileImage =
        dto.profileImage !== undefined ? await this.storageService.storeImage(dto.profileImage, `avatars/${userId}`) : undefined;

      const updated = await this.prisma.user.update({
        where: { id: userId },
        data: {
          ...(dto.name !== undefined && { name: dto.name }),
          ...(dto.email !== undefined && { email: dto.email }),
          ...(dto.address !== undefined && { address: dto.address }),
          ...(resolvedProfileImage !== undefined && { profileImage: resolvedProfileImage }),
          ...(dto.dateOfBirth !== undefined && { dateOfBirth: new Date(dto.dateOfBirth) }),
          ...(dto.gender !== undefined && { gender: dto.gender }),
          ...(dto.occupation !== undefined && { occupation: dto.occupation }),
          ...(dto.nationality !== undefined && { nationality: dto.nationality }),
          ...(dto.maritalStatus !== undefined && { maritalStatus: dto.maritalStatus }),
          ...(dto.nextOfKinName !== undefined && { nextOfKinName: dto.nextOfKinName }),
          ...(dto.nextOfKinPhone !== undefined && { nextOfKinPhone: dto.nextOfKinPhone }),
          ...(dto.bvn !== undefined && { bvnEncrypted: encryptCustomerPII(dto.bvn), bvnLast4: dto.bvn.slice(-4) }),
          ...(dto.nin !== undefined && { ninEncrypted: encryptCustomerPII(dto.nin), ninLast4: dto.nin.slice(-4) }),
          ...(shouldSubmitForReview && { kycStatus: 'pending' }),
        },
      });

      return { success: true, user: this.sanitizeUser(updated), submittedForReview: !!shouldSubmitForReview };
    } catch (error) {
      // Prisma unique constraint violation (email already taken by another account)
      if (error.code === 'P2002') {
        throw new ConflictException('That email address is already in use.');
      }
      throw error;
    }
  }

  // Strips fields that should never reach a client response: the PIN hash,
  // and the raw encrypted BVN/NIN blobs (meaningless to the client anyway,
  // but there's no reason for ciphertext to leave the server either — the
  // *Last4 hint fields are what the UI actually displays).
  private sanitizeUser<T extends Record<string, any>>(user: T) {
    const { pin, bvnEncrypted, ninEncrypted, kycRevealFailedAttempts, kycRevealLockedUntil, ...safeUser } = user;
    return safeUser;
  }

  // The only path that ever returns a full, plaintext BVN/NIN to anyone.
  // Requires the user's own transaction PIN — the same secret that
  // authorizes money movement — so a stolen-but-unlocked phone doesn't
  // automatically hand over national ID numbers along with wallet access.
  // Rate-limited the same way admin login is: 5 wrong PINs locks this
  // specific action for 15 minutes, independent of the wallet PIN itself
  // still working normally for transfers in the meantime.
  private static readonly REVEAL_LOCKOUT_THRESHOLD = 5;
  private static readonly REVEAL_LOCKOUT_MINUTES = 15;

  async revealKycField(userId: string, dto: RevealKycFieldDto) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found.');

    if (user.kycRevealLockedUntil && user.kycRevealLockedUntil.getTime() > Date.now()) {
      const minutesLeft = Math.ceil((user.kycRevealLockedUntil.getTime() - Date.now()) / 60000);
      throw new UnauthorizedException(`Too many attempts. Try again in ${minutesLeft} minute(s).`);
    }

    const isPinValid = await bcrypt.compare(dto.pin, user.pin);
    if (!isPinValid) {
      const attempts = user.kycRevealFailedAttempts + 1;
      const data: { kycRevealFailedAttempts: number; kycRevealLockedUntil?: Date } = { kycRevealFailedAttempts: attempts };
      if (attempts >= UserService.REVEAL_LOCKOUT_THRESHOLD) {
        data.kycRevealLockedUntil = new Date(Date.now() + UserService.REVEAL_LOCKOUT_MINUTES * 60 * 1000);
      }
      await this.prisma.user.update({ where: { id: userId }, data });
      throw new UnauthorizedException('Incorrect PIN.');
    }

    if (user.kycRevealFailedAttempts > 0 || user.kycRevealLockedUntil) {
      await this.prisma.user.update({ where: { id: userId }, data: { kycRevealFailedAttempts: 0, kycRevealLockedUntil: null } });
    }

    const encrypted = dto.field === 'bvn' ? user.bvnEncrypted : user.ninEncrypted;
    if (!encrypted) {
      throw new BadRequestException(`No ${dto.field.toUpperCase()} is on file for this account.`);
    }

    return { success: true, field: dto.field, value: decryptCustomerPII(encrypted) };
  }

  // A real, backend-tracked daily check-in — one credit per calendar day,
  // not a client-side AsyncStorage counter that resets on reinstall.
  // Also tracks a genuine consecutive-day streak (resets if a day is
  // missed) with milestone bonus points, rather than just a flat +10 with
  // no sense of progress.
  async dailyCheckIn(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found.');

    const now = new Date();
    const isSameDay = (a: Date, b: Date) =>
      a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
    const isYesterday = (a: Date, b: Date) => {
      const yesterday = new Date(b);
      yesterday.setDate(yesterday.getDate() - 1);
      return isSameDay(a, yesterday);
    };

    if (user.lastCheckIn && isSameDay(new Date(user.lastCheckIn), now)) {
      return { success: false, alreadyCheckedIn: true, rewardPoints: user.rewardPoints, streak: user.checkInStreak };
    }

    // Checking in the day right after the last one extends the streak;
    // any gap (or a first-ever check-in) starts a fresh one at 1.
    const newStreak = user.lastCheckIn && isYesterday(new Date(user.lastCheckIn), now) ? user.checkInStreak + 1 : 1;

    let bonus = 0;
    let milestone: number | null = null;
    if (newStreak === 7) { bonus = 50; milestone = 7; }
    else if (newStreak === 14) { bonus = 100; milestone = 14; }
    else if (newStreak > 0 && newStreak % 30 === 0) { bonus = 250; milestone = newStreak; }

    const pointsEarned = 10 + bonus;

    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { rewardPoints: { increment: pointsEarned }, lastCheckIn: now, checkInStreak: newStreak },
    });

    return {
      success: true,
      alreadyCheckedIn: false,
      rewardPoints: updated.rewardPoints,
      streak: newStreak,
      pointsEarned,
      milestone, // non-null only on a milestone day — the frontend uses this to show a bigger celebration
    };
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
        OR: [{ accountNumber: cleanIdentifier }, { phone: cleanIdentifier }, { businessAccountNumber: cleanIdentifier }],
      },
      select: { id: true, name: true, accountNumber: true, phone: true, profileImage: true, businessName: true, businessAccountNumber: true },
    });

    if (!recipient) {
      throw new NotFoundException('No Zannypay user found with that account number or phone number.');
    }

    if (recipient.id === requestingUserId) {
      throw new BadRequestException('That identifier belongs to your own account.');
    }

    // If the sender specifically typed the business number, show the
    // business name back to them — "Sending to: Jane's Bakery" is a more
    // meaningful confirmation than her personal name when that's clearly
    // what they meant to pay.
    const matchedViaBusiness = recipient.businessAccountNumber === cleanIdentifier;
    const displayRecipient = matchedViaBusiness ? { ...recipient, name: recipient.businessName || recipient.name } : recipient;

    return { found: true, recipient: displayRecipient };
  }
}

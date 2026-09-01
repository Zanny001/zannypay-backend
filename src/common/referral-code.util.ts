import { PrismaService } from '../prisma/prisma.service';

// A handful of collision retries is more than enough at realistic user
// scale; the code space (8 chars, base36) is enormous relative to expected
// signup volume.
export async function generateUniqueReferralCode(prisma: PrismaService): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = Math.random().toString(36).slice(2, 10).toUpperCase();
    const existing = await prisma.user.findUnique({ where: { referralCode: code } });
    if (!existing) return code;
  }
  // Extremely unlikely fallback — timestamp-based, still effectively unique.
  return `Z${Date.now().toString(36).toUpperCase()}`;
}

// Self-heals any user record still missing a referral code (e.g. a row
// that predates referrals being added, or slipped through a migration
// backfill) by generating and persisting one on next read, rather than
// requiring another manual migration every time this happens.
export async function ensureReferralCode(prisma: PrismaService, user: { id: string; referralCode: string | null }): Promise<string> {
  if (user.referralCode) return user.referralCode;
  const code = await generateUniqueReferralCode(prisma);
  await prisma.user.update({ where: { id: user.id }, data: { referralCode: code } });
  return code;
}

-- FIX: production rows exist with NULL "referralCode" despite the column
-- previously being set NOT NULL — every read of those rows (login,
-- /user/me, /referrals/me) was crashing with Prisma error P2032
-- ("found incompatible value of null"). This migration is written to be
-- safe to run regardless of the column's current actual state:
--   - DROP NOT NULL is a no-op if it's already nullable
--   - the UPDATE only touches rows that still have NULL, so it's safe to
--     re-run even if a previous attempt partially succeeded

-- AlterTable
ALTER TABLE "User" ALTER COLUMN "referralCode" DROP NOT NULL;

-- Backfill (idempotent — only affects rows still missing a code)
UPDATE "User"
SET "referralCode" = UPPER(SUBSTRING(MD5(RANDOM()::TEXT || "id" || CLOCK_TIMESTAMP()::TEXT), 1, 8))
WHERE "referralCode" IS NULL;

-- Previously "bvn" only ever stored the last 4 digits (enforced by
-- @MaxLength(4) at the API layer) — no full BVN was ever collected or
-- stored, so there is no real data to migrate out of it. Dropping it
-- outright rather than renaming, since its old semantics ("this is already
-- masked") no longer apply and keeping it around would be misleading.
ALTER TABLE "User" DROP COLUMN "bvn";

ALTER TABLE "User" ADD COLUMN "bvnEncrypted" TEXT;
ALTER TABLE "User" ADD COLUMN "bvnLast4" TEXT;
ALTER TABLE "User" ADD COLUMN "ninEncrypted" TEXT;
ALTER TABLE "User" ADD COLUMN "ninLast4" TEXT;
ALTER TABLE "User" ADD COLUMN "kycRevealFailedAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "User" ADD COLUMN "kycRevealLockedUntil" TIMESTAMP(3);

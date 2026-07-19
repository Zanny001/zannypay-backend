-- AlterTable: expanded profile / KYC-lite fields on User
ALTER TABLE "User" ADD COLUMN "dateOfBirth" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "gender" TEXT;
ALTER TABLE "User" ADD COLUMN "occupation" TEXT;
ALTER TABLE "User" ADD COLUMN "nationality" TEXT;
ALTER TABLE "User" ADD COLUMN "maritalStatus" TEXT;
ALTER TABLE "User" ADD COLUMN "nextOfKinName" TEXT;
ALTER TABLE "User" ADD COLUMN "nextOfKinPhone" TEXT;
ALTER TABLE "User" ADD COLUMN "bvn" TEXT;
ALTER TABLE "User" ADD COLUMN "kycTier" INTEGER NOT NULL DEFAULT 1;

-- AlterTable: referral tracking
ALTER TABLE "User" ADD COLUMN "referralCode" TEXT;
ALTER TABLE "User" ADD COLUMN "referredBy" TEXT;

-- Backfill referralCode for any existing rows before enforcing NOT NULL + UNIQUE
UPDATE "User" SET "referralCode" = UPPER(SUBSTRING(MD5(RANDOM()::TEXT || "id"), 1, 8)) WHERE "referralCode" IS NULL;

ALTER TABLE "User" ALTER COLUMN "referralCode" SET NOT NULL;
CREATE UNIQUE INDEX "User_referralCode_key" ON "User"("referralCode");

-- CreateTable: Dispute
CREATE TABLE "Dispute" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "details" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Dispute_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "Dispute" ADD CONSTRAINT "Dispute_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

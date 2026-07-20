-- AlterTable
ALTER TABLE "User" ADD COLUMN "rewardPoints" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "User" ADD COLUMN "lastCheckIn" TIMESTAMP(3);

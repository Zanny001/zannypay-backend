-- CreateEnum
CREATE TYPE "AdminRole" AS ENUM ('SUPER_ADMIN', 'COMPLIANCE_OFFICER', 'FINANCE_OFFICER', 'SUPPORT_AGENT');

-- CreateTable: AdminUser
CREATE TABLE "AdminUser" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "role" "AdminRole" NOT NULL DEFAULT 'SUPPORT_AGENT',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdminUser_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AdminUser_email_key" ON "AdminUser"("email");

-- CreateTable: AuditLog
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "adminId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "metadata" JSONB,
    "ipAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "AdminUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable: User — freeze + real KYC review status
ALTER TABLE "User" ADD COLUMN "kycStatus" TEXT NOT NULL DEFAULT 'unverified';
ALTER TABLE "User" ADD COLUMN "kycRejectionReason" TEXT;
ALTER TABLE "User" ADD COLUMN "isFrozen" BOOLEAN NOT NULL DEFAULT false;

-- Any user who already reached kycTier 2 under the old auto-approval flow
-- is grandfathered in as "approved" so they aren't demoted by this change.
UPDATE "User" SET "kycStatus" = 'approved' WHERE "kycTier" >= 2;

-- AlterTable: Transaction — flagging + reversal tracking
ALTER TABLE "Transaction" ADD COLUMN "flagged" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Transaction" ADD COLUMN "reversedTransactionId" TEXT;
ALTER TABLE "Transaction" ADD COLUMN "reversalReason" TEXT;

-- AlterTable: Dispute — resolution tracking
ALTER TABLE "Dispute" ADD COLUMN "resolutionNote" TEXT;
ALTER TABLE "Dispute" ADD COLUMN "resolvedByAdminId" TEXT;

ALTER TABLE "User" ADD COLUMN "businessName" TEXT;
ALTER TABLE "User" ADD COLUMN "businessAccountNumber" TEXT;
CREATE UNIQUE INDEX "User_businessAccountNumber_key" ON "User"("businessAccountNumber");

ALTER TABLE "Transaction" ADD COLUMN "receivedVia" TEXT NOT NULL DEFAULT 'personal';

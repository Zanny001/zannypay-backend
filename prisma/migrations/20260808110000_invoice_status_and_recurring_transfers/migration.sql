ALTER TABLE "Invoice" ADD COLUMN "paidAt" TIMESTAMP(3);

CREATE TABLE "RecurringTransfer" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "recipientAccount" TEXT NOT NULL,
    "recipientName" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "note" TEXT,
    "frequency" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "nextRunAt" TIMESTAMP(3) NOT NULL,
    "lastRunAt" TIMESTAMP(3),
    "lastRunStatus" TEXT,
    "lastRunError" TEXT,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecurringTransfer_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "RecurringTransfer" ADD CONSTRAINT "RecurringTransfer_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "RecurringTransfer_userId_status_idx" ON "RecurringTransfer"("userId", "status");
CREATE INDEX "RecurringTransfer_status_nextRunAt_idx" ON "RecurringTransfer"("status", "nextRunAt");

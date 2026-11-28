ALTER TABLE "Transaction" ADD COLUMN "providerTransferId" TEXT;
CREATE UNIQUE INDEX "Transaction_providerTransferId_key" ON "Transaction"("providerTransferId");

CREATE TABLE "PaystackBalanceLedgerEntry" (
  "providerEntryId" TEXT NOT NULL,
  "modelResponsible" TEXT,
  "modelRow" TEXT,
  "currency" TEXT NOT NULL,
  "differenceKobo" BIGINT NOT NULL,
  "balanceKobo" BIGINT NOT NULL,
  "reason" TEXT,
  "providerCreatedAt" TIMESTAMP(3) NOT NULL,
  "matchedTransactionId" TEXT,
  "reconciliationStatus" TEXT NOT NULL DEFAULT 'unmatched',
  "raw" JSONB NOT NULL,
  "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PaystackBalanceLedgerEntry_pkey" PRIMARY KEY ("providerEntryId")
);
CREATE INDEX "PaystackBalanceLedgerEntry_modelResponsible_modelRow_idx" ON "PaystackBalanceLedgerEntry"("modelResponsible", "modelRow");
CREATE INDEX "PaystackBalanceLedgerEntry_providerCreatedAt_idx" ON "PaystackBalanceLedgerEntry"("providerCreatedAt");
CREATE INDEX "PaystackBalanceLedgerEntry_reconciliationStatus_providerCreatedAt_idx" ON "PaystackBalanceLedgerEntry"("reconciliationStatus", "providerCreatedAt");

ALTER TABLE "Transaction"
  ADD COLUMN "providerRequestId" TEXT,
  ADD COLUMN "providerTransactionId" TEXT,
  ADD COLUMN "providerStatus" TEXT,
  ADD COLUMN "providerServiceId" TEXT,
  ADD COLUMN "providerVariationCode" TEXT,
  ADD COLUMN "customerIdentifier" TEXT,
  ADD COLUMN "purchasedCode" TEXT;

CREATE UNIQUE INDEX "Transaction_providerRequestId_key"
  ON "Transaction"("providerRequestId");

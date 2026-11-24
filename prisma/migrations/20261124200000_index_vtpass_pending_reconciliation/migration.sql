CREATE INDEX "Transaction_category_status_providerLastCheckedAt_createdAt_idx"
  ON "Transaction"("category", "status", "providerLastCheckedAt", "createdAt");
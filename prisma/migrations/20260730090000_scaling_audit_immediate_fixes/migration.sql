-- Idempotency support on money-movement transactions: a client-supplied
-- key makes a retried transfer/bill/airtime request a no-op instead of a
-- second debit. Nullable + unique: most historical rows have none, but any
-- two rows that DO have one must never collide.
ALTER TABLE "Transaction" ADD COLUMN "idempotencyKey" TEXT;
CREATE UNIQUE INDEX "Transaction_idempotencyKey_key" ON "Transaction"("idempotencyKey");

-- Missing indexes on foreign-key columns that power every "show my X"
-- customer-facing query. Without these, each one is a sequential scan as
-- the table grows. (Budget already has a usable leading-column index via
-- its existing @@unique([userId, category]), so it's not repeated here.)
CREATE INDEX "Dispute_userId_idx" ON "Dispute"("userId");
CREATE INDEX "SavingsGoal_userId_idx" ON "SavingsGoal"("userId");
CREATE INDEX "Loan_userId_idx" ON "Loan"("userId");
CREATE INDEX "Card_userId_idx" ON "Card"("userId");
CREATE INDEX "Invoice_userId_idx" ON "Invoice"("userId");

-- CVV must never be a stored field, per PCI-DSS, even for mock/demo card
-- data — see the schema comment on the Card model. Dropping the column
-- outright rather than just no longer writing to it, so it can't leak via
-- an old row or a stray SELECT *.
ALTER TABLE "Card" DROP COLUMN "cvv";

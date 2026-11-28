-- Record actual Paystack transfer charges independently from the customer payout.
ALTER TYPE "LedgerAccountType" ADD VALUE 'SYSTEM_PROCESSOR_FEE_EXPENSE';

ALTER TABLE "Transaction"
ADD COLUMN "providerFee" DECIMAL(10,2);

-- Add a per-customer credential generation. Existing tokens are generation 0.
ALTER TABLE "User"
ADD COLUMN "tokenVersion" INTEGER NOT NULL DEFAULT 0;

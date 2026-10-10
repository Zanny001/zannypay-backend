-- Self-serve account deletion (DELETE /user/me): the user row is
-- anonymized in place rather than hard-deleted so transaction and ledger
-- history is preserved for CBN record-retention rules and the
-- double-entry ledger keeps balancing.
ALTER TABLE "User" ADD COLUMN "deletedAt" TIMESTAMP(3);

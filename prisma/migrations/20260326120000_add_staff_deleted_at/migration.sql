ALTER TABLE "Staff"
ADD COLUMN "deletedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "Staff_deletedAt_idx" ON "Staff"("deletedAt");

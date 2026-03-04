-- AlterTable
ALTER TABLE "ClientAccount"
ADD COLUMN "passwordResetTokenHash" TEXT,
ADD COLUMN "passwordResetExpiresAt" TIMESTAMP(3),
ADD COLUMN "passwordResetUsedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "ClientAccount_passwordResetTokenHash_idx" ON "ClientAccount"("passwordResetTokenHash");

-- CreateIndex
CREATE INDEX "ClientAccount_passwordResetExpiresAt_idx" ON "ClientAccount"("passwordResetExpiresAt");

-- CreateIndex
CREATE INDEX "ClientAccount_passwordResetUsedAt_idx" ON "ClientAccount"("passwordResetUsedAt");

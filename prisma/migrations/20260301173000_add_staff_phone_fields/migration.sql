ALTER TABLE "Staff"
ADD COLUMN "phone10" TEXT,
ADD COLUMN "phoneE164" TEXT;

CREATE UNIQUE INDEX "Staff_phone10_key" ON "Staff"("phone10");

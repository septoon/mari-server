CREATE TABLE "SpecialistRating" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "value" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SpecialistRating_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "SpecialistRating"
ADD CONSTRAINT "SpecialistRating_clientId_fkey"
FOREIGN KEY ("clientId") REFERENCES "Client"("id")
ON DELETE CASCADE
ON UPDATE CASCADE;

ALTER TABLE "SpecialistRating"
ADD CONSTRAINT "SpecialistRating_staffId_fkey"
FOREIGN KEY ("staffId") REFERENCES "Staff"("id")
ON DELETE CASCADE
ON UPDATE CASCADE;

CREATE UNIQUE INDEX "SpecialistRating_clientId_staffId_key" ON "SpecialistRating"("clientId", "staffId");
CREATE INDEX "SpecialistRating_clientId_idx" ON "SpecialistRating"("clientId");
CREATE INDEX "SpecialistRating_staffId_idx" ON "SpecialistRating"("staffId");

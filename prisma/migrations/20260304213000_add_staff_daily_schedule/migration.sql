-- CreateTable
CREATE TABLE "StaffDailySchedule" (
    "id" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "intervals" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StaffDailySchedule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StaffDailySchedule_staffId_date_key" ON "StaffDailySchedule"("staffId", "date");

-- CreateIndex
CREATE INDEX "StaffDailySchedule_date_idx" ON "StaffDailySchedule"("date");

-- AddForeignKey
ALTER TABLE "StaffDailySchedule" ADD CONSTRAINT "StaffDailySchedule_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "Staff"("id") ON DELETE CASCADE ON UPDATE CASCADE;

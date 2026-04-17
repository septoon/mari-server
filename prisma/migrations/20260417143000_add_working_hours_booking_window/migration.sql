ALTER TABLE "WorkingHours"
ADD COLUMN "bookingStartTime" TEXT,
ADD COLUMN "bookingEndTime" TEXT;

UPDATE "WorkingHours"
SET
  "bookingStartTime" = "startTime",
  "bookingEndTime" = "endTime"
WHERE "bookingStartTime" IS NULL
   OR "bookingEndTime" IS NULL;

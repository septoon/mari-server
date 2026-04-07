ALTER TABLE "Staff"
ADD COLUMN "receivesAllAppointmentNotifications" BOOLEAN NOT NULL DEFAULT false;

UPDATE "Staff"
SET "receivesAllAppointmentNotifications" = true
WHERE "role" = 'OWNER';

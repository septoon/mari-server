-- Remove MASTER staff and all dependent data.
-- This keeps only OWNER/ADMIN accounts until masters are added manually via UI.
DELETE FROM "Payment"
WHERE "appointmentId" IN (
  SELECT a."id"
  FROM "Appointment" a
  JOIN "Staff" s ON s."id" = a."staffId"
  WHERE s."role" = 'MASTER'
);

DELETE FROM "AppointmentService"
WHERE "appointmentId" IN (
  SELECT a."id"
  FROM "Appointment" a
  JOIN "Staff" s ON s."id" = a."staffId"
  WHERE s."role" = 'MASTER'
);

DELETE FROM "Appointment"
WHERE "staffId" IN (
  SELECT "id" FROM "Staff" WHERE "role" = 'MASTER'
);

DELETE FROM "WorkingHours"
WHERE "staffId" IN (
  SELECT "id" FROM "Staff" WHERE "role" = 'MASTER'
);

DELETE FROM "TimeOff"
WHERE "staffId" IN (
  SELECT "id" FROM "Staff" WHERE "role" = 'MASTER'
);

DELETE FROM "Block"
WHERE "staffId" IN (
  SELECT "id" FROM "Staff" WHERE "role" = 'MASTER'
);

DELETE FROM "StaffService"
WHERE "staffId" IN (
  SELECT "id" FROM "Staff" WHERE "role" = 'MASTER'
);

DELETE FROM "StaffToken"
WHERE "staffId" IN (
  SELECT "id" FROM "Staff" WHERE "role" = 'MASTER'
);

DELETE FROM "StaffPermission"
WHERE "staffId" IN (
  SELECT "id" FROM "Staff" WHERE "role" = 'MASTER'
)
OR "grantedByStaffId" IN (
  SELECT "id" FROM "Staff" WHERE "role" = 'MASTER'
);

DELETE FROM "ImportJobErrorRow"
WHERE "importJobId" IN (
  SELECT "id"
  FROM "ImportJob"
  WHERE "uploadedByStaffId" IN (
    SELECT "id" FROM "Staff" WHERE "role" = 'MASTER'
  )
);

DELETE FROM "ImportJob"
WHERE "uploadedByStaffId" IN (
  SELECT "id" FROM "Staff" WHERE "role" = 'MASTER'
);

DELETE FROM "Staff"
WHERE "role" = 'MASTER';

-- Enforce absolute phone identity for all staff.
ALTER TABLE "Staff"
ALTER COLUMN "phone10" SET NOT NULL;

ALTER TABLE "Staff"
ALTER COLUMN "phoneE164" SET NOT NULL;

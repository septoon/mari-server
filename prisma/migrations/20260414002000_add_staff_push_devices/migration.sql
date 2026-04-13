CREATE TYPE "PushEnvironment" AS ENUM ('SANDBOX', 'PRODUCTION');

CREATE TABLE "StaffPushDevice" (
    "id" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "environment" "PushEnvironment" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StaffPushDevice_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PushDispatch" (
    "id" TEXT NOT NULL,
    "dispatchKey" TEXT NOT NULL,
    "notificationId" TEXT NOT NULL,
    "staffPushDeviceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PushDispatch_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "StaffPushDevice_token_key" ON "StaffPushDevice"("token");
CREATE INDEX "StaffPushDevice_staffId_idx" ON "StaffPushDevice"("staffId");
CREATE INDEX "StaffPushDevice_environment_idx" ON "StaffPushDevice"("environment");

CREATE UNIQUE INDEX "PushDispatch_dispatchKey_key" ON "PushDispatch"("dispatchKey");
CREATE INDEX "PushDispatch_notificationId_createdAt_idx" ON "PushDispatch"("notificationId", "createdAt");
CREATE INDEX "PushDispatch_staffPushDeviceId_idx" ON "PushDispatch"("staffPushDeviceId");

ALTER TABLE "StaffPushDevice" ADD CONSTRAINT "StaffPushDevice_staffId_fkey"
FOREIGN KEY ("staffId") REFERENCES "Staff"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PushDispatch" ADD CONSTRAINT "PushDispatch_staffPushDeviceId_fkey"
FOREIGN KEY ("staffPushDeviceId") REFERENCES "StaffPushDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AppConfig"
ADD COLUMN "notificationMinNoticeMinutes" INTEGER NOT NULL DEFAULT 120,
ADD COLUMN "notificationSettings" JSONB NOT NULL DEFAULT '{}';

CREATE TABLE "NotificationDispatch" (
    "id" TEXT NOT NULL,
    "dispatchKey" TEXT NOT NULL,
    "notificationId" TEXT NOT NULL,
    "recipientEmail" TEXT NOT NULL,
    "meta" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationDispatch_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "NotificationDispatch_dispatchKey_key" ON "NotificationDispatch"("dispatchKey");
CREATE INDEX "NotificationDispatch_notificationId_createdAt_idx" ON "NotificationDispatch"("notificationId", "createdAt");
CREATE INDEX "NotificationDispatch_recipientEmail_idx" ON "NotificationDispatch"("recipientEmail");

-- CreateTable
CREATE TABLE "AppConfig" (
    "id" TEXT NOT NULL,
    "singleton" TEXT NOT NULL DEFAULT 'default',
    "clientCancelMinNoticeMinutes" INTEGER NOT NULL DEFAULT 120,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AppConfig_singleton_key" ON "AppConfig"("singleton");

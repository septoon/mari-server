-- CreateEnum
CREATE TYPE "ClientContentStatus" AS ENUM ('DRAFT', 'PUBLISHED');

-- CreateEnum
CREATE TYPE "ClientPlatform" AS ENUM ('ALL', 'IOS', 'ANDROID', 'WEB');

-- CreateTable
CREATE TABLE "ClientAppConfig" (
    "id" TEXT NOT NULL,
    "singleton" TEXT NOT NULL DEFAULT 'default',
    "brandNameDraft" TEXT,
    "legalNameDraft" TEXT,
    "minAppVersionIosDraft" TEXT,
    "minAppVersionAndroidDraft" TEXT,
    "maintenanceModeDraft" BOOLEAN NOT NULL DEFAULT false,
    "maintenanceMessageDraft" TEXT,
    "featureFlagsDraft" JSONB NOT NULL DEFAULT '{}',
    "contactsDraft" JSONB NOT NULL DEFAULT '[]',
    "extraDraft" JSONB NOT NULL DEFAULT '{}',
    "brandNamePublished" TEXT,
    "legalNamePublished" TEXT,
    "minAppVersionIosPublished" TEXT,
    "minAppVersionAndroidPublished" TEXT,
    "maintenanceModePublished" BOOLEAN NOT NULL DEFAULT false,
    "maintenanceMessagePublished" TEXT,
    "featureFlagsPublished" JSONB NOT NULL DEFAULT '{}',
    "contactsPublished" JSONB NOT NULL DEFAULT '[]',
    "extraPublished" JSONB NOT NULL DEFAULT '{}',
    "publishedVersion" INTEGER NOT NULL DEFAULT 0,
    "publishedReleaseId" TEXT,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClientAppConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClientContentRelease" (
    "id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "etag" TEXT NOT NULL,
    "appConfigSnapshot" JSONB NOT NULL,
    "blocksCount" INTEGER NOT NULL,
    "publishedByStaffId" TEXT NOT NULL,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClientContentRelease_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClientContentBlock" (
    "id" TEXT NOT NULL,
    "blockKey" TEXT NOT NULL,
    "blockType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "status" "ClientContentStatus" NOT NULL DEFAULT 'DRAFT',
    "platform" "ClientPlatform" NOT NULL DEFAULT 'ALL',
    "minAppVersion" TEXT,
    "maxAppVersion" TEXT,
    "startAt" TIMESTAMP(3),
    "endAt" TIMESTAMP(3),
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "releaseId" TEXT,
    "createdByStaffId" TEXT,
    "updatedByStaffId" TEXT,
    "publishedByStaffId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClientContentBlock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MediaAsset" (
    "id" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "originalFileName" TEXT NOT NULL,
    "originalMime" TEXT NOT NULL,
    "originalSize" INTEGER NOT NULL,
    "originalWidth" INTEGER NOT NULL,
    "originalHeight" INTEGER NOT NULL,
    "checksumSha256" TEXT NOT NULL,
    "originalPath" TEXT NOT NULL,
    "createdByStaffId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MediaAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MediaVariant" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "path" TEXT NOT NULL,
    "urlPath" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MediaVariant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MediaUsage" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "usageType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "fieldPath" TEXT NOT NULL DEFAULT '',
    "note" TEXT,
    "createdByStaffId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MediaUsage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "actorStaffId" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "diff" JSONB,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ClientAppConfig_singleton_key" ON "ClientAppConfig"("singleton");

-- CreateIndex
CREATE UNIQUE INDEX "ClientContentRelease_version_key" ON "ClientContentRelease"("version");

-- CreateIndex
CREATE UNIQUE INDEX "ClientContentRelease_etag_key" ON "ClientContentRelease"("etag");

-- CreateIndex
CREATE INDEX "ClientContentRelease_publishedAt_idx" ON "ClientContentRelease"("publishedAt");

-- CreateIndex
CREATE INDEX "ClientContentBlock_status_sortOrder_idx" ON "ClientContentBlock"("status", "sortOrder");

-- CreateIndex
CREATE INDEX "ClientContentBlock_blockType_idx" ON "ClientContentBlock"("blockType");

-- CreateIndex
CREATE INDEX "ClientContentBlock_platform_minAppVersion_maxAppVersion_idx" ON "ClientContentBlock"("platform", "minAppVersion", "maxAppVersion");

-- CreateIndex
CREATE INDEX "ClientContentBlock_startAt_endAt_idx" ON "ClientContentBlock"("startAt", "endAt");

-- CreateIndex
CREATE INDEX "ClientContentBlock_releaseId_idx" ON "ClientContentBlock"("releaseId");

-- CreateIndex
CREATE INDEX "MediaAsset_entity_createdAt_idx" ON "MediaAsset"("entity", "createdAt");

-- CreateIndex
CREATE INDEX "MediaAsset_checksumSha256_idx" ON "MediaAsset"("checksumSha256");

-- CreateIndex
CREATE INDEX "MediaAsset_createdByStaffId_idx" ON "MediaAsset"("createdByStaffId");

-- CreateIndex
CREATE INDEX "MediaVariant_assetId_idx" ON "MediaVariant"("assetId");

-- CreateIndex
CREATE UNIQUE INDEX "MediaVariant_assetId_format_width_key" ON "MediaVariant"("assetId", "format", "width");

-- CreateIndex
CREATE INDEX "MediaUsage_usageType_entityId_idx" ON "MediaUsage"("usageType", "entityId");

-- CreateIndex
CREATE INDEX "MediaUsage_assetId_idx" ON "MediaUsage"("assetId");

-- CreateIndex
CREATE INDEX "MediaUsage_createdByStaffId_idx" ON "MediaUsage"("createdByStaffId");

-- CreateIndex
CREATE UNIQUE INDEX "MediaUsage_assetId_usageType_entityId_fieldPath_key" ON "MediaUsage"("assetId", "usageType", "entityId", "fieldPath");

-- CreateIndex
CREATE INDEX "AuditLog_entityType_entityId_createdAt_idx" ON "AuditLog"("entityType", "entityId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_actorStaffId_createdAt_idx" ON "AuditLog"("actorStaffId", "createdAt");

-- AddForeignKey
ALTER TABLE "ClientAppConfig" ADD CONSTRAINT "ClientAppConfig_publishedReleaseId_fkey" FOREIGN KEY ("publishedReleaseId") REFERENCES "ClientContentRelease"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientContentRelease" ADD CONSTRAINT "ClientContentRelease_publishedByStaffId_fkey" FOREIGN KEY ("publishedByStaffId") REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientContentBlock" ADD CONSTRAINT "ClientContentBlock_releaseId_fkey" FOREIGN KEY ("releaseId") REFERENCES "ClientContentRelease"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientContentBlock" ADD CONSTRAINT "ClientContentBlock_createdByStaffId_fkey" FOREIGN KEY ("createdByStaffId") REFERENCES "Staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientContentBlock" ADD CONSTRAINT "ClientContentBlock_updatedByStaffId_fkey" FOREIGN KEY ("updatedByStaffId") REFERENCES "Staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientContentBlock" ADD CONSTRAINT "ClientContentBlock_publishedByStaffId_fkey" FOREIGN KEY ("publishedByStaffId") REFERENCES "Staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_createdByStaffId_fkey" FOREIGN KEY ("createdByStaffId") REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaVariant" ADD CONSTRAINT "MediaVariant_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "MediaAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaUsage" ADD CONSTRAINT "MediaUsage_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "MediaAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaUsage" ADD CONSTRAINT "MediaUsage_createdByStaffId_fkey" FOREIGN KEY ("createdByStaffId") REFERENCES "Staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorStaffId_fkey" FOREIGN KEY ("actorStaffId") REFERENCES "Staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;

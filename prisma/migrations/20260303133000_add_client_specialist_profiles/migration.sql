-- CreateTable
CREATE TABLE "ClientSpecialistProfile" (
    "id" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "photoAssetIdDraft" TEXT,
    "photoAssetIdPublished" TEXT,
    "specialtyDraft" TEXT,
    "specialtyPublished" TEXT,
    "infoDraft" TEXT,
    "infoPublished" TEXT,
    "ctaTextDraft" TEXT NOT NULL DEFAULT 'Записаться',
    "ctaTextPublished" TEXT NOT NULL DEFAULT 'Записаться',
    "isVisibleDraft" BOOLEAN NOT NULL DEFAULT true,
    "isVisiblePublished" BOOLEAN NOT NULL DEFAULT true,
    "sortOrderDraft" INTEGER NOT NULL DEFAULT 0,
    "sortOrderPublished" INTEGER NOT NULL DEFAULT 0,
    "updatedByStaffId" TEXT,
    "publishedByStaffId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClientSpecialistProfile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ClientSpecialistProfile_staffId_key" ON "ClientSpecialistProfile"("staffId");

-- CreateIndex
CREATE INDEX "ClientSpecialistProfile_isVisibleDraft_sortOrderDraft_idx" ON "ClientSpecialistProfile"("isVisibleDraft", "sortOrderDraft");

-- CreateIndex
CREATE INDEX "ClientSpecialistProfile_isVisiblePublished_sortOrderPublished_idx" ON "ClientSpecialistProfile"("isVisiblePublished", "sortOrderPublished");

-- CreateIndex
CREATE INDEX "ClientSpecialistProfile_updatedByStaffId_idx" ON "ClientSpecialistProfile"("updatedByStaffId");

-- CreateIndex
CREATE INDEX "ClientSpecialistProfile_publishedByStaffId_idx" ON "ClientSpecialistProfile"("publishedByStaffId");

-- AddForeignKey
ALTER TABLE "ClientSpecialistProfile" ADD CONSTRAINT "ClientSpecialistProfile_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "Staff"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientSpecialistProfile" ADD CONSTRAINT "ClientSpecialistProfile_photoAssetIdDraft_fkey" FOREIGN KEY ("photoAssetIdDraft") REFERENCES "MediaAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientSpecialistProfile" ADD CONSTRAINT "ClientSpecialistProfile_photoAssetIdPublished_fkey" FOREIGN KEY ("photoAssetIdPublished") REFERENCES "MediaAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientSpecialistProfile" ADD CONSTRAINT "ClientSpecialistProfile_updatedByStaffId_fkey" FOREIGN KEY ("updatedByStaffId") REFERENCES "Staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientSpecialistProfile" ADD CONSTRAINT "ClientSpecialistProfile_publishedByStaffId_fkey" FOREIGN KEY ("publishedByStaffId") REFERENCES "Staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;

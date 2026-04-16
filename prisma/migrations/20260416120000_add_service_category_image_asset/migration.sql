ALTER TABLE "ServiceCategory"
ADD COLUMN "imageAssetId" TEXT;

ALTER TABLE "ServiceCategory"
ADD CONSTRAINT "ServiceCategory_imageAssetId_fkey"
FOREIGN KEY ("imageAssetId") REFERENCES "MediaAsset"("id")
ON DELETE SET NULL
ON UPDATE CASCADE;

CREATE INDEX "ServiceCategory_imageAssetId_idx" ON "ServiceCategory"("imageAssetId");

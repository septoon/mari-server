ALTER TABLE "Service"
ADD COLUMN "imageAssetId" TEXT;

CREATE INDEX "Service_imageAssetId_idx" ON "Service"("imageAssetId");

ALTER TABLE "Service"
ADD CONSTRAINT "Service_imageAssetId_fkey"
FOREIGN KEY ("imageAssetId") REFERENCES "MediaAsset"("id")
ON DELETE SET NULL
ON UPDATE CASCADE;

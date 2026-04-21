CREATE TABLE "ServiceSection" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "imageAssetId" TEXT,
    "orderIndex" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ServiceSection_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "ServiceCategory"
ADD COLUMN "sectionId" TEXT;

ALTER TABLE "ServiceSection"
ADD CONSTRAINT "ServiceSection_imageAssetId_fkey"
FOREIGN KEY ("imageAssetId") REFERENCES "MediaAsset"("id")
ON DELETE SET NULL
ON UPDATE CASCADE;

ALTER TABLE "ServiceCategory"
ADD CONSTRAINT "ServiceCategory_sectionId_fkey"
FOREIGN KEY ("sectionId") REFERENCES "ServiceSection"("id")
ON DELETE SET NULL
ON UPDATE CASCADE;

CREATE UNIQUE INDEX "ServiceSection_name_key" ON "ServiceSection"("name");
CREATE INDEX "ServiceSection_imageAssetId_idx" ON "ServiceSection"("imageAssetId");
CREATE INDEX "ServiceSection_orderIndex_idx" ON "ServiceSection"("orderIndex");
CREATE INDEX "ServiceCategory_sectionId_idx" ON "ServiceCategory"("sectionId");

INSERT INTO "ServiceSection" ("id", "name", "orderIndex")
VALUES
  ('f995b1e0-31c6-478a-8cc4-4cbe0c1f8551', 'Парикмахерские услуги', 10),
  ('711278eb-3db0-4b55-b3cb-8a7d7165870e', 'Ногтевой сервис', 20),
  ('2ad1d37a-aad7-47ad-9756-af3020bd1d5f', 'Косметология', 30),
  ('5d87e7e6-df34-4d9c-b6f0-59d7a9f90588', 'Массаж тела', 40)
ON CONFLICT ("id") DO NOTHING;

UPDATE "ServiceCategory"
SET "sectionId" = 'f995b1e0-31c6-478a-8cc4-4cbe0c1f8551'
WHERE lower(replace("name", 'ё', 'е')) IN (
  'стрижки мужские',
  'стрижки женские',
  'окрашивание',
  'уход',
  'укладка',
  'прическа'
);

UPDATE "ServiceCategory"
SET "sectionId" = '711278eb-3db0-4b55-b3cb-8a7d7165870e'
WHERE lower(replace("name", 'ё', 'е')) IN (
  'маникюр',
  'педикюр',
  'педикюр от подолога'
);

UPDATE "ServiceCategory"
SET "sectionId" = '2ad1d37a-aad7-47ad-9756-af3020bd1d5f'
WHERE lower(replace("name", 'ё', 'е')) IN (
  'косметология',
  'косметология - пилинг',
  'косметология - аппаратные процедуры',
  'массаж лица'
);

UPDATE "ServiceCategory"
SET "sectionId" = '5d87e7e6-df34-4d9c-b6f0-59d7a9f90588'
WHERE lower(replace("name", 'ё', 'е')) IN (
  'лечебный массаж',
  'лимфодренажный массаж',
  'антицеллюлитный массаж',
  'аппаратный массаж'
);

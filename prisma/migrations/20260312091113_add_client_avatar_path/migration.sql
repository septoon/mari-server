ALTER TABLE "Client"
ADD COLUMN "avatarPath" TEXT;

INSERT INTO "Permission" ("id", "code", "description")
VALUES (
  '9fcecb6b-944d-4b10-9b56-83b6d5fa5d62',
  'MANAGE_CLIENT_AVATARS',
  'Upload, replace and delete client avatars'
)
ON CONFLICT ("code") DO UPDATE
SET "description" = EXCLUDED."description";

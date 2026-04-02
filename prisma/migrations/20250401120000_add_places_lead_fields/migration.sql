-- AlterTable
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "googlePlaceId" TEXT;
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "websiteUri" TEXT;
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "websiteHost" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "Lead_googlePlaceId_key" ON "Lead"("googlePlaceId");

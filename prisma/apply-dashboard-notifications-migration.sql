-- Run if Prisma migrate is not used. Creates in-app notification feed table.

CREATE TABLE IF NOT EXISTS "DashboardNotification" (
  "id" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "readAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DashboardNotification_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "DashboardNotification_createdAt_idx" ON "DashboardNotification" ("createdAt" DESC);
CREATE INDEX IF NOT EXISTS "DashboardNotification_readAt_idx" ON "DashboardNotification" ("readAt");

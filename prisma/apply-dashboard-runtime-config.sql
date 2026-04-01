-- Runtime dashboard overrides (singleton row). Safe to run once.
CREATE TABLE IF NOT EXISTS "DashboardRuntimeConfig" (
  "id" TEXT NOT NULL,
  "outreachDryRunOverride" BOOLEAN,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DashboardRuntimeConfig_pkey" PRIMARY KEY ("id")
);

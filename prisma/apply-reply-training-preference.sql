-- Run once on your Postgres (e.g. Supabase SQL editor) if you do not use `prisma migrate` for this repo.
-- Creates the table for inbox "Train bot" preferences.

CREATE TABLE IF NOT EXISTS "ReplyTrainingPreference" (
  "id" TEXT NOT NULL,
  "leadId" TEXT NOT NULL,
  "inboundReplyId" TEXT,
  "classification" TEXT NOT NULL,
  "bodyTemplate" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ReplyTrainingPreference_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ReplyTrainingPreference_classification_createdAt_idx"
  ON "ReplyTrainingPreference" ("classification", "createdAt" DESC);

ALTER TABLE "ReplyTrainingPreference"
  DROP CONSTRAINT IF EXISTS "ReplyTrainingPreference_leadId_fkey";

ALTER TABLE "ReplyTrainingPreference"
  ADD CONSTRAINT "ReplyTrainingPreference_leadId_fkey"
  FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

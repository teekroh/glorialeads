-- Voice alignment notes for Claude (run against your DB if not using prisma migrate).
CREATE TABLE IF NOT EXISTS "VoiceTrainingNote" (
  "id" TEXT NOT NULL,
  "scenarioKind" TEXT NOT NULL,
  "mockClaudeReply" TEXT NOT NULL,
  "userCorrection" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "VoiceTrainingNote_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "VoiceTrainingNote_createdAt_idx" ON "VoiceTrainingNote" ("createdAt" DESC);

-- Optional: retire inbox per-classification templates
DROP TABLE IF EXISTS "ReplyTrainingPreference";

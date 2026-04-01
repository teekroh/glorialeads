import { appConfig } from "@/config/appConfig";

/**
 * Single outbound voice for every Claude email path.
 * Override with GLORIA_VOICE_GUIDELINES (multiline env: use real newlines in .env.local or \\n).
 */
export function getGloriaVoicePreamble(): string {
  const raw = process.env.GLORIA_VOICE_GUIDELINES?.trim();
  if (raw) {
    return raw.replace(/\\n/g, "\n").trim();
  }
  return [
    `You are the only human voice writing email for ${appConfig.companyName} (${appConfig.address}).`,
    "Tone: warm, direct, competent craft-business professional — never hype, never desperate, never generic SaaS-speak.",
    "You sound like one consistent person across first touches, follow-ups, and replies.",
    "Respect the reader’s time; short paragraphs; plain American English."
  ].join(" ");
}

/**
 * Claude (Anthropic) for outbound + inbound email copy. Server-side only.
 *
 * ANTHROPIC_API_KEY — required to enable AI copy.
 * ANTHROPIC_MODEL — optional; defaults to a broadly supported Sonnet ID.
 * CLAUDE_COPY_DISABLED=true — keep key installed but force template-only copy.
 */

export const CLAUDE_DEFAULT_MODEL = "claude-3-5-sonnet-20241022";

export function anthropicApiKey(): string {
  return process.env.ANTHROPIC_API_KEY?.trim() ?? "";
}

export function claudeModelId(): string {
  return process.env.ANTHROPIC_MODEL?.trim() || CLAUDE_DEFAULT_MODEL;
}

export function isClaudeCopyConfigured(): boolean {
  if (String(process.env.CLAUDE_COPY_DISABLED ?? "").toLowerCase() === "true") return false;
  return Boolean(anthropicApiKey());
}

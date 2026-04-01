import { getGloriaVoicePreamble } from "@/config/gloriaVoice";
import { fetchVoiceTrainingPromptAppendix } from "@/services/voiceTrainingStorage";

/** Full system string for any Claude task: one voice + task rules + remembered corrections. */
export async function resolveClaudeSystemPrompt(taskSpecificRules: string): Promise<string> {
  const voice = getGloriaVoicePreamble();
  const training = await fetchVoiceTrainingPromptAppendix(15);
  const parts = [voice, taskSpecificRules.trim()];
  if (training) parts.push(training);
  return parts.filter(Boolean).join("\n\n");
}

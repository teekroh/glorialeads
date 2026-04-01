export const VOICE_TRAIN_SCENARIOS = [
  "first_touch",
  "follow_up_1",
  "follow_up_2",
  "reply_pricing",
  "reply_info",
  "reply_unclear",
  "booking_invite"
] as const;

export type VoiceTrainScenarioKind = (typeof VOICE_TRAIN_SCENARIOS)[number];

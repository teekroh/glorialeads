# Gmail: Promotions → Primary / inbox

Context for Gloria outbound (Resend, first-touch subjects, `OUTREACH_FROM_EMAIL`, etc.). Gmail tab placement is **not** controlled in app code.

## Add notes below

- (Paste ChatGPT tips, checklists, SPF/DKIM/DMARC, copy/from experiments — no secrets.)

## Code pointers (Gloria)

- First-touch subject (fixed): `services/persistenceService.ts` → `launchCampaign`
- Send: `services/outreachSendService.ts` → `sendOutreachEmail` (Resend `text`, `from`, `replyTo`)
- Config: `config/outreachConfig.ts`

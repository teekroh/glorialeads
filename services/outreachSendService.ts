import { Resend } from "resend";
import { outreachConfig } from "@/config/outreachConfig";
import { getEffectiveOutreachDryRun } from "@/services/outreachDryRunService";

export type SendResult = {
  status: "sent" | "dry_run" | "failed";
  providerId?: string;
  error?: string;
  /** Exact text sent or that would have been sent (optional safe-test footer only). */
  finalText: string;
};

const resend = outreachConfig.resendApiKey ? new Resend(outreachConfig.resendApiKey) : null;

function withTestRecipientFooter(
  text: string,
  intendedRecipient: string | undefined,
  actualTo: string
): string {
  const testTo = outreachConfig.testToEmail;
  if (
    testTo &&
    testTo.length > 0 &&
    intendedRecipient &&
    intendedRecipient !== testTo &&
    actualTo === testTo
  ) {
    return `${text}\n\n---\n[Test mode] Intended recipient was: ${intendedRecipient}`;
  }
  return text;
}

export function buildOutboundEmailText(payload: {
  text: string;
  to: string;
  intendedTo?: string;
}): string {
  const testTo = outreachConfig.testToEmail;
  const actualTo = testTo && testTo.length > 0 ? testTo : payload.to;
  const body = payload.text.trim();
  const intended = payload.intendedTo?.trim() || payload.to;
  return withTestRecipientFooter(body, intended, actualTo);
}

export const sendOutreachEmail = async (payload: {
  to: string;
  subject: string;
  text: string;
  /** When redirecting test sends, original lead address for logging only. */
  intendedTo?: string;
}): Promise<SendResult> => {
  const testTo = outreachConfig.testToEmail;
  const actualTo = testTo && testTo.length > 0 ? testTo : payload.to;
  const finalText = buildOutboundEmailText({
    text: payload.text,
    to: payload.to,
    intendedTo: payload.intendedTo
  });

  if (await getEffectiveOutreachDryRun()) {
    return { status: "dry_run", finalText };
  }
  if (!resend) {
    return { status: "failed", error: "RESEND_API_KEY missing.", finalText };
  }

  try {
    const result = await resend.emails.send({
      from: outreachConfig.fromEmail,
      to: actualTo,
      replyTo: outreachConfig.replyToEmail,
      subject: payload.subject,
      text: finalText
    });
    return { status: "sent", providerId: result.data?.id, finalText };
  } catch (error) {
    return {
      status: "failed",
      error: error instanceof Error ? error.message : "Unknown send failure",
      finalText
    };
  }
};

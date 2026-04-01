import { Resend } from "resend";
import { outreachConfig } from "@/config/outreachConfig";
import { createDashboardNotification } from "@/services/dashboardNotificationService";
import { getEffectiveOutreachDryRun } from "@/services/outreachDryRunService";

/**
 * Email the owner / ops inbox when a meeting is confirmed on a lead.
 * Uses Resend; skipped when DRY_RUN or RESEND_API_KEY missing (logs only).
 */
export async function notifyOwnerMeetingBooked(opts: {
  leadName: string;
  leadEmail: string;
  meetingStartIso?: string | null;
}): Promise<void> {
  const when = opts.meetingStartIso
    ? new Date(opts.meetingStartIso).toLocaleString("en-US", { timeZone: "America/New_York" })
    : "Time TBD";

  void createDashboardNotification({
    kind: "meeting_booked",
    title: `Meeting booked · ${opts.leadName}`,
    body: [`${opts.leadEmail}`, when !== "Time TBD" ? `Time: ${when}` : ""].filter(Boolean).join("\n")
  });

  const to = outreachConfig.ownerNotifyEmail;
  if (!to) {
    console.warn("[Gloria] OWNER_NOTIFY / OUTREACH_REPLY_TO_EMAIL unset; skipping meeting email.");
    return;
  }

  const text = [
    "A meeting was scheduled with a Gloria lead.",
    "",
    `Lead: ${opts.leadName}`,
    `Email: ${opts.leadEmail}`,
    `Start (ET display): ${when}`,
    "",
    `Dashboard: ${outreachConfig.appBaseUrl}`
  ].join("\n");

  if (await getEffectiveOutreachDryRun()) {
    console.log("[Gloria] Meeting booked (dry run — no owner email)\n", text);
    return;
  }

  const resend = outreachConfig.resendApiKey ? new Resend(outreachConfig.resendApiKey) : null;
  if (!resend) {
    console.warn("[Gloria] Meeting booked but RESEND_API_KEY missing; owner not emailed.");
    return;
  }

  try {
    await resend.emails.send({
      from: outreachConfig.fromEmail,
      to,
      subject: `[Gloria] Meeting booked · ${opts.leadName}`,
      text
    });
  } catch (e) {
    console.warn("[Gloria] Owner notify email failed:", e);
  }
}

import { mapDbLeadToLead } from "@/lib/mappers";
import { db } from "@/lib/db";
import { isClaudeCopyConfigured } from "@/config/claudeConfig";
import { composeFollowUpFromThreadWithClaude } from "@/services/claudeCopyService";
import { createDashboardNotification } from "@/services/dashboardNotificationService";
import { sendOutreachEmail } from "@/services/outreachSendService";
import type { Lead } from "@/types/lead";

async function buildConversationTranscript(leadId: string): Promise<string> {
  const rows = await db.message.findMany({
    where: { leadId },
    orderBy: { sentAt: "asc" }
  });
  const lines: string[] = [];
  for (const m of rows) {
    if (m.status === "scheduled") continue;
    const dir = m.direction === "inbound" ? "Them" : "Us";
    const kind = m.kind.replace(/_/g, " ");
    const body = m.body.replace(/\n+/g, " ").trim().slice(0, 900);
    lines.push(`[${dir} · ${kind}] ${body}`);
  }
  return lines.join("\n");
}

async function firstTouchExcerpt(leadId: string): Promise<string> {
  const m = await db.message.findFirst({
    where: { leadId, kind: "first_touch", status: { in: ["sent", "dry_run"] } },
    orderBy: { sentAt: "asc" }
  });
  return (m?.body ?? "").slice(0, 1200);
}

export async function dispatchDueScheduledOutreach(limit = 30): Promise<{ dispatched: number; skipped: number; errors: string[] }> {
  const now = new Date();
  const errors: string[] = [];
  let dispatched = 0;
  let skipped = 0;

  const due = await db.message.findMany({
    where: {
      direction: "outbound",
      status: "scheduled",
      kind: { in: ["follow_up_1", "follow_up_2"] },
      sentAt: { lte: now }
    },
    orderBy: { sentAt: "asc" },
    take: limit
  });

  for (const msg of due) {
    try {
      const leadRow = await db.lead.findUnique({ where: { id: msg.leadId } });
      if (!leadRow) {
        skipped += 1;
        continue;
      }
      if (leadRow.doNotContact) {
        await db.message.update({
          where: { id: msg.id },
          data: { status: "cancelled_dnc", body: `${msg.body}\n[cancelled: do not contact]` }
        });
        skipped += 1;
        continue;
      }
      const st = leadRow.status;
      if (st === "Booked" || st === "Not Interested") {
        await db.message.update({
          where: { id: msg.id },
          data: { status: "cancelled_pipeline", body: `${msg.body}\n[cancelled: ${st}]` }
        });
        skipped += 1;
        continue;
      }

      const leadDto: Lead = mapDbLeadToLead(leadRow);
      const transcript = await buildConversationTranscript(msg.leadId);
      const firstExcerpt = await firstTouchExcerpt(msg.leadId);
      const sequence = msg.kind === "follow_up_1" ? 1 : 2;

      let body = msg.body;
      if (isClaudeCopyConfigured()) {
        const ai = await composeFollowUpFromThreadWithClaude(
          leadDto,
          sequence,
          transcript || "(no prior thread in log)",
          firstExcerpt,
          msg.body
        );
        if (ai) body = ai;
      }

      const send = await sendOutreachEmail({
        to: leadRow.email,
        subject:
          sequence === 1
            ? "Re: Gloria Custom Cabinetry — quick follow-up"
            : "Re: Gloria Custom Cabinetry — last note from me",
        text: body,
        intendedTo: leadRow.email
      });

      await db.message.update({
        where: { id: msg.id },
        data: {
          body: send.finalText,
          status: send.status === "failed" ? "failed" : send.status === "dry_run" ? "dry_run" : "sent",
          sentAt: new Date()
        }
      });

      if (msg.campaignId) {
        const seqRow = sequence;
        await db.followUp.updateMany({
          where: {
            leadId: msg.leadId,
            campaignId: msg.campaignId,
            sequence: seqRow,
            status: "scheduled"
          },
          data: { status: send.status === "failed" ? "failed" : "sent", sentAt: new Date() }
        });
      }

      if (send.status !== "failed") {
        dispatched += 1;
        void createDashboardNotification({
          kind: "scheduled_follow_up",
          title: `Follow-up ${sequence} sent · ${leadRow.fullName}`,
          body: send.status === "dry_run" ? "[Dry run] " + body.slice(0, 280) : body.slice(0, 400)
        });
      } else {
        errors.push(`${msg.id}: ${send.error ?? "send failed"}`);
      }
    } catch (e) {
      errors.push(`${msg.id}: ${e instanceof Error ? e.message : "error"}`);
    }
  }

  return { dispatched, skipped, errors };
}

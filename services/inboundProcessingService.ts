import { replyAutomationConfig } from "@/config/replyAutomationConfig";
import { isClaudeCopyConfigured } from "@/config/claudeConfig";
import { getBookingLink, humanBookingMessage, isBookingLinkConfigured, warnBookingLinkMissing } from "@/config/bookingCopy";
import { shouldSuppressBookingInvite } from "@/services/bookingGate";
import { db } from "@/lib/db";
import { mapDbLeadToLead } from "@/lib/mappers";
import { addBusinessDays, uid } from "@/lib/utils";
import { classifyReply, ReplyClassificationResult } from "@/services/replyClassifier";
import { autoReplySubjectForClassification, evaluateClaudeAutoSend } from "@/services/claudeAutoReplyService";
import { refineReplyClassificationWithClaude, shouldRefineClassificationWithClaude } from "@/services/claudeClassifierService";
import { createDashboardNotification } from "@/services/dashboardNotificationService";
import {
  draftBookingInviteWithClaude,
  draftUnclearReplyWithClaude,
  expandClaudeBookingPlaceholders
} from "@/services/claudeCopyService";
import { buildAutomatedReplyDraft, draftSuggestedTimeReply } from "@/services/replyDrafts";
import { sendOutreachEmail } from "@/services/outreachSendService";
import { getRemainingRealOutboundQuota } from "@/services/outreachRateLimiter";
import { tryAutoBookSuggestedTime } from "@/services/googleCalendarBookingService";
import { markBooked } from "@/services/markBookedService";
import { Lead, LeadStatus, ReplyCategory } from "@/types/lead";

const CLAUDE_GATED_AUTO_CLASSIFICATIONS: ReplyCategory[] = [
  "pricing_question",
  "info_request",
  "suggested_time",
  "unclear",
  "positive",
  "asks_for_link"
];

async function tryClaudeGatedAutoSend(params: {
  lead: { id: string; email: string };
  leadDto: Lead;
  campaignId: string | null;
  classification: ReplyCategory;
  raw: ReplyClassificationResult;
  bodyText: string;
  suggestedReplyDraft: string | null;
}): Promise<{ ok: true; body: string; rationale: string } | { ok: false }> {
  if (!replyAutomationConfig.claudeAutoSendEnabled || !isClaudeCopyConfigured()) return { ok: false };
  if ((await getRemainingRealOutboundQuota()) <= 0) return { ok: false };
  if (params.raw.mixedIntent) return { ok: false };
  if (!params.suggestedReplyDraft?.trim()) return { ok: false };
  if (!CLAUDE_GATED_AUTO_CLASSIFICATIONS.includes(params.classification)) return { ok: false };

  const decision = await evaluateClaudeAutoSend({
    lead: params.leadDto,
    classification: params.classification,
    classifierConfidence: params.raw.confidence,
    classifierReason: params.raw.reason,
    mixedIntent: params.raw.mixedIntent,
    inboundText: params.bodyText,
    proposedDraft: params.suggestedReplyDraft
  });
  if (!decision || decision.confidence < replyAutomationConfig.claudeAutoSendMinConfidence) return { ok: false };

  const body = expandClaudeBookingPlaceholders(decision.replyBody.trim());
  const subject = autoReplySubjectForClassification(params.classification);
  const send = await sendOutreachEmail({
    to: params.lead.email,
    subject,
    text: body,
    intendedTo: params.lead.email
  });

  await db.message.create({
    data: {
      id: uid(),
      leadId: params.lead.id,
      campaignId: params.campaignId,
      direction: "outbound",
      kind: "claude_auto_reply",
      body: `[Claude auto ${decision.confidence.toFixed(2)}] ${send.finalText}`,
      sentAt: new Date(),
      status: send.status === "failed" ? "failed" : send.status === "dry_run" ? "dry_run" : "sent"
    }
  });

  if (send.status === "failed") return { ok: false };

  void createDashboardNotification({
    kind: "claude_auto_reply",
    title: `Auto-reply sent · ${params.leadDto.fullName}`,
    body: `${params.classification} — ${subject}\n${body.slice(0, 360)}`
  });

  return { ok: true, body, rationale: decision.rationale };
}

export interface InboundEmailPayload {
  fromEmail: string;
  toEmail?: string;
  subject?: string;
  bodyText: string;
  bodyHtml?: string;
  providerMessageId?: string;
  messageId?: string;
  receivedAt?: Date;
}

/** Cancels queued follow-ups and scheduled outbound immediately when any inbound reply arrives. */
export async function stopPendingOutreachForLead(leadId: string) {
  await db.$transaction([
    db.followUp.updateMany({
      where: { leadId, status: "scheduled" },
      data: { status: "stopped_inbound_reply" }
    }),
    db.message.updateMany({
      where: { leadId, direction: "outbound", status: "scheduled" },
      data: { status: "cancelled_inbound_reply" }
    })
  ]);
}

export async function stopPendingForCampaign(leadId: string, campaignId: string) {
  await db.followUp.updateMany({
    where: { leadId, campaignId, status: "scheduled" },
    data: { status: "stopped_campaign_objection" }
  });
}

function resolveBookingAutomationBlockReason(
  classification: ReplyCategory,
  raw: ReplyClassificationResult,
  canAutoBook: boolean,
  bookingLinkPresent: boolean,
  alreadyBookedPipeline: boolean
): string | null {
  if (classification !== "positive" && classification !== "asks_for_link") return null;
  if (alreadyBookedPipeline) return null;
  if (canAutoBook) return null;
  if (!bookingLinkPresent) return "BOOKING_LINK missing or still a placeholder — configure a real Cal link.";
  if (raw.mixedIntent) return "Mixed intent — booking automation blocked (safety).";
  if (raw.confidence < replyAutomationConfig.autoBookingMinConfidence) {
    return `Classifier confidence ${raw.confidence.toFixed(2)} below AUTO_BOOKING_MIN_CONFIDENCE (${replyAutomationConfig.autoBookingMinConfidence}).`;
  }
  return "Booking automation not applied.";
}

export async function processInboundEmail(
  payload: InboundEmailPayload,
  options?: { leadIdHint?: string }
): Promise<{
  ok: boolean;
  error?: string;
  inboundReplyId?: string;
  classification?: ReplyCategory;
}> {
  const normalizedFrom = payload.fromEmail.trim().toLowerCase();
  const receivedAt = payload.receivedAt ?? new Date();

  let lead = options?.leadIdHint
    ? await db.lead.findUnique({ where: { id: options.leadIdHint } })
    : await db.lead.findFirst({ where: { email: normalizedFrom } });

  if (!lead && options?.leadIdHint) {
    lead = await db.lead.findUnique({ where: { id: options.leadIdHint } });
  }
  if (!lead) {
    return { ok: false, error: "No lead matched this from address." };
  }

  const campaignRow = await db.campaignLead.findFirst({
    where: { leadId: lead.id },
    orderBy: { assignedAt: "desc" }
  });
  const campaignId = campaignRow?.campaignId ?? null;

  await stopPendingOutreachForLead(lead.id);

  let raw = classifyReply(payload.bodyText);
  if (shouldRefineClassificationWithClaude(raw)) {
    const refined = await refineReplyClassificationWithClaude(payload.bodyText, raw);
    if (refined) raw = refined;
  }
  const classification: ReplyCategory = raw.classification;
  const bookingLinkPresent = isBookingLinkConfigured();
  const alreadyBookedPipeline = await shouldSuppressBookingInvite(lead.id);
  const canAutoBook =
    (classification === "positive" || classification === "asks_for_link") &&
    !alreadyBookedPipeline &&
    raw.confidence >= replyAutomationConfig.autoBookingMinConfidence &&
    !raw.mixedIntent &&
    bookingLinkPresent;

  const bookingBlockReason = resolveBookingAutomationBlockReason(
    classification,
    raw,
    canAutoBook,
    bookingLinkPresent,
    alreadyBookedPipeline
  );

  const leadDto = mapDbLeadToLead(lead);
  let suggestedReplyDraft = await buildAutomatedReplyDraft(leadDto, classification, payload.bodyText);

  if (classification === "unclear") {
    const unclearFallback = `Hi ${lead.firstName || "there"} — thanks for your note. Could you share a bit more about what you have in mind? If helpful, here’s where to book a quick intro: ${getBookingLink() || "[BOOKING_LINK]"}`;
    suggestedReplyDraft =
      suggestedReplyDraft ??
      (isClaudeCopyConfigured() ? await draftUnclearReplyWithClaude(leadDto, payload.bodyText) : null) ??
      unclearFallback;
  }

  if ((classification === "positive" || classification === "asks_for_link") && !canAutoBook && !alreadyBookedPipeline) {
    warnBookingLinkMissing("review-queue booking draft");
    suggestedReplyDraft =
      (isClaudeCopyConfigured() ? await draftBookingInviteWithClaude(leadDto, payload.bodyText) : null) ??
      humanBookingMessage();
  }

  let needsReview =
    ["suggested_time", "pricing_question", "info_request", "unclear"].includes(classification) ||
    ((classification === "positive" || classification === "asks_for_link") && !canAutoBook);

  const pricingManualOnly =
    classification === "pricing_question" &&
    !(
      replyAutomationConfig.allowAutoSendPricingReply &&
      raw.confidence >= replyAutomationConfig.autoSendPricingMinConfidence &&
      !raw.mixedIntent &&
      bookingLinkPresent
    );

  let automationAllowed = false;
  let automationBlockedReason: string | null =
    classification === "pricing_question" && pricingManualOnly
      ? "Pricing replies default to manual review (enable AUTO_SEND_PRICING_REPLY to allow rare auto-send)."
      : bookingBlockReason;

  const inboundId = uid();

  await db.message.create({
    data: {
      id: uid(),
      leadId: lead.id,
      campaignId,
      direction: "inbound",
      kind: "inbound_reply",
      body: `[Inbound${payload.subject ? `: ${payload.subject}` : ""}]\n${payload.bodyText}`,
      sentAt: receivedAt,
      status: "received"
    }
  });

  const actions: string[] = [];

  const persistInbound = async (final: {
    needsReview: boolean;
    autoActionTaken: string;
    automationAllowed: boolean;
    automationBlockedReason: string | null;
  }) => {
    await db.inboundReply.create({
      data: {
        id: inboundId,
        leadId: lead.id,
        campaignId,
        messageId: payload.messageId ?? null,
        providerMessageId: payload.providerMessageId ?? null,
        fromEmail: normalizedFrom,
        toEmail: (payload.toEmail ?? "").trim(),
        subject: payload.subject ?? "",
        bodyText: payload.bodyText,
        bodyHtml: payload.bodyHtml ?? "",
        receivedAt,
        classification,
        classificationConfidence: raw.confidence,
        classificationReason: raw.reason,
        suggestedAction: raw.recommendedAction,
        suggestedReplyDraft,
        autoActionTaken: final.autoActionTaken,
        needsReview: final.needsReview,
        mixedIntent: raw.mixedIntent,
        automationAllowed: final.automationAllowed,
        automationBlockedReason: final.automationBlockedReason,
        classifierExplanation: raw.explanation,
        processedAt: new Date()
      }
    });
  };

  if (classification === "unclear") {
    let unclearNeedsReview = true;
    let unclearAutoAllowed = false;
    let unclearBlocked: string | null = null;
    let unclearActions = ["stored_inbound", "classified_unclear", "routed_needs_review"];

    if (!raw.mixedIntent) {
      const gated = await tryClaudeGatedAutoSend({
        lead,
        leadDto,
        campaignId,
        classification,
        raw,
        bodyText: payload.bodyText,
        suggestedReplyDraft
      });
      if (gated.ok) {
        unclearNeedsReview = false;
        unclearAutoAllowed = true;
        unclearBlocked = `Claude auto-send (${replyAutomationConfig.claudeAutoSendMinConfidence}+): ${gated.rationale.slice(0, 240)}`;
        suggestedReplyDraft = gated.body;
        unclearActions = [...unclearActions, "claude_auto_reply_sent"];
      }
    }

    await persistInbound({
      needsReview: unclearNeedsReview,
      autoActionTaken: JSON.stringify(unclearActions),
      automationAllowed: unclearAutoAllowed,
      automationBlockedReason: unclearBlocked
    });
    await db.lead.update({
      where: { id: lead.id },
      data: { status: unclearNeedsReview ? "Needs Review" : "In Campaign", updatedAt: new Date() }
    });
    return { ok: true, inboundReplyId: inboundId, classification };
  }

  let nextStatus: LeadStatus = lead.status as LeadStatus;
  let nextFollowUpAt: Date | null = lead.nextFollowUpAt;
  let doNotContact = lead.doNotContact;

  if (
    classification === "pricing_question" &&
    replyAutomationConfig.allowAutoSendPricingReply &&
    raw.confidence >= replyAutomationConfig.autoSendPricingMinConfidence &&
    !raw.mixedIntent &&
    bookingLinkPresent &&
    (await getRemainingRealOutboundQuota()) > 0
  ) {
    const body = suggestedReplyDraft;
    if (!body) return { ok: false, error: "No pricing reply draft" };
    const send = await sendOutreachEmail({
      to: lead.email,
      subject: "Re: Pricing — quick intro",
      text: body,
      intendedTo: lead.email
    });
    await db.message.create({
      data: {
        id: uid(),
        leadId: lead.id,
        campaignId,
        direction: "outbound",
        kind: "manual_reply",
        body: `[Auto-sent pricing] ${send.finalText}`,
        sentAt: new Date(),
        status: send.status === "failed" ? "failed" : send.status === "dry_run" ? "dry_run" : "sent"
      }
    });
    automationAllowed = true;
    automationBlockedReason = null;
    needsReview = false;
    nextStatus = "In Campaign";
    actions.push("pricing_reply:auto_sent_rare", "status:In Campaign");
    await persistInbound({
      needsReview: false,
      autoActionTaken: JSON.stringify(actions.length ? actions : ["stored_inbound"]),
      automationAllowed: true,
      automationBlockedReason: null
    });
    await db.lead.update({
      where: { id: lead.id },
      data: { status: nextStatus, doNotContact, nextFollowUpAt, updatedAt: new Date() }
    });
    return { ok: true, inboundReplyId: inboundId, classification };
  }

  if (
    classification === "suggested_time" &&
    !alreadyBookedPipeline &&
    !raw.mixedIntent &&
    raw.confidence >= replyAutomationConfig.autoSuggestedTimeMinConfidence
  ) {
    const googleResult = await tryAutoBookSuggestedTime({
      lead,
      bodyText: payload.bodyText,
      receivedAt,
      firstNameFallback: (lead.firstName || "").trim() || "there"
    });

    if (googleResult.handled && googleResult.mode === "google_calendar") {
      const booked = await markBooked(lead.id, {
        externalBookingId: googleResult.eventId,
        meetingStart: googleResult.meetingStart.toISOString(),
        meetingEnd: googleResult.meetingEnd.toISOString(),
        campaignId: campaignId ?? undefined
      });

      if (booked.ok) {
        if ((await getRemainingRealOutboundQuota()) <= 0) {
          suggestedReplyDraft = googleResult.replyText;
          actions.push("suggested_time:auto_google_calendar", "status:Booked", "outbound_confirmation:skipped_daily_cap");
          await persistInbound({
            needsReview: true,
            autoActionTaken: JSON.stringify(actions),
            automationAllowed: false,
            automationBlockedReason:
              "Daily outbound limit reached; the meeting was booked but the confirmation email was not sent."
          });
          await db.lead.update({
            where: { id: lead.id },
            data: { status: "Booked", updatedAt: new Date() }
          });
          return { ok: true, inboundReplyId: inboundId, classification };
        }

        const send = await sendOutreachEmail({
          to: lead.email,
          subject: "Re: Time confirmed",
          text: googleResult.replyText,
          intendedTo: lead.email
        });

        await db.message.create({
          data: {
            id: uid(),
            leadId: lead.id,
            campaignId,
            direction: "outbound",
            kind: "manual_reply",
            body: `[Auto-sent] ${send.finalText}`,
            sentAt: new Date(),
            status: send.status === "failed" ? "failed" : send.status === "dry_run" ? "dry_run" : "sent"
          }
        });

        suggestedReplyDraft = googleResult.replyText;
        actions.push("suggested_time:auto_google_calendar", "status:Booked");
        await persistInbound({
          needsReview: false,
          autoActionTaken: JSON.stringify(actions),
          automationAllowed: true,
          automationBlockedReason: null
        });
        return { ok: true, inboundReplyId: inboundId, classification };
      }
      actions.push(`suggested_time:google_event_ok_but_markBooked_failed:${booked.error ?? "unknown"}`);
    }

    if (
      replyAutomationConfig.autoSuggestedTimeFallbackCalLink &&
      bookingLinkPresent &&
      !(googleResult.handled && googleResult.mode === "google_calendar") &&
      (await getRemainingRealOutboundQuota()) > 0
    ) {
      const body = suggestedReplyDraft ?? draftSuggestedTimeReply(leadDto, payload.bodyText);
      const send = await sendOutreachEmail({
        to: lead.email,
        subject: "Re: Picking a time",
        text: body,
        intendedTo: lead.email
      });

      await db.message.create({
        data: {
          id: uid(),
          leadId: lead.id,
          campaignId,
          direction: "outbound",
          kind: "booking_invite",
          body: `[Auto-sent] ${send.finalText}`,
          sentAt: new Date(),
          status: send.status === "failed" ? "failed" : send.status === "dry_run" ? "dry_run" : "sent"
        }
      });

      const link = getBookingLink();
      await db.booking.create({
        data: {
          id: uid(),
          leadId: lead.id,
          campaignId,
          status: "booking_sent",
          note: "High-confidence suggested time — auto-sent scheduling link",
          bookingLink: link,
          createdAt: new Date()
        }
      });

      const skipReason = googleResult.handled ? null : googleResult.reason;
      const blocked =
        skipReason === null || skipReason === "google_calendar_not_configured_or_dry_run"
          ? null
          : `Calendar auto-book skipped (${skipReason}); sent self-serve link.`;

      suggestedReplyDraft = body;
      actions.push("suggested_time:auto_cal_fallback", "status:Booking Sent");
      await persistInbound({
        needsReview: false,
        autoActionTaken: JSON.stringify(actions),
        automationAllowed: true,
        automationBlockedReason: blocked
      });

      await db.lead.update({
        where: { id: lead.id },
        data: { status: "Booking Sent", nextFollowUpAt: null, updatedAt: new Date() }
      });
      return { ok: true, inboundReplyId: inboundId, classification };
    }
  }

  switch (classification) {
    case "positive":
    case "asks_for_link": {
      if (alreadyBookedPipeline) {
        actions.push("booking_invite:suppressed_already_confirmed", "automation:complete_no_resend");
        nextStatus = "Booked";
        needsReview = false;
        automationAllowed = false;
        automationBlockedReason = null;
        break;
      }
      if (canAutoBook) {
        if ((await getRemainingRealOutboundQuota()) <= 0) {
          actions.push("booking_invite:blocked_daily_cap", "status:Needs Review");
          nextStatus = "Needs Review";
          needsReview = true;
          automationAllowed = false;
          automationBlockedReason = "Daily outbound limit reached.";
          break;
        }
        actions.push("booking_automation:eligible");
        await db.message.create({
          data: {
            id: uid(),
            leadId: lead.id,
            campaignId,
            direction: "outbound",
            kind: "system_auto",
            body: "[Auto] Positive / scheduling intent — sending booking invite.",
            sentAt: new Date(),
            status: "sent"
          }
        });

        let inviteBody =
          (isClaudeCopyConfigured() ? await draftBookingInviteWithClaude(leadDto, payload.bodyText) : null) ??
          humanBookingMessage();
        if (replyAutomationConfig.claudeAutoSendEnabled && isClaudeCopyConfigured()) {
          const gatedInvite = await evaluateClaudeAutoSend({
            lead: leadDto,
            classification,
            classifierConfidence: raw.confidence,
            classifierReason: raw.reason,
            mixedIntent: raw.mixedIntent,
            inboundText: payload.bodyText,
            proposedDraft: inviteBody
          });
          if (!gatedInvite || gatedInvite.confidence < replyAutomationConfig.claudeAutoSendMinConfidence) {
            inviteBody = humanBookingMessage();
          } else {
            inviteBody = expandClaudeBookingPlaceholders(gatedInvite.replyBody.trim());
          }
        }
        const send = await sendOutreachEmail({
          to: lead.email,
          subject: "15-minute intro — pick a time",
          text: inviteBody,
          intendedTo: lead.email
        });

        await db.message.create({
          data: {
            id: uid(),
            leadId: lead.id,
            campaignId,
            direction: "outbound",
            kind: "booking_invite",
            body: `[Auto-sent] ${send.finalText}`,
            sentAt: new Date(),
            status: send.status === "failed" ? "failed" : send.status === "dry_run" ? "dry_run" : "sent"
          }
        });

        const link = getBookingLink();
        await db.booking.create({
          data: {
            id: uid(),
            leadId: lead.id,
            campaignId,
            status: "booking_sent",
            note: "Booking link sent (auto)",
            bookingLink: link,
            createdAt: new Date()
          }
        });

        nextStatus = "Booking Sent";
        nextFollowUpAt = null;
        needsReview = false;
        automationAllowed = true;
        automationBlockedReason = null;
        actions.push("booking_invite:auto_sent", "status:Booking Sent");
      } else {
        nextStatus = "Needs Review";
        needsReview = true;
        automationAllowed = false;
        actions.push("booking_invite:blocked_review", "status:Needs Review", ...(bookingBlockReason ? [`block:${bookingBlockReason}`] : []));
      }
      break;
    }
    case "suggested_time":
    case "info_request":
      nextStatus = "Needs Review";
      needsReview = true;
      automationAllowed = false;
      actions.push("status:Needs Review", "draft_suggested");
      break;
    case "pricing_question":
      nextStatus = "Needs Review";
      needsReview = true;
      automationAllowed = false;
      if (!automationBlockedReason) {
        automationBlockedReason =
          "Pricing replies default to manual review (enable AUTO_SEND_PRICING_REPLY to allow rare auto-send).";
      }
      actions.push("status:Needs Review", "draft_pricing_call_first");
      break;
    case "objection":
      nextStatus = "Not Interested";
      needsReview = false;
      automationAllowed = false;
      automationBlockedReason = null;
      if (campaignId) await stopPendingForCampaign(lead.id, campaignId);
      actions.push("status:Not Interested", "stopped_campaign_followups");
      break;
    case "not_now":
      nextStatus = "Not Now";
      nextFollowUpAt = new Date(addBusinessDays(new Date().toISOString(), 10));
      needsReview = false;
      automationAllowed = false;
      automationBlockedReason = null;
      actions.push("status:Not Now", "snooze_default:+10bd");
      break;
    case "unsubscribe":
      doNotContact = true;
      nextStatus = "Not Interested";
      nextFollowUpAt = null;
      needsReview = false;
      automationAllowed = false;
      automationBlockedReason = null;
      actions.push("doNotContact:true", "status:Not Interested");
      break;
    default:
      nextStatus = "Needs Review";
      needsReview = true;
      automationAllowed = false;
      automationBlockedReason = null;
  }

  if (
    needsReview &&
    suggestedReplyDraft?.trim() &&
    !raw.mixedIntent &&
    replyAutomationConfig.claudeAutoSendEnabled &&
    isClaudeCopyConfigured() &&
    CLAUDE_GATED_AUTO_CLASSIFICATIONS.includes(classification)
  ) {
    const gated = await tryClaudeGatedAutoSend({
      lead,
      leadDto,
      campaignId,
      classification,
      raw,
      bodyText: payload.bodyText,
      suggestedReplyDraft
    });
    if (gated.ok) {
      needsReview = false;
      automationAllowed = true;
      automationBlockedReason = `Claude auto-send: ${gated.rationale.slice(0, 280)}`;
      suggestedReplyDraft = gated.body;
      nextStatus = "In Campaign";
      actions.push("claude_auto_reply_sent");
    }
  }

  await persistInbound({
    needsReview,
    autoActionTaken: JSON.stringify(actions.length ? actions : ["stored_inbound"]),
    automationAllowed,
    automationBlockedReason
  });

  await db.lead.update({
    where: { id: lead.id },
    data: {
      status: nextStatus,
      doNotContact,
      nextFollowUpAt,
      updatedAt: new Date()
    }
  });

  return { ok: true, inboundReplyId: inboundId, classification };
}

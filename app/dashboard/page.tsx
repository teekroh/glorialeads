import { DashboardApp } from "@/components/dashboard/DashboardApp";
import { getLeadImportSummaryForDashboard } from "@/data/importLeads";
import { getBootstrapData } from "@/lib/bootstrapData";
import { getDashboardData } from "@/services/persistenceService";

// Vercel build was failing during "Collecting page data" because this page is runtime-data dependent.
// Force this route to be rendered dynamically at request time (no static pre-render at build).
export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  let data: Awaited<ReturnType<typeof getDashboardData>>;
  let importSummary = getLeadImportSummaryForDashboard();
  try {
    data = await getDashboardData();
  } catch (error) {
    console.error("[dashboard] Falling back to bootstrap data:", error);
    const bootstrap = getBootstrapData();
    importSummary = bootstrap.importSummary;
    data = {
      leads: bootstrap.leads,
      campaigns: [],
      notifications: [],
      voiceTrainingNotes: [],
      messageCount: 0,
      followUps: [],
      bookings: [],
      inboundReplies: [],
      inboxThreads: [],
      phase3Metrics: {
        repliesReceived: 0,
        positiveReplies: 0,
        bookingInvitesSent: 0,
        bookedMeetings: 0,
        notInterested: 0,
        unsubscribes: 0,
        replyRateBySource: {},
        replyRateByLeadType: {},
        bookingRateByTier: {}
      },
      bookingLinkConfigured: false,
      bookingLinkDisplay: "",
      bookingReplyPreview: "",
      outreachDryRun: true,
      outreachDryRunEnvDefault: true,
      outreachDryRunOverride: null,
      outreachTestToActive: false,
      autoDailyFirstTouchEnabled: false
    };
  }
  return (
    <DashboardApp
      initialLeads={data.leads}
      initialCampaigns={data.campaigns.map((c) => ({
        id: c.id,
        name: c.name,
        launchedAt: c.launchedAt,
        sentCount: c.sentCount,
        recipientNames: c.recipientNames
      }))}
      initialInboxThreads={data.inboxThreads ?? []}
      initialPhase3Metrics={
        data.phase3Metrics ?? {
          repliesReceived: 0,
          positiveReplies: 0,
          bookingInvitesSent: 0,
          bookedMeetings: 0,
          notInterested: 0,
          unsubscribes: 0,
          replyRateBySource: {},
          replyRateByLeadType: {},
          bookingRateByTier: {}
        }
      }
      initialBookingLinkConfigured={data.bookingLinkConfigured ?? true}
      initialBookingLinkDisplay={data.bookingLinkDisplay ?? ""}
      initialBookingReplyPreview={data.bookingReplyPreview ?? ""}
      initialOutreachDryRun={data.outreachDryRun ?? true}
      initialOutreachDryRunEnvDefault={data.outreachDryRunEnvDefault ?? data.outreachDryRun ?? true}
      initialOutreachDryRunOverride={data.outreachDryRunOverride ?? null}
      initialOutreachTestToActive={data.outreachTestToActive ?? false}
      initialAutoDailyFirstTouchEnabled={data.autoDailyFirstTouchEnabled ?? false}
      initialNotifications={data.notifications ?? []}
      initialVoiceTrainingNotes={data.voiceTrainingNotes ?? []}
      importSummary={importSummary}
    />
  );
}

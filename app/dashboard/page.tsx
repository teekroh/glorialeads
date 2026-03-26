import { DashboardApp } from "@/components/dashboard/DashboardApp";
import { importCsvLeads } from "@/data/importLeads";
import { getDashboardData } from "@/services/persistenceService";

export default async function DashboardPage() {
  const data = await getDashboardData();
  const importSummary = importCsvLeads().summary;
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
      importSummary={importSummary}
    />
  );
}

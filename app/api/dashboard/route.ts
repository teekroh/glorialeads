import { NextResponse } from "next/server";
import { getDashboardData } from "@/services/persistenceService";
import { getLeadImportSummaryForDashboard } from "@/data/importLeads";
import { getBootstrapData } from "@/lib/bootstrapData";

export async function GET() {
  try {
    const data = await getDashboardData();
    const importSummary = getLeadImportSummaryForDashboard();
    return NextResponse.json({ ...data, importSummary });
  } catch (error) {
    console.error("[api/dashboard] Falling back to bootstrap data:", error);
    const bootstrap = getBootstrapData();
    return NextResponse.json({
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
      autoDailyFirstTouchEnabled: false,
      importSummary: bootstrap.importSummary,
      degraded: true
    });
  }
}

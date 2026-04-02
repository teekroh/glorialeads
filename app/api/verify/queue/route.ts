import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { mapDbLeadToLead } from "@/lib/mappers";
import { DEPLOY_VERIFY_MIN_SCORE } from "@/services/deployVerifyPolicy";
import { compareVerifyQueue } from "@/services/scoringService";

/** Max leads returned in one response (browser memory). `stats.pending` is always the full count. */
const VERIFY_QUEUE_MAX = 2000;

/** Leads awaiting Verify (any score). Newest first, then score / lead type. */
export async function GET() {
  const [pending, rejected, approved] = await Promise.all([
    db.lead.count({
      where: {
        deployVerifyVerdict: null,
        doNotContact: false
      }
    }),
    db.lead.count({ where: { deployVerifyVerdict: "rejected" } }),
    db.lead.count({
      where: { deployVerifyVerdict: "approved" }
    })
  ]);

  const rows = await db.lead.findMany({
    where: {
      deployVerifyVerdict: null,
      doNotContact: false
    },
    orderBy: [{ createdAt: "desc" }, { score: "desc" }, { fullName: "asc" }, { id: "asc" }],
    take: VERIFY_QUEUE_MAX
  });

  const leads = rows.map(mapDbLeadToLead);
  leads.sort(compareVerifyQueue);
  return NextResponse.json({
    leads,
    stats: {
      pending,
      rejected,
      approved,
      approvedHigh: approved,
      minScore: DEPLOY_VERIFY_MIN_SCORE,
      loaded: leads.length,
      cappedAt: VERIFY_QUEUE_MAX
    }
  });
}

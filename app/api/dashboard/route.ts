import { NextResponse } from "next/server";
import { getDashboardData } from "@/services/persistenceService";
import { getLeadImportSummaryForDashboard } from "@/data/importLeads";

export async function GET() {
  const data = await getDashboardData();
  const importSummary = getLeadImportSummaryForDashboard();
  return NextResponse.json({ ...data, importSummary });
}

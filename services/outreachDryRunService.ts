import { db } from "@/lib/db";
import { outreachConfig } from "@/config/outreachConfig";

const SINGLETON_ID = "default";

export function outreachDryRunFromEnv(): boolean {
  return outreachConfig.dryRun;
}

/** Effective dry run for Resend sends, owner notify, and Google Calendar auto-book. */
export async function getEffectiveOutreachDryRun(): Promise<boolean> {
  const row = await db.dashboardRuntimeConfig.findUnique({ where: { id: SINGLETON_ID } });
  if (row?.outreachDryRunOverride !== null && row?.outreachDryRunOverride !== undefined) {
    return row.outreachDryRunOverride;
  }
  return outreachConfig.dryRun;
}

export type OutreachDryRunDashboardState = {
  envDefault: boolean;
  override: boolean | null;
  effective: boolean;
};

export async function getOutreachDryRunDashboardState(): Promise<OutreachDryRunDashboardState> {
  const envDefault = outreachConfig.dryRun;
  const row = await db.dashboardRuntimeConfig.findUnique({ where: { id: SINGLETON_ID } });
  const override = row?.outreachDryRunOverride ?? null;
  const effective = override !== null ? override : envDefault;
  return { envDefault, override, effective };
}

/** Persist override (true/false) or null to follow `DRY_RUN` env again. */
export async function setOutreachDryRunOverride(override: boolean | null): Promise<void> {
  await db.dashboardRuntimeConfig.upsert({
    where: { id: SINGLETON_ID },
    create: { id: SINGLETON_ID, outreachDryRunOverride: override },
    update: { outreachDryRunOverride: override }
  });
}

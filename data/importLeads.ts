import fs from "node:fs";
import path from "node:path";
import { parseCsv } from "@/lib/csv";
import { getCsvColumn } from "@/lib/csvColumns";
import { uid, asNum } from "@/lib/utils";
import { pipelineStatusForTier, scoreLeadBase } from "@/services/scoringService";
import { estimateDistanceMinutes } from "@/services/distanceService";
import { Lead, LeadType } from "@/types/lead";

export interface ImportSummary {
  totalRows: number;
  validRows: number;
  skippedRows: number;
  duplicateRows: number;
  /** Basename of the file actually imported (under `resources/`). */
  sourceFile: string;
}

/** Preferred CSV base name (without extension); user sheet with Address_Confidence / Confidence_Notes. */
export const LEAD_CSV_BASENAME = "customersbench_confidence_scored_1";

function resolveLeadImportCsvPath(): string {
  const resourcesDir = path.join(process.cwd(), "resources");
  const preferredBase = path.join(resourcesDir, LEAD_CSV_BASENAME);
  for (const ext of [".csv", ".CSV"]) {
    const p = preferredBase + ext;
    if (fs.existsSync(p)) return p;
  }
  const legacy = path.join(resourcesDir, "customersbench.CSV");
  if (fs.existsSync(legacy)) return legacy;
  const numbersPath = path.join(resourcesDir, `${LEAD_CSV_BASENAME}.numbers`);
  if (fs.existsSync(numbersPath)) {
    throw new Error(
      `Found resources/${LEAD_CSV_BASENAME}.numbers but Gloria only imports CSV. In Numbers: File → Export To → CSV… → save as resources/${LEAD_CSV_BASENAME}.csv`
    );
  }
  throw new Error(
    `Missing lead import file. Add resources/${LEAD_CSV_BASENAME}.csv (comma-separated).`
  );
}

function tryResolveLeadImportCsvPath(): string | null {
  try {
    return resolveLeadImportCsvPath();
  } catch {
    return null;
  }
}

const EMPTY_CSV_SUMMARY: ImportSummary = {
  totalRows: 0,
  validRows: 0,
  skippedRows: 0,
  duplicateRows: 0,
  sourceFile: "(no CSV in deployment — leads use the database only)"
};

/** Dashboard / API: never throw when `resources/*.csv` is missing (e.g. Vercel without the file in git). */
export function getLeadImportSummaryForDashboard(): ImportSummary {
  if (!tryResolveLeadImportCsvPath()) {
    return { ...EMPTY_CSV_SUMMARY };
  }
  return importCsvLeads().summary;
}

/** Seeding: use CSV when present; otherwise empty array (still seeds `mockDiscoveredLeads` in callers). */
export function importCsvLeadsOrEmpty(): { leads: Lead[]; summary: ImportSummary } {
  if (!tryResolveLeadImportCsvPath()) {
    return { leads: [], summary: { ...EMPTY_CSV_SUMMARY } };
  }
  return importCsvLeads();
}

const pickLeadType = (company: string): LeadType => {
  const lc = company.toLowerCase();
  if (lc.includes("design")) return "designer";
  if (lc.includes("architect")) return "architect";
  if (lc.includes("builder") || lc.includes("construction")) return "builder";
  if (lc.includes("cabinet")) return "cabinet shop";
  if (lc.includes("commercial")) return "commercial builder";
  return "homeowner";
};

const firstNonEmpty = (...values: Array<string | undefined>) =>
  values.map((v) => (v ?? "").trim()).find((v) => v.length > 0) ?? "";

const cleanName = (value: string) => value.replaceAll(/\s+/g, " ").replaceAll(",", " ").trim();

const splitName = (fullName: string) => {
  const normalized = cleanName(fullName);
  const [firstName = "", ...rest] = normalized.split(" ");
  return { firstName, lastName: rest.join(" ").trim(), fullName: normalized };
};

export const importCsvLeads = (): { leads: Lead[]; summary: ImportSummary } => {
  const filePath = resolveLeadImportCsvPath();
  const raw = fs.readFileSync(filePath, "utf8");
  const rows = parseCsv(raw);
  const sourceLabel = path.join("resources", path.basename(filePath));
  const seen = new Set<string>();
  const leads: Lead[] = [];
  let duplicateRows = 0;
  let skippedRows = 0;
  const now = new Date().toISOString();

  for (const row of rows) {
    const email = firstNonEmpty(row["Main Email"], row["Alt. Email 1"], row["CC Email"]).toLowerCase();
    const fullNameRaw = firstNonEmpty(
      row["Primary Contact"],
      [row["First Name"], row["Last Name"]].join(" "),
      row.Customer
    );
    const nameParts = splitName(fullNameRaw);
    const fullName = nameParts.fullName;
    if (!fullName || (!email && !(row["Main Phone"] || row.Mobile))) {
      skippedRows += 1;
      continue;
    }
    const dedupeKey = email || `${fullName}-${row.City}-${row.State}`;
    if (seen.has(dedupeKey)) {
      duplicateRows += 1;
      continue;
    }
    seen.add(dedupeKey);

    const firstName = firstNonEmpty(row["First Name"], nameParts.firstName);
    const lastName = firstNonEmpty(row["Last Name"], nameParts.lastName);
    const amountSpent = asNum(row["Estimate Total"]);
    const city = (row.City || "").trim();
    const state = (row.State || "").trim().toUpperCase();
    const company = firstNonEmpty(row["Bill to"], row.Customer);
    const leadType = pickLeadType(company);
    const distanceMinutes = estimateDistanceMinutes((row.Zip || "").trim(), state);
    const phone = firstNonEmpty(row["Main Phone"], row.Mobile, row["Work Phone"], row["Home Phone"]);
    const street = firstNonEmpty(row.Street1);
    const note = firstNonEmpty(row["Job Description"], street ? `Address: ${street}` : "");

    const addrConfRaw = getCsvColumn(row, [
      "Address_Confidence",
      "address_confidence",
      "Address Confidence",
      "ADDRESS_CONFIDENCE",
      "address confidence"
    ]);
    let addressConfidence: number | null = null;
    if (addrConfRaw) {
      const n = Number.parseFloat(addrConfRaw.replace(/,/g, ""));
      if (Number.isFinite(n)) addressConfidence = Math.min(100, Math.max(0, Math.round(n)));
    }
    const confidenceNotes = getCsvColumn(row, [
      "Confidence_Notes",
      "confidence_notes",
      "Confidence Notes",
      "CONFIDENCE_NOTES",
      "confidence notes"
    ]);

    const scored = scoreLeadBase({ distanceMinutes, amountSpent, leadType });

    leads.push({
      id: uid(),
      firstName,
      lastName,
      fullName,
      company: company.slice(0, 80),
      email,
      phone,
      city,
      state,
      zip: (row.Zip || "").trim(),
      leadType,
      source: "CSV Import",
      sourceDetail: `Imported from ${sourceLabel} (Customer=${firstNonEmpty(row.Customer)})`,
      amountSpent,
      notes: note,
      distanceMinutes,
      score: scored.score,
      conversionScore: scored.conversionScore,
      projectFitScore: scored.projectFitScore,
      estimatedProjectTier: scored.estimatedProjectTier,
      priorityTier: scored.priorityTier,
      status: pipelineStatusForTier(scored.priorityTier),
      doNotContact: false,
      createdAt: now,
      updatedAt: now,
      importedFromCsv: true,
      enrichmentStatus: "none",
      addressConfidence,
      confidenceNotes,
      outreachHistory: [],
      replyHistory: [],
      bookingHistory: [],
      scoreBreakdown: scored.breakdown
    });
  }

  return {
    leads,
    summary: {
      totalRows: rows.length,
      validRows: leads.length,
      skippedRows,
      duplicateRows,
      sourceFile: path.basename(filePath)
    }
  };
};

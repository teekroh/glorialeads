import { pipelineStatusForTier, scoreLeadBase } from "@/services/scoringService";
import { Lead } from "@/types/lead";
import { uid } from "@/lib/utils";

export const mockDiscoveredLeads = (): Lead[] => {
  const now = new Date().toISOString();
  const seeds = [
    { fullName: "Mia Rowan", city: "Doylestown", state: "PA", zip: "18901", email: "mia@rowandesign.co", phone: "267-555-0199", leadType: "designer" as const, amountSpent: 32000, distanceMinutes: 28 },
    { fullName: "Nate Fulton", city: "Blue Bell", state: "PA", zip: "19422", email: "nate@fultonbuild.com", phone: "610-555-4488", leadType: "builder" as const, amountSpent: 41000, distanceMinutes: 23 },
    { fullName: "Claire Ward", city: "Princeton", state: "NJ", zip: "08540", email: "claire@wardstudio.com", phone: "609-555-2201", leadType: "architect" as const, amountSpent: 18500, distanceMinutes: 49 },
    { fullName: "Devon Hale", city: "Lansdale", state: "PA", zip: "19446", email: "devon@halehomes.com", phone: "267-555-1160", leadType: "homeowner" as const, amountSpent: 28000, distanceMinutes: 17 },
    { fullName: "Paige Corman", city: "Ambler", state: "PA", zip: "19002", email: "paige@cormanbuild.com", phone: "215-555-7144", leadType: "builder" as const, amountSpent: 36000, distanceMinutes: 20 },
    { fullName: "Elliot Barnes", city: "Horsham", state: "PA", zip: "19044", email: "elliot@barnesstudio.com", phone: "215-555-7139", leadType: "architect" as const, amountSpent: 52000, distanceMinutes: 15 },
    { fullName: "Sofia Greer", city: "Newtown", state: "PA", zip: "18940", email: "sofia@greerdesign.com", phone: "267-555-9017", leadType: "designer" as const, amountSpent: 39000, distanceMinutes: 35 },
    { fullName: "Calvin Drake", city: "Conshohocken", state: "PA", zip: "19428", email: "calvin@drakecommercial.com", phone: "610-555-6761", leadType: "commercial builder" as const, amountSpent: 90000, distanceMinutes: 33 },
    { fullName: "Rene Sato", city: "Phoenixville", state: "PA", zip: "19460", email: "rene@satocabinetworks.com", phone: "610-555-3004", leadType: "cabinet shop" as const, amountSpent: 24000, distanceMinutes: 41 },
    { fullName: "Naomi Keats", city: "Bethlehem", state: "PA", zip: "18017", email: "naomi@keatshome.com", phone: "484-555-1974", leadType: "homeowner" as const, amountSpent: 21000, distanceMinutes: 57 },
    { fullName: "Trent Ivers", city: "Cherry Hill", state: "NJ", zip: "08002", email: "trent@iversbuild.com", phone: "856-555-6104", leadType: "builder" as const, amountSpent: 34000, distanceMinutes: 58 },
    { fullName: "Avery Monroe", city: "Yardley", state: "PA", zip: "19067", email: "avery@monroedesignhouse.com", phone: "215-555-2944", leadType: "designer" as const, amountSpent: 43000, distanceMinutes: 44 }
  ];
  return seeds.map((seed) => {
    const scored = scoreLeadBase({
      email: seed.email,
      source: "Scraped / External",
      enrichmentStatus: "none",
      distanceMinutes: seed.distanceMinutes,
      amountSpent: seed.amountSpent,
      leadType: seed.leadType
    });
    const [firstName, ...rest] = seed.fullName.split(" ");
    return {
      id: uid(),
      firstName,
      lastName: rest.join(" "),
      fullName: seed.fullName,
      company: seed.email.split("@")[1],
      email: seed.email,
      phone: seed.phone,
      city: seed.city,
      state: seed.state,
      zip: seed.zip,
      leadType: seed.leadType,
      source: "Scraped / External",
      sourceDetail: "Mock discovered via external partner directory",
      amountSpent: seed.amountSpent,
      notes: "Auto-seeded external lead for source transparency demo.",
      distanceMinutes: seed.distanceMinutes,
      score: scored.score,
      conversionScore: scored.conversionScore,
      projectFitScore: scored.projectFitScore,
      estimatedProjectTier: scored.estimatedProjectTier,
      priorityTier: scored.priorityTier,
      status: pipelineStatusForTier(scored.priorityTier),
      doNotContact: false,
      createdAt: now,
      updatedAt: now,
      importedFromCsv: false,
      enrichmentStatus: "none",
      addressConfidence: 72,
      confidenceNotes: "Mock external lead — assumed mid-confidence address.",
      outreachHistory: [],
      replyHistory: [],
      bookingHistory: [],
      scoreBreakdown: scored.breakdown
    };
  });
};

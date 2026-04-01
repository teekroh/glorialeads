import { importCsvLeadsOrEmpty } from "@/data/importLeads";
import { mockDiscoveredLeads } from "@/services/externalDiscoveryService";
import { ImportSummary } from "@/data/importLeads";
import { Lead } from "@/types/lead";

export interface BootstrapData {
  leads: Lead[];
  importSummary: ImportSummary;
}

export const getBootstrapData = (): BootstrapData => {
  const { leads: csvLeads, summary } = importCsvLeadsOrEmpty();
  const external = mockDiscoveredLeads();
  return {
    leads: [...csvLeads, ...external],
    importSummary: summary
  };
};

import { LOCATIONS } from "../../shared/keyword-locations.ts";
import type { ResearchScope } from "../../shared/researchScope.ts";

export function domainResearchKey(input: {
  hostname: string;
  scope: ResearchScope;
  path: string;
  locationCode: number;
  languageCode: string;
}): string {
  return `${input.hostname}|${input.scope}|${input.path}|${input.locationCode}|${input.languageCode}`;
}

export function formatOverviewResearchSummary(input: {
  display: string;
  locationCode: number;
  organicKeywords?: number | null;
  organicTraffic?: number | null;
  hasData?: boolean;
}): string {
  const country = LOCATIONS[input.locationCode] ?? `Location ${input.locationCode}`;
  if (!input.hasData || !input.organicKeywords || input.organicKeywords <= 0) {
    return `Domain overview for ${input.display} in ${country}: no data.`;
  }
  const keywords = input.organicKeywords;
  const traffic = input.organicTraffic != null ? input.organicTraffic : 0;
  return `Domain overview for ${input.display} in ${country}: ${keywords} organic keywords, about ${traffic} visits a month.`;
}

export function formatCompetitorsResearchSummary(input: {
  keywordCount: number;
  display: string;
  topDomains: string[];
}): string {
  const topList = input.topDomains.slice(0, 3).join(", ");
  return `SERP competitors for ${input.keywordCount} keywords of ${input.display}: ${topList}.`;
}

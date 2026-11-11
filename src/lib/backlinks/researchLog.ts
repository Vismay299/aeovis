import type { ResearchScope } from "../../shared/researchScope.ts";

export function backlinksResearchKey(input: {
  apiTarget: string;
  scope: ResearchScope;
  path: string;
}): string {
  return `${input.apiTarget}|${input.scope}|${input.path}`;
}

export function formatBacklinksResearchSummary(input: {
  display: string;
  backlinks?: number | null;
  referringDomains?: number | null;
}): string {
  const backlinks =
    input.backlinks != null ? String(input.backlinks) : "unknown";
  const referringDomains =
    input.referringDomains != null
      ? String(input.referringDomains)
      : "unknown";
  return `Backlinks for ${input.display}: ${backlinks} backlinks from ${referringDomains} domains.`;
}

/**
 * F05 §6.2 — the query-key registry. Every query key comes from here.
 *
 * Rule: a workspace-scoped key is `[domain, brandKey, ...params]`; a record
 * addressed by an id the route authorises (`scanReport`) is `[domain, id]`.
 * Later specs add their entries in their own PR.
 */

export const keys = {
  features: (brandKey: string) => ["features", brandKey] as const,
  overview: (brandKey: string) => ["overview", brandKey] as const,
  gsc: (brandKey: string) => ["gsc", brandKey] as const,
  panel: (brandKey: string, artifactKey = "default") =>
    ["panel", brandKey, artifactKey] as const,
  scanStatus: (brandKey: string, jobId: string) =>
    ["scanStatus", brandKey, jobId] as const,
  jobStatus: (brandKey: string, jobId: string) =>
    ["jobStatus", brandKey, jobId] as const,
  scanReport: (scanId: string) => ["scanReport", scanId] as const,
  // F03
  usage: (brandKey: string, range: string, tz: string) =>
    ["usage", brandKey, range, tz] as const,
  // F09
  price: (brandKey: string, action: string, inputKey: string) =>
    ["price", brandKey, action, inputKey] as const,
  // F07
  projectContext: (brandKey: string) => ["projectContext", brandKey] as const,
  // F26
  privacyChoice: () => ["privacyChoice"] as const,
  // F10
  schedule: (brandKey: string) => ["schedule", brandKey] as const,
  // F19
  indexnowSetup: (brandKey: string) => ["indexnowSetup", brandKey] as const,
  indexnowSubmissions: (
    brandKey: string,
    source?: string,
    sourceRef?: string,
  ) =>
    [
      "indexnowSubmissions",
      brandKey,
      source ?? null,
      sourceRef ?? null,
    ] as const,
  // F17
  localBusinesses: (brandKey: string) => ["localBusinesses", brandKey] as const,
  localFetch: (brandKey: string, fetchId: string) =>
    ["localFetch", brandKey, fetchId] as const,
  localFetches: (
    brandKey: string,
    businessId?: string | null,
    kind?: string | null,
  ) =>
    ["localFetches", brandKey, businessId ?? null, kind ?? null] as const,
  localGrid: (brandKey: string, gridId: string) =>
    ["localGrid", brandKey, gridId] as const,
  localGrids: (brandKey: string) => ["localGrids", brandKey] as const,
  localCategories: (query?: string) =>
    ["localCategories", query ?? ""] as const,
  // F13 — all keyword data is scoped to its workspace.
  keywordResearch: (brandKey: string, inputKey: string) =>
    ["keywordResearch", brandKey, inputKey] as const,
  keywordSerp: (brandKey: string, inputKey: string) =>
    ["keywordSerp", brandKey, inputKey] as const,
  savedKeywords: (brandKey: string, inputKey: string) =>
    ["savedKeywords", brandKey, inputKey] as const,
  keywordLocations: (brandKey: string, iso: string, q: string) =>
    ["keywordLocations", brandKey, iso, q] as const,
  // F14
  domainOverview: (brandKey: string, inputKey: string) =>
    ["domainOverview", brandKey, inputKey] as const,
  domainKeywords: (brandKey: string, inputKey: string) =>
    ["domainKeywords", brandKey, inputKey] as const,
  domainPages: (brandKey: string, inputKey: string) =>
    ["domainPages", brandKey, inputKey] as const,
  domainCompetitors: (brandKey: string, inputKey: string) =>
    ["domainCompetitors", brandKey, inputKey] as const,
  declaredCompetitors: (brandKey: string) =>
    ["declaredCompetitors", brandKey] as const,
  // F16
  backlinksOverview: (brandKey: string, inputKey: string) =>
    ["backlinksOverview", brandKey, inputKey] as const,
  backlinksTab: (brandKey: string, tab: string, inputKey: string) =>
    ["backlinksTab", brandKey, tab, inputKey] as const,
  backlinksDomainLinks: (brandKey: string, inputKey: string) =>
    ["backlinksDomainLinks", brandKey, inputKey] as const,
  ahrefsRatings: (brandKey: string, inputKey: string) =>
    ["ahrefsRatings", brandKey, inputKey] as const,
  backlinkSnapshotTargets: (brandKey: string) =>
    ["backlinkSnapshotTargets", brandKey] as const,
  backlinkSnapshots: (brandKey: string, target: string, scope: string) =>
    ["backlinkSnapshots", brandKey, target, scope] as const,
  // F18 — site audits. The workspace list and its capabilities are scoped to
  // the brand; an audit and its reads are addressed by the id the route
  // authorises.
  siteAudits: (brandKey: string) => ["siteAudits", brandKey] as const,
  siteAuditCapabilities: (brandKey: string) =>
    ["siteAuditCapabilities", brandKey] as const,
  siteAudit: (auditId: string) => ["siteAudit", auditId] as const,
  siteAuditFeed: (auditId: string) => ["siteAuditFeed", auditId] as const,
  siteAuditSummary: (auditId: string) => ["siteAuditSummary", auditId] as const,
  siteAuditIssues: (auditId: string, type: string, offset: number) =>
    ["siteAuditIssues", auditId, type, offset] as const,
  siteAuditPages: (auditId: string, filtersHash: string) =>
    ["siteAuditPages", auditId, filtersHash] as const,
  siteAuditPerformance: (auditId: string) =>
    ["siteAuditPerformance", auditId] as const,
  // Registered for F18 phase 5 (Lighthouse detail) and phase 8 (compare).
  siteAuditLighthouse: (resultId: string) =>
    ["siteAuditLighthouse", resultId] as const,
  siteAuditCompare: (base: string, head: string) =>
    ["siteAuditCompare", base, head] as const,
} as const;

export const privacyKeys = {
  choice: () => ["privacyChoice"] as const,
} as const;


/** Every domain above whose second element is a brandKey. */
export const WORKSPACE_DOMAINS: ReadonlySet<string> = new Set([
  "features",
  "overview",
  "gsc",
  "panel",
  "scanStatus",
  "jobStatus",
  "usage",
  "price",
  "projectContext",
  "localBusinesses",
  "localFetch",
  "localFetches",
  "localGrid",
  "localGrids",
  "keywordResearch",
  "keywordSerp",
  "savedKeywords",
  "keywordLocations",
  "schedule",
  "backlinksOverview",
  "backlinksTab",
  "backlinksDomainLinks",
  "ahrefsRatings",
  "backlinkSnapshotTargets",
  "backlinkSnapshots",
  "siteAudits",
  "siteAuditCapabilities",
]);

export function isWorkspaceKey(
  key: readonly unknown[],
  brandKey: string,
): boolean {
  const [domain, second] = key;
  return (
    typeof domain === "string" &&
    WORKSPACE_DOMAINS.has(domain) &&
    second === brandKey
  );
}

export function invalidateWorkspace(
  client: {
    invalidateQueries(f: {
      predicate(q: { queryKey: readonly unknown[] }): boolean;
    }): Promise<void>;
  },
  brandKey: string,
): Promise<void> {
  return client.invalidateQueries({
    predicate: (q) => isWorkspaceKey(q.queryKey, brandKey),
  });
}

/** JSON with object keys sorted at every depth; used to build `inputKey`s. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  // Serialise what JSON.stringify would (a Date's ISO string, any toJSON)
  // before the keys are rebuilt, or a Date would become `{}`.
  if (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { toJSON?: unknown }).toJSON === "function"
  ) {
    return sortKeys((value as { toJSON(): unknown }).toJSON());
  }
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value).sort()) {
      out[k] = sortKeys((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

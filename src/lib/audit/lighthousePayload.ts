// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/lib/lighthousePayload.ts
//   src/server/lib/lighthouseStoredPayload.ts
//   src/server/lib/dataforseoLighthousePayload.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { z } from "zod";

export const LIGHTHOUSE_CATEGORIES = [
  "performance",
  "accessibility",
  "best-practices",
  "seo",
] as const;

export type LighthouseCategory = (typeof LIGHTHOUSE_CATEGORIES)[number];
export type LighthouseCategoryTab = LighthouseCategory | "all";
export const categoryTabs: LighthouseCategoryTab[] = ["all", ...LIGHTHOUSE_CATEGORIES];

export type LighthouseStrategy = "mobile" | "desktop";

export type RawLighthouseAudit = {
  title?: string;
  description?: string;
  score?: number | null;
  scoreDisplayMode?: string;
  displayValue?: string;
  numericValue?: number;
  details?: {
    overallSavingsMs?: number;
    overallSavingsBytes?: number;
    items?: Array<Record<string, unknown>> | Record<string, unknown>;
  };
};

export type RawLighthouseCategory = {
  score?: number | null;
  auditRefs?: Array<{ id?: string }>;
};

const storedLighthouseMetricSchema = z.object({
  score: z.number().nullable(),
  displayValue: z.string().nullable(),
  numericValue: z.number().nullable(),
});

const storedLighthouseMetricsSchema = z.object({
  firstContentfulPaint: storedLighthouseMetricSchema,
  largestContentfulPaint: storedLighthouseMetricSchema,
  totalBlockingTime: storedLighthouseMetricSchema,
  cumulativeLayoutShift: storedLighthouseMetricSchema,
  speedIndex: storedLighthouseMetricSchema,
  timeToInteractive: storedLighthouseMetricSchema,
  interactionToNextPaint: storedLighthouseMetricSchema,
  serverResponseTime: storedLighthouseMetricSchema,
});

const storedLighthouseIssueSchema = z.object({
  category: z.enum(LIGHTHOUSE_CATEGORIES),
  auditKey: z.string(),
  title: z.string(),
  description: z.string(),
  score: z.number().nullable(),
  scoreDisplayMode: z.string().nullable(),
  displayValue: z.string().nullable(),
  impactMs: z.number().nullable(),
  impactBytes: z.number().nullable(),
  severity: z.enum(["critical", "warning", "info"]),
  items: z.array(z.string()),
});

export const storedLighthousePayloadSchema = z.object({
  version: z.literal(2),
  source: z.literal("dataforseo-lighthouse"),
  hasIssueDetails: z.boolean(),
  metadata: z.object({
    requestedUrl: z.string(),
    finalUrl: z.string(),
    strategy: z.enum(["mobile", "desktop"]),
    fetchedAt: z.string(),
    lighthouseVersion: z.string().nullable(),
    taskId: z.string().nullable(),
    cost: z.number().nullable(),
  }),
  scores: z.object({
    performance: z.number().nullable(),
    accessibility: z.number().nullable(),
    "best-practices": z.number().nullable(),
    seo: z.number().nullable(),
  }),
  metrics: storedLighthouseMetricsSchema,
  issues: z.array(storedLighthouseIssueSchema),
});

export type StoredLighthousePayload = z.infer<typeof storedLighthousePayloadSchema>;
export type StoredLighthouseIssue = z.infer<typeof storedLighthouseIssueSchema>;
export type StoredLighthouseMetrics = z.infer<typeof storedLighthouseMetricsSchema>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function scoreToPercent(score: number | null | undefined): number | null {
  if (typeof score !== "number" || Number.isNaN(score)) return null;
  return Math.round(score * 100);
}

function buildStoredMetric(audit: RawLighthouseAudit | undefined) {
  return {
    score: scoreToPercent(audit?.score),
    displayValue: audit?.displayValue ?? null,
    numericValue: typeof audit?.numericValue === "number" ? audit.numericValue : null,
  };
}

const DIAGNOSTIC_AUDIT_KEYS = new Set([
  "largest-contentful-paint-element",
  "layout-shifts",
  "diagnostics",
  "metrics",
  "network-requests",
  "network-rtt",
  "network-server-latency",
  "main-thread-tasks",
  "screenshot-thumbnails",
  "final-screenshot",
  "script-treemap-data",
  "resource-summary",
]);

function compactItem(item: Record<string, unknown>): string {
  const preferredKeys = [
    "url",
    "source",
    "nodeLabel",
    "snippet",
    "totalBytes",
    "wastedBytes",
    "wastedMs",
    "label",
    "value",
  ];
  const output: Record<string, unknown> = {};
  for (const key of preferredKeys) {
    if (item[key] != null) output[key] = item[key];
  }
  if (Object.keys(output).length === 0) {
    for (const [key, value] of Object.entries(item).slice(0, 6)) output[key] = value;
  }
  return JSON.stringify(output);
}

function getSeverity(input: { score: number | null; impactMs: number | null; impactBytes: number | null }): "critical" | "warning" | "info" {
  if ((input.impactMs ?? 0) >= 300 || (input.impactBytes ?? 0) >= 150_000) return "critical";
  if (input.score != null && input.score < 50) return "critical";
  if ((input.impactMs ?? 0) >= 100 || (input.impactBytes ?? 0) >= 50_000) return "warning";
  if (input.score != null && input.score < 90) return "warning";
  return "info";
}

export function buildStoredLighthouseIssues(input: {
  audits: Record<string, RawLighthouseAudit>;
  categories: Record<string, RawLighthouseCategory>;
}) {
  const hasIssueDetails = LIGHTHOUSE_CATEGORIES.some(
    (category) => (input.categories[category]?.auditRefs?.length ?? 0) > 0,
  );
  const issues: StoredLighthouseIssue[] = [];
  for (const category of LIGHTHOUSE_CATEGORIES) {
    const rawRefs = input.categories[category]?.auditRefs;
    const refs = Array.isArray(rawRefs) ? rawRefs : [];
    for (const ref of refs) {
      const auditKey = ref?.id;
      if (!auditKey) continue;
      const audit = input.audits[auditKey];
      if (!audit) continue;
      const score = scoreToPercent(audit.score);
      const scoreDisplayMode = audit.scoreDisplayMode ?? null;
      if (scoreDisplayMode === "numeric") continue;
      if (DIAGNOSTIC_AUDIT_KEYS.has(auditKey)) continue;
      const isPass =
        score == null ||
        score >= 90 ||
        scoreDisplayMode === "notApplicable" ||
        scoreDisplayMode === "informative" ||
        scoreDisplayMode === "manual" ||
        scoreDisplayMode === "error";
      if (isPass) continue;
      const impactMs =
        typeof audit.details?.overallSavingsMs === "number" ? audit.details.overallSavingsMs : null;
      const impactBytes =
        typeof audit.details?.overallSavingsBytes === "number" ? audit.details.overallSavingsBytes : null;
      const rawItems = audit.details?.items;
      const itemList = Array.isArray(rawItems) ? rawItems : isRecord(rawItems) ? [rawItems] : [];
      const items = itemList.filter(isRecord).slice(0, 10).map(compactItem);
      issues.push({
        category,
        auditKey,
        title: audit.title ?? auditKey,
        description: audit.description ?? "",
        score,
        scoreDisplayMode,
        displayValue: audit.displayValue ?? null,
        impactMs,
        impactBytes,
        severity: getSeverity({ score, impactMs, impactBytes }),
        items,
      });
    }
  }
  return { hasIssueDetails, issues };
}

export function buildStoredLighthouseMetrics(input: { audits: Record<string, RawLighthouseAudit> }): StoredLighthouseMetrics {
  return {
    firstContentfulPaint: buildStoredMetric(input.audits["first-contentful-paint"]),
    largestContentfulPaint: buildStoredMetric(input.audits["largest-contentful-paint"]),
    totalBlockingTime: buildStoredMetric(input.audits["total-blocking-time"]),
    cumulativeLayoutShift: buildStoredMetric(input.audits["cumulative-layout-shift"]),
    speedIndex: buildStoredMetric(input.audits["speed-index"]),
    timeToInteractive: buildStoredMetric(input.audits["interactive"]),
    interactionToNextPaint: buildStoredMetric(input.audits["interaction-to-next-paint"]),
    serverResponseTime: buildStoredMetric(input.audits["server-response-time"]),
  };
}

const lighthouseResponseSchema = z.object({
  requestedUrl: z.string().optional(),
  finalUrl: z.string().optional(),
  lighthouseVersion: z.string().optional(),
  categories: z.record(z.string(), z.custom<RawLighthouseCategory>()).optional(),
  audits: z.record(z.string(), z.custom<RawLighthouseAudit>()).optional(),
});

const dataforseoTaskSchema = z.object({
  id: z.string().optional(),
  cost: z.number().optional(),
  status_code: z.number().optional(),
  status_message: z.string().optional(),
  result: z.array(lighthouseResponseSchema).optional(),
});

const dataforseoLighthouseResponseSchema = z.object({
  status_code: z.number().optional(),
  status_message: z.string().optional(),
  tasks: z.array(dataforseoTaskSchema).optional(),
});

function summarizeZodIssues(error: z.ZodError, maxIssues = 3): string {
  return error.issues
    .slice(0, maxIssues)
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "<root>";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

export function parseDataforseoLighthousePayload(
  payload: unknown,
  input: { url: string; strategy: LighthouseStrategy },
): StoredLighthousePayload {
  const parsed = dataforseoLighthouseResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error(`DataForSEO Lighthouse returned an invalid response: ${summarizeZodIssues(parsed.error)}`);
  }
  if (parsed.data.status_code !== 20000) {
    throw new Error(parsed.data.status_message ?? "DataForSEO Lighthouse request failed");
  }
  const task = parsed.data.tasks?.[0];
  if (!task) throw new Error("DataForSEO Lighthouse response missing task");
  if (task.status_code !== 20000) {
    throw new Error(task.status_message ?? "DataForSEO Lighthouse task failed");
  }
  const result = task.result?.[0];
  if (!result) throw new Error("DataForSEO Lighthouse response missing result");
  const fetchedAt = new Date().toISOString();
  const categories = result.categories ?? {};
  const audits = result.audits ?? {};
  const issueReport = buildStoredLighthouseIssues({ audits, categories });
  const metrics = buildStoredLighthouseMetrics({ audits });
  const storedPayload: StoredLighthousePayload = {
    version: 2,
    source: "dataforseo-lighthouse",
    hasIssueDetails: issueReport.hasIssueDetails,
    metadata: {
      requestedUrl: result.requestedUrl ?? input.url,
      finalUrl: result.finalUrl ?? input.url,
      strategy: input.strategy,
      fetchedAt,
      lighthouseVersion: result.lighthouseVersion ?? null,
      taskId: task.id ?? null,
      cost: task.cost ?? null,
    },
    scores: {
      performance: scoreToPercent(categories.performance?.score),
      accessibility: scoreToPercent(categories.accessibility?.score),
      "best-practices": scoreToPercent(categories["best-practices"]?.score),
      seo: scoreToPercent(categories.seo?.score),
    },
    metrics,
    issues: issueReport.issues,
  };
  const allScoresMissing = Object.values(storedPayload.scores).every((score) => score == null);
  if (allScoresMissing) {
    throw new Error(`DataForSEO Lighthouse returned no category scores for ${storedPayload.metadata.finalUrl}`);
  }
  const validated = storedLighthousePayloadSchema.safeParse(storedPayload);
  if (!validated.success) {
    throw new Error(`DataForSEO Lighthouse returned an invalid report: ${summarizeZodIssues(validated.error)}`);
  }
  return storedPayload;
}

export function readStoredLighthousePayload(payloadJson: string, categoryFilter?: LighthouseCategory) {
  let storedPayload: StoredLighthousePayload | null = null;
  try {
    const parsed = storedLighthousePayloadSchema.safeParse(JSON.parse(payloadJson));
    if (parsed.success) storedPayload = parsed.data;
  } catch {
    try {
      JSON.parse(payloadJson);
    } catch {
      throw new Error("Invalid Lighthouse payload JSON");
    }
  }
  const issues = categoryFilter
    ? (storedPayload?.issues ?? []).filter((i) => i.category === categoryFilter)
    : (storedPayload?.issues ?? []);
  const sorted = [...issues].sort((a, b) => {
    const impactA = (a.impactMs ?? 0) * 1000 + (a.impactBytes ?? 0);
    const impactB = (b.impactMs ?? 0) * 1000 + (b.impactBytes ?? 0);
    if (impactA !== impactB) return impactB - impactA;
    return (a.score ?? 100) - (b.score ?? 100);
  });
  return {
    storedPayload,
    report: { hasIssueDetails: storedPayload?.hasIssueDetails ?? false, issues: sorted },
  };
}

export type ExportMode = "full" | "issues" | "category";

export function buildLighthouseExportFile(input: {
  idField: "auditId" | "resultId";
  idValue: string;
  finalUrl: string;
  strategy: "mobile" | "desktop";
  createdAt: string;
  payloadJson: string;
  mode: ExportMode;
  category?: LighthouseCategory;
}) {
  const safeDate = input.createdAt.replace(/[:.]/g, "-");
  const baseName = `lighthouse-${input.strategy}-${safeDate}`;
  if (input.mode === "full") {
    return { filename: `${baseName}-payload.json`, content: input.payloadJson };
  }
  const { report } = readStoredLighthousePayload(input.payloadJson, input.category);
  return {
    filename:
      input.mode === "category" && input.category
        ? `${baseName}-${input.category}-issues.json`
        : `${baseName}-issues.json`,
    content: JSON.stringify(
      {
        [input.idField]: input.idValue,
        finalUrl: input.finalUrl,
        strategy: input.strategy,
        createdAt: input.createdAt,
        category: input.category ?? "all",
        issues: report.issues,
      },
      null,
      2,
    ),
  };
}

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/lighthouse/issues/types.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

export const categoryTabs = ["all", "performance", "accessibility", "best-practices", "seo"] as const;
export type CategoryTab = (typeof categoryTabs)[number];

export type LighthouseIssue = {
  category: string;
  auditKey: string;
  title: string;
  description: string;
  score: number | null;
  scoreDisplayMode: string | null;
  displayValue: string | null;
  impactMs: number | null;
  impactBytes: number | null;
  severity: "critical" | "warning" | "info";
  items: string[];
};

export type LighthouseScores = {
  performance: number | null;
  accessibility: number | null;
  "best-practices": number | null;
  seo: number | null;
};

export type LighthouseMetrics = Record<
  string,
  { score: number | null; displayValue: string | null; numericValue: number | null }
>;

export type LighthouseDetail = {
  id: string;
  finalUrl: string | null;
  strategy: "mobile" | "desktop";
  createdAt: string;
  hasIssueDetails: boolean;
  scores: LighthouseScores;
  metrics: LighthouseMetrics | null;
  issues: LighthouseIssue[];
};

export type ExportPayload = { mode: "full" | "issues" | "category"; category?: string };

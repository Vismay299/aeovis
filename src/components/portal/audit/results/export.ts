// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/audit/results/export.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

// F18 phase 4 — the client exports for the visible results tables.
//
// Server-side export kinds (the "all rows" scope) are deferred with F06 phase
// 3, so every export here covers the rows the screen has loaded.

import type { CsvValue } from "@/lib/export/csv";
import { getIssueDescriptor } from "@/shared/audit-issues";
import type { AiAccessRow, AuditIssueGroup } from "../hooks/useAuditSummary";
import type { AuditPageRow } from "../hooks/useAuditPages";
import type { AuditPerformanceRow } from "../hooks/useAuditPerformance";

export type ExportTable = { headers: string[]; rows: CsvValue[][] };

export function issuesExport(groups: AuditIssueGroup[]): ExportTable {
  return {
    headers: ["Severity", "Issue", "Pages", "Rows", "How to fix"],
    rows: groups.map((group) => {
      const descriptor = getIssueDescriptor(group.issueType);
      return [
        group.severity,
        descriptor?.title ?? group.issueType,
        group.pages,
        group.rows,
        descriptor?.howToFix ?? "",
      ];
    }),
  };
}

export function pagesExport(rows: AuditPageRow[]): ExportTable {
  return {
    headers: [
      "URL",
      "Status",
      "Fetch result",
      "Title",
      "H1",
      "Words",
      "Images",
      "Missing alt",
      "Response time (ms)",
      "Depth",
      "In sitemap",
      "Indexable",
      "Structured data types",
    ],
    rows: rows.map((row) => [
      row.url,
      row.statusCode ?? "",
      row.fetchClass,
      row.title ?? "",
      row.h1Count,
      row.wordCount,
      row.imagesTotal,
      row.imagesMissingAlt,
      row.responseTimeMs ?? "",
      row.crawlDepth ?? "",
      row.inSitemap ? "Yes" : "No",
      row.isIndexable ? "Yes" : "No",
      row.structuredDataTypes.join(", "),
    ]),
  };
}

export function performanceExport(rows: AuditPerformanceRow[]): ExportTable {
  return {
    headers: [
      "URL",
      "Device",
      "Performance",
      "Accessibility",
      "Best practices",
      "SEO",
      "LCP (ms)",
      "CLS",
      "INP (ms)",
      "TTFB (ms)",
      "Error",
    ],
    rows: rows.map((row) => [
      row.pageUrl,
      row.strategy,
      row.performanceScore ?? "",
      row.accessibilityScore ?? "",
      row.bestPracticesScore ?? "",
      row.seoScore ?? "",
      row.lcpMs ?? "",
      row.cls ?? "",
      row.inpMs ?? "",
      row.ttfbMs ?? "",
      row.errorMessage ?? "",
    ]),
  };
}

export function aiAccessExport(rows: AiAccessRow[]): ExportTable {
  return {
    headers: ["Crawler", "Operator", "Used for", "Purpose", "Access", "Rule"],
    rows: rows.map((row) => [
      row.name,
      row.operator ?? "",
      row.platform ?? "",
      row.purpose,
      row.status,
      row.matchedGroup ?? "",
    ]),
  };
}

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/audit/results/export.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AppError } from "../../http/errors.ts";
import { exportFilename } from "../filenames.ts";
import { getIssueDescriptor } from "../../../shared/audit-issues.ts";
import type { ExportKind } from "./index.ts";

export const SITE_AUDIT_ISSUES_MAX_ROWS = 50_000;
export const SITE_AUDIT_PAGES_MAX_ROWS = 10_000;
export const SITE_AUDIT_PERFORMANCE_MAX_ROWS = 20;

export const SITE_AUDIT_ISSUES_CSV_HEADERS = [
  "Severity",
  "Issue",
  "URL",
  "Details",
  "How to fix",
] as const;

export const SITE_AUDIT_PAGES_CSV_HEADERS = [
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
] as const;

export const SITE_AUDIT_PERFORMANCE_CSV_HEADERS = [
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
] as const;

export const siteAuditIssuesParams = z.strictObject({
  auditId: z.uuid(),
  issueType: z.string().max(64).optional(),
});

export const siteAuditPagesParams = z.strictObject({
  auditId: z.uuid(),
});

export const siteAuditPerformanceParams = z.strictObject({
  auditId: z.uuid(),
});

export type SiteAuditIssuesParams = z.infer<typeof siteAuditIssuesParams>;
export type SiteAuditPagesParams = z.infer<typeof siteAuditPagesParams>;
export type SiteAuditPerformanceParams = z.infer<typeof siteAuditPerformanceParams>;

function detailsText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function yesNo(value: unknown): string {
  return value === true ? "Yes" : value === false ? "No" : "";
}

async function ownedAudit(
  admin: SupabaseClient,
  brandKey: string,
  auditId: string,
): Promise<{ id: string; start_url: string; started_at: string; status: string } | null> {
  const { data, error } = await admin
    .from("site_audits")
    .select("id,start_url,started_at,status")
    .eq("id", auditId)
    .eq("brand_key", brandKey)
    .maybeSingle();
  if (error) throw error;
  return (data as { id: string; start_url: string; started_at: string; status: string } | null) ?? null;
}

async function loadIssues(
  admin: SupabaseClient,
  brandKey: string,
  params: SiteAuditIssuesParams,
) {
  const audit = await ownedAudit(admin, brandKey, params.auditId);
  if (!audit) {
    throw new AppError(422, "no_rows", "There are no issues for this audit.");
  }

  const rows: Record<string, unknown>[] = [];
  const pageSize = 1_000;
  let start = 0;
  while (rows.length <= SITE_AUDIT_ISSUES_MAX_ROWS) {
    let query = admin
      .from("site_audit_issues")
      .select("id,page_id,page_url,issue_type,severity,details")
      .eq("audit_id", params.auditId)
      .eq("brand_key", brandKey);
    if (params.issueType) query = query.eq("issue_type", params.issueType);
    query = query
      .order("page_url", { ascending: true })
      .order("id", { ascending: true })
      .range(start, start + pageSize - 1);
    const { data, error } = await query;
    if (error) throw error;
    const page = Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
    for (const row of page) {
      rows.push(row);
      if (rows.length > SITE_AUDIT_ISSUES_MAX_ROWS) break;
    }
    if (page.length === 0) break;
    start += page.length;
    if (page.length < pageSize) break;
  }

  return {
    rows,
    meta: {
      audit: {
        id: audit.id,
        startUrl: audit.start_url,
        startedAt: audit.started_at,
        status: audit.status,
      },
    },
  };
}

async function loadPages(
  admin: SupabaseClient,
  brandKey: string,
  params: SiteAuditPagesParams,
) {
  const audit = await ownedAudit(admin, brandKey, params.auditId);
  if (!audit) {
    throw new AppError(422, "no_rows", "There are no pages for this audit.");
  }

  const rows: Record<string, unknown>[] = [];
  const pageSize = 1_000;
  let start = 0;
  while (rows.length <= SITE_AUDIT_PAGES_MAX_ROWS) {
    const { data, error } = await admin
      .from("site_audit_pages")
      .select(
        "id,url,status_code,fetch_class,title,h1_count,word_count,images_total,images_missing_alt,response_time_ms,crawl_depth,in_sitemap,is_indexable,structured_data_types",
      )
      .eq("audit_id", params.auditId)
      .eq("brand_key", brandKey)
      .order("url", { ascending: true })
      .order("id", { ascending: true })
      .range(start, start + pageSize - 1);
    if (error) throw error;
    const page = Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
    for (const row of page) {
      rows.push(row);
      if (rows.length > SITE_AUDIT_PAGES_MAX_ROWS) break;
    }
    if (page.length === 0) break;
    start += page.length;
    if (page.length < pageSize) break;
  }

  return {
    rows,
    meta: {
      audit: {
        id: audit.id,
        startUrl: audit.start_url,
        startedAt: audit.started_at,
        status: audit.status,
      },
    },
  };
}

async function loadPerformance(
  admin: SupabaseClient,
  brandKey: string,
  params: SiteAuditPerformanceParams,
) {
  const audit = await ownedAudit(admin, brandKey, params.auditId);
  if (!audit) {
    throw new AppError(422, "no_rows", "There is no performance data for this audit.");
  }

  const { data: lighthouseRows, error: lhError } = await admin
    .from("site_audit_lighthouse")
    .select(
      "id,page_id,strategy,performance_score,accessibility_score,best_practices_score,seo_score,lcp_ms,cls,inp_ms,ttfb_ms,error_message",
    )
    .eq("audit_id", params.auditId)
    .eq("brand_key", brandKey)
    .order("created_at", { ascending: true });
  if (lhError) throw lhError;

  const pageIds = Array.from(
    new Set((Array.isArray(lighthouseRows) ? lighthouseRows : []).map((r: any) => r.page_id).filter(Boolean)),
  );
  const pageUrls = new Map<string, string>();
  if (pageIds.length) {
    const { data: pages, error: pageError } = await admin
      .from("site_audit_pages")
      .select("id,url")
      .eq("audit_id", params.auditId)
      .in("id", pageIds);
    if (pageError) throw pageError;
    for (const page of Array.isArray(pages) ? pages : []) {
      pageUrls.set(String((page as any).id), String((page as any).url ?? ""));
    }
  }

  const rows = (Array.isArray(lighthouseRows) ? lighthouseRows : []).map((row: any) => ({
    ...row,
    page_url: pageUrls.get(String(row.page_id)) ?? "",
  }));

  return {
    rows,
    meta: {
      audit: {
        id: audit.id,
        startUrl: audit.start_url,
        startedAt: audit.started_at,
        status: audit.status,
      },
    },
  };
}

export const siteAuditIssuesKind: ExportKind<SiteAuditIssuesParams> = {
  kind: "site_audit_issues",
  feature: "site_audit_issues",
  params: siteAuditIssuesParams,
  maxRows: SITE_AUDIT_ISSUES_MAX_ROWS,
  load: loadIssues,
  csvHeaders: SITE_AUDIT_ISSUES_CSV_HEADERS,
  toCsvRow(row) {
    const descriptor = getIssueDescriptor(String(row.issue_type ?? ""));
    return [
      (row.severity as string) ?? descriptor?.severity ?? "",
      descriptor?.title ?? String(row.issue_type ?? ""),
      (row.page_url as string) ?? "",
      detailsText(row.details),
      descriptor?.howToFix ?? "",
    ];
  },
  toJson(rows, meta, ctx) {
    return {
      exportedAt: ctx.exportedAt,
      brandKey: ctx.brandKey,
      audit: (meta as any).audit ?? null,
      rows: rows.map((row) => {
        const descriptor = getIssueDescriptor(String(row.issue_type ?? ""));
        return {
          id: row.id ?? null,
          pageId: row.page_id ?? null,
          pageUrl: row.page_url ?? "",
          issueType: row.issue_type ?? "",
          severity: (row.severity as string) ?? descriptor?.severity ?? "",
          issue: descriptor?.title ?? String(row.issue_type ?? ""),
          details: row.details ?? null,
          howToFix: descriptor?.howToFix ?? "",
        };
      }),
    };
  },
  filename(brandKey, _params, format) {
    return `${exportFilename([brandKey, "site-audit", "issues"])}.${format}`;
  },
};

export const siteAuditPagesKind: ExportKind<SiteAuditPagesParams> = {
  kind: "site_audit_pages",
  feature: "site_audit_pages",
  params: siteAuditPagesParams,
  maxRows: SITE_AUDIT_PAGES_MAX_ROWS,
  load: loadPages,
  csvHeaders: SITE_AUDIT_PAGES_CSV_HEADERS,
  toCsvRow(row) {
    return [
      (row.url as string) ?? "",
      row.status_code == null ? "" : (row.status_code as number),
      (row.fetch_class as string) ?? "",
      (row.title as string) ?? "",
      row.h1_count == null ? "" : (row.h1_count as number),
      row.word_count == null ? "" : (row.word_count as number),
      row.images_total == null ? "" : (row.images_total as number),
      row.images_missing_alt == null ? "" : (row.images_missing_alt as number),
      row.response_time_ms == null ? "" : (row.response_time_ms as number),
      row.crawl_depth == null ? "" : (row.crawl_depth as number),
      row.in_sitemap ? "Yes" : "No",
      row.is_indexable ? "Yes" : "No",
      Array.isArray(row.structured_data_types)
        ? (row.structured_data_types as string[]).join(", ")
        : "",
    ];
  },
  toJson(rows, meta, ctx) {
    return {
      exportedAt: ctx.exportedAt,
      brandKey: ctx.brandKey,
      audit: (meta as any).audit ?? null,
      rows: rows.map((row) => ({
        id: row.id ?? null,
        url: row.url ?? "",
        statusCode: row.status_code ?? null,
        fetchClass: row.fetch_class ?? "",
        title: row.title ?? null,
        h1Count: row.h1_count ?? 0,
        wordCount: row.word_count ?? 0,
        imagesTotal: row.images_total ?? 0,
        imagesMissingAlt: row.images_missing_alt ?? 0,
        responseTimeMs: row.response_time_ms ?? null,
        crawlDepth: row.crawl_depth ?? null,
        inSitemap: Boolean(row.in_sitemap),
        isIndexable: Boolean(row.is_indexable),
        structuredDataTypes: Array.isArray(row.structured_data_types)
          ? row.structured_data_types
          : [],
      })),
    };
  },
  filename(brandKey, _params, format) {
    return `${exportFilename([brandKey, "site-audit", "pages"])}.${format}`;
  },
};

export const siteAuditPerformanceKind: ExportKind<SiteAuditPerformanceParams> = {
  kind: "site_audit_performance",
  feature: "site_audit_performance",
  params: siteAuditPerformanceParams,
  maxRows: SITE_AUDIT_PERFORMANCE_MAX_ROWS,
  load: loadPerformance,
  csvHeaders: SITE_AUDIT_PERFORMANCE_CSV_HEADERS,
  toCsvRow(row) {
    return [
      (row.page_url as string) ?? "",
      (row.strategy as string) ?? "",
      row.performance_score == null ? "" : (row.performance_score as number),
      row.accessibility_score == null ? "" : (row.accessibility_score as number),
      row.best_practices_score == null ? "" : (row.best_practices_score as number),
      row.seo_score == null ? "" : (row.seo_score as number),
      row.lcp_ms == null ? "" : (row.lcp_ms as number),
      row.cls == null ? "" : (row.cls as number),
      row.inp_ms == null ? "" : (row.inp_ms as number),
      row.ttfb_ms == null ? "" : (row.ttfb_ms as number),
      (row.error_message as string) ?? "",
    ];
  },
  toJson(rows, meta, ctx) {
    return {
      exportedAt: ctx.exportedAt,
      brandKey: ctx.brandKey,
      audit: (meta as any).audit ?? null,
      rows: rows.map((row) => ({
        id: row.id ?? null,
        pageId: row.page_id ?? null,
        pageUrl: (row.page_url as string) ?? "",
        strategy: row.strategy ?? "",
        performanceScore: row.performance_score ?? null,
        accessibilityScore: row.accessibility_score ?? null,
        bestPracticesScore: row.best_practices_score ?? null,
        seoScore: row.seo_score ?? null,
        lcpMs: row.lcp_ms ?? null,
        cls: row.cls ?? null,
        inpMs: row.inp_ms ?? null,
        ttfbMs: row.ttfb_ms ?? null,
        errorMessage: row.error_message ?? null,
      })),
    };
  },
  filename(brandKey, _params, format) {
    return `${exportFilename([brandKey, "site-audit", "performance"])}.${format}`;
  },
};

// Aliases for callers that prefer the shorter names.
export const siteAuditIssues = siteAuditIssuesKind;
export const siteAuditPages = siteAuditPagesKind;
export const siteAuditPerformance = siteAuditPerformanceKind;
export const siteAuditKinds = [
  siteAuditIssuesKind,
  siteAuditPagesKind,
  siteAuditPerformanceKind,
];
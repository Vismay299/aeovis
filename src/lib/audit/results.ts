import { AppError } from "../http/errors.ts";
import { AUDIT_ISSUE_TYPES } from "../../shared/audit-issues.ts";
import { readStoredLighthousePayload } from "./lighthousePayload.ts";

const NOT_FOUND = "Audit not found.";

async function ownedAudit(admin: any, brandKey: string, auditId: string, columns = "*"): Promise<any> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(auditId)) {
    throw new AppError(404, "audit_not_found", NOT_FOUND);
  }
  const { data, error } = await admin.from("site_audits").select(columns).eq("id", auditId).eq("brand_key", brandKey).maybeSingle();
  if (error) throw error;
  if (!data) throw new AppError(404, "audit_not_found", NOT_FOUND);
  return data;
}

export { ownedAudit as getOwnedAudit };

export async function getAuditFeed(admin: any, brandKey: string, auditId: string, limit: number): Promise<any> {
  const audit = await ownedAudit(admin, brandKey, auditId, "id,status");
  const { data, error } = await admin.from("site_audit_pages").select("url,status_code,title,crawled_at")
    .eq("audit_id", auditId).eq("brand_key", brandKey).order("crawled_at", { ascending: false }).limit(limit);
  if (error) throw error;
  return {
    entries: (data ?? []).map((row: any) => ({ url: row.url, statusCode: row.status_code, title: row.title?.slice(0, 300) ?? null, crawledAt: row.crawled_at })),
    pollAfterSeconds: audit.status === "queued" || audit.status === "running" ? 1.5 : null,
  };
}

export async function getAuditSummary(admin: any, brandKey: string, auditId: string): Promise<any> {
  const audit = await ownedAudit(admin, brandKey, auditId,
    "id,status,start_url,pages_crawled,pages_seen,pages_total,max_pages,crawl_completed,run_lighthouse,render_javascript,site_platform,created_at,completed_at,pages_abandoned,link_graph_complete,discovery_truncated,ai_access,robots_status,llms_txt",
  );
  const [groupRes, pagesRes, lighthouseRes] = await Promise.all([
    admin.rpc("site_audit_issue_summary", { p_audit_id: auditId }),
    admin.from("site_audit_pages").select("id,fetch_class,response_time_ms,rendered", { count: "exact" }).eq("audit_id", auditId).eq("brand_key", brandKey),
    admin.from("site_audit_lighthouse").select("performance_score,accessibility_score,best_practices_score,seo_score,error_message").eq("audit_id", auditId).eq("brand_key", brandKey),
  ]);
  if (groupRes.error) throw groupRes.error;
  if (pagesRes.error) throw pagesRes.error;
  if (lighthouseRes.error) throw lighthouseRes.error;
  const pages = pagesRes.data ?? [];
  const groups: any[] = (groupRes.data ?? []).map((row: any) => {
    const descriptor = AUDIT_ISSUE_TYPES[row.issue_type as keyof typeof AUDIT_ISSUE_TYPES];
    return {
      issueType: row.issue_type,
      severity: descriptor?.severity ?? row.severity,
      category: descriptor?.category ?? "crawl",
      scope: descriptor?.scope ?? "page",
      pages: Number(row.pages ?? 0),
      rows: Number(row.rows_count ?? 0),
    };
  });
  const issueTypeCounts = new Map<string, number>(groups.map((group: any) => [group.issueType, group.rows]));
  const okPages = pages.filter((row: any) => row.fetch_class === "ok" && typeof row.response_time_ms === "number");
  const lighthouse = lighthouseRes.data ?? [];
  const scoreAverage = (key: string) => {
    const scores = lighthouse.filter((row: any) => !row.error_message).map((row: any) => row[key]).filter((value: unknown) => typeof value === "number");
    return scores.length ? scores.reduce((sum: number, value: number) => sum + value, 0) / scores.length : null;
  };
  const hasShells = (issueTypeCounts.get("javascript-rendering-suspected") ?? 0) > 0;
  const rateLimited = pages.filter((row: any) => row.fetch_class === "rate_limited").length;
  const errorPages = pages.filter((row: any) => row.fetch_class === "error").length;
  const siteBlocked = audit.status === "completed" && Number(audit.pages_crawled ?? 0) <= 1 && !hasShells && rateLimited === 0;
  return {
    audit: {
      id: audit.id, startUrl: audit.start_url, status: audit.status, pagesCrawled: audit.pages_crawled,
      pagesSeen: audit.pages_seen ?? audit.pages_total, maxPages: audit.max_pages, crawlCompleted: Boolean(audit.crawl_completed),
      lighthouse: audit.run_lighthouse, renderJavaScript: audit.render_javascript, sitePlatform: audit.site_platform,
      createdAt: audit.created_at, completedAt: audit.completed_at,
    },
    stats: {
      averageResponseMs: okPages.length ? okPages.reduce((sum: number, row: any) => sum + row.response_time_ms, 0) / okPages.length : null,
      pagesBlocked: pages.filter((row: any) => row.fetch_class === "blocked").length,
      pagesRateLimited: rateLimited,
      pagesAbandoned: Number(audit.pages_abandoned ?? 0),
      pagesUnread: errorPages,
      lighthouse: {
        tests: lighthouse.length,
        failed: lighthouse.filter((row: any) => row.error_message).length,
        avgPerformance: scoreAverage("performance_score"),
        avgSeo: scoreAverage("seo_score"),
        avgAccessibility: scoreAverage("accessibility_score"),
      },
    },
    issueGroups: groups,
    aiAccess: { robotsStatus: audit.robots_status ?? null, rows: Array.isArray(audit.ai_access) ? audit.ai_access : [] },
    llmsTxt: audit.llms_txt ?? { status: "unreachable", httpStatus: null, contentType: null, firstLine: null },
    flags: {
      siteBlocked,
      crawlStopped: (issueTypeCounts.get("crawl-rate-limited") ?? 0) > 0,
      hasShells,
      unreadRendered: Boolean(audit.render_javascript) && errorPages > 0,
      linkGraphComplete: Boolean(audit.link_graph_complete),
      discoveryTruncated: Boolean(audit.discovery_truncated),
    },
  };
}

export async function listAuditIssues(
  admin: any,
  brandKey: string,
  auditId: string,
  input: { type: string; offset: number; limit: number },
): Promise<any> {
  await ownedAudit(admin, brandKey, auditId, "id");
  const { data, error, count } = await admin.from("site_audit_issues").select("id,page_id,page_url,details", { count: "exact" })
    .eq("audit_id", auditId).eq("brand_key", brandKey).eq("issue_type", input.type)
    .order("page_url", { ascending: true }).range(input.offset, input.offset + input.limit - 1);
  if (error) throw error;
  return {
    issueType: input.type,
    total: count ?? 0,
    rows: (data ?? []).map((row: any) => ({ id: row.id, pageId: row.page_id, pageUrl: row.page_url, details: row.details })),
  };
}

export type AuditPageFilters = {
  q?: string; status?: string; fetchClass?: string; minWords?: number; maxWords?: number;
  minResponseMs?: number; maxResponseMs?: number; missingAlt?: string; issueType?: string;
  sort: string; dir: "asc" | "desc"; offset: number; limit: number;
};

export async function listAuditPages(admin: any, brandKey: string, auditId: string, filters: AuditPageFilters): Promise<any> {
  await ownedAudit(admin, brandKey, auditId, "id");
  let query = admin.from("site_audit_pages").select(
    "id,url,status_code,fetch_class,redirect_url,title,meta_description,h1_count,word_count,images_total,images_missing_alt,response_time_ms,crawl_depth,in_sitemap,is_indexable,structured_data_types,rendered",
    { count: "exact" },
  ).eq("audit_id", auditId).eq("brand_key", brandKey);
  if (filters.q) {
    const safe = filters.q.replace(/[(),"\\]/g, " ").trim();
    if (safe) query = query.or(`url.ilike.%${safe}%,title.ilike.%${safe}%,meta_description.ilike.%${safe}%`);
  }
  if (filters.status === "ok") query = query.gte("status_code", 200).lt("status_code", 300);
  if (filters.status === "redirect") query = query.gte("status_code", 300).lt("status_code", 400);
  if (filters.status === "error") query = query.gte("status_code", 400);
  if (filters.status === "missing") query = query.or("status_code.is.null,status_code.eq.0");
  if (filters.fetchClass && filters.fetchClass !== "all") query = query.eq("fetch_class", filters.fetchClass);
  if (filters.minWords !== undefined) query = query.gte("word_count", filters.minWords);
  if (filters.maxWords !== undefined) query = query.lte("word_count", filters.maxWords);
  if (filters.minResponseMs !== undefined) query = query.gte("response_time_ms", filters.minResponseMs);
  if (filters.maxResponseMs !== undefined) query = query.lte("response_time_ms", filters.maxResponseMs);
  if (filters.missingAlt === "yes") query = query.gt("images_missing_alt", 0);
  if (filters.missingAlt === "no") query = query.eq("images_missing_alt", 0);
  if (filters.issueType) {
    const { data: issues, error: issueError } = await admin.from("site_audit_issues").select("page_id")
      .eq("audit_id", auditId).eq("brand_key", brandKey).eq("issue_type", filters.issueType).not("page_id", "is", null);
    if (issueError) throw issueError;
    const pageIds = Array.from(new Set((issues ?? []).map((row: any) => row.page_id).filter(Boolean)));
    if (!pageIds.length) return { total: 0, rows: [] };
    query = query.in("id", pageIds);
  }
  const orderColumns: Record<string, string> = {
    url: "url", status: "status_code", title: "title", h1: "h1_count", words: "word_count",
    images: "images_missing_alt", speed: "response_time_ms",
  };
  query = query.order(orderColumns[filters.sort] ?? "url", { ascending: filters.dir === "asc", nullsFirst: false })
    .range(filters.offset, filters.offset + filters.limit - 1);
  const { data, error, count } = await query;
  if (error) throw error;
  const rows = data ?? [];
  const ids = rows.map((row: any) => row.id);
  const issueCounts = new Map<string, number>();
  if (ids.length) {
    const { data: issueRows, error: countError } = await admin.from("site_audit_issues").select("page_id")
      .eq("audit_id", auditId).eq("brand_key", brandKey).in("page_id", ids);
    if (countError) throw countError;
    for (const issue of issueRows ?? []) issueCounts.set(issue.page_id, (issueCounts.get(issue.page_id) ?? 0) + 1);
  }
  return {
    total: count ?? 0,
    rows: rows.map((row: any) => ({
      id: row.id, url: row.url, statusCode: row.status_code, fetchClass: row.fetch_class, redirectUrl: row.redirect_url,
      title: row.title, metaDescription: row.meta_description, h1Count: row.h1_count, wordCount: row.word_count,
      imagesTotal: row.images_total, imagesMissingAlt: row.images_missing_alt, responseTimeMs: row.response_time_ms,
      crawlDepth: row.crawl_depth, inSitemap: row.in_sitemap, isIndexable: row.is_indexable,
      structuredDataTypes: row.structured_data_types ?? [], issueCount: issueCounts.get(row.id) ?? 0, rendered: row.rendered,
    })),
  };
}

export async function listAuditPerformance(admin: any, brandKey: string, auditId: string): Promise<any> {
  await ownedAudit(admin, brandKey, auditId, "id");
  const { data: rows, error } = await admin.from("site_audit_lighthouse").select(
    "id,page_id,strategy,performance_score,accessibility_score,best_practices_score,seo_score,lcp_ms,cls,inp_ms,ttfb_ms,error_message,payload_path",
  ).eq("audit_id", auditId).eq("brand_key", brandKey).order("created_at", { ascending: true });
  if (error) throw error;
  const pageIds = Array.from(new Set((rows ?? []).map((row: any) => row.page_id).filter(Boolean)));
  const pageUrls = new Map<string, string>();
  if (pageIds.length) {
    const { data: pages, error: pageError } = await admin.from("site_audit_pages").select("id,url").eq("audit_id", auditId).in("id", pageIds);
    if (pageError) throw pageError;
    for (const page of pages ?? []) pageUrls.set(page.id, page.url);
  }
  return { rows: (rows ?? []).map((row: any) => ({
    id: row.id, pageId: row.page_id, pageUrl: pageUrls.get(row.page_id) ?? "", pagePath: (() => { try { return new URL(pageUrls.get(row.page_id) ?? "").pathname; } catch { return ""; } })(),
    strategy: row.strategy, performanceScore: row.performance_score, accessibilityScore: row.accessibility_score,
    bestPracticesScore: row.best_practices_score, seoScore: row.seo_score, lcpMs: row.lcp_ms, cls: row.cls,
    inpMs: row.inp_ms, ttfbMs: row.ttfb_ms, errorMessage: row.error_message, hasDetails: Boolean(row.payload_path),
  })) };
}

export async function getLighthouseDetail(admin: any, brandKey: string, auditId: string, resultId: string): Promise<any> {
  await ownedAudit(admin, brandKey, auditId, "id");
  const { data: row, error } = await admin.from("site_audit_lighthouse").select("*").eq("id", resultId).eq("audit_id", auditId).eq("brand_key", brandKey).maybeSingle();
  if (error) throw error;
  if (!row) throw new AppError(404, "not_found", "Lighthouse result not found.");
  let payload: any = null;
  let report: any = { hasIssueDetails: false, issues: [] };
  if (row.payload_path) {
    try {
      const { data: fileData, error: dlErr } = await admin.storage.from("site-audit-lighthouse").download(row.payload_path);
      if (!dlErr && fileData) {
        const text = await fileData.text();
        const parsed = readStoredLighthousePayload(text);
        payload = parsed.storedPayload;
        report = parsed.report;
      }
    } catch {
      // ignore
    }
  }
  return {
    id: row.id,
    finalUrl: row.final_url ?? row.url ?? null,
    strategy: row.strategy,
    createdAt: row.created_at,
    hasIssueDetails: report.hasIssueDetails,
    scores: {
      performance: row.performance_score,
      accessibility: row.accessibility_score,
      "best-practices": row.best_practices_score,
      seo: row.seo_score,
    },
    metrics: payload?.metrics ?? null,
    issues: report.issues,
  };
}

export function knownIssueType(type: string): boolean {
  return type in AUDIT_ISSUE_TYPES;
}

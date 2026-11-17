// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/audit/repositories/AuditRepository.ts
//   src/server/features/audit/repositories/auditIssueWrites.ts
//   src/server/features/audit/AuditScratchpad.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import type { CrawlThrottleState } from "./crawlThrottle.ts";
import type { CrawledPageResult, LighthouseResult } from "./types.ts";
import type { DetectedIssue } from "./issues/pageReporters.ts";
import type { SlimPage } from "./issues/multipageChecks.ts";
import type { PageFetchClass } from "../../shared/audit-fetch-class.ts";
import { AUDIT_ISSUE_TYPES } from "../../shared/audit-issues.ts";
import { deterministicUuid } from "./ids.ts";

export type AuditStatus = "queued" | "running" | "completed" | "partial" | "failed" | "cancelled";
export type AuditPhase =
  | "queued"
  | "starting"
  | "discovery"
  | "crawling"
  | "lighthouse"
  | "finalizing"
  | "completed"
  | "failed"
  | "cancelled";
export type RobotsStatus = "found" | "missing" | "error" | "unreachable" | "malformed";

export type AuditRow = {
  id: string;
  brand_key: string;
  job_id: string | null;
  status: AuditStatus;
  current_phase: AuditPhase;
  start_url: string;
  start_host: string;
  max_pages: number;
  run_lighthouse: boolean;
  render_javascript: boolean;
  site_platform: "shopify" | null;
  robots_status: RobotsStatus | null;
  robots_txt: string | null;
  window_hint: number;
  throttle_state: CrawlThrottleState | null;
  render_hold_id: string | null;
  render_approved_usd: number | null;
  render_attempts: number;
  render_billed: number;
  render_settled_at: string | null;
  lighthouse_approved_usd: number | null;
  pages_crawled: number;
  pages_total: number;
  pages_abandoned: number;
  link_graph_complete: boolean;
  cancel_requested_at: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  requested_url?: string;
  trigger?: "manual" | "baseline" | "tool";
  crawler_credential_id?: string | null;
  pages_seen?: number;
  crawl_completed?: boolean | null;
  rate_limited?: boolean;
  discovery_truncated?: boolean;
  link_targets_stored?: number;
  lighthouse_total?: number;
  lighthouse_completed?: number;
  lighthouse_failed?: number;
  robots_http_status?: number | null;
  ai_access?: unknown;
  llms_txt?: unknown;
  approved_max_usd?: number | null;
  price_quote?: unknown;
  error_code?: string | null;
  error_detail?: string | null;
  failed_phase?: string | null;
  updated_at?: string;
};

export interface BrokenLinkRow {
  source_page_id: string;
  source_url: string;
  target_url: string;
  target_status: number;
}

export interface ClaimedUrl {
  url: string;
  depth: number | null;
  inSitemap: boolean;
}

export interface FrontierStats {
  attempted: number;
  pending: number;
  abandoned: number;
  seen: number;
}

export interface AuditStore {
  getAudit(auditId: string): Promise<AuditRow | null>;
  updateAudit(auditId: string, jobId: string, patch: Partial<AuditRow>): Promise<void>;
  failAudit(auditId: string, info: { errorCode: string; errorDetail: string; failedPhase: string | null }): Promise<boolean>;
  cancelAudit(auditId: string, info?: { errorDetail?: string | null; failedPhase?: string | null }): Promise<boolean>;
  seedStart(auditId: string, url: string): Promise<void>;
  seedSitemap(auditId: string, urls: string[]): Promise<void>;
  claimChunk(auditId: string, chunkNo: number, limit: number): Promise<{ urls: ClaimedUrl[]; isRetry: boolean }>;
  recordBatch(auditId: string, input: {
    crawledUrls: string[];
    links: Array<{ pageId: string; url: string; targets: string[] }>;
    discovered: Array<{ url: string; depth: number | null }>;
  }): Promise<FrontierStats>;
  releaseUrls(auditId: string, urls: string[]): Promise<void>;
  abandonChunk(auditId: string, chunkNo: number): Promise<number>;
  stats(auditId: string): Promise<FrontierStats>;
  saveThrottle(auditId: string, state: CrawlThrottleState): Promise<void>;
  upsertPages(audit: { id: string; brandKey: string }, pages: CrawledPageResult[]): Promise<void>;
  insertIssues(audit: { id: string; brandKey: string }, issues: DetectedIssue[]): Promise<void>;
  listSlimPages(auditId: string, afterId: string | null, limit: number): Promise<SlimPage[]>;
  shellPageIds(auditId: string): Promise<Set<string>>;
  brokenLinks(auditId: string, cap: number): Promise<BrokenLinkRow[]>;
  orphanPages(auditId: string, startUrl: string): Promise<Array<{ pageId: string; url: string }>>;
  countPagesByFetchClass(auditId: string, fetchClass: PageFetchClass): Promise<number>;
  hasPages(auditId: string): Promise<boolean>;
  lighthouseCandidates(auditId: string): Promise<Array<{ id: string; url: string; statusCode: number; fetchClass: PageFetchClass }>>;
  insertLighthouse(audit: { id: string; brandKey: string }, rows: LighthouseResult[]): Promise<void>;
  destroyScratch(auditId: string): Promise<void>;
}

export function createSqlAuditStore(admin: any, opts?: { linkBudget?: number }): AuditStore {
  const linkBudget = opts?.linkBudget ?? 3_000_000;

  return {
    async getAudit(auditId: string): Promise<AuditRow | null> {
      const { data, error } = await admin
        .from("site_audits")
        .select("*")
        .eq("id", auditId)
        .maybeSingle();
      if (error) throw error;
      return data as AuditRow | null;
    },

    async updateAudit(auditId: string, jobId: string, patch: Partial<AuditRow>): Promise<void> {
      const { error } = await admin
        .from("site_audits")
        .update(patch)
        .eq("id", auditId)
        .or(`job_id.is.null,job_id.eq.${jobId}`);
      if (error) throw error;
    },

    async failAudit(auditId: string, info: { errorCode: string; errorDetail: string; failedPhase: string | null }): Promise<boolean> {
      const { data, error } = await admin
        .from("site_audits")
        .update({
          status: "failed",
          current_phase: "failed",
          error_code: info.errorCode,
          error_detail: info.errorDetail ? info.errorDetail.slice(0, 500) : null,
          failed_phase: info.failedPhase,
          completed_at: new Date().toISOString(),
        })
        .eq("id", auditId)
        .in("status", ["queued", "running"])
        .select("id");
      if (error) throw error;
      return Boolean(data && data.length > 0);
    },

    async cancelAudit(auditId: string, info?: { errorDetail?: string | null; failedPhase?: string | null }): Promise<boolean> {
      const { data, error } = await admin
        .from("site_audits")
        .update({
          status: "cancelled",
          current_phase: "cancelled",
          error_code: "cancelled",
          error_detail: info?.errorDetail ? info.errorDetail.slice(0, 500) : null,
          failed_phase: info?.failedPhase ?? null,
          completed_at: new Date().toISOString(),
        })
        .eq("id", auditId)
        .in("status", ["queued", "running"])
        .select("id");
      if (error) throw error;
      return Boolean(data && data.length > 0);
    },

    async seedStart(auditId: string, url: string): Promise<void> {
      const { error } = await admin.rpc("site_audit_seed", {
        p_audit_id: auditId,
        p_urls: [url],
        p_source: "link",
      });
      if (error) throw error;
    },

    async seedSitemap(auditId: string, urls: string[]): Promise<void> {
      for (let i = 0; i < urls.length; i += 2000) {
        const chunk = urls.slice(i, i + 2000);
        const { error } = await admin.rpc("site_audit_seed", {
          p_audit_id: auditId,
          p_urls: chunk,
          p_source: "sitemap",
        });
        if (error) throw error;
      }
    },

    async claimChunk(auditId: string, chunkNo: number, limit: number): Promise<{ urls: ClaimedUrl[]; isRetry: boolean }> {
      const { data, error } = await admin.rpc("site_audit_claim_chunk", {
        p_audit_id: auditId,
        p_chunk_no: chunkNo,
        p_limit: limit,
      });
      if (error) throw error;
      return {
        urls: (data?.urls ?? []).map((u: any) => ({
          url: u.url,
          depth: u.depth ?? null,
          inSitemap: Boolean(u.inSitemap),
        })),
        isRetry: Boolean(data?.isRetry),
      };
    },

    async recordBatch(
      auditId: string,
      input: {
        crawledUrls: string[];
        links: Array<{ pageId: string; url: string; targets: string[] }>;
        discovered: Array<{ url: string; depth: number | null }>;
      }
    ): Promise<FrontierStats> {
      const { data, error } = await admin.rpc("site_audit_record_batch", {
        p_audit_id: auditId,
        p_crawled: input.crawledUrls,
        p_links: input.links,
        p_discovered: input.discovered,
        p_link_budget: linkBudget,
      });
      if (error) throw error;
      return {
        attempted: Number(data?.attempted ?? 0),
        pending: Number(data?.pending ?? 0),
        abandoned: Number(data?.abandoned ?? 0),
        seen: Number(data?.seen ?? 0),
      };
    },

    async releaseUrls(auditId: string, urls: string[]): Promise<void> {
      if (!urls || urls.length === 0) return;
      const { error } = await admin.rpc("site_audit_release", {
        p_audit_id: auditId,
        p_urls: urls,
      });
      if (error) throw error;
    },

    async abandonChunk(auditId: string, chunkNo: number): Promise<number> {
      const { data, error } = await admin.rpc("site_audit_abandon_chunk", {
        p_audit_id: auditId,
        p_chunk_no: chunkNo,
      });
      if (error) throw error;
      return Number(data ?? 0);
    },

    async stats(auditId: string): Promise<FrontierStats> {
      const { data, error } = await admin.rpc("site_audit_frontier_stats", {
        p_audit_id: auditId,
      });
      if (error) throw error;
      return {
        attempted: Number(data?.attempted ?? 0),
        pending: Number(data?.pending ?? 0),
        abandoned: Number(data?.abandoned ?? 0),
        seen: Number(data?.seen ?? 0),
      };
    },

    async saveThrottle(auditId: string, state: CrawlThrottleState): Promise<void> {
      const { error } = await admin
        .from("site_audits")
        .update({ throttle_state: state })
        .eq("id", auditId);
      if (error) throw error;
    },

    async upsertPages(audit: { id: string; brandKey: string }, pages: CrawledPageResult[]): Promise<void> {
      if (!pages || pages.length === 0) return;
      const rows = pages.map((p) => ({
        id: p.id,
        audit_id: audit.id,
        brand_key: audit.brandKey,
        url: p.url.slice(0, 2048),
        status_code: p.statusCode,
        fetch_class: p.fetchClass,
        redirect_url: p.redirectUrl ? p.redirectUrl.slice(0, 2048) : null,
        title: p.title ? p.title.slice(0, 1000) : null,
        meta_description: p.metaDescription ? p.metaDescription.slice(0, 2000) : null,
        canonical_url: p.canonicalUrl ? p.canonicalUrl.slice(0, 2048) : null,
        header_canonical_url: p.headerCanonicalUrl ? p.headerCanonicalUrl.slice(0, 2048) : null,
        robots_meta: p.robotsMeta ? p.robotsMeta.slice(0, 500) : null,
        x_robots_tag: p.xRobotsTag ? p.xRobotsTag.slice(0, 500) : null,
        og_title: p.ogTitle ? p.ogTitle.slice(0, 2000) : null,
        og_description: p.ogDescription ? p.ogDescription.slice(0, 2000) : null,
        og_image: p.ogImage ? p.ogImage.slice(0, 2000) : null,
        h1_count: p.h1Count ?? 0,
        h2_count: p.h2Count ?? 0,
        h3_count: p.h3Count ?? 0,
        h4_count: p.h4Count ?? 0,
        h5_count: p.h5Count ?? 0,
        h6_count: p.h6Count ?? 0,
        word_count: p.wordCount ?? 0,
        content_hash: p.contentHash ?? null,
        images_total: p.imagesTotal ?? 0,
        images_missing_alt: p.imagesMissingAlt ?? 0,
        internal_link_count: (p.links ?? []).filter((l) => l.isInternal).length,
        external_link_count: (p.links ?? []).filter((l) => !l.isInternal).length,
        has_structured_data: Boolean(p.hasStructuredData),
        structured_data_types: p.structuredDataTypes ?? [],
        hreflang: (p.hreflang ?? []).slice(0, 50),
        is_indexable: Boolean(p.isIndexable),
        crawl_depth: p.crawlDepth ?? null,
        in_sitemap: Boolean(p.inSitemap),
        response_time_ms: p.responseTimeMs ?? null,
        rendered: Boolean(p.rendered),
        crawled_at: new Date().toISOString(),
      }));

      for (let i = 0; i < rows.length; i += 200) {
        const batch = rows.slice(i, i + 200);
        const { error } = await admin
          .from("site_audit_pages")
          .upsert(batch, { onConflict: "id" });
        if (error) throw error;
      }
    },

    async insertIssues(audit: { id: string; brandKey: string }, issues: DetectedIssue[]): Promise<void> {
      if (!issues || issues.length === 0) return;
      const rows = issues.map((issue) => {
        const severity = AUDIT_ISSUE_TYPES[issue.issueType]?.severity ?? "info";
        const issueId = deterministicUuid(
          audit.id,
          issue.pageUrl,
          issue.issueType,
          issue.dedupeKey ?? ""
        );
        return {
          id: issueId,
          audit_id: audit.id,
          brand_key: audit.brandKey,
          page_id: issue.pageId ?? null,
          page_url: issue.pageUrl.slice(0, 2048),
          issue_type: issue.issueType,
          severity,
          details: issue.details ?? null,
          created_at: new Date().toISOString(),
        };
      });

      for (let i = 0; i < rows.length; i += 500) {
        const batch = rows.slice(i, i + 500);
        const { error } = await admin
          .from("site_audit_issues")
          .upsert(batch, { onConflict: "id", ignoreDuplicates: true });
        if (error) throw error;
      }
    },

    async listSlimPages(auditId: string, afterId: string | null, limit: number): Promise<SlimPage[]> {
      let query = admin
        .from("site_audit_pages")
        .select(
          "id, url, status_code, fetch_class, title, meta_description, content_hash, redirect_url, word_count, is_indexable, canonical_url, header_canonical_url, rendered, hreflang"
        )
        .eq("audit_id", auditId)
        .order("id", { ascending: true })
        .limit(limit);

      if (afterId) {
        query = query.gt("id", afterId);
      }

      const { data, error } = await query;
      if (error) throw error;

      return (data ?? []).map((r: any) => ({
        id: r.id,
        url: r.url,
        statusCode: r.status_code,
        fetchClass: r.fetch_class as PageFetchClass,
        title: r.title,
        metaDescription: r.meta_description,
        contentHash: r.content_hash,
        redirectUrl: r.redirect_url,
        wordCount: r.word_count ?? 0,
        isIndexable: Boolean(r.is_indexable),
        canonicalUrl: r.canonical_url,
        headerCanonicalUrl: r.header_canonical_url,
        javascriptShell: r.rendered ? false : undefined,
        hreflang: r.hreflang ?? [],
      }));
    },

    async shellPageIds(auditId: string): Promise<Set<string>> {
      const { data, error } = await admin
        .from("site_audit_issues")
        .select("page_id")
        .eq("audit_id", auditId)
        .eq("issue_type", "javascript-rendering-suspected");
      if (error) throw error;
      const ids = new Set<string>();
      for (const row of data ?? []) {
        if (row.page_id) ids.add(row.page_id);
      }
      return ids;
    },

    async brokenLinks(auditId: string, cap: number): Promise<BrokenLinkRow[]> {
      const { data, error } = await admin.rpc("site_audit_broken_links", {
        p_audit_id: auditId,
        p_limit: cap,
      });
      if (error) throw error;
      return (data ?? []).map((r: any) => ({
        source_page_id: r.source_page_id,
        source_url: r.source_url,
        target_url: r.target_url,
        target_status: Number(r.target_status),
      }));
    },

    async orphanPages(auditId: string, startUrl: string): Promise<Array<{ pageId: string; url: string }>> {
      const { data, error } = await admin.rpc("site_audit_orphan_pages", {
        p_audit_id: auditId,
        p_start_url: startUrl,
      });
      if (error) throw error;
      return (data ?? []).map((r: any) => ({
        pageId: r.page_id,
        url: r.url,
      }));
    },

    async countPagesByFetchClass(auditId: string, fetchClass: PageFetchClass): Promise<number> {
      const { count, error } = await admin
        .from("site_audit_pages")
        .select("id", { count: "exact", head: true })
        .eq("audit_id", auditId)
        .eq("fetch_class", fetchClass);
      if (error) throw error;
      return count ?? 0;
    },

    async hasPages(auditId: string): Promise<boolean> {
      const { data, error } = await admin
        .from("site_audit_pages")
        .select("id")
        .eq("audit_id", auditId)
        .limit(1);
      if (error) throw error;
      return Boolean(data && data.length > 0);
    },

    async lighthouseCandidates(auditId: string): Promise<Array<{ id: string; url: string; statusCode: number; fetchClass: PageFetchClass }>> {
      const { data, error } = await admin
        .from("site_audit_pages")
        .select("id, url, status_code, fetch_class")
        .eq("audit_id", auditId)
        .eq("fetch_class", "ok")
        .gte("status_code", 200)
        .lt("status_code", 300);
      if (error) throw error;
      return (data ?? []).map((r: any) => ({
        id: r.id,
        url: r.url,
        statusCode: r.status_code,
        fetchClass: r.fetch_class,
      }));
    },

    async insertLighthouse(audit: { id: string; brandKey: string }, rows: LighthouseResult[]): Promise<void> {
      if (!rows || rows.length === 0) return;
      const records = rows.map((r) => ({
        id: deterministicUuid(audit.id, r.pageId, r.strategy),
        audit_id: audit.id,
        brand_key: audit.brandKey,
        page_id: r.pageId,
        strategy: r.strategy,
        performance_score: r.performanceScore,
        accessibility_score: r.accessibilityScore,
        best_practices_score: r.bestPracticesScore,
        seo_score: r.seoScore,
        lcp_ms: r.lcpMs,
        cls: r.cls,
        inp_ms: r.inpMs,
        ttfb_ms: r.ttfbMs,
        error_message: r.errorMessage ?? null,
        payload_path: r.r2Key ?? null,
        payload_bytes: r.payloadSizeBytes ?? null,
        created_at: new Date().toISOString(),
      }));

      const { error } = await admin
        .from("site_audit_lighthouse")
        .upsert(records, { onConflict: "audit_id,page_id,strategy" });
      if (error) throw error;
    },

    async destroyScratch(auditId: string): Promise<void> {
      const { error } = await admin.rpc("site_audit_destroy_scratch", {
        p_audit_id: auditId,
      });
      if (error) throw error;
    },
  };
}

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/audit/AuditScratchpad.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import type {
  AuditStore,
  AuditRow,
  ClaimedUrl,
  FrontierStats,
  BrokenLinkRow,
} from "./store.ts";
import type { CrawlThrottleState } from "./crawlThrottle.ts";
import type { CrawledPageResult, LighthouseResult } from "./types.ts";
import type { DetectedIssue } from "./issues/pageReporters.ts";
import type { SlimPage } from "./issues/multipageChecks.ts";
import type { PageFetchClass } from "../../shared/audit-fetch-class.ts";
import { AUDIT_ISSUE_TYPES } from "../../shared/audit-issues.ts";
import { deterministicUuid } from "./ids.ts";

interface FrontierItem {
  auditId: string;
  url: string;
  depth: number | null;
  source: "link" | "sitemap";
  inSitemap: boolean;
  state: "pending" | "leased" | "crawled" | "abandoned";
  chunkNo: number | null;
  seq: number;
}

interface StoredPage {
  id: string;
  audit_id: string;
  brand_key: string;
  url: string;
  status_code: number;
  fetch_class: PageFetchClass;
  redirect_url: string | null;
  title: string | null;
  meta_description: string | null;
  canonical_url: string | null;
  header_canonical_url: string | null;
  robots_meta: string | null;
  x_robots_tag: string | null;
  og_title: string | null;
  og_description: string | null;
  og_image: string | null;
  h1_count: number;
  h2_count: number;
  h3_count: number;
  h4_count: number;
  h5_count: number;
  h6_count: number;
  word_count: number;
  content_hash: string | null;
  images_total: number;
  images_missing_alt: number;
  internal_link_count: number;
  external_link_count: number;
  has_structured_data: boolean;
  structured_data_types: string[];
  hreflang: any[];
  is_indexable: boolean;
  crawl_depth: number | null;
  in_sitemap: boolean;
  response_time_ms: number | null;
  rendered: boolean;
  crawled_at: string;
}

export interface MemoryAuditStore extends AuditStore {
  _audits: Map<string, AuditRow>;
  _frontier: Map<string, FrontierItem>;
  _links: Map<string, { auditId: string; pageId: string; url: string; targetUrls: string[] }>;
  _pages: Map<string, StoredPage>;
  _issues: Map<string, any>;
  _lighthouse: Map<string, any>;
  seedAudit(audit: AuditRow): void;
}

export function createMemoryAuditStore(opts?: { linkBudget?: number }): MemoryAuditStore {
  const linkBudget = opts?.linkBudget ?? 3_000_000;
  let seqCounter = 0;

  const audits = new Map<string, AuditRow>();
  const frontier = new Map<string, FrontierItem>();
  const links = new Map<string, { auditId: string; pageId: string; url: string; targetUrls: string[] }>();
  const pages = new Map<string, StoredPage>();
  const issues = new Map<string, any>();
  const lighthouse = new Map<string, any>();

  const frontierKey = (auditId: string, url: string) => `${auditId}::${url}`;

  return {
    _audits: audits,
    _frontier: frontier,
    _links: links,
    _pages: pages,
    _issues: issues,
    _lighthouse: lighthouse,

    seedAudit(audit: AuditRow) {
      audits.set(audit.id, { ...audit });
    },

    async getAudit(auditId: string): Promise<AuditRow | null> {
      const a = audits.get(auditId);
      return a ? { ...a } : null;
    },

    async updateAudit(auditId: string, jobId: string, patch: Partial<AuditRow>): Promise<void> {
      const a = audits.get(auditId);
      if (!a) return;
      if (a.job_id !== null && a.job_id !== jobId) {
        return;
      }
      Object.assign(a, patch);
    },

    async failAudit(auditId: string, info: { errorCode: string; errorDetail: string; failedPhase: string | null }): Promise<boolean> {
      const a = audits.get(auditId);
      if (!a) return false;
      if (a.status !== "queued" && a.status !== "running") {
        return false;
      }
      a.status = "failed";
      a.current_phase = "failed";
      a.error_code = info.errorCode;
      a.error_detail = info.errorDetail ? info.errorDetail.slice(0, 500) : null;
      a.failed_phase = info.failedPhase;
      a.completed_at = new Date().toISOString();
      return true;
    },

    async cancelAudit(auditId: string, info?: { errorDetail?: string | null; failedPhase?: string | null }): Promise<boolean> {
      const a = audits.get(auditId);
      if (!a) return false;
      if (a.status !== "queued" && a.status !== "running") {
        return false;
      }
      a.status = "cancelled";
      a.current_phase = "cancelled";
      a.error_code = "cancelled";
      a.error_detail = info?.errorDetail ? info.errorDetail.slice(0, 500) : null;
      a.failed_phase = info?.failedPhase ?? null;
      a.completed_at = new Date().toISOString();
      return true;
    },

    async seedStart(auditId: string, url: string): Promise<void> {
      const key = frontierKey(auditId, url);
      if (!frontier.has(key)) {
        frontier.set(key, {
          auditId,
          url,
          depth: 0,
          source: "link",
          inSitemap: false,
          state: "pending",
          chunkNo: null,
          seq: ++seqCounter,
        });
      }
    },

    async seedSitemap(auditId: string, urls: string[]): Promise<void> {
      for (const url of urls) {
        const key = frontierKey(auditId, url);
        const existing = frontier.get(key);
        if (existing) {
          existing.inSitemap = true;
        } else {
          frontier.set(key, {
            auditId,
            url,
            depth: null,
            source: "sitemap",
            inSitemap: true,
            state: "pending",
            chunkNo: null,
            seq: ++seqCounter,
          });
        }
      }
    },

    async claimChunk(auditId: string, chunkNo: number, limit: number): Promise<{ urls: ClaimedUrl[]; isRetry: boolean }> {
      const auditFrontier = Array.from(frontier.values()).filter((f) => f.auditId === auditId);

      const leased = auditFrontier.filter((f) => f.state === "leased" && f.chunkNo === chunkNo);
      if (leased.length > 0) {
        leased.sort((a, b) => {
          if (a.source !== b.source) return a.source === "link" ? -1 : 1;
          return a.seq - b.seq;
        });
        return {
          urls: leased.map((u) => ({
            url: u.url,
            depth: u.depth,
            inSitemap: u.inSitemap,
          })),
          isRetry: true,
        };
      }

      const crawledOrAbandoned = auditFrontier.some(
        (f) => f.chunkNo === chunkNo && (f.state === "crawled" || f.state === "abandoned")
      );
      if (crawledOrAbandoned) {
        return { urls: [], isRetry: true };
      }

      if (limit <= 0) {
        return { urls: [], isRetry: false };
      }

      const pending = auditFrontier.filter((f) => f.state === "pending");
      pending.sort((a, b) => {
        if (a.source !== b.source) return a.source === "link" ? -1 : 1;
        return a.seq - b.seq;
      });

      const picked = pending.slice(0, limit);
      for (const item of picked) {
        item.state = "leased";
        item.chunkNo = chunkNo;
      }

      return {
        urls: picked.map((u) => ({
          url: u.url,
          depth: u.depth,
          inSitemap: u.inSitemap,
        })),
        isRetry: false,
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
      for (const url of input.crawledUrls) {
        const item = frontier.get(frontierKey(auditId, url));
        if (item && (item.state === "leased" || item.state === "pending")) {
          item.state = "crawled";
        }
      }

      const audit = audits.get(auditId);
      let netDelta = 0;
      for (const link of input.links ?? []) {
        const key = `${auditId}::${link.pageId}`;
        const existing = links.get(key);
        const existingCount = existing ? existing.targetUrls.length : 0;
        netDelta += (link.targets?.length ?? 0) - existingCount;
      }
      if (audit) {
        if ((audit.link_targets_stored ?? 0) + netDelta <= linkBudget) {
          for (const link of input.links ?? []) {
            links.set(`${auditId}::${link.pageId}`, {
              auditId,
              pageId: link.pageId,
              url: link.url,
              targetUrls: [...link.targets],
            });
          }
          audit.link_targets_stored = (audit.link_targets_stored ?? 0) + netDelta;
        } else if (netDelta > 0) {
          audit.link_graph_complete = false;
        }
      }

      for (const d of input.discovered ?? []) {
        const key = frontierKey(auditId, d.url);
        const existing = frontier.get(key);
        if (!existing) {
          frontier.set(key, {
            auditId,
            url: d.url,
            depth: d.depth,
            source: "link",
            inSitemap: false,
            state: "pending",
            chunkNo: null,
            seq: ++seqCounter,
          });
        } else if (existing.state === "pending" && existing.depth === null && d.depth !== null) {
          existing.source = "link";
          existing.depth = d.depth;
        }
      }

      return this.stats(auditId);
    },

    async releaseUrls(auditId: string, urls: string[]): Promise<void> {
      for (const url of urls) {
        const item = frontier.get(frontierKey(auditId, url));
        if (item && item.state === "leased") {
          item.state = "pending";
          item.chunkNo = null;
        }
      }
    },

    async abandonChunk(auditId: string, chunkNo: number): Promise<number> {
      let count = 0;
      for (const item of frontier.values()) {
        if (item.auditId === auditId && item.chunkNo === chunkNo && item.state === "leased") {
          item.state = "abandoned";
          count++;
        }
      }
      const audit = audits.get(auditId);
      if (audit) {
        audit.pages_abandoned = (audit.pages_abandoned ?? 0) + count;
      }
      return count;
    },

    async stats(auditId: string): Promise<FrontierStats> {
      let attempted = 0;
      let pending = 0;
      let abandoned = 0;
      let seen = 0;

      for (const item of frontier.values()) {
        if (item.auditId === auditId) {
          seen++;
          if (item.state === "crawled") attempted++;
          else if (item.state === "pending") pending++;
          else if (item.state === "abandoned") abandoned++;
        }
      }

      return { attempted, pending, abandoned, seen };
    },

    async saveThrottle(auditId: string, state: CrawlThrottleState): Promise<void> {
      const a = audits.get(auditId);
      if (a) a.throttle_state = { ...state };
    },

    async upsertPages(audit: { id: string; brandKey: string }, crawledPages: CrawledPageResult[]): Promise<void> {
      for (const p of crawledPages) {
        const key = `${audit.id}::${p.id}`;
        pages.set(key, {
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
        });
      }
    },

    async insertIssues(audit: { id: string; brandKey: string }, issueList: DetectedIssue[]): Promise<void> {
      for (const issue of issueList) {
        const severity = AUDIT_ISSUE_TYPES[issue.issueType]?.severity ?? "info";
        const issueId = deterministicUuid(
          audit.id,
          issue.pageUrl,
          issue.issueType,
          issue.dedupeKey ?? ""
        );
        if (!issues.has(issueId)) {
          issues.set(issueId, {
            id: issueId,
            audit_id: audit.id,
            brand_key: audit.brandKey,
            page_id: issue.pageId ?? null,
            page_url: issue.pageUrl.slice(0, 2048),
            issue_type: issue.issueType,
            severity,
            details: issue.details ?? null,
            created_at: new Date().toISOString(),
          });
        }
      }
    },

    async listSlimPages(auditId: string, afterId: string | null, limit: number): Promise<SlimPage[]> {
      const auditPages = Array.from(pages.values()).filter((p) => p.audit_id === auditId);
      auditPages.sort((a, b) => a.id.localeCompare(b.id));

      let filtered = auditPages;
      if (afterId) {
        filtered = filtered.filter((p) => p.id > afterId);
      }

      return filtered.slice(0, limit).map((r) => ({
        id: r.id,
        url: r.url,
        statusCode: r.status_code,
        fetchClass: r.fetch_class,
        title: r.title,
        metaDescription: r.meta_description,
        contentHash: r.content_hash,
        redirectUrl: r.redirect_url,
        wordCount: r.word_count,
        isIndexable: r.is_indexable,
        canonicalUrl: r.canonical_url,
        headerCanonicalUrl: r.header_canonical_url,
        javascriptShell: r.rendered ? false : undefined,
        hreflang: r.hreflang ?? [],
      }));
    },

    async shellPageIds(auditId: string): Promise<Set<string>> {
      const ids = new Set<string>();
      for (const issue of issues.values()) {
        if (
          issue.audit_id === auditId &&
          issue.issue_type === "javascript-rendering-suspected" &&
          issue.page_id
        ) {
          ids.add(issue.page_id);
        }
      }
      return ids;
    },

    async brokenLinks(auditId: string, cap: number): Promise<BrokenLinkRow[]> {
      const auditLinks = Array.from(links.values()).filter((l) => l.auditId === auditId);
      const auditPages = Array.from(pages.values()).filter((p) => p.audit_id === auditId);
      const pageByUrl = new Map<string, StoredPage>();
      for (const p of auditPages) {
        pageByUrl.set(p.url, p);
      }

      const rows: BrokenLinkRow[] = [];
      for (const link of auditLinks) {
        for (const targetUrl of link.targetUrls) {
          const target = pageByUrl.get(targetUrl);
          if (target && target.status_code >= 400 && target.fetch_class === "ok") {
            rows.push({
              source_page_id: link.pageId,
              source_url: link.url,
              target_url: targetUrl,
              target_status: target.status_code,
            });
          }
        }
      }

      rows.sort((a, b) => {
        const idCmp = a.source_page_id.localeCompare(b.source_page_id);
        if (idCmp !== 0) return idCmp;
        return a.target_url.localeCompare(b.target_url);
      });

      return rows.slice(0, cap);
    },

    async orphanPages(auditId: string, startUrl: string): Promise<Array<{ pageId: string; url: string }>> {
      const auditPages = Array.from(pages.values()).filter((p) => p.audit_id === auditId);
      const auditLinks = Array.from(links.values()).filter((l) => l.auditId === auditId);

      const inbound = new Set<string>();
      for (const l of auditLinks) {
        for (const t of l.targetUrls) {
          if (t !== l.url) {
            inbound.add(t);
          }
        }
      }

      const redirectedUrls = new Set<string>();
      for (const p of auditPages) {
        if (p.redirect_url) {
          redirectedUrls.add(p.redirect_url);
        }
      }

      const orphans: Array<{ pageId: string; url: string }> = [];
      for (const p of auditPages) {
        if (
          p.url !== startUrl &&
          p.fetch_class === "ok" &&
          p.status_code >= 200 &&
          p.status_code < 300 &&
          !inbound.has(p.url) &&
          !redirectedUrls.has(p.url)
        ) {
          orphans.push({ pageId: p.id, url: p.url });
        }
      }

      orphans.sort((a, b) => a.pageId.localeCompare(b.pageId));
      return orphans;
    },

    async countPagesByFetchClass(auditId: string, fetchClass: PageFetchClass): Promise<number> {
      let count = 0;
      for (const p of pages.values()) {
        if (p.audit_id === auditId && p.fetch_class === fetchClass) {
          count++;
        }
      }
      return count;
    },

    async hasPages(auditId: string): Promise<boolean> {
      for (const p of pages.values()) {
        if (p.audit_id === auditId) return true;
      }
      return false;
    },

    async lighthouseCandidates(auditId: string): Promise<Array<{ id: string; url: string; statusCode: number; fetchClass: PageFetchClass }>> {
      const results: Array<{ id: string; url: string; statusCode: number; fetchClass: PageFetchClass }> = [];
      for (const p of pages.values()) {
        if (p.audit_id === auditId && p.fetch_class === "ok" && p.status_code >= 200 && p.status_code < 300) {
          results.push({
            id: p.id,
            url: p.url,
            statusCode: p.status_code,
            fetchClass: p.fetch_class,
          });
        }
      }
      results.sort((a, b) => a.id.localeCompare(b.id));
      return results;
    },

    async insertLighthouse(audit: { id: string; brandKey: string }, rows: LighthouseResult[]): Promise<void> {
      for (const r of rows) {
        const id = deterministicUuid(audit.id, r.pageId, r.strategy);
        lighthouse.set(id, {
          ...r,
          id,
          audit_id: audit.id,
          brand_key: audit.brandKey,
          page_id: r.pageId,
          strategy: r.strategy,
          created_at: new Date().toISOString(),
        });
      }
    },

    async destroyScratch(auditId: string): Promise<void> {
      for (const [key, item] of frontier.entries()) {
        if (item.auditId === auditId) {
          frontier.delete(key);
        }
      }
      for (const [key, link] of links.entries()) {
        if (link.auditId === auditId) {
          links.delete(key);
        }
      }
    },
  };
}

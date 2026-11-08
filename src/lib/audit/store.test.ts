// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/audit/AuditScratchpad.test.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createMemoryAuditStore } from "./memoryStore.ts";
import type { AuditRow } from "./store.ts";
import type { CrawledPageResult } from "./types.ts";

const AUDIT_ID = "11111111-1111-4111-8111-111111111111";
const BRAND_KEY = "test-brand";
const START = "https://site.test/";

function makeAudit(patch?: Partial<AuditRow>): AuditRow {
  return {
    id: AUDIT_ID,
    brand_key: BRAND_KEY,
    job_id: "22222222-2222-4222-8222-222222222222",
    status: "running",
    current_phase: "crawling",
    start_url: START,
    start_host: "site.test",
    max_pages: 100,
    run_lighthouse: false,
    render_javascript: false,
    site_platform: null,
    robots_status: "found",
    robots_txt: "User-agent: *\nAllow: /",
    window_hint: 2,
    throttle_state: null,
    render_hold_id: null,
    render_approved_usd: null,
    render_attempts: 0,
    render_billed: 0,
    render_settled_at: null,
    lighthouse_approved_usd: null,
    pages_crawled: 0,
    pages_total: 100,
    pages_abandoned: 0,
    link_graph_complete: true,
    cancel_requested_at: null,
    created_at: new Date().toISOString(),
    started_at: new Date().toISOString(),
    completed_at: null,
    ...patch,
  };
}

function makePage(id: string, url: string, patch?: Partial<CrawledPageResult>): CrawledPageResult {
  return {
    id,
    url,
    statusCode: patch?.statusCode ?? 200,
    fetchClass: patch?.fetchClass ?? "ok",
    redirectUrl: patch?.redirectUrl ?? null,
    title: "Test Page",
    metaDescription: "Description",
    canonicalUrl: null,
    robotsMeta: null,
    xRobotsTag: null,
    headerCanonicalUrl: null,
    ogTitle: null,
    ogDescription: null,
    ogImage: null,
    h1Count: 1,
    h2Count: 0,
    h3Count: 0,
    h4Count: 0,
    h5Count: 0,
    h6Count: 0,
    headingOrder: [1],
    wordCount: 200,
    contentHash: "hash123",
    isHtml: true,
    htmlBytes: 1024,
    rateLimited: false,
    imagesTotal: 1,
    imagesMissingAlt: 0,
    images: [],
    links: [],
    hasStructuredData: false,
    hreflangTags: [],
    hreflang: [],
    structuredData: {
      blocks: [],
      missingType: 0,
      missingRequired: [],
      claimsNotVisible: [],
    },
    structuredDataTypes: [],
    dataNosnippet: false,
    rendered: false,
    isIndexable: true,
    responseTimeMs: 100,
    crawlDepth: 1,
    inSitemap: false,
    ...patch,
  };
}

describe("AuditStore: broken internal links", () => {
  it("reports a crawled-and-failed target once, ignoring fine and uncrawled targets", async () => {
    const store = createMemoryAuditStore();
    store.seedAudit(makeAudit());

    await store.upsertPages({ id: AUDIT_ID, brandKey: BRAND_KEY }, [
      makePage("p1", START),
      makePage("p2", "https://site.test/gone", { statusCode: 404 }),
      makePage("p3", "https://site.test/ok"),
    ]);

    await store.recordBatch(AUDIT_ID, {
      crawledUrls: [START, "https://site.test/gone", "https://site.test/ok"],
      links: [
        {
          pageId: "p1",
          url: START,
          targets: [
            "https://site.test/gone",
            "https://site.test/ok",
            "https://site.test/never-crawled",
          ],
        },
      ],
      discovered: [],
    });

    const broken = await store.brokenLinks(AUDIT_ID, 2000);
    assert.deepEqual(broken, [
      {
        source_page_id: "p1",
        source_url: START,
        target_url: "https://site.test/gone",
        target_status: 404,
      },
    ]);
  });

  it("ignores WAF-blocked 4xx targets", async () => {
    const store = createMemoryAuditStore();
    store.seedAudit(makeAudit());

    await store.upsertPages({ id: AUDIT_ID, brandKey: BRAND_KEY }, [
      makePage("p1", START),
      makePage("p2", "https://site.test/waf", { statusCode: 403, fetchClass: "blocked" }),
    ]);

    await store.recordBatch(AUDIT_ID, {
      crawledUrls: [START, "https://site.test/waf"],
      links: [
        {
          pageId: "p1",
          url: START,
          targets: ["https://site.test/waf"],
        },
      ],
      discovered: [],
    });

    const broken = await store.brokenLinks(AUDIT_ID, 2000);
    assert.deepEqual(broken, []);
  });

  it("respects the row limit and orders deterministically", async () => {
    const store = createMemoryAuditStore();
    store.seedAudit(makeAudit());

    const pages = [makePage("p1", START)];
    const targets: string[] = [];
    for (let i = 0; i < 5; i++) {
      pages.push(makePage(`b${i}`, `https://site.test/gone-${i}`, { statusCode: 404 }));
      targets.push(`https://site.test/gone-${i}`);
    }
    await store.upsertPages({ id: AUDIT_ID, brandKey: BRAND_KEY }, pages);

    await store.recordBatch(AUDIT_ID, {
      crawledUrls: pages.map((p) => p.url),
      links: [{ pageId: "p1", url: START, targets }],
      discovered: [],
    });

    const broken = await store.brokenLinks(AUDIT_ID, 2);
    assert.equal(broken.length, 2);
    assert.deepEqual(
      broken.map((b) => b.target_url),
      ["https://site.test/gone-0", "https://site.test/gone-1"]
    );
  });
});

describe("AuditStore: orphan pages", () => {
  it("flags a 2xx page nothing links to, not the start URL or a linked page", async () => {
    const store = createMemoryAuditStore();
    store.seedAudit(makeAudit());

    await store.upsertPages({ id: AUDIT_ID, brandKey: BRAND_KEY }, [
      makePage("p1", START),
      makePage("p2", "https://site.test/lonely"),
      makePage("p3", "https://site.test/linked"),
    ]);

    await store.recordBatch(AUDIT_ID, {
      crawledUrls: [START, "https://site.test/lonely", "https://site.test/linked"],
      links: [{ pageId: "p1", url: START, targets: ["https://site.test/linked"] }],
      discovered: [],
    });

    const orphans = await store.orphanPages(AUDIT_ID, START);
    assert.deepEqual(orphans, [{ pageId: "p2", url: "https://site.test/lonely" }]);
  });

  it("does not rescue a page that only links to itself", async () => {
    const store = createMemoryAuditStore();
    store.seedAudit(makeAudit());

    await store.upsertPages({ id: AUDIT_ID, brandKey: BRAND_KEY }, [
      makePage("p1", START),
      makePage("p2", "https://site.test/lonely"),
    ]);

    await store.recordBatch(AUDIT_ID, {
      crawledUrls: [START, "https://site.test/lonely"],
      links: [
        {
          pageId: "p2",
          url: "https://site.test/lonely",
          targets: ["https://site.test/lonely"],
        },
      ],
      discovered: [],
    });

    const orphans = await store.orphanPages(AUDIT_ID, START);
    assert.deepEqual(orphans, [{ pageId: "p2", url: "https://site.test/lonely" }]);
  });

  it("does not flag a page something redirects to", async () => {
    const store = createMemoryAuditStore();
    store.seedAudit(makeAudit());

    await store.upsertPages({ id: AUDIT_ID, brandKey: BRAND_KEY }, [
      makePage("p1", START),
      makePage("p2", "https://site.test/target"),
      makePage("p3", "https://site.test/old", {
        statusCode: 301,
        redirectUrl: "https://site.test/target",
      }),
    ]);

    await store.recordBatch(AUDIT_ID, {
      crawledUrls: [START, "https://site.test/target", "https://site.test/old"],
      links: [],
      discovered: [],
    });

    const orphans = await store.orphanPages(AUDIT_ID, START);
    assert.deepEqual(orphans, []);
  });

  it("ignores non-2xx and blocked pages", async () => {
    const store = createMemoryAuditStore();
    store.seedAudit(makeAudit());

    await store.upsertPages({ id: AUDIT_ID, brandKey: BRAND_KEY }, [
      makePage("p1", START),
      makePage("p2", "https://site.test/gone", { statusCode: 404 }),
      makePage("p3", "https://site.test/waf", { statusCode: 200, fetchClass: "blocked" }),
    ]);

    await store.recordBatch(AUDIT_ID, {
      crawledUrls: [START, "https://site.test/gone", "https://site.test/waf"],
      links: [],
      discovered: [],
    });

    const orphans = await store.orphanPages(AUDIT_ID, START);
    assert.deepEqual(orphans, []);
  });
});

describe("AuditStore: frontier link discovery and claims", () => {
  it("gives a pending sitemap seed the link's depth and priority, keeping its sitemap flag", async () => {
    const store = createMemoryAuditStore();
    store.seedAudit(makeAudit());

    const url = "https://site.test/post";
    await store.seedSitemap(AUDIT_ID, [url]);

    let stats = await store.stats(AUDIT_ID);
    assert.equal(stats.pending, 1);
    assert.equal(stats.seen, 1);

    await store.recordBatch(AUDIT_ID, {
      crawledUrls: [],
      links: [],
      discovered: [{ url, depth: 2 }],
    });

    // Discovery link again with higher depth should not overwrite depth 2
    await store.recordBatch(AUDIT_ID, {
      crawledUrls: [],
      links: [],
      discovered: [{ url, depth: 3 }],
    });

    const claimed = await store.claimChunk(AUDIT_ID, 1, 10);
    assert.equal(claimed.urls.length, 1);
    assert.equal(claimed.urls[0].url, url);
    assert.equal(claimed.urls[0].depth, 2);
    assert.equal(claimed.urls[0].inSitemap, true);
  });

  it("claim idempotency: retrying returns the same leases", async () => {
    const store = createMemoryAuditStore();
    store.seedAudit(makeAudit());

    await store.seedStart(AUDIT_ID, START);
    await store.seedSitemap(AUDIT_ID, ["https://site.test/page1", "https://site.test/page2"]);

    const first = await store.claimChunk(AUDIT_ID, 1, 2);
    assert.equal(first.isRetry, false);
    assert.equal(first.urls.length, 2);
    assert.equal(first.urls[0].url, START); // 'link' sorts before 'sitemap'

    // Retry chunk 1 returns the same leases
    const retry = await store.claimChunk(AUDIT_ID, 1, 2);
    assert.equal(retry.isRetry, true);
    assert.deepEqual(retry.urls, first.urls);
  });

  it("claim idempotency: crawled or abandoned chunk number claims nothing", async () => {
    const store = createMemoryAuditStore();
    store.seedAudit(makeAudit());

    await store.seedStart(AUDIT_ID, START);
    const first = await store.claimChunk(AUDIT_ID, 1, 10);
    assert.equal(first.urls.length, 1);

    // Now crawl it
    await store.recordBatch(AUDIT_ID, {
      crawledUrls: [START],
      links: [],
      discovered: [],
    });

    // Retrying chunk 1 when it's crawled returns empty
    const retryCrawled = await store.claimChunk(AUDIT_ID, 1, 10);
    assert.equal(retryCrawled.isRetry, true);
    assert.deepEqual(retryCrawled.urls, []);

    // Also test abandoned chunk
    await store.seedSitemap(AUDIT_ID, ["https://site.test/p2"]);
    await store.claimChunk(AUDIT_ID, 2, 10);
    await store.abandonChunk(AUDIT_ID, 2);

    const retryAbandoned = await store.claimChunk(AUDIT_ID, 2, 10);
    assert.equal(retryAbandoned.isRetry, true);
    assert.deepEqual(retryAbandoned.urls, []);
  });

  it("claim with limit 0 returns empty non-retry", async () => {
    const store = createMemoryAuditStore();
    store.seedAudit(makeAudit());
    await store.seedStart(AUDIT_ID, START);

    const claimed = await store.claimChunk(AUDIT_ID, 1, 0);
    assert.equal(claimed.isRetry, false);
    assert.deepEqual(claimed.urls, []);
  });

  it("releaseUrls returns leased URLs to pending", async () => {
    const store = createMemoryAuditStore();
    store.seedAudit(makeAudit());
    await store.seedStart(AUDIT_ID, START);

    const claimed = await store.claimChunk(AUDIT_ID, 1, 10);
    assert.equal(claimed.urls.length, 1);

    let stats = await store.stats(AUDIT_ID);
    assert.equal(stats.pending, 0);

    await store.releaseUrls(AUDIT_ID, [START]);
    stats = await store.stats(AUDIT_ID);
    assert.equal(stats.pending, 1);

    // Can be claimed by chunk 2
    const chunk2 = await store.claimChunk(AUDIT_ID, 2, 10);
    assert.equal(chunk2.urls.length, 1);
    assert.equal(chunk2.urls[0].url, START);
  });

  it("abandonChunk marks leases abandoned and increments audit.pages_abandoned", async () => {
    const store = createMemoryAuditStore();
    store.seedAudit(makeAudit());
    await store.seedStart(AUDIT_ID, START);

    await store.claimChunk(AUDIT_ID, 1, 10);
    const count = await store.abandonChunk(AUDIT_ID, 1);
    assert.equal(count, 1);

    const audit = await store.getAudit(AUDIT_ID);
    assert.equal(audit?.pages_abandoned, 1);

    const stats = await store.stats(AUDIT_ID);
    assert.equal(stats.abandoned, 1);
    assert.equal(stats.pending, 0);
  });

  it("link budget sets link_graph_complete = false when exceeded", async () => {
    const store = createMemoryAuditStore({ linkBudget: 3 });
    store.seedAudit(makeAudit());

    // First batch with 2 links: fits within budget 3
    await store.recordBatch(AUDIT_ID, {
      crawledUrls: [],
      links: [{ pageId: "p1", url: "https://site.test/p1", targets: ["t1", "t2"] }],
      discovered: [],
    });

    let audit = await store.getAudit(AUDIT_ID);
    assert.equal(audit?.link_graph_complete, true);
    assert.equal(audit?.link_targets_stored, 2);

    // Second batch with 2 links: 2 + 2 = 4 > 3 -> trips budget
    await store.recordBatch(AUDIT_ID, {
      crawledUrls: [],
      links: [{ pageId: "p2", url: "https://site.test/p2", targets: ["t3", "t4"] }],
      discovered: [],
    });

    audit = await store.getAudit(AUDIT_ID);
    assert.equal(audit?.link_graph_complete, false);
    assert.equal(audit?.link_targets_stored, 2); // Not incremented when budget exceeded
  });
});

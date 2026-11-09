// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/workflows/SiteAuditWorkflow.test.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import test from "node:test";
import assert from "node:assert/strict";
import { setSiteAuditJobBindings, registerSiteAuditJob } from "./job.ts";
import { createMemoryAuditStore } from "./memoryStore.ts";
import { createMemoryJobStore } from "../jobs/memoryStore.ts";
import { runJob } from "../jobs/runner.ts";
import { AuditPhaseError } from "./errors.ts";
import type { AuditRow } from "./store.ts";
import type { SafeFetchResult } from "../http/safeFetch.ts";

function makeAudit(id: string, patch?: Partial<AuditRow>): AuditRow {
  const startUrl = patch?.start_url ?? "https://example.com/";
  return {
    id,
    brand_key: "qa-brand",
    job_id: null,
    status: "queued",
    current_phase: "queued",
    requested_url: patch?.requested_url ?? startUrl,
    start_url: startUrl,
    start_host: "example.com",
    max_pages: 10,
    run_lighthouse: false,
    render_javascript: false,
    site_platform: null,
    robots_status: null,
    robots_txt: null,
    window_hint: 2,
    throttle_state: null,
    render_hold_id: null,
    render_approved_usd: null,
    render_attempts: 0,
    render_billed: 0,
    render_settled_at: null,
    lighthouse_approved_usd: null,
    pages_crawled: 0,
    pages_total: 10,
    pages_abandoned: 0,
    link_graph_complete: true,
    cancel_requested_at: null,
    created_at: new Date().toISOString(),
    started_at: null,
    completed_at: null,
    ...patch,
  };
}

function mockResponse(url: string, status: number, body: string): SafeFetchResult {
  const enc = new TextEncoder().encode(body);
  return {
    url,
    status,
    headers: new Headers({ "content-type": url.endsWith(".txt") ? "text/plain" : "text/html" }),
    body: enc,
    truncated: false,
    text: () => body,
    json: <T>() => ({}) as unknown as T,
  };
}

test("job: site_audit.run executes steps 1-10 and completes successfully", async () => {
  const auditStore = createMemoryAuditStore();
  const jobStore = createMemoryJobStore();
  const auditId = "00000000-0000-4000-8000-000000000010";

  auditStore.seedAudit(makeAudit(auditId));

  const mockSafeFetch = async (targetUrl: string | URL): Promise<SafeFetchResult> => {
    const u = targetUrl.toString();
    if (u === "https://example.com/robots.txt") {
      return mockResponse(u, 200, "User-agent: *\nAllow: /");
    }
    if (u === "https://example.com/llms.txt") {
      return mockResponse(u, 200, "# Example Site\nWelcome to example");
    }
    if (u === "https://example.com/") {
      return mockResponse(
        u,
        200,
        `<!DOCTYPE html><html><head><title>Home Page</title></head><body><h1>Home</h1><a href="/about">About</a></body></html>`,
      );
    }
    if (u === "https://example.com/about") {
      return mockResponse(
        u,
        200,
        `<!DOCTYPE html><html><head><title>About Page</title></head><body><h1>About</h1><a href="/">Home</a></body></html>`,
      );
    }
    return mockResponse(u, 404, "Not Found");
  };

  setSiteAuditJobBindings(auditStore, null, {
    safeFetch: mockSafeFetch,
    lookup: async () => ["93.184.216.34"],
    initialIntervalMs: 0,
  });

  registerSiteAuditJob();

  const { jobId } = await jobStore.enqueue({
    kind: "site_audit.run",
    brandKey: "qa-brand",
    payload: { auditId },
    trigger: "manual",
    dedupeKey: null,
    singleActiveKey: null,
    runAt: null,
    createdBy: null,
    deadlineSeconds: 3600,
    maxInvocations: 10,
  });

  const claimed = await jobStore.claimDue("worker:1", 1, 300, jobId);
  assert.equal(claimed.length, 1);

  const outcome = await runJob(claimed[0], {
    store: jobStore,
    owner: "worker:1",
    deadlineMs: Date.now() + 3_600_000,
    now: () => Date.now(),
    selfContinue: () => {},
  });

  assert.equal(outcome, "completed");

  const finalAudit = await auditStore.getAudit(auditId);
  assert.ok(finalAudit);
  assert.equal(finalAudit.status, "completed");
  assert.equal(finalAudit.current_phase, "completed");
  assert.equal(finalAudit.job_id, jobId);
  assert.ok(finalAudit.pages_crawled >= 2);
  assert.ok(finalAudit.completed_at !== null);

  const finishedJob = await jobStore.getJob(jobId!);
  assert.equal((finishedJob?.result as any)?.pagesCrawled, finalAudit.pages_crawled);
  assert.ok((finishedJob?.result as any)?.pagesCrawled >= 2);

  // Scratchpad is cleaned up
  const stats = await auditStore.stats(auditId);
  assert.equal(stats.pending, 0);
  assert.equal(stats.attempted, 0);
});

test("job: AuditPhaseError in step triggers mark-failed and sets failed status", async () => {
  const auditStore = createMemoryAuditStore();
  const jobStore = createMemoryJobStore();
  const auditId = "00000000-0000-4000-8000-000000000011";

  // Start URL redirects to external host (start_url_off_site)
  auditStore.seedAudit(
    makeAudit(auditId, {
      start_url: "https://example.com/redirect-away",
    }),
  );

  const mockSafeFetch = async (targetUrl: string | URL): Promise<SafeFetchResult> => {
    const u = targetUrl.toString();
    if (u === "https://example.com/redirect-away") {
      const headers = new Headers({ location: "https://other-site.com/" });
      return {
        url: u,
        status: 301,
        headers,
        body: new Uint8Array(),
        truncated: false,
        text: () => "",
        json: <T>() => ({}) as unknown as T,
      };
    }
    return mockResponse(u, 200, "OK");
  };

  setSiteAuditJobBindings(auditStore, null, {
    safeFetch: mockSafeFetch,
    lookup: async () => ["93.184.216.34"],
    initialIntervalMs: 0,
  });

  registerSiteAuditJob();

  const { jobId } = await jobStore.enqueue({
    kind: "site_audit.run",
    brandKey: "qa-brand",
    payload: { auditId },
    trigger: "manual",
    dedupeKey: null,
    singleActiveKey: null,
    runAt: null,
    createdBy: null,
    deadlineSeconds: 3600,
    maxInvocations: 10,
  });

  const claimed = await jobStore.claimDue("worker:1", 1, 300, jobId);
  const outcome = await runJob(claimed[0], {
    store: jobStore,
    owner: "worker:1",
    deadlineMs: Date.now() + 3_600_000,
    now: () => Date.now(),
    selfContinue: () => {},
  });

  assert.equal(outcome, "failed");

  const finalAudit = await auditStore.getAudit(auditId);
  assert.ok(finalAudit);
  assert.equal(finalAudit.status, "failed");
  assert.equal(finalAudit.error_code, "start_url_off_site");
  assert.equal(finalAudit.failed_phase, "starting");
});

test("job: already terminal audit returns early with terminal job status and does not touch audit row", async () => {
  const auditStore = createMemoryAuditStore();
  const jobStore = createMemoryJobStore();
  const auditId = "00000000-0000-4000-8000-000000000012";

  const originalCreatedAt = new Date(Date.now() - 60_000).toISOString();
  auditStore.seedAudit(
    makeAudit(auditId, {
      status: "cancelled",
      current_phase: "cancelled",
      created_at: originalCreatedAt,
      pages_crawled: 0,
    }),
  );

  let fetchCalled = false;
  setSiteAuditJobBindings(auditStore, null, {
    safeFetch: async () => {
      fetchCalled = true;
      return mockResponse("https://example.com/", 200, "OK");
    },
    lookup: async () => ["93.184.216.34"],
    initialIntervalMs: 0,
  });

  registerSiteAuditJob();

  const { jobId } = await jobStore.enqueue({
    kind: "site_audit.run",
    brandKey: "qa-brand",
    payload: { auditId },
    trigger: "manual",
    dedupeKey: null,
    singleActiveKey: null,
    runAt: null,
    createdBy: null,
    deadlineSeconds: 3600,
    maxInvocations: 10,
  });

  const claimed = await jobStore.claimDue("worker:1", 1, 300, jobId);
  const outcome = await runJob(claimed[0], {
    store: jobStore,
    owner: "worker:1",
    deadlineMs: Date.now() + 3_600_000,
    now: () => Date.now(),
    selfContinue: () => {},
  });

  assert.equal(outcome, "cancelled");
  assert.equal(fetchCalled, false, "crawl must not run for terminal audit");

  const auditAfter = await auditStore.getAudit(auditId);
  assert.equal(auditAfter?.status, "cancelled");
  assert.equal(auditAfter?.job_id, null, "audit row must not be touched");
});

test("job: validate step claims job_id when audit is already running but job_id is null", async () => {
  const auditStore = createMemoryAuditStore();
  const jobStore = createMemoryJobStore();
  const auditId = "00000000-0000-4000-8000-000000000013";

  auditStore.seedAudit(
    makeAudit(auditId, {
      status: "running",
      job_id: null,
    }),
  );

  setSiteAuditJobBindings(auditStore, null, {
    safeFetch: async (u: string | URL) => mockResponse(u.toString(), 200, "<!DOCTYPE html><html><head><title>T</title></head><body>OK</body></html>"),
    lookup: async () => ["93.184.216.34"],
    initialIntervalMs: 0,
  });

  registerSiteAuditJob();

  const { jobId } = await jobStore.enqueue({
    kind: "site_audit.run",
    brandKey: "qa-brand",
    payload: { auditId },
    trigger: "manual",
    dedupeKey: null,
    singleActiveKey: null,
    runAt: null,
    createdBy: null,
    deadlineSeconds: 3600,
    maxInvocations: 10,
  });

  const claimed = await jobStore.claimDue("worker:1", 1, 300, jobId);
  const outcome = await runJob(claimed[0], {
    store: jobStore,
    owner: "worker:1",
    deadlineMs: Date.now() + 3_600_000,
    now: () => Date.now(),
    selfContinue: () => {},
  });

  assert.equal(outcome, "completed");
  const finalAudit = await auditStore.getAudit(auditId);
  assert.equal(finalAudit?.job_id, jobId);
});

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/audit/services/auditReconciler.test.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import test from "node:test";
import assert from "node:assert/strict";
import { reconcileRunningAudit } from "./reconcile.ts";
import { createMemoryAuditStore } from "./memoryStore.ts";
import { AppError } from "../http/errors.ts";
import type { AuditRow } from "./store.ts";

function makeAudit(id: string, patch?: Partial<AuditRow>): AuditRow {
  const startUrl = patch?.start_url ?? "https://example.com/";
  return {
    id,
    brand_key: "qa-brand",
    job_id: "job-1",
    status: "running",
    current_phase: "crawling",
    requested_url: patch?.requested_url ?? startUrl,
    start_url: startUrl,
    start_host: "example.com",
    max_pages: 50,
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
    pages_crawled: 5,
    pages_total: 50,
    pages_abandoned: 0,
    link_graph_complete: true,
    cancel_requested_at: null,
    created_at: new Date(Date.now() - 20 * 60_000).toISOString(), // 20 mins ago
    started_at: new Date(Date.now() - 19 * 60_000).toISOString(),
    completed_at: null,
    ...patch,
  };
}

test("reconcile: completed or failed audit is never flipped (AC-20)", async () => {
  const store = createMemoryAuditStore();
  const auditId = "00000000-0000-4000-8000-000000000020";
  const audit = makeAudit(auditId, { status: "completed", current_phase: "completed" });
  store.seedAudit(audit);

  const res = await reconcileRunningAudit(audit, {
    store,
    getJobStatus: async () => {
      throw new Error("Should not be called");
    },
  });

  assert.equal(res.flipped, false);
  const fresh = await store.getAudit(auditId);
  assert.equal(fresh?.status, "completed");
});

test("reconcile: flips running audit to failed when job failed", async () => {
  const store = createMemoryAuditStore();
  const auditId = "00000000-0000-4000-8000-000000000021";
  const audit = makeAudit(auditId, { status: "running" });
  store.seedAudit(audit);

  const res = await reconcileRunningAudit(audit, {
    store,
    getJobStatus: async () => ({
      status: "failed",
      error: { code: "step_timeout", message: "Step exceeded timeout" },
      progress: null,
      pollAfterSeconds: null,
      result: null,
    }),
  });

  assert.equal(res.flipped, true);
  assert.equal(res.newStatus, "failed");

  const fresh = await store.getAudit(auditId);
  assert.equal(fresh?.status, "failed");
  assert.equal(fresh?.error_code, "step_timeout");
});

test("reconcile: flips running audit to cancelled when job was cancelled", async () => {
  const store = createMemoryAuditStore();
  const auditId = "00000000-0000-4000-8000-000000000022";
  const audit = makeAudit(auditId, { status: "running" });
  store.seedAudit(audit);

  const res = await reconcileRunningAudit(audit, {
    store,
    getJobStatus: async () => ({
      status: "cancelled",
      error: { code: "cancelled", message: "Job cancelled by user" },
      progress: null,
      pollAfterSeconds: null,
      result: null,
    }),
  });

  assert.equal(res.flipped, true);
  assert.equal(res.newStatus, "cancelled");

  const fresh = await store.getAudit(auditId);
  assert.equal(fresh?.status, "cancelled");
  assert.equal(fresh?.error_code, "cancelled");
});

test("reconcile: flips to job_lost when job row missing and older than 10 minutes", async () => {
  const store = createMemoryAuditStore();
  const auditId = "00000000-0000-4000-8000-000000000023";
  const audit = makeAudit(auditId, {
    status: "running",
    created_at: new Date(Date.now() - 15 * 60_000).toISOString(),
  });
  store.seedAudit(audit);

  const res = await reconcileRunningAudit(audit, {
    store,
    getJobStatus: async () => {
      throw new AppError(404, "job_not_found", "Not found");
    },
  });

  assert.equal(res.flipped, true);
  assert.equal(res.newStatus, "failed");

  const fresh = await store.getAudit(auditId);
  assert.equal(fresh?.status, "failed");
  assert.equal(fresh?.error_code, "job_lost");
});

test("reconcile: does not flip on transient read errors", async () => {
  const store = createMemoryAuditStore();
  const auditId = "00000000-0000-4000-8000-000000000024";
  const audit = makeAudit(auditId, { status: "running" });
  store.seedAudit(audit);

  const res = await reconcileRunningAudit(audit, {
    store,
    getJobStatus: async () => {
      throw new Error("Temporary network glitch");
    },
  });

  assert.equal(res.flipped, false);
  const fresh = await store.getAudit(auditId);
  assert.equal(fresh?.status, "running");
});

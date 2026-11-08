// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/workflows/SiteAuditWorkflow.test.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import test from "node:test";
import assert from "node:assert/strict";
import { setSiteAuditRetentionAdmin, registerSiteAuditRetentionJobs } from "./retention.ts";
import { createMemoryJobStore } from "../jobs/memoryStore.ts";
import { runJob } from "../jobs/runner.ts";

test("retention: calls prune_site_audits and removes storage objects", async () => {
  const jobStore = createMemoryJobStore();
  const deletedStoragePaths: string[] = [];

  const mockAdmin: any = {
    rpc: async (fn: string, params: any) => {
      if (fn === "prune_site_audits") {
        return {
          data: [
            { audit_id: "00000000-0000-4000-8000-000000000030", brand_key: "brand-a" },
            { audit_id: "00000000-0000-4000-8000-000000000031", brand_key: "brand-b" },
          ],
          error: null,
        };
      }
      return { data: [], error: null };
    },
    storage: {
      from: (bucket: string) => ({
        list: async (prefix: string) => ({
          data: [{ name: "report-mobile.json" }, { name: "report-desktop.json" }],
          error: null,
        }),
        remove: async (paths: string[]) => {
          deletedStoragePaths.push(...paths);
          return { data: paths, error: null };
        },
      }),
    },
  };

  setSiteAuditRetentionAdmin(mockAdmin);
  registerSiteAuditRetentionJobs({ admin: mockAdmin });

  const { jobId } = await jobStore.enqueue({
    kind: "site_audit.retention",
    brandKey: null,
    payload: {},
    trigger: "system",
    dedupeKey: "site_audit.retention:test",
    singleActiveKey: null,
    runAt: null,
    createdBy: null,
    deadlineSeconds: 1800,
    maxInvocations: 10,
  });

  const claimed = await jobStore.claimDue("worker:1", 1, 300, jobId);
  assert.equal(claimed.length, 1);

  const outcome = await runJob(claimed[0], {
    store: jobStore,
    owner: "worker:1",
    deadlineMs: Date.now() + 600_000,
    now: () => Date.now(),
    selfContinue: () => {},
  });

  assert.equal(outcome, "completed");
  assert.equal(deletedStoragePaths.length, 4);
  assert.ok(deletedStoragePaths.includes("brand-a/00000000-0000-4000-8000-000000000030/report-mobile.json"));
});

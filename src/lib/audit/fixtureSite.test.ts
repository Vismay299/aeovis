// Fixture-site end-to-end integration test (F18 P2.T4 / F18-AC-11).
// Runs site_audit.run against tests/fixtures/site-audit virtual hosts.

import test from "node:test";
import assert from "node:assert/strict";
import { AUDIT_ISSUE_TYPES, type AuditIssueType } from "../../shared/audit-issues.ts";
import { FIXTURES } from "../../../tests/fixtures/site-audit/registry.ts";
import { SITES } from "../../../tests/fixtures/site-audit/sites.ts";
import { startFixtureServer } from "../../../tests/fixtures/site-audit/server.ts";
import { fixtureFetch, fixtureLookup } from "../../../tests/fixtures/site-audit/fixtureFetch.ts";
import { setSiteAuditJobBindings, registerSiteAuditJob } from "./job.ts";
import { createMemoryAuditStore, type MemoryAuditStore } from "./memoryStore.ts";
import { createMemoryJobStore } from "../jobs/memoryStore.ts";
import { runJob } from "../jobs/runner.ts";
import { safeFetch } from "../http/safeFetch.ts";
import type { AuditRow } from "./store.ts";

function makeAudit(id: string, startUrl: string, startHost: string, patch?: Partial<AuditRow>): AuditRow {
  return {
    id,
    brand_key: "fixture-brand",
    job_id: null,
    status: "queued",
    current_phase: "queued",
    start_url: startUrl,
    start_host: startHost,
    max_pages: 200,
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
    pages_total: 200,
    pages_abandoned: 0,
    link_graph_complete: true,
    cancel_requested_at: null,
    created_at: new Date().toISOString(),
    started_at: null,
    completed_at: null,
    ...patch,
  };
}

test("fixtureSite: runs site_audit.run across all fixture sites and covers 100% of registry issue types", async () => {
  const server = await startFixtureServer();
  registerSiteAuditJob();

  const observedIssueTypes = new Set<AuditIssueType>();

  try {
    const customSafeFetch = async (targetUrl: string | URL, init?: any) => {
      return safeFetch(targetUrl.toString(), init, {
        lookup: fixtureLookup,
        fetchImpl: fixtureFetch(server.origin),
      });
    };

    const siteList = Object.values(SITES);
    const SITE_UUIDS: Record<string, string> = {
      main: "00000000-0000-4000-a000-000000000001",
      llmsbad: "00000000-0000-4000-a000-000000000002",
      robots500: "00000000-0000-4000-a000-000000000003",
      robotshtml: "00000000-0000-4000-a000-000000000004",
      closed: "00000000-0000-4000-a000-000000000005",
      throttled: "00000000-0000-4000-a000-000000000006",
    };

    for (const site of siteList) {
      const auditStore = createMemoryAuditStore();
      const jobStore = createMemoryJobStore();

      setSiteAuditJobBindings(auditStore, null, {
        safeFetch: customSafeFetch,
        lookup: fixtureLookup,
        initialIntervalMs: 0,
      });

      const auditId = SITE_UUIDS[site.id] ?? `00000000-0000-4000-a000-000000000099`;
      const startUrl =
        site.id === "throttled"
          ? `http://${site.host}/status/429`
          : `http://${site.host}/`;
      const startHost = site.host;

      auditStore.seedAudit(makeAudit(auditId, startUrl, startHost));

      const { jobId } = await jobStore.enqueue({
        kind: "site_audit.run",
        brandKey: "fixture-brand",
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
      assert.equal(claimed.length, 1, `Failed to claim job for site ${site.id}`);

      const outcome = await runJob(claimed[0], {
        store: jobStore,
        owner: "worker:1",
        deadlineMs: Date.now() + 600_000,
        now: () => Date.now(),
        selfContinue: () => {},
      });

      // Sites complete or partial (throttled stops early and marks partial)
      if (outcome !== "completed" && outcome !== "partial") {
        const fa = await auditStore.getAudit(auditId);
        const jb = jobId ? await jobStore.getJob(jobId) : null;
        console.log("FAILED SITE:", site.id, "error_code:", fa?.error_code, "error_detail:", fa?.error_detail, "job_error:", jb?.error_code, jb?.error_message);
      }
      assert.ok(
        outcome === "completed" || outcome === "partial",
        `Site ${site.id} job finished with unexpected outcome ${outcome}`,
      );

      const finalAudit = await auditStore.getAudit(auditId);
      assert.ok(finalAudit, `Audit row missing for ${site.id}`);
      assert.ok(
        finalAudit.status === "completed" || finalAudit.status === "partial",
        `Audit status for ${site.id} was ${finalAudit.status}`,
      );

      // Collect issues from auditStore
      const auditIssues = Array.from(auditStore._issues.values()).filter(
        (iss) => iss.audit_id === auditId,
      );

      // 1. Check site-level issues
      const siteIssues = auditIssues
        .filter((iss) => iss.page_id === null)
        .map((iss) => iss.issue_type as AuditIssueType);
      const siteIssueSet = new Set(siteIssues);


      for (const expected of site.expectedSiteIssues) {
        assert.ok(
          siteIssueSet.has(expected),
          `Site ${site.id} missing expected site issue: ${expected}. Observed: [${siteIssues.join(", ")}]`,
        );
        observedIssueTypes.add(expected);
      }
      assert.equal(
        siteIssueSet.size,
        site.expectedSiteIssues.length,
        `Site ${site.id} had unexpected extra site issues. Expected [${site.expectedSiteIssues.join(", ")}], got [${siteIssues.join(", ")}]`,
      );

      // 2. Check page-level issues
      const pageIssuesByPath = new Map<string, Set<AuditIssueType>>();
      for (const iss of auditIssues) {
        if (iss.page_id !== null) {
          observedIssueTypes.add(iss.issue_type as AuditIssueType);
          let path: string;
          try {
            path = new URL(iss.page_url).pathname;
          } catch {
            path = iss.page_url;
          }
          if (!pageIssuesByPath.has(path)) {
            pageIssuesByPath.set(path, new Set());
          }
          pageIssuesByPath.get(path)!.add(iss.issue_type as AuditIssueType);
        }
      }

      // Check fixtures for this site
      const siteFixtures = FIXTURES.filter((f) => (f.site ?? "main") === site.id);
      for (const fixture of siteFixtures) {
        const observed = pageIssuesByPath.get(fixture.path) ?? new Set<AuditIssueType>();
        const expectedSet = new Set(fixture.expectedIssues);

        for (const exp of fixture.expectedIssues) {
          assert.ok(
            observed.has(exp),
            `Fixture ${fixture.path} on site ${site.id} missing expected issue: ${exp}. Observed: [${Array.from(observed).join(", ")}]`,
          );
        }

        assert.equal(
          observed.size,
          expectedSet.size,
          `Fixture ${fixture.path} on site ${site.id} had unexpected issues. Expected [${fixture.expectedIssues.join(", ")}], got [${Array.from(observed).join(", ")}]`,
        );
      }

      // 3. Check healthy pages are clean (0 issues)
      const healthyPaths = ["/", "/catalog"];
      for (const hPath of healthyPaths) {
        const healthyObserved = pageIssuesByPath.get(hPath);
        if (healthyObserved && healthyObserved.size > 0) {
          assert.fail(
            `Healthy page ${hPath} on site ${site.id} had unexpected issues: [${Array.from(healthyObserved).join(", ")}]`,
          );
        }
      }
    }

    // 4. Final assertion: 100% of registry issue types observed across all sites
    const allRegistryTypes = Object.keys(AUDIT_ISSUE_TYPES) as AuditIssueType[];
    const missingTypes = allRegistryTypes.filter((t) => !observedIssueTypes.has(t));

    assert.equal(
      missingTypes.length,
      0,
      `Registry issue types never observed across fixture runs: ${missingTypes.join(", ")}`,
    );
    assert.equal(
      observedIssueTypes.size,
      allRegistryTypes.length,
      `Expected ${allRegistryTypes.length} observed issue types, got ${observedIssueTypes.size}`,
    );
  } finally {
    await server.close();
  }
});

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/workflows/SiteAuditWorkflow.ts
//   src/server/workflows/auditStepConfigs.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { z } from "zod";
import "./reconcile.ts";
import "./retention.ts";
import { defineJob, getJobDefinition } from "../jobs/registry.ts";
import { DB_STEP } from "../jobs/stepConfigs.ts";
import { StepFailedError } from "../jobs/runner.ts";
import { AppError } from "../http/errors.ts";
import { getSupabaseAdmin } from "../supabase/admin.js";
import { createSqlAuditStore, type AuditStore, type AuditRow } from "./store.ts";
import { AuditPhaseError, classifyAuditFailure } from "./errors.ts";
import { captureAuditEvent } from "./telemetry.ts";
import {
  resolveAuditStart,
  runDiscoveryPhase,
  runSiteChecks,
  runLighthousePhase,
  finalizeAudit,
  type PhaseDeps,
} from "./phases.ts";
import { runCrawlPhase, type CrawlDeps } from "./crawlPhase.ts";
import { runMultipageChecks } from "./issues/multipage.ts";
import type { DetectedIssue } from "./issues/pageReporters.ts";

export interface JobDeps extends PhaseDeps, CrawlDeps {
  store?: AuditStore;
  admin?: any;
}

let boundStore: AuditStore | null = null;
let boundAdmin: any = null;
let boundDeps: JobDeps | null = null;

/**
 * Configure audit job bindings (used in tests with in-memory stores and runners).
 */
export function setSiteAuditJobBindings(
  store: AuditStore | null,
  admin?: any,
  deps?: JobDeps,
): void {
  boundStore = store;
  boundAdmin = admin ?? null;
  boundDeps = deps ?? null;
}

export function getActiveAuditStore(): AuditStore {
  if (boundStore) return boundStore;
  const admin = boundAdmin ?? getSupabaseAdmin();
  return createSqlAuditStore(admin);
}

export const AUDIT_STEPS = {
  validate: DB_STEP,
  resolveStart: { timeoutMs: 90_000, retries: 2 },
  discover: { timeoutMs: 200_000, retries: 1 },
  siteChecks: { timeoutMs: 60_000, retries: 2 },
  multipageChecks: { timeoutMs: 200_000, retries: 2 },
  finalize: DB_STEP,
  settleRender: { timeoutMs: 60_000, retries: 0 },
  cleanup: DB_STEP,
  markFailed: DB_STEP,
} as const;

export const siteAuditPayloadSchema = z.strictObject({
  auditId: z.string().uuid(),
});

export function registerSiteAuditJob(): void {
  if (getJobDefinition("site_audit.run")) return;

  defineJob(
    "site_audit.run",
    async (ctx) => {
      const store = getActiveAuditStore();
      const admin = boundAdmin ?? (typeof getSupabaseAdmin === "function" ? getSupabaseAdmin() : null);
      const deps: JobDeps = boundDeps ?? {};
      const { auditId } = ctx.payload as { auditId: string };

      let currentPhase = "queued";

      // 1. validate (DB_STEP)
      const audit = await ctx.step.do("validate", AUDIT_STEPS.validate, async () => {
        const row = await store.getAudit(auditId);
        if (!row) {
          throw new AuditPhaseError("job_lost", "starting", `Audit ${auditId} not found`);
        }
        const isTerminal = ["completed", "partial", "failed", "cancelled"].includes(row.status);
        if (isTerminal) {
          return row;
        }

        const claimPatch: Partial<AuditRow> = {};
        if (row.job_id === null) {
          claimPatch.job_id = ctx.jobId;
        }
        if (row.status === "queued") {
          claimPatch.status = "running";
          claimPatch.current_phase = "starting";
          claimPatch.started_at = new Date().toISOString();
        }

        if (Object.keys(claimPatch).length > 0) {
          await store.updateAudit(auditId, ctx.jobId, claimPatch);
        }
        return { ...row, ...claimPatch };
      });

      if (["completed", "partial", "failed", "cancelled"].includes(audit.status)) {
        // The audit already ended (e.g. cancelled before this job ran): nothing to do. The job itself
        // completed normally; the audit's own status is reported in the result.
        return {
          status: "completed",
          result: {
            status: audit.status,
            skipped: true,
            pagesCrawled: audit.pages_crawled ?? 0,
          },
        };
      }

      currentPhase = "starting";

      try {
        // 2. resolve-start
        const resolved = await ctx.step.do("resolve-start", AUDIT_STEPS.resolveStart, async () => {
          const fresh = (await store.getAudit(auditId)) ?? audit;
          const res = await resolveAuditStart(fresh, deps);
          const finalHost = new URL(res.startUrl).hostname.toLowerCase();
          await store.updateAudit(auditId, ctx.jobId, {
            start_url: res.startUrl,
            start_host: finalHost,
            site_platform: res.sitePlatform,
          });
          return res;
        });

        // 3. discover
        currentPhase = "discovery";
        await ctx.step.do("discover", AUDIT_STEPS.discover, async () => {
          const fresh = (await store.getAudit(auditId)) ?? audit;
          return runDiscoveryPhase(fresh, resolved.origin, store, ctx.jobId, deps);
        });

        // 4. site-checks
        const siteChecksRes = await ctx.step.do("site-checks", AUDIT_STEPS.siteChecks, async () => {
          const fresh = (await store.getAudit(auditId)) ?? audit;
          return runSiteChecks(fresh, store, ctx.jobId, deps);
        });

        // 5. crawl phase
        currentPhase = "crawling";
        const freshForCrawl = await ctx.step.do("crawl-audit-read", DB_STEP, async () => {
          return (await store.getAudit(auditId)) ?? audit;
        });
        const crawlOutcome = await runCrawlPhase(ctx, {
          audit: freshForCrawl,
          store,
          admin,
          deps,
        });

        // 6. lighthouse (if requested)
        if (freshForCrawl.run_lighthouse) {
          currentPhase = "lighthouse";
          await ctx.step.do("lighthouse-select", DB_STEP, async () => {
            const fresh = (await store.getAudit(auditId)) ?? audit;
            return runLighthousePhase(fresh, store, ctx.jobId);
          });
        }

        // 7. multipage-checks
        currentPhase = "finalizing";
        await ctx.step.do("multipage-checks", AUDIT_STEPS.multipageChecks, async () => {
          const fresh = (await store.getAudit(auditId)) ?? audit;
          if (fresh.pages_crawled > 0 && !(await store.hasPages(auditId))) {
            throw new AuditPhaseError("db_error", "finalizing", "Pages were recorded but none were stored");
          }

          const { issues: multiIssues, hasUnreadShells } = await runMultipageChecks({
            auditId,
            store,
          });

          const brokenRows = await store.brokenLinks(auditId, 2000);
          const brokenIssues: DetectedIssue[] = brokenRows.map((b) => ({
            issueType: "broken-internal-link",
            pageId: b.source_page_id,
            pageUrl: b.source_url,
            dedupeKey: b.target_url,
            details: { targetUrl: b.target_url, targetStatus: b.target_status },
          }));

          const orphanRows =
            crawlOutcome.crawlCompleted &&
            fresh.link_graph_complete &&
            (!fresh.render_javascript || !hasUnreadShells)
              ? await store.orphanPages(auditId, fresh.start_url)
              : [];
          const orphanIssues: DetectedIssue[] = orphanRows.map((o) => ({
            issueType: "orphan-page",
            pageId: o.pageId,
            pageUrl: o.url,
          }));

          const allIssues = [...multiIssues, ...brokenIssues, ...orphanIssues];
          if (crawlOutcome.rateLimited) {
            allIssues.push({
              issueType: "crawl-rate-limited",
              pageId: null,
              pageUrl: fresh.start_url,
              dedupeKey: "site",
            });
          }

          if (allIssues.length > 0) {
            await store.insertIssues({ id: fresh.id, brandKey: fresh.brand_key }, allIssues);
          }

          return { issueCount: allIssues.length };
        });

        // 8. finalize
        const finalStatus = await ctx.step.do("finalize", AUDIT_STEPS.finalize, async () => {
          const fresh = (await store.getAudit(auditId)) ?? audit;
          return finalizeAudit(fresh, crawlOutcome, store, ctx.jobId);
        });

        // 9. settle-render
        if (freshForCrawl.render_hold_id) {
          await ctx.step.do("settle-render", AUDIT_STEPS.settleRender, async () => {
            return { settled: false };
          });
        }

        // 10. cleanup
        await ctx.step.do("cleanup", AUDIT_STEPS.cleanup, async () => {
          await store.destroyScratch(auditId);
          return { cleaned: true };
        });

        return {
          status: finalStatus.status === "completed" ? "completed" : "partial",
          result: {
            status: finalStatus.status,
            pagesCrawled: crawlOutcome.attempted,
          },
        };
      } catch (err: unknown) {
        if (err instanceof StepFailedError || err instanceof AuditPhaseError) {
          const classification = classifyAuditFailure(err);
          const failedPhase =
            err instanceof AuditPhaseError
              ? err.phase
              : (err instanceof StepFailedError &&
                  err.message.match(/Audit failed in phase ([^:]+):/i)?.[1]) ||
                currentPhase;

          await ctx.step.do("mark-failed", AUDIT_STEPS.markFailed, async () => {
            await store.failAudit(auditId, {
              errorCode: classification.errorCode,
              errorDetail: classification.errorDetail,
              failedPhase,
            });
            const fresh = await store.getAudit(auditId);
            await captureAuditEvent("site_audit:complete", {
              status: "failed",
              pages_crawled: fresh?.pages_crawled ?? 0,
              pages_total: fresh?.pages_total ?? 0,
              crawl_completed: false,
              pages_blocked: 0,
              pages_rate_limited: 0,
              pages_abandoned: fresh?.pages_abandoned ?? 0,
              lighthouse: fresh?.run_lighthouse ?? false,
              render_js: fresh?.render_javascript ?? false,
              error_code: classification.errorCode,
              failed_phase: failedPhase,
            });
            return { failed: true };
          });

          if (audit.render_hold_id) {
            await ctx.step.do("settle-render", AUDIT_STEPS.settleRender, async () => {
              return { settled: false };
            });
          }

          throw new AppError(500, classification.errorCode, "The site audit failed.");
        }
        throw err;
      }
    },
    {
      pollAfterSeconds: 3,
      deadlineSeconds: 21_600,
      maxInvocations: 600,
      payloadSchema: siteAuditPayloadSchema,
    },
  );
}

// Auto-register on import
registerSiteAuditJob();

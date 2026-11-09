// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/workflows/SiteAuditWorkflow.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { definePeriodic, listPeriodics } from "../jobs/periodic.ts";
import { enqueueSystemJob } from "../jobs/enqueue.ts";
import { defineJob, getJobDefinition } from "../jobs/registry.ts";
import { DB_STEP, READ_STEP } from "../jobs/stepConfigs.ts";
import { AppError } from "../http/errors.ts";
import { getSupabaseAdmin } from "../supabase/admin.js";

const DAY_MS = 86_400_000;
const AUDIT_RETENTION_DAYS = 395;
const SCRATCH_RETENTION_DAYS = 7;
const PRUNE_BATCH_LIMIT = 200;
const MAX_PRUNE_STEPS = 20;

export interface RetentionDeps {
  admin?: any;
  now?: () => number;
}

let boundAdmin: any = null;

export function setSiteAuditRetentionAdmin(admin: any): void {
  boundAdmin = admin;
}

export function registerSiteAuditRetentionJobs(deps?: RetentionDeps): void {
  if (deps?.admin) {
    boundAdmin = deps.admin;
  }

  // 1. periodic site_audit.retention (every 86,400s / 24 hours)
  if (!listPeriodics().some((p) => p.name === "site_audit.retention")) {
    definePeriodic({
      name: "site_audit.retention",
      everySeconds: 86_400,
      run: async (now: Date) => {
        const dateIso = now.toISOString().slice(0, 10);
        try {
          await enqueueSystemJob(
            "site_audit.retention",
            {},
            { dedupeKey: `site_audit.retention:${dateIso}` },
          );
        } catch (err: unknown) {
          if (err instanceof AppError && err.code === "job_already_running") return;
          throw err;
        }
      },
    });
  }

  // 2. job site_audit.retention definition
  if (!getJobDefinition("site_audit.retention")) {
    defineJob(
      "site_audit.retention",
      async (ctx) => {
        const admin = boundAdmin ?? (typeof getSupabaseAdmin === "function" ? getSupabaseAdmin() : null);
        if (!admin) {
          throw new AppError(503, "database_unavailable", "Database is unavailable.");
        }

        const now = (deps?.now ?? Date.now)();
        const auditsBefore = new Date(now - AUDIT_RETENTION_DAYS * DAY_MS).toISOString();
        const scratchBefore = new Date(now - SCRATCH_RETENTION_DAYS * DAY_MS).toISOString();

        const deletedAudits: Array<{ audit_id: string; brand_key: string }> = [];

        for (let i = 1; i <= MAX_PRUNE_STEPS; i++) {
          const res = await ctx.step.do(`prune-${i}`, DB_STEP, async () => {
            const { data, error } = await admin.rpc("prune_site_audits", {
              p_audits_before: auditsBefore,
              p_scratch_before: scratchBefore,
              p_limit: PRUNE_BATCH_LIMIT,
            });
            if (error) throw error;
            const rows = Array.isArray(data) ? data : [];
            return rows.map((r: any) => ({
              audit_id: r.audit_id ?? r.id,
              brand_key: r.brand_key,
            }));
          });

          deletedAudits.push(...res);
          if (res.length < PRUNE_BATCH_LIMIT) {
            break;
          }
        }

        let deletedObjects = 0;
        if (admin.storage && deletedAudits.length > 0) {
          for (let i = 0; i < deletedAudits.length; i++) {
            const audit = deletedAudits[i];
            const prefix = `${audit.brand_key}/${audit.audit_id}/`;
            await ctx.step.do(`storage-${i + 1}`, READ_STEP, async () => {
              try {
                const bucket = admin.storage.from("site-audit-lighthouse");
                const { data: files } = await bucket.list(prefix, { limit: 100 });
                if (Array.isArray(files) && files.length > 0) {
                  const paths = files.map((f: any) => `${prefix}${f.name}`);
                  const { data: removed } = await bucket.remove(paths);
                  deletedObjects += Array.isArray(removed) ? removed.length : paths.length;
                }
              } catch {
                // Storage cleanup is best-effort
              }
              return { prefix };
            });
          }
        }

        return {
          status: "completed",
          result: {
            audits: deletedAudits.length,
            objects: deletedObjects,
          },
        };
      },
      {
        deadlineSeconds: 1800,
        maxInvocations: 30,
      },
    );
  }
}

// Auto-register on import
registerSiteAuditRetentionJobs();

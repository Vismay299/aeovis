// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/lib/audit/rendering-billing.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { settleSpendBatch } from "../spend/index.ts";
import type { AuditStore } from "./store.ts";

export const FIRECRAWL_SCRAPE_USD_DEFAULT = 0.005;

function firecrawlUnitUsd(env?: Record<string, string | undefined>): number {
  const raw = env?.FIRECRAWL_SCRAPE_USD ?? (typeof process !== "undefined" ? (process.env as any)?.FIRECRAWL_SCRAPE_USD : undefined);
  if (raw !== undefined && raw !== "") {
    const val = Number(raw);
    if (Number.isFinite(val) && val > 0) return val;
  }
  return FIRECRAWL_SCRAPE_USD_DEFAULT;
}

export interface RenderSettleDeps {
  settleSpendBatch?: typeof settleSpendBatch;
  firecrawlUnitUsd?: number;
  env?: Record<string, string | undefined>;
  jobId?: string;
}

/**
 * Settles the one Firecrawl hold for an audit exactly once, guarded by
 * `render_settled_at IS NULL`. Used by the job's `settle-render` step and by
 * reconcile when it flips an active audit.
 */
export async function settleRenderHold(
  auditId: string,
  store: AuditStore,
  admin: any,
  deps?: RenderSettleDeps,
): Promise<{ settled: boolean }> {
  const audit = await store.getAudit(auditId);
  if (!audit || !audit.render_hold_id || audit.render_settled_at) {
    return { settled: false };
  }
  const holdId = audit.render_hold_id;
  if (admin?.from) {
    const nowIso = new Date().toISOString();
    const { data, error } = await admin
      .from("site_audits")
      .update({ render_settled_at: nowIso })
      .eq("id", auditId)
      .is("render_settled_at", null)
      .select("id");
    if (error) throw error;
    if (!data || data.length === 0) return { settled: false };
  } else {
    const fresh = await store.getAudit(auditId);
    if (!fresh || !fresh.render_hold_id || fresh.render_settled_at) return { settled: false };
    await store.updateAudit(auditId, deps?.jobId ?? fresh.job_id ?? "settle", {
      render_settled_at: new Date().toISOString(),
    });
  }
  const latest = (await store.getAudit(auditId)) ?? audit;
  const unit = deps?.firecrawlUnitUsd ?? firecrawlUnitUsd(deps?.env);
  const billed = latest.render_billed ?? 0;
  const approved = Number(latest.render_approved_usd ?? billed * unit);
  const actualUsd = Math.min(billed * unit, approved);
  const settle = deps?.settleSpendBatch ?? settleSpendBatch;
  await settle(holdId, [
    {
      provider: "firecrawl",
      endpoint: "/v1/scrape",
      units: billed,
      actualUsd,
      costSource: "price_table",
    },
  ]);
  return { settled: true };
}

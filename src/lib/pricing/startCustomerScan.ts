import crypto from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { PriceQuote } from "../../shared/pricing.ts";
import { reserveSpend, releaseSpend } from "../spend/index.ts";
import { recordApproval } from "./pricedActions.ts";
import { createScanJob } from "../db.js";
import { repairWorkflowStore } from "../db/repairWorkflow.js";
import { DuplicateScanError } from "../duplicateScan.js";
import { keepAlive } from "../keepAlive.js";
import { runScanChunk } from "../workers/scanWorker.js";
import { AppError } from "../http/errors.ts";

export type ScanStartDeps = {
  reserveSpend?: typeof reserveSpend;
  releaseSpend?: typeof releaseSpend;
  createScanJob?: typeof createScanJob;
  recordApproval?: typeof recordApproval;
  repairWorkflowStore?: typeof repairWorkflowStore;
  keepAlive?: typeof keepAlive;
  runScanChunk?: (jobId: string) => Promise<unknown> | void;
  randomUUID?: () => string;
};

export async function startCustomerScan(
  args: {
    admin: SupabaseClient;
    brandKey: string;
    userId?: string;
    quote: PriceQuote;
    approvedMaxUsd: number;
    source: "dialog" | "implicit";
    panelKey?: string;
    panelSnapshot?: any;
    brandDisplayName?: string;
    url?: string;
    legacy?: { industry?: string; competitors?: string };
  },
  deps?: ScanStartDeps,
): Promise<{ jobId: string; approvedMaxUsd: number; quotedUsd: number }> {
  const panelKey = args.panelKey || "default";
  let panel = args.panelSnapshot;
  if (!panel) {
    const store = (deps?.repairWorkflowStore || repairWorkflowStore)(args.admin);
    const panels = await store.list(args.brandKey, "panel");
    panel = panels.find((p: any) => p.artifact_key === panelKey && p.state === "approved");
    if (!panel) {
      throw new AppError(
        409,
        "panel_not_approved",
        "Review and approve a question panel before starting measurement.",
      );
    }
  }

  const uuidGen = deps?.randomUUID || crypto.randomUUID;
  const jobId = uuidGen();
  const reserveFn = deps?.reserveSpend || reserveSpend;
  const releaseFn = deps?.releaseSpend || releaseSpend;
  const createJobFn = deps?.createScanJob || createScanJob;
  const recordApprovalFn = deps?.recordApproval || recordApproval;
  const keepAliveFn = deps?.keepAlive || keepAlive;
  const runScanChunkFn = deps?.runScanChunk || runScanChunk;

  let hold = { holdId: "fixture-hold", existing: false };
  if (!(globalThis as any).customerRouteFixture) {
    hold = await reserveFn({
      brandKey: args.brandKey,
      feature: "ai_visibility.scan" as any,
      estimateUsd: Math.max(args.quote.totalUsd, 0.000001),
      maxUsd: args.approvedMaxUsd,
      idempotencyKey: "scan:" + jobId,
      ttlSeconds: 86340,
      subject: { kind: "scan_job", id: jobId },
    });
  }

  try {
    await createJobFn({
      panelSnapshot: panel,
      measurementContext: panel?.payload?.context,
      brand: args.brandDisplayName || args.brandKey,
      brandKey: args.brandKey,
      url: args.url || "",
      industry: (args.legacy?.industry || "").trim(),
      competitors: (args.legacy?.competitors || "").trim(),
      jobId,
      approvedMaxUsd: args.approvedMaxUsd,
      priceQuote: args.quote,
    });
  } catch (error) {
    if (error instanceof DuplicateScanError) {
      if (!(globalThis as any).customerRouteFixture) {
        await releaseFn(hold.holdId, "scan_already_running");
      }
      throw new AppError(
        409,
        "scan_already_running",
        "A scan is already running for this workspace.",
      );
    }
    await releaseFn(hold.holdId, "scan_create_failed");
    console.error(`[customer] scan creation failed for ${args.brandKey}:`, error);
    throw new AppError(500, "internal_error", "Could not start the scan. Please retry.");
  }

  try {
    await recordApprovalFn(args.admin, {
      brandKey: args.brandKey,
      action: "ai_visibility.scan.run",
      approvedMaxUsd: args.approvedMaxUsd,
      quote: args.quote,
      source: args.source,
      subject: { kind: "scan_job", id: jobId },
      approvedBy: args.userId,
    });
  } catch (approvalErr) {
    console.error(`[pricing] approval record failed ${jobId}:`, approvalErr);
  }

  keepAliveFn(async () => {
    await runScanChunkFn(jobId);
  });

  return {
    jobId,
    approvedMaxUsd: args.approvedMaxUsd,
    quotedUsd: args.quote.totalUsd,
  };
}

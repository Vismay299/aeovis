// Customer-facing site-audit services. This module keeps database and pricing
// work out of route handlers so it can be exercised with in-memory fixtures.

import { randomUUID } from "node:crypto";
import type { Workspace } from "../workspace/requireWorkspace.ts";
import { AppError } from "../../shared/http/errors.ts";
import { isFeatureEnabled } from "../features/flags.ts";
import { assertPublicUrl } from "../ssrfGuard.js";
import { isOwnedHost, normalizeStartUrl, startUrlAppError } from "./urlPolicy.ts";
import { requireApprovedPrice, recordApproval } from "../../shared/pricing/pricedActions.ts";
import type { PriceQuote } from "../../shared/pricing.ts";
import { reserveSpend, releaseSpend } from "../../shared/spend/index.ts";
import { enqueueJob } from "../jobs/enqueue.ts";
import { captureAuditEvent } from "./telemetry.ts";
import { AUDIT_MONTHLY_PAGES_DEFAULT, AUDIT_HOST_CAP, MAX_AUDIT_PAGES, RENDERED_MAX_AUDIT_PAGES } from "../../shared/audit-limits.ts";
import { cancelJob } from "../jobs/cancel.ts";
import { reconcileRunningAudit } from "./reconcile.ts";
import "../../shared/pricing/actions/index.ts";

export type StartAuditInput = {
  startUrl?: string;
  maxPages: number;
  lighthouse: boolean;
  renderJavaScript: boolean;
  maxUsd?: number;
  trigger?: "manual" | "baseline" | "tool";
};

export type StartDeps = {
  env?: Record<string, string | undefined>;
  now?: () => Date;
  uuid?: () => string;
  isFeatureEnabled?: typeof isFeatureEnabled;
  assertPublicUrl?: typeof assertPublicUrl;
  requireApprovedPrice?: typeof requireApprovedPrice;
  reserveSpend?: typeof reserveSpend;
  releaseSpend?: typeof releaseSpend;
  enqueueJob?: typeof enqueueJob;
  cancelJob?: typeof cancelJob;
  captureAuditEvent?: typeof captureAuditEvent;
  recordApproval?: typeof recordApproval;
};

const FEATURE_OFF = "This page is not available for your workspace yet.";
const FEATURE_DISABLED = "This feature is not enabled for your workspace.";
const RENDER_UNAVAILABLE = "JavaScript rendering isn't available right now.";

function configInt(env: Record<string, string | undefined>, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function isOwnedAuditHost(host: string, websiteHost: string): boolean {
  const stripWww = (value: string) => value.replace(/^www\./i, "");
  return isOwnedHost(stripWww(host), stripWww(websiteHost));
}

async function deleteAuditRow(admin: any, auditId: string, brandKey: string): Promise<void> {
  const { error } = await admin.from("site_audits").delete().eq("id", auditId).eq("brand_key", brandKey);
  if (error) throw error;
}

async function rollbackAuditRow(admin: any, auditId: string, brandKey: string): Promise<void> {
  try { await deleteAuditRow(admin, auditId, brandKey); } catch { /* the start error remains authoritative */ }
}

function lighthouseLineUsd(quote: PriceQuote): number {
  return quote.lines.find((line) => line.label === "Lighthouse checks (up to 10 pages, mobile and desktop)")?.totalUsd ?? 0;
}

/** Starts a workspace-owned audit and reserves rendering spend before enqueueing. */
export async function startSiteAudit(
  ws: Workspace,
  input: StartAuditInput,
  deps?: StartDeps,
): Promise<{ auditId: string; jobId: string; status: "queued"; pollAfterSeconds: 3; approvedMaxUsd: number | null }> {
  const env = deps?.env ?? process.env;
  const enabled = deps?.isFeatureEnabled ?? isFeatureEnabled;
  if (!(await enabled("site_audit", ws.brandKey, { env, admin: ws.admin }))) {
    throw new AppError(404, "feature_unavailable", FEATURE_OFF);
  }
  if (input.lighthouse && !(await enabled("site_audit_lighthouse", ws.brandKey, { env, admin: ws.admin }))) {
    throw new AppError(403, "feature_disabled", FEATURE_DISABLED);
  }
  if (input.renderJavaScript) {
    if (!(await enabled("site_audit_render", ws.brandKey, { env, admin: ws.admin }))) {
      throw new AppError(403, "feature_disabled", FEATURE_DISABLED);
    }
    if (!env.FIRECRAWL_API_KEY) throw new AppError(503, "render_unavailable", RENDER_UNAVAILABLE);
  }

  const maxPages = configInt(env, "SITE_AUDIT_MAX_PAGES", MAX_AUDIT_PAGES);
  const maxAllowed = Math.min(maxPages, MAX_AUDIT_PAGES);
  if (!Number.isInteger(input.maxPages) || input.maxPages < 10 || input.maxPages > maxAllowed) {
    throw new AppError(422, "page_limit", `Choose from 10 to ${maxAllowed} pages.`);
  }
  if (input.renderJavaScript && input.maxPages > RENDERED_MAX_AUDIT_PAGES) {
    throw new AppError(422, "render_page_limit", "Audits that render JavaScript are limited to 1,000 pages.");
  }

  const requestedUrl = input.startUrl ?? ws.brand.website;
  const startUrl = normalizeStartUrl(requestedUrl);
  const host = new URL(startUrl).hostname;
  if (String(env.SITE_AUDIT_ALLOW_ANY_HOST ?? "").toLowerCase() !== "on" && !isOwnedAuditHost(host, ws.brand.website_host)) {
    throw new AppError(422, "audit_host_not_owned", `Site audits run on your workspace website (${ws.brand.website_host}) and its subdomains.`);
  }
  try {
    await (deps?.assertPublicUrl ?? assertPublicUrl)(startUrl);
  } catch (err) {
    throw startUrlAppError(err);
  }

  const quoteCtx = { brandKey: ws.brandKey, admin: ws.admin, env, now: (deps?.now ?? (() => new Date()))() };
  let priced: Awaited<ReturnType<typeof requireApprovedPrice>>;
  try {
    priced = await (deps?.requireApprovedPrice ?? requireApprovedPrice)(
      "site_audit.run",
      quoteCtx,
      { maxPages: input.maxPages, lighthouse: input.lighthouse, renderJavaScript: input.renderJavaScript },
      input.maxUsd,
    );
  } catch (err) {
    if (err instanceof AppError && err.code === "audit_already_running") {
      let activeId: string | undefined;
      try {
        const { data: active } = await ws.admin.from("site_audits").select("id").eq("brand_key", ws.brandKey)
          .in("status", ["queued", "running"]).limit(1).maybeSingle();
        activeId = active?.id;
      } catch { /* keep the priced-action refusal if the lookup is unavailable */ }
      throw new AppError(409, "audit_already_running", err.message, {
        details: { ...(err.details ?? {}), ...(activeId ? { activeAuditId: activeId } : {}) }, cause: err,
      });
    }
    throw err;
  }
  if (priced.source === "implicit" && priced.quote.totalUsd > 0) {
    throw new AppError(400, "approval_required", "Review and approve the price before running this.", { details: { quote: priced.quote } });
  }

  const auditId = (deps?.uuid ?? randomUUID)();
  const monthStart = new Date(Date.UTC(quoteCtx.now.getUTCFullYear(), quoteCtx.now.getUTCMonth(), 1)).toISOString();
  const monthCap = configInt(env, "SITE_AUDIT_MONTHLY_PAGES", AUDIT_MONTHLY_PAGES_DEFAULT);
  const { data: created, error: createError } = await ws.admin.rpc("site_audit_create", {
    p_id: auditId,
    p_brand_key: ws.brandKey,
    p_started_by: ws.user.id,
    p_trigger: input.trigger === "baseline" ? "baseline" : "manual",
    p_requested_url: requestedUrl,
    p_start_url: startUrl,
    p_start_host: host,
    p_max_pages: input.maxPages,
    p_lighthouse: input.lighthouse,
    p_render: input.renderJavaScript,
    p_month_start: monthStart,
    p_monthly_cap: monthCap,
    p_host_cap: AUDIT_HOST_CAP,
  });
  if (createError) throw new AppError(503, "audit_unavailable", "Site audits are unavailable right now. Please retry.", { cause: createError });
  if (!created?.created) {
    const reason = created?.reason;
    if (reason === "audit_already_running") {
      throw new AppError(409, reason, "An audit is already running for this workspace.", { details: { activeAuditId: created.activeAuditId } });
    }
    if (reason === "host_busy") {
      throw new AppError(409, reason, `Another audit of ${host} is running. Try again when it finishes.`);
    }
    if (reason === "audit_capacity_reached") {
      throw new AppError(409, reason, `This workspace has used ${created.used} of its ${created.cap} audit pages this month. Lower the page limit or wait until next month.`, { details: { used: created.used, cap: created.cap } });
    }
    if (reason === "workspace_not_found") throw new AppError(404, "workspace_not_found", "Workspace not found.");
    throw new AppError(503, "audit_unavailable", "Site audits are unavailable right now. Please retry.");
  }

  let renderHoldId: string | null = null;
  const renderLineUsd = priced.quote.lines.find((line) => line.label === "Pages loaded by a browser service")?.totalUsd ?? 0;
  if (input.renderJavaScript && renderLineUsd > 0) {
    try {
      const hold = await (deps?.reserveSpend ?? reserveSpend)({
        brandKey: ws.brandKey,
        feature: "site_audit.render",
        estimateUsd: renderLineUsd,
        maxUsd: Math.max(0, priced.approvedMaxUsd - lighthouseLineUsd(priced.quote)),
        idempotencyKey: `site_audit:${auditId}:render`,
        ttlSeconds: 86_340,
        subject: { kind: "site_audit", id: auditId },
      });
      renderHoldId = hold.holdId;
    } catch (err) {
      await rollbackAuditRow(ws.admin, auditId, ws.brandKey);
      throw err;
    }
  }

  let jobId: string;
  try {
    const queued = await (deps?.enqueueJob ?? enqueueJob)(
      "site_audit.run",
      { auditId },
      {
        brandKey: ws.brandKey,
        singleActiveKey: `site_audit:${ws.brandKey}`,
        trigger: input.trigger === "baseline" ? "baseline" : "manual",
        createdBy: ws.user.id,
      },
    );
    jobId = queued.jobId;
  } catch (err) {
    if (renderHoldId) {
      try { await (deps?.releaseSpend ?? releaseSpend)(renderHoldId, "audit_start_failed"); } catch { /* preserve the enqueue failure */ }
    }
    await rollbackAuditRow(ws.admin, auditId, ws.brandKey);
    if (err instanceof AppError && err.code === "job_already_running") {
      let activeId: string | undefined;
      try {
        const { data: active } = await ws.admin.from("site_audits").select("id").eq("brand_key", ws.brandKey)
          .in("status", ["queued", "running"]).neq("id", auditId).limit(1).maybeSingle();
        activeId = active?.id;
      } catch { /* preserve the F01 conflict if the active audit cannot be read */ }
      throw new AppError(409, "audit_already_running", "An audit is already running for this workspace.", {
        details: activeId ? { activeAuditId: activeId } : undefined, cause: err,
      });
    }
    throw err;
  }

  const { error: updateError } = await ws.admin.from("site_audits").update({
    job_id: jobId,
    render_hold_id: renderHoldId,
    render_approved_usd: input.renderJavaScript ? renderLineUsd : null,
    lighthouse_approved_usd: lighthouseLineUsd(priced.quote),
    approved_max_usd: priced.quote.totalUsd > 0 ? priced.approvedMaxUsd : null,
    price_quote: priced.quote,
  }).eq("id", auditId).eq("brand_key", ws.brandKey);
  if (updateError) {
    try { await (deps?.cancelJob ?? cancelJob)(jobId); } catch { /* an enqueue can race with its first tick */ }
    if (renderHoldId) {
      try { await (deps?.releaseSpend ?? releaseSpend)(renderHoldId, "audit_start_failed"); } catch { /* preserve the write failure */ }
    }
    await rollbackAuditRow(ws.admin, auditId, ws.brandKey);
    throw new AppError(503, "audit_unavailable", "Site audits are unavailable right now. Please retry.", { cause: updateError });
  }

  if (priced.source === "dialog") {
    try {
      await (deps?.recordApproval ?? recordApproval)(ws.admin, {
        brandKey: ws.brandKey,
        action: "site_audit.run",
        approvedMaxUsd: priced.approvedMaxUsd,
        quote: priced.quote,
        source: "dialog",
        subject: { kind: "site_audit", id: auditId },
        approvedBy: ws.user.id,
      });
    } catch {
      // Approval history is useful for operators but must not undo a queued audit.
      console.warn("[audit] approval record failed", { auditId });
    }
  }

  await (deps?.captureAuditEvent ?? captureAuditEvent)("site_audit:start", {
    max_pages: input.maxPages,
    lighthouse: input.lighthouse,
    render_js: input.renderJavaScript,
    trigger: input.trigger ?? "manual",
  });
  return { auditId, jobId, status: "queued", pollAfterSeconds: 3, approvedMaxUsd: priced.quote.totalUsd > 0 ? priced.approvedMaxUsd : null };
}

export async function getAuditStatus(admin: any, brandKey: string, auditId: string): Promise<any> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(auditId)) {
    throw new AppError(404, "audit_not_found", "Audit not found.");
  }
  const { data, error } = await admin.from("site_audits").select(
    "id,start_url,status,current_phase,pages_crawled,pages_total,lighthouse_total,lighthouse_completed,lighthouse_failed,render_javascript,run_lighthouse,cancel_requested_at,error_code,failed_phase,created_at,started_at,completed_at",
  ).eq("id", auditId).eq("brand_key", brandKey).maybeSingle();
  if (error) throw error;
  if (!data) throw new AppError(404, "audit_not_found", "Audit not found.");
  return {
    id: data.id, startUrl: data.start_url, status: data.status, currentPhase: data.current_phase,
    pagesCrawled: data.pages_crawled, pagesTotal: data.pages_total, lighthouseTotal: data.lighthouse_total ?? 0,
    lighthouseCompleted: data.lighthouse_completed ?? 0, lighthouseFailed: data.lighthouse_failed ?? 0,
    renderJavaScript: data.render_javascript, lighthouse: data.run_lighthouse, cancelRequested: Boolean(data.cancel_requested_at),
    errorCode: data.error_code ?? null, failedPhase: data.failed_phase ?? null, createdAt: data.created_at,
    startedAt: data.started_at, completedAt: data.completed_at,
    pollAfterSeconds: data.status === "queued" || data.status === "running" ? 3 : null,
  };
}

export async function listAudits(admin: any, brandKey: string, limit: number, env: Record<string, string | undefined> = process.env, defaultUrl: string | null = null): Promise<any> {
  const { data: rows, error } = await admin.from("site_audits").select(
    "id,start_url,status,pages_crawled,pages_total,max_pages,run_lighthouse,render_javascript,created_at,completed_at",
  ).eq("brand_key", brandKey)
    .order("created_at", { ascending: false }).limit(limit);
  if (error) throw error;
  const audits = Array.isArray(rows) ? rows : [];
  const summaries = audits.length ? await admin.rpc("site_audit_issue_summary", { p_audit_id: audits[0].id }) : { data: [], error: null };
  if (summaries.error) throw summaries.error;
  const counts = new Map<string, { critical: number; warning: number; info: number }>();
  // The summary RPC is per-audit, so request remaining audits individually.
  for (const row of audits) {
    const result = row.id === audits[0]?.id ? summaries : await admin.rpc("site_audit_issue_summary", { p_audit_id: row.id });
    if (result.error) throw result.error;
    counts.set(row.id, (result.data ?? []).reduce((acc: any, item: any) => {
      const key = item.severity as "critical" | "warning" | "info";
      if (key in acc) acc[key] += Number(item.rows_count ?? 0);
      return acc;
    }, { critical: 0, warning: 0, info: 0 }));
  }
  return {
    audits: audits.map((row: any) => ({
      id: row.id, startUrl: row.start_url, status: row.status, pagesCrawled: row.pages_crawled,
      pagesTotal: row.pages_total, maxPages: row.max_pages, lighthouse: row.run_lighthouse,
      renderJavaScript: row.render_javascript, createdAt: row.created_at, completedAt: row.completed_at,
      issueCounts: ["completed", "partial", "failed", "cancelled"].includes(row.status) ? counts.get(row.id) ?? { critical: 0, warning: 0, info: 0 } : null,
    })),
    capabilities: await auditCapabilities(admin, brandKey, env, defaultUrl),
  };
}

export async function auditCapabilities(admin: any, brandKey: string, env: Record<string, string | undefined> = process.env, defaultUrl: string | null = null): Promise<any> {
  const lighthouse = await isFeatureEnabled("site_audit_lighthouse", brandKey, { env, admin });
  const render = await isFeatureEnabled("site_audit_render", brandKey, { env, admin });
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const { data, error } = await admin.from("site_audits").select("max_pages,pages_crawled,status")
    .eq("brand_key", brandKey).gte("created_at", monthStart.toISOString());
  if (error) throw error;
  const monthlyPagesUsed = (data ?? []).reduce((total: number, row: any) => total + (row.status === "queued" || row.status === "running" ? Number(row.max_pages ?? 0) : Number(row.pages_crawled ?? 0)), 0);
  return {
    lighthouse, render, renderReason: render ? null : (env.FEATURE_SITE_AUDIT_RENDER === "off" ? "flag_off" : !env.FIRECRAWL_API_KEY ? "not_configured" : "flag_off"),
    maxPages: Math.min(MAX_AUDIT_PAGES, configInt(env, "SITE_AUDIT_MAX_PAGES", MAX_AUDIT_PAGES)),
    renderedMaxPages: Math.min(RENDERED_MAX_AUDIT_PAGES, configInt(env, "SITE_AUDIT_MAX_PAGES", MAX_AUDIT_PAGES)),
    monthlyPagesUsed, monthlyPagesCap: configInt(env, "SITE_AUDIT_MONTHLY_PAGES", AUDIT_MONTHLY_PAGES_DEFAULT),
    defaultUrl,
  };
}

export async function cancelAudit(
  admin: any,
  brandKey: string,
  auditId: string,
  deps?: { cancelJob?: typeof cancelJob; reconcile?: typeof reconcileRunningAudit; now?: () => Date },
): Promise<{ status: string }> {
  const { data: audit, error } = await admin.from("site_audits").select("*").eq("id", auditId).eq("brand_key", brandKey).maybeSingle();
  if (error) throw error;
  if (!audit) throw new AppError(404, "audit_not_found", "Audit not found.");
  if (audit.status !== "queued" && audit.status !== "running") return { status: audit.status };
  const { error: updateError } = await admin.from("site_audits").update({ cancel_requested_at: (deps?.now ?? (() => new Date()))().toISOString() })
    .eq("id", auditId).eq("brand_key", brandKey).in("status", ["queued", "running"]);
  if (updateError) throw updateError;
  if (!audit.job_id) {
    await (deps?.reconcile ?? reconcileRunningAudit)(audit, { admin });
    return { status: "cancelling" };
  }
  try {
    await (deps?.cancelJob ?? cancelJob)(audit.job_id);
  } catch (err) {
    if (err instanceof AppError && err.code === "job_not_found") {
      await (deps?.reconcile ?? reconcileRunningAudit)(audit, { admin });
      return { status: "cancelling" };
    }
    throw err;
  }
  return { status: "cancelling" };
}

export async function deleteAudit(admin: any, brandKey: string, auditId: string, userId: string, role: "owner" | "member"): Promise<{ deleted: true }> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(auditId)) {
    throw new AppError(404, "audit_not_found", "Audit not found.");
  }
  const { data: audit, error } = await admin.from("site_audits").select("id,brand_key,started_by,status")
    .eq("id", auditId).eq("brand_key", brandKey).maybeSingle();
  if (error) throw error;
  if (!audit) throw new AppError(404, "audit_not_found", "Audit not found.");
  if (audit.status === "queued" || audit.status === "running") {
    throw new AppError(409, "audit_running", "Cancel the audit before deleting it.");
  }
  if (role !== "owner" && audit.started_by !== userId) {
    throw new AppError(403, "owner_required", "Only the workspace owner or the person who started this audit can delete it.");
  }
  const { error: deleteError } = await admin.from("site_audits").delete().eq("id", auditId).eq("brand_key", brandKey);
  if (deleteError) throw deleteError;
  try {
    if (admin.storage) {
      const bucket = admin.storage.from("site-audit-lighthouse");
      const prefix = `${brandKey}/${auditId}/`;
      const paths: string[] = [];
      for (let offset = 0; offset < 5_000; offset += 100) {
        const { data, error: listError } = await bucket.list(prefix, { limit: 100, offset });
        if (listError) throw listError;
        const files = Array.isArray(data) ? data : [];
        paths.push(...files.map((file: any) => `${prefix}${file.name}`));
        if (files.length < 100) break;
      }
      if (paths.length) {
        const { error: removeError } = await bucket.remove(paths);
        if (removeError) throw removeError;
      }
    }
  } catch {
    // Audit data deletion is authoritative; retention retries Storage cleanup.
  }
  return { deleted: true };
}

import { z } from "zod";
import { defineRouteContract, type RouteContract } from "../http/routeContract.ts";

export const auditListQuery = z.strictObject({
  brand_key: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const startAuditBody = z.strictObject({
  brand_key: z.string().max(200).optional(),
  startUrl: z.string().trim().min(1).max(2048).optional(),
  maxPages: z.int().min(10).max(10_000).default(50),
  lighthouse: z.boolean().default(false),
  renderJavaScript: z.boolean().default(false),
  maxUsd: z.number().positive().max(1000).optional(),
});

export const auditId = z.uuid();
export const feedQuery = z.strictObject({ limit: z.coerce.number().int().min(1).max(100).default(50) });
export const issuesQuery = z.strictObject({
  type: z.string().regex(/^[a-z][a-z0-9-]{1,60}$/),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
export const pagesQuery = z.strictObject({
  q: z.string().max(200).optional(),
  status: z.enum(["all", "ok", "redirect", "error", "missing"]).optional(),
  fetchClass: z.enum(["all", "ok", "blocked", "rate_limited", "error"]).optional(),
  minWords: z.coerce.number().int().min(0).optional(),
  maxWords: z.coerce.number().int().min(0).optional(),
  minResponseMs: z.coerce.number().int().min(0).optional(),
  maxResponseMs: z.coerce.number().int().min(0).optional(),
  missingAlt: z.enum(["all", "yes", "no"]).optional(),
  issueType: z.string().optional(),
  sort: z.enum(["url", "status", "title", "h1", "words", "images", "speed"]).default("url"),
  dir: z.enum(["asc", "desc"]).default("asc"),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
export const cancelBody = z.strictObject({ brand_key: z.string().max(200).optional() });

const loose = z.looseObject({});

export const contracts: RouteContract[] = [
  defineRouteContract({ id: "f18.audit.list", method: "GET", path: "/api/customer/audit", file: "src/app/api/customer/audit/route.ts", auth: "workspace", query: auditListQuery, response: z.looseObject({ audits: z.array(loose), capabilities: loose }), errorCodes: ["feature_unavailable", "invalid_request", "audit_unavailable"], examples: [{ response: { audits: [], capabilities: { lighthouse: false, render: false, renderReason: "flag_off", maxPages: 10000, renderedMaxPages: 1000, monthlyPagesUsed: 0, monthlyPagesCap: 50000, defaultUrl: "https://example.com/" } } }] }),
  defineRouteContract({ id: "f18.audit.start", method: "POST", path: "/api/customer/audit", file: "src/app/api/customer/audit/route.ts", auth: "workspace", request: startAuditBody, response: z.looseObject({ auditId: z.uuid(), jobId: z.uuid(), status: z.literal("queued"), pollAfterSeconds: z.literal(3), approvedMaxUsd: z.number().nullable() }), errorCodes: ["feature_unavailable", "feature_disabled", "render_unavailable", "page_limit", "render_page_limit", "invalid_url", "audit_host_not_owned", "url_blocked", "url_unreachable", "approval_required", "price_changed", "audit_already_running", "host_busy", "audit_capacity_reached", "daily_cap", "workspace_cap", "spend_unavailable"], examples: [{ response: { auditId: "6f1d2c3b-0a4e-4b8f-9c1d-2e3f4a5b6c7d", jobId: "0c2a4b1e-8d1f-4f35-9b5e-2e0c6f1a7d90", status: "queued", pollAfterSeconds: 3, approvedMaxUsd: 0.35 } }] }),
  defineRouteContract({ id: "f18.audit.status", method: "GET", path: "/api/customer/audit/[auditId]", file: "src/app/api/customer/audit/[auditId]/route.ts", auth: "workspace", response: loose, errorCodes: ["feature_unavailable", "audit_not_found", "audit_unavailable"], examples: [{ response: { id: "6f1d2c3b-0a4e-4b8f-9c1d-2e3f4a5b6c7d", startUrl: "https://example.com/", status: "queued", currentPhase: "queued", pagesCrawled: 0, pagesTotal: 50, lighthouseTotal: 0, lighthouseCompleted: 0, lighthouseFailed: 0, renderJavaScript: false, lighthouse: false, cancelRequested: false, errorCode: null, failedPhase: null, createdAt: "2026-10-22T09:00:00.000Z", startedAt: null, completedAt: null, pollAfterSeconds: 3 } }] }),
  defineRouteContract({ id: "f18.audit.delete", method: "DELETE", path: "/api/customer/audit/[auditId]", file: "src/app/api/customer/audit/[auditId]/route.ts", auth: "workspace", response: z.looseObject({ deleted: z.literal(true) }), errorCodes: ["feature_unavailable", "audit_not_found", "audit_running", "owner_required"], examples: [{ response: { deleted: true } }] }),
  defineRouteContract({ id: "f18.audit.feed", method: "GET", path: "/api/customer/audit/[auditId]/feed", file: "src/app/api/customer/audit/[auditId]/feed/route.ts", auth: "workspace", query: feedQuery, response: z.looseObject({ entries: z.array(loose), pollAfterSeconds: z.number().nullable() }), errorCodes: ["feature_unavailable", "audit_not_found"], examples: [{ response: { entries: [], pollAfterSeconds: null } }] }),
  defineRouteContract({ id: "f18.audit.summary", method: "GET", path: "/api/customer/audit/[auditId]/summary", file: "src/app/api/customer/audit/[auditId]/summary/route.ts", auth: "workspace", response: loose, errorCodes: ["feature_unavailable", "audit_not_found"], examples: [{ response: { audit: {}, stats: {}, issueGroups: [], aiAccess: { rows: [] }, llmsTxt: {}, flags: {} } }] }),
  defineRouteContract({ id: "f18.audit.issues", method: "GET", path: "/api/customer/audit/[auditId]/issues", file: "src/app/api/customer/audit/[auditId]/issues/route.ts", auth: "workspace", query: issuesQuery, response: z.looseObject({ issueType: z.string(), total: z.number().int(), rows: z.array(loose) }), errorCodes: ["feature_unavailable", "audit_not_found", "invalid_request"], examples: [{ response: { issueType: "broken-page", total: 0, rows: [] } }] }),
  defineRouteContract({ id: "f18.audit.pages", method: "GET", path: "/api/customer/audit/[auditId]/pages", file: "src/app/api/customer/audit/[auditId]/pages/route.ts", auth: "workspace", query: pagesQuery, response: z.looseObject({ total: z.number().int(), rows: z.array(loose) }), errorCodes: ["feature_unavailable", "audit_not_found", "invalid_request"], examples: [{ response: { total: 0, rows: [] } }] }),
  defineRouteContract({ id: "f18.audit.performance", method: "GET", path: "/api/customer/audit/[auditId]/performance", file: "src/app/api/customer/audit/[auditId]/performance/route.ts", auth: "workspace", response: z.looseObject({ rows: z.array(loose) }), errorCodes: ["feature_unavailable", "audit_not_found"], examples: [{ response: { rows: [] } }] }),
  defineRouteContract({ id: "f18.audit.cancel", method: "POST", path: "/api/customer/audit/[auditId]/cancel", file: "src/app/api/customer/audit/[auditId]/cancel/route.ts", auth: "workspace", request: cancelBody, response: z.looseObject({ status: z.string() }), errorCodes: ["feature_unavailable", "audit_not_found"], examples: [{ response: { status: "cancelling" } }] }),
];

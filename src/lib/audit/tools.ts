import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CustomerBrand, Workspace } from "../workspace/requireWorkspace.ts";
import { startSiteAudit, getAuditStatus, listAudits } from "./service.ts";
import { getAuditSummary, listAuditIssues, listAuditPages } from "./results.ts";
import { AUDIT_ISSUE_TYPES } from "../../shared/audit-issues.ts";

export type SiteAuditToolContext = {
  admin: SupabaseClient;
  brand: CustomerBrand;
  userId: string;
  deps?: {
    startSiteAudit?: typeof startSiteAudit;
    getAuditStatus?: typeof getAuditStatus;
    getAuditSummary?: typeof getAuditSummary;
    listAuditIssues?: typeof listAuditIssues;
    listAuditPages?: typeof listAuditPages;
    listAudits?: typeof listAudits;
    getLatestAuditId?: (admin: SupabaseClient, brandKey: string) => Promise<string | null>;
  };
};

const runInput = z.strictObject({
  maxPages: z.int().min(10).max(10_000).default(50),
  lighthouse: z.boolean().default(false),
  renderJavaScript: z.boolean().default(false),
  maxUsd: z.number().positive().max(1000).optional(),
});
const runOutput = z.looseObject({ auditId: z.uuid(), status: z.string() });
const statusInput = z.strictObject({ auditId: z.uuid().optional() });
const statusOutput = z.looseObject({
  status: z.string(), phase: z.string(), pagesCrawled: z.number(), pagesTotal: z.number(),
  lighthouseTotal: z.number(), lighthouseCompleted: z.number(), lighthouseFailed: z.number(), errorCode: z.string().nullable(),
});
const issueInput = z.strictObject({
  auditId: z.uuid().optional(), severity: z.enum(["critical", "warning", "info"]).optional(),
  issueType: z.string().max(64).optional(), limit: z.int().min(1).max(200).default(50),
});
const issueOutput = z.looseObject({ groups: z.array(z.looseObject({
  issueType: z.string(), title: z.string(), severity: z.string(), pages: z.number(), howToFix: z.string(), urls: z.array(z.string()),
})) });
const pagesInput = z.strictObject({
  auditId: z.uuid().optional(), issueType: z.string().max(64).optional(),
  status: z.enum(["all", "ok", "redirect", "error", "missing"]).optional(), limit: z.int().min(1).max(200).default(50),
});
const pagesOutput = z.looseObject({ rows: z.array(z.looseObject({ id: z.string(), url: z.string() })), total: z.number() });
const historyInput = z.strictObject({ limit: z.int().min(1).max(50).default(10) });
const historyOutput = z.looseObject({ audits: z.array(z.looseObject({ id: z.string(), startUrl: z.string(), status: z.string() })) });

async function latestAuditId(ctx: SiteAuditToolContext): Promise<string | null> {
  if (ctx.deps?.getLatestAuditId) return ctx.deps.getLatestAuditId(ctx.admin, ctx.brand.brandKey);
  const { data, error } = await ctx.admin.from("site_audits").select("id").eq("brand_key", ctx.brand.brandKey)
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (error) throw error;
  return data?.id ?? null;
}

async function auditIdOrLatest(ctx: SiteAuditToolContext, auditId?: string): Promise<string | null> {
  return auditId ?? latestAuditId(ctx);
}

function toolWorkspace(ctx: SiteAuditToolContext): Workspace {
  return { user: { id: ctx.userId, email: "" }, brandKey: ctx.brand.brandKey, brand: ctx.brand, role: ctx.brand.role ?? "member", admin: ctx.admin };
}

export const runSiteAuditTool = {
  name: "run_site_audit",
  description: "Start a crawl of this workspace's website (10–10,000 pages) that checks technical SEO, AI-crawler access in robots.txt, llms.txt, structured data, Open Graph and hreflang. Free without Lighthouse or JavaScript rendering; those are paid: get a price estimate first and pass the approved maxUsd. One audit runs at a time.",
  input: runInput,
  output: runOutput,
  handler: async (ctx: SiteAuditToolContext, rawInput?: unknown) => {
    const input = runInput.parse(rawInput ?? {});
    const result = await (ctx.deps?.startSiteAudit ?? startSiteAudit)(toolWorkspace(ctx), { ...input, trigger: "tool" });
    return runOutput.parse({ auditId: result.auditId, status: result.status });
  },
};

export const getSiteAuditStatusTool = {
  name: "get_site_audit_status",
  description: "Read the status and progress of this workspace's latest site audit, or a specific audit by id.",
  input: statusInput,
  output: statusOutput,
  handler: async (ctx: SiteAuditToolContext, rawInput?: unknown) => {
    const input = statusInput.parse(rawInput ?? {});
    const auditId = await auditIdOrLatest(ctx, input.auditId);
    if (!auditId) return { status: "not_found", phase: "queued", pagesCrawled: 0, pagesTotal: 0, lighthouseTotal: 0, lighthouseCompleted: 0, lighthouseFailed: 0, errorCode: null };
    const result = await (ctx.deps?.getAuditStatus ?? getAuditStatus)(ctx.admin, ctx.brand.brandKey, auditId);
    return statusOutput.parse({ status: result.status, phase: result.currentPhase, pagesCrawled: result.pagesCrawled, pagesTotal: result.pagesTotal,
      lighthouseTotal: result.lighthouseTotal, lighthouseCompleted: result.lighthouseCompleted, lighthouseFailed: result.lighthouseFailed, errorCode: result.errorCode });
  },
};

export const getSiteAuditIssuesTool = {
  name: "get_site_audit_issues",
  description: "Read grouped site-audit issues with severity, guidance, and affected page URLs.",
  input: issueInput,
  output: issueOutput,
  handler: async (ctx: SiteAuditToolContext, rawInput?: unknown) => {
    const input = issueInput.parse(rawInput ?? {});
    const auditId = await auditIdOrLatest(ctx, input.auditId);
    if (!auditId) return { groups: [] };
    const summary = await (ctx.deps?.getAuditSummary ?? getAuditSummary)(ctx.admin, ctx.brand.brandKey, auditId);
    const groups = summary.issueGroups.filter((group: any) => (!input.issueType || group.issueType === input.issueType) && (!input.severity || group.severity === input.severity));
    const result = await Promise.all(groups.map(async (group: any) => {
      const issues = await (ctx.deps?.listAuditIssues ?? listAuditIssues)(ctx.admin, ctx.brand.brandKey, auditId, { type: group.issueType, offset: 0, limit: input.limit });
      const descriptor = AUDIT_ISSUE_TYPES[group.issueType as keyof typeof AUDIT_ISSUE_TYPES];
      return { issueType: group.issueType, title: descriptor?.title ?? group.issueType, severity: group.severity, pages: group.pages, howToFix: descriptor?.howToFix ?? "", urls: issues.rows.map((row: any) => row.pageUrl) };
    }));
    return issueOutput.parse({ groups: result });
  },
};

export const getSiteAuditPagesTool = {
  name: "get_site_audit_pages",
  description: "Read site-audit pages, optionally filtered by issue type or HTTP status.",
  input: pagesInput,
  output: pagesOutput,
  handler: async (ctx: SiteAuditToolContext, rawInput?: unknown) => {
    const input = pagesInput.parse(rawInput ?? {});
    const auditId = await auditIdOrLatest(ctx, input.auditId);
    if (!auditId) return { rows: [], total: 0 };
    const result = await (ctx.deps?.listAuditPages ?? listAuditPages)(ctx.admin, ctx.brand.brandKey, auditId, {
      issueType: input.issueType, status: input.status, sort: "url", dir: "asc", offset: 0, limit: input.limit,
    });
    return pagesOutput.parse(result);
  },
};

export const listSiteAuditsTool = {
  name: "list_site_audits",
  description: "List recent site audits for this workspace.",
  input: historyInput,
  output: historyOutput,
  handler: async (ctx: SiteAuditToolContext, rawInput?: unknown) => {
    const input = historyInput.parse(rawInput ?? {});
    const result = await (ctx.deps?.listAudits ?? listAudits)(ctx.admin, ctx.brand.brandKey, input.limit);
    return historyOutput.parse({ audits: result.audits });
  },
};

export const siteAuditTools = [runSiteAuditTool, getSiteAuditStatusTool, getSiteAuditIssuesTool, getSiteAuditPagesTool, listSiteAuditsTool];

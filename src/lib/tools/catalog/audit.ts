import {
  getSiteAuditIssuesTool,
  getSiteAuditPagesTool,
  getSiteAuditStatusTool,
  listSiteAuditsTool,
  runSiteAuditTool,
} from "../../audit/tools.ts";
import { defineRegistration, type ToolRegistration } from "../types.ts";
import {
  actionQuoteInput,
  paidAnnotations,
  readAnnotations,
} from "./quote.ts";

const AUDIT_ID = "9e8d0000-0000-4000-8000-000000000004";
const auditPath = "/portal/audit";

export const registrations: ToolRegistration[] = [
  defineRegistration({
    def: runSiteAuditTool as never,
    area: "audit",
    feature: "site_audit",
    effect: "paid",
    approval: (_ctx, input) => ({
      kind: "price",
      action: "site_audit.run",
      quoteInput: actionQuoteInput("site_audit.run", input),
      label: "Run a site audit (" + String(input.maxPages ?? 50) + " pages)",
    }),
    annotations: paidAnnotations(),
    summarize: (_output: any, input: any) =>
      "Site audit started (" + String(input?.maxPages ?? 50) + " pages).",
    link: (output: any) => ({
      path: output?.auditId ? auditPath + "/" + output.auditId : auditPath,
      label: "Site audit",
    }),
    example: {
      input: { maxPages: 50, maxUsd: 0.5 },
      output: { auditId: AUDIT_ID, status: "queued" },
    },
  }),
  defineRegistration({
    def: getSiteAuditStatusTool as never,
    area: "audit",
    feature: "site_audit",
    effect: "read",
    approval: () => ({ kind: "none" }),
    annotations: readAnnotations(),
    summarize: (output: any) =>
      "Audit " +
      String(output?.status ?? "unknown") +
      ": " +
      (output?.pagesCrawled ?? 0) +
      " of " +
      (output?.pagesTotal ?? 0) +
      " pages.",
    link: (_output, input) => ({
      path: input.auditId ? auditPath + "/" + input.auditId : auditPath,
      label: "Site audit",
    }),
    waitForProgress: {
      statusPath: "status",
      runningValues: ["queued", "running"],
      progressPath: "pagesCrawled",
      budgetMs: 45_000,
    },
    example: {
      input: { auditId: AUDIT_ID },
      output: {
        status: "running",
        phase: "crawling",
        pagesCrawled: 0,
        pagesTotal: 50,
        lighthouseTotal: 0,
        lighthouseCompleted: 0,
        lighthouseFailed: 0,
        errorCode: null,
      },
    },
  }),
  defineRegistration({
    def: getSiteAuditIssuesTool as never,
    area: "audit",
    feature: "site_audit",
    effect: "read",
    approval: () => ({ kind: "none" }),
    annotations: readAnnotations(),
    summarize: (output: any) => {
      const groups = output?.groups ?? [];
      const pages = groups.reduce(
        (sum: number, group: any) => sum + (group?.pages ?? 0),
        0,
      );
      return groups.length + " issue types on " + pages + " pages.";
    },
    link: (_output, input) => ({
      path: input.auditId ? auditPath + "/" + input.auditId : auditPath,
      label: "Site audit",
    }),
    example: {
      input: { auditId: AUDIT_ID },
      output: { groups: [] },
    },
  }),
  defineRegistration({
    def: getSiteAuditPagesTool as never,
    area: "audit",
    feature: "site_audit",
    effect: "read",
    approval: () => ({ kind: "none" }),
    annotations: readAnnotations(),
    summarize: (output: any) => (output?.rows?.length ?? 0) + " pages.",
    link: (_output, input) => ({
      path: input.auditId ? auditPath + "/" + input.auditId : auditPath,
      label: "Site audit",
    }),
    example: {
      input: { auditId: AUDIT_ID },
      output: { rows: [], total: 0 },
    },
  }),
  defineRegistration({
    def: listSiteAuditsTool as never,
    area: "audit",
    feature: "site_audit",
    effect: "read",
    approval: () => ({ kind: "none" }),
    annotations: readAnnotations(),
    summarize: (output: any) => (output?.audits?.length ?? 0) + " audits.",
    link: () => ({ path: auditPath, label: "Site audit" }),
    example: {
      input: {},
      output: { audits: [] },
    },
  }),
];

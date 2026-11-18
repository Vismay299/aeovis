import { defineRegistration, type ToolRegistration } from "../types.ts";
import {
  getReportTool,
  listReportTemplatesTool,
  listReportsTool,
  saveReportTool,
} from "../../reports/tools.ts";

function formatSize(bytes: number): string {
  const count = new Intl.NumberFormat("en-US");
  if (bytes < 1000) return `${count.format(bytes)} bytes`;
  return `${count.format(Math.round(bytes / 1000))} KB`;
}

const readAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
  idempotentHint: true,
} as const;

export const registrations: ToolRegistration[] = [
  defineRegistration({
    def: listReportsTool as never,
    area: "reports",
    feature: "reports",
    effect: "read",
    approval: () => ({ kind: "none" }),
    annotations: { ...readAnnotations },
    summarize: (output: any) =>
      `${output?.rowCount ?? 0} of ${output?.totalCount ?? 0} reports.`,
    link: () => ({ path: "/portal/reports", label: "Reports" }),
    untrustedPaths: ["reports[*].summaryPreview"],
    example: {
      input: { limit: 20, offset: 0 },
      output: {
        reports: [
          {
            id: "1f0c9a2b-3d4e-4f5a-9a1b-2f0c4d5e6a7b",
            title: "AI Visibility Audit — Oct 22, 2026",
            skill: "ai-visibility-audit",
            updatedAt: "2026-10-22T09:00:00.000Z",
            htmlBytes: 21480,
            summaryPreview: "The verdict in one line.",
          },
        ],
        totalCount: 1,
        rowCount: 1,
        remaining: 1999,
      },
    },
  }),
  defineRegistration({
    def: getReportTool as never,
    area: "reports",
    feature: "reports",
    effect: "read",
    approval: () => ({ kind: "none" }),
    annotations: { ...readAnnotations },
    summarize: (output: any) =>
      `Report \u201C${String(output?.report?.title ?? "report")}\u201D (${formatSize(Number(output?.report?.htmlBytes ?? 0))}).`,
    link: (output: any) => ({
      path: `/portal/reports/${String(output?.report?.id ?? "")}`,
      label: "Open report",
    }),
    untrustedPaths: ["report.summary", "report.html"],
    example: {
      input: { reportId: "1f0c9a2b-3d4e-4f5a-9a1b-2f0c4d5e6a7b", includeHtml: false },
      output: {
        report: {
          id: "1f0c9a2b-3d4e-4f5a-9a1b-2f0c4d5e6a7b",
          title: "AI Visibility Audit — Oct 22, 2026",
          summary: "The verdict, the top action and the key numbers.",
          skill: "ai-visibility-audit",
          templateId: null,
          createdBy: "assistant",
          updatedAt: "2026-10-22T09:00:00.000Z",
          htmlBytes: 21480,
          path: "/portal/reports/1f0c9a2b-3d4e-4f5a-9a1b-2f0c4d5e6a7b",
          shared: false,
        },
      },
    },
  }),
  defineRegistration({
    def: saveReportTool as never,
    area: "reports",
    feature: "reports",
    effect: "write",
    approval: async (ctx: any, input: Record<string, unknown>) => {
      const reportId = input.reportId;
      if (typeof reportId !== "string" || !reportId) return { kind: "none" };
      try {
        const { data, error } = await ctx.admin
          .from("reports")
          .select("title")
          .eq("id", reportId)
          .eq("brand_key", ctx.brand?.brandKey ?? ctx.brand?.brand_key ?? "")
          .maybeSingle();
        if (error || !data) return { kind: "none" };
        const title = (data as { title?: unknown }).title;
        if (typeof title !== "string" || !title) return { kind: "none" };
        return { kind: "confirm", label: `Replace the report \u201C${title}\u201D` };
      } catch {
        return { kind: "none" };
      }
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
      idempotentHint: false,
    },
    summarize: (output: any) =>
      `${output?.created === false ? "Replaced" : "Saved"} report \u201C${String(output?.title ?? "report")}\u201D (${formatSize(Number(output?.htmlBytes ?? 0))}).`,
    link: (output: any) => ({
      path: `/portal/reports/${String(output?.reportId ?? "")}`,
      label: "Open report",
    }),
    example: {
      input: {
        title: "AI Visibility Audit — Oct 22, 2026",
        summary: "The verdict, the top action and the key numbers.",
        html: "<!doctype html><html><head><title>AI Visibility Audit — Oct 22, 2026</title></head><body><h1>AI Visibility Audit — Oct 22, 2026</h1></body></html>",
      },
      output: {
        reportId: "1f0c9a2b-3d4e-4f5a-9a1b-2f0c4d5e6a7b",
        title: "AI Visibility Audit — Oct 22, 2026",
        created: true,
        htmlBytes: 214,
        path: "/portal/reports/1f0c9a2b-3d4e-4f5a-9a1b-2f0c4d5e6a7b",
        sanitized: { changed: false, removedTags: [] },
      },
    },
  }),
  defineRegistration({
    def: listReportTemplatesTool as never,
    area: "reports",
    feature: "reports",
    effect: "read",
    approval: () => ({ kind: "none" }),
    annotations: { ...readAnnotations },
    summarize: (output: any) => `${output?.templates?.length ?? 0} report templates.`,
    link: () => ({ path: "/portal/reports/templates", label: "Templates" }),
    example: {
      input: {},
      output: {
        templates: [
          {
            id: "2a1b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
            name: "Monthly client check-in",
            description: "The monthly update we send retainer clients.",
            instructions: "Audience: the client's marketing lead.",
          },
        ],
        remaining: 9,
      },
    },
  }),
];

/**
 * F23 §6.2.4 — the four report tools. Own code (PATTERN of OpenSEO's
 * report-tools.ts, report-template-tools.ts: no delete, no sharing, no
 * template writes for the assistant; never returns tokens).
 */

import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ToolHandlerContext } from "../tools/types.ts";
import {
  getReport,
  getReportWithHtml,
  listReports,
  saveReport,
} from "./service.ts";
import { listReportTemplates } from "./templateService.ts";
import { getSkillVersion } from "../../assistant/skills/index.ts";
import type { ReportStore } from "./repository.ts";
import type { ReportTemplateStore } from "./templateRepository.ts";

export type ReportToolContext = ToolHandlerContext & {
  deps?: {
    reportStore?: ReportStore;
    templateStore?: ReportTemplateStore;
    getSkillVersion?: typeof getSkillVersion;
  };
};

const listReportsInput = z.strictObject({
  limit: z.int().min(1).max(50).default(20),
  offset: z.int().min(0).max(10000).default(0),
});

const listReportsOutput = z.looseObject({
  reports: z.array(
    z.looseObject({
      id: z.string(),
      title: z.string(),
      skill: z.string().nullable(),
      updatedAt: z.string(),
      htmlBytes: z.number(),
      summaryPreview: z.string(),
    }),
  ),
  totalCount: z.number(),
  rowCount: z.number(),
  remaining: z.number(),
});

const getReportInput = z.strictObject({
  reportId: z.uuid(),
  includeHtml: z.boolean().default(false),
});

const getReportOutput = z.looseObject({
  report: z.looseObject({
    id: z.string(),
    title: z.string(),
    summary: z.string(),
    skill: z.string().nullable(),
    templateId: z.string().nullable(),
    createdBy: z.string(),
    updatedAt: z.string(),
    htmlBytes: z.number(),
    path: z.string(),
    shared: z.boolean(),
    html: z.string().optional(),
  }),
});

const saveReportInput = z.strictObject({
  title: z.string().min(1).max(120),
  summary: z.string().min(1).max(2500),
  html: z.string().min(1).max(1_000_000),
  reportId: z.uuid().optional(),
  skill: z.string().regex(/^[a-z][a-z0-9-]{2,59}$/).optional(),
  templateId: z.uuid().optional(),
});

const saveReportOutput = z.looseObject({
  reportId: z.string(),
  title: z.string(),
  created: z.boolean(),
  htmlBytes: z.number(),
  path: z.string(),
  sanitized: z.looseObject({
    changed: z.boolean(),
    removedTags: z.array(z.string()),
  }),
});

const listTemplatesInput = z.strictObject({});

const listTemplatesOutput = z.looseObject({
  templates: z.array(
    z.looseObject({
      id: z.string(),
      name: z.string(),
      description: z.string(),
      instructions: z.string(),
    }),
  ),
  remaining: z.number(),
});

function truncatePreview(value: string, max = 300): string {
  return value.length <= max ? value : `${value.slice(0, max).trimEnd()}\u2026`;
}

function storeDeps(ctx: ReportToolContext) {
  return {
    store: ctx.deps?.reportStore,
    templates: ctx.deps?.templateStore,
  };
}

export const listReportsTool = {
  name: "list_reports",
  description:
    "List this workspace's saved reports, newest first: id, title, skill, size, update time and a short summary preview. Call this before save_report so you replace the right report instead of making a near-duplicate.",
  input: listReportsInput,
  output: listReportsOutput,
  handler: async (ctx: ReportToolContext, rawInput?: unknown) => {
    const input = listReportsInput.parse(rawInput ?? {});
    const deps = storeDeps(ctx);
    const result = await listReports(
      ctx.admin,
      { brandKey: ctx.brand.brandKey, limit: input.limit, offset: input.offset },
      {
        ...(deps.store ? { store: deps.store } : {}),
        ...(deps.templates ? { templates: deps.templates } : {}),
      },
    );
    const rows = result.reports.map((report) => {
      // listReports already returned metadata; the summary rides with it.
      // The repository keeps `summary` on the metadata row.
      return {
        id: report.id,
        title: report.title,
        skill: report.skill,
        updatedAt: report.updatedAt,
        htmlBytes: report.sizeBytes,
        summaryPreview: truncatePreview(report.summary),
      };
    });
    return listReportsOutput.parse({
      reports: rows,
      totalCount: result.totalCount,
      rowCount: rows.length,
      remaining: result.remaining,
    });
  },
};

export const getReportTool = {
  name: "get_report",
  description:
    "Read one saved report: title, summary, skill and size. Pass includeHtml only when you must edit a specific passage; a large report is long. Reading never shares a report.",
  input: getReportInput,
  output: getReportOutput,
  handler: async (ctx: ReportToolContext, rawInput?: unknown) => {
    const input = getReportInput.parse(rawInput ?? {});
    const deps = storeDeps(ctx);
    const serviceDeps = {
      ...(deps.store ? { store: deps.store } : {}),
      ...(deps.templates ? { templates: deps.templates } : {}),
    };
    if (input.includeHtml) {
      const { report, html } = await getReportWithHtml(
        ctx.admin,
        ctx.brand.brandKey,
        input.reportId,
        serviceDeps,
      );
      return getReportOutput.parse({
        report: {
          id: report.id,
          title: report.title,
          summary: report.summary,
          skill: report.skill,
          templateId: report.templateId,
          createdBy: report.createdBy,
          updatedAt: report.updatedAt,
          htmlBytes: report.sizeBytes,
          path: `/portal/reports/${report.id}`,
          shared: report.shareToken !== null,
          html,
        },
      });
    }
    const report = await getReport(ctx.admin, ctx.brand.brandKey, input.reportId, serviceDeps);
    return getReportOutput.parse({
      report: {
        id: report.id,
        title: report.title,
        summary: report.summary,
        skill: report.skill,
        templateId: report.templateId,
        createdBy: report.createdBy,
        updatedAt: report.updatedAt,
        htmlBytes: report.sizeBytes,
        path: `/portal/reports/${report.id}`,
        shared: report.shareToken !== null,
      },
    });
  },
};

export const saveReportTool = {
  name: "save_report",
  description:
    "Save a finished, self-contained HTML report to this workspace, where the team can read and print it. New reports are private; only a person can share them from Reports. Call list_reports first and pass the reportId of the report you are redoing instead of creating a near-duplicate; a title already used in this workspace is refused. Give a specific title (the report type or subject and the full date), a summary with the verdict, the top action and the key numbers, and the skill name you are running. Scripts, forms, iframes, remote images and fonts are removed when saved. Then reply with the returned path, a one-line verdict and the top action; do not paste the report into chat.",
  input: saveReportInput,
  output: saveReportOutput,
  handler: async (ctx: ReportToolContext, rawInput?: unknown) => {
    const input = saveReportInput.parse(rawInput ?? {});
    const deps = storeDeps(ctx);
    const versionFn = ctx.deps?.getSkillVersion ?? getSkillVersion;
    const skillVersion = input.skill ? (versionFn(input.skill) ?? undefined) : undefined;
    const result = await saveReport(
      ctx.admin,
      {
        brandKey: ctx.brand.brandKey,
        reportId: input.reportId,
        title: input.title,
        summary: input.summary,
        html: input.html,
        skill: input.skill,
        skillVersion,
        templateId: input.templateId,
        sessionId: ctx.sessionId ?? null,
        createdBy: "assistant",
        createdByUserId: ctx.userId,
      },
      {
        ...(deps.store ? { store: deps.store } : {}),
        ...(deps.templates ? { templates: deps.templates } : {}),
      },
    );
    return saveReportOutput.parse({
      reportId: result.reportId,
      title: result.title,
      created: result.created,
      htmlBytes: result.htmlBytes,
      path: `/portal/reports/${result.reportId}`,
      sanitized: result.sanitized,
    });
  },
};

export const listReportTemplatesTool = {
  name: "list_report_templates",
  description:
    "List this workspace's report templates: the user's briefs for kinds of report (audience, sections, tone, sign-off). Use one only when the user names it or asks for the kind of report it describes, and pass its id to save_report.",
  input: listTemplatesInput,
  output: listTemplatesOutput,
  handler: async (ctx: ReportToolContext, rawInput?: unknown) => {
    listTemplatesInput.parse(rawInput ?? {});
    const deps = storeDeps(ctx);
    const result = await listReportTemplates(ctx.admin, ctx.brand.brandKey, {
      ...(deps.templates ? { store: deps.templates } : {}),
    });
    return listTemplatesOutput.parse({
      templates: result.templates.map((template) => ({
        id: template.id,
        name: template.name,
        description: template.description,
        instructions: template.instructions,
      })),
      remaining: result.remaining,
    });
  },
};

export const reportTools = [listReportsTool, getReportTool, saveReportTool, listReportTemplatesTool];

export type { SupabaseClient };

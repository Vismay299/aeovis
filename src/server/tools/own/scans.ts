import { z } from "zod";
import { AppError } from "../../../shared/http/appError.ts";
import type { ToolDefinition, ToolHandlerContext } from "../types.ts";
import {
  requireApprovedPrice,
  type PricingContext,
} from "../../../shared/pricing/pricedActions.ts";
import {
  startCustomerScan,
  type ScanStartDeps,
} from "../../../shared/pricing/startCustomerScan.ts";

const listInput = z.strictObject({
  limit: z.int().min(1).max(50).default(10),
});

const listOutput = z.looseObject({
  scans: z.array(
    z.looseObject({
      scanId: z.string(),
      scannedAt: z.string().nullable(),
      visibilityPct: z.number().nullable(),
      promptsTracked: z.number().nullable(),
      promptsMentioned: z.number().nullable(),
      sharePct: z.number().nullable(),
    }),
  ),
  totalCount: z.number(),
});

const reportInput = z.strictObject({
  scanId: z.uuid(),
  engine: z.string().max(40).optional(),
  onlyGaps: z.boolean().default(false),
  limit: z.int().min(1).max(200).default(100),
  offset: z.int().min(0).max(5000).default(0),
});

const reportOutput = z.looseObject({
  scan: z.looseObject({
    scanId: z.string(),
    scannedAt: z.string().nullable(),
    visibilityPct: z.number().nullable(),
    engines: z.unknown(),
    competitors: z.array(z.unknown()),
  }),
  rows: z.array(
    z.looseObject({
      resultId: z.string(),
      question: z.string(),
      engine: z.string(),
      answered: z.boolean().nullable(),
      mentioned: z.boolean().nullable(),
      cited: z.boolean().nullable(),
      position: z.number().nullable(),
      competitorsNamed: z.array(z.string()),
    }),
  ),
  totalCount: z.number(),
  coverage: z.looseObject({
    planned: z.number().nullable(),
    answered: z.number(),
    notAnswered: z.number(),
    failed: z.number(),
  }),
});

const answerInput = z.strictObject({
  resultId: z.uuid(),
});

const answerOutput = z.looseObject({
  resultId: z.string(),
  scanId: z.string(),
  question: z.string(),
  engine: z.string(),
  answered: z.boolean().nullable(),
  mentioned: z.boolean().nullable(),
  cited: z.boolean().nullable(),
  answer: z.string(),
  truncated: z.boolean(),
});

const sourcesInput = z.strictObject({
  scanId: z.uuid(),
  onlyWhereBrandAbsent: z.boolean().default(false),
  limit: z.int().min(1).max(100).default(50),
});

const sourcesOutput = z.looseObject({
  sources: z.array(
    z.looseObject({
      domain: z.string(),
      exampleUrl: z.string(),
      domainType: z.string().nullable(),
      contentType: z.string().nullable(),
      isOwn: z.boolean(),
      answersCiting: z.number(),
      engines: z.array(z.string()),
    }),
  ),
  totalCount: z.number(),
  note: z.string(),
});

const statusInput = z.strictObject({
  jobId: z.uuid(),
});

const statusOutput = z.looseObject({
  jobId: z.string(),
  status: z.string(),
  progressPct: z.number().nullable(),
  scanId: z.string().nullable(),
});

type Row = Record<string, any>;
type Admin = ToolHandlerContext["admin"];

async function read<T>(query: unknown): Promise<T> {
  const response = (await query) as { data: T; error: unknown };
  if (response.error) throw response.error;
  return response.data;
}

function objectValue(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {};
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nullableBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

async function getOwnedScan(admin: Admin, brandKey: string, scanId: string): Promise<Row> {
  const scan = await read<Row | null>(
    admin
      .from("scans")
      .select("*")
      .eq("id", scanId)
      .eq("brand_key", brandKey)
      .maybeSingle(),
  );

  if (!scan) {
    throw new AppError(404, "scan_not_found", "This scan does not exist in this workspace.");
  }

  return scan;
}

function domainOf(row: Row): string {
  if (typeof row.domain === "string" && row.domain) return row.domain.toLowerCase();

  try {
    return new URL(String(row.url ?? row.href)).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function competitorsNamed(rawValue: unknown): string[] {
  const raw = objectValue(rawValue);
  const brands = Array.isArray(raw.brands) ? (raw.brands as Row[]) : [];

  return brands
    .filter((brand) => brand.is_self !== true && brand.isSelf !== true && brand.mentioned === true)
    .map((brand) => String(brand.name ?? "").trim())
    .filter(Boolean);
}

function scanTimestamp(scan: Row): string | null {
  if (typeof scan.scanned_at === "string") return scan.scanned_at;
  if (typeof scan.created_at === "string") return scan.created_at;
  return null;
}

export const listScansTool: ToolDefinition = {
  name: "list_scans",
  description: "List recent visibility scans for this workspace.",
  input: listInput,
  output: listOutput,
  handler: async (ctx, raw) => {
    const input = listInput.parse(raw);
    const response = (await ctx.admin
      .from("scans")
      .select("*", { count: "exact" })
      .eq("brand_key", ctx.brand.brandKey)
      .order("scanned_at", { ascending: false, nullsFirst: false })
      .limit(input.limit)) as unknown as {
      data: Row[] | null;
      count: number | null;
      error: unknown;
    };

    if (response.error) throw response.error;
    const scans = Array.isArray(response.data) ? response.data : [];

    return listOutput.parse({
      scans: scans.map((scan) => ({
        scanId: String(scan.id),
        scannedAt: scanTimestamp(scan),
        visibilityPct: nullableNumber(scan.visibility_pct),
        promptsTracked: nullableNumber(scan.prompts_tracked),
        promptsMentioned: nullableNumber(scan.prompts_mentioned),
        sharePct: nullableNumber(objectValue(scan.raw_results).share_of_voice_pct),
      })),
      totalCount: response.count ?? scans.length,
    });
  },
};

export const getScanReportTool: ToolDefinition = {
  name: "get_scan_report",
  description: "Read a scan report without returning answer text.",
  input: reportInput,
  output: reportOutput,
  handler: async (ctx, raw) => {
    const input = reportInput.parse(raw);
    const scan = await getOwnedScan(ctx.admin, ctx.brand.brandKey, input.scanId);
    const query = ctx.admin
      .from("prompt_results")
      .select("id,query,engine,answered,mentioned,brand_cited,position,raw,created_at")
      .eq("scan_id", input.scanId)
      .order("created_at", { ascending: true });

    if (input.engine) query.eq("engine", input.engine);

    const loaded = await read<Row[]>(query);
    const results = Array.isArray(loaded) ? loaded : [];
    const baseRows = results.map((row) => ({
      resultId: String(row.id),
      question: String(row.query ?? ""),
      engine: String(row.engine ?? ""),
      answered: nullableBoolean(row.answered),
      mentioned: nullableBoolean(row.mentioned),
      cited: nullableBoolean(row.brand_cited),
      position: nullableNumber(row.position),
      competitorsNamed: competitorsNamed(row.raw),
    }));
    const rows = input.onlyGaps
      ? baseRows.filter((row) => row.mentioned === false && row.competitorsNamed.length > 0)
      : baseRows;
    const rawResults = objectValue(scan.raw_results);

    return reportOutput.parse({
      scan: {
        scanId: String(scan.id),
        scannedAt: scanTimestamp(scan),
        visibilityPct: nullableNumber(scan.visibility_pct),
        engines: rawResults.engines ?? null,
        competitors: Array.isArray(rawResults.competitors) ? rawResults.competitors : [],
      },
      rows: rows.slice(input.offset, input.offset + input.limit),
      totalCount: rows.length,
      coverage: {
        planned: nullableNumber(rawResults.planned_questions) ?? nullableNumber(scan.prompts_tracked),
        answered: baseRows.filter((row) => row.answered === true).length,
        notAnswered: baseRows.filter((row) => row.answered === false).length,
        failed: results.filter((row) => {
          const resultRaw = objectValue(row.raw);
          return Boolean(resultRaw.error) || resultRaw.status === "failed";
        }).length,
      },
    });
  },
};

export const getScanAnswerTool: ToolDefinition = {
  name: "get_scan_answer",
  description: "Read one answer from a scan in this workspace.",
  input: answerInput,
  output: answerOutput,
  handler: async (ctx, raw) => {
    const input = answerInput.parse(raw);

    // Resolve the scan ID without selecting answer text, then authorize the scan.
    const metadata = await read<Row | null>(
      ctx.admin
        .from("prompt_results")
        .select("id,scan_id")
        .eq("id", input.resultId)
        .maybeSingle(),
    );

    if (!metadata?.scan_id) {
      throw new AppError(404, "scan_not_found", "This scan does not exist in this workspace.");
    }

    const scan = await getOwnedScan(ctx.admin, ctx.brand.brandKey, String(metadata.scan_id));

    // Read answer text only after the scan is authorized, and scope this query to
    // the result and its authorized scan.
    const row = await read<Row | null>(
      ctx.admin
        .from("prompt_results")
        .select("id,scan_id,query,engine,answered,mentioned,brand_cited,answer_text")
        .eq("id", input.resultId)
        .eq("scan_id", String(scan.id))
        .maybeSingle(),
    );

    if (!row) {
      throw new AppError(404, "scan_not_found", "This scan does not exist in this workspace.");
    }

    const answerText = typeof row.answer_text === "string" ? row.answer_text : "";

    return answerOutput.parse({
      resultId: String(row.id),
      scanId: String(scan.id),
      question: String(row.query ?? ""),
      engine: String(row.engine ?? ""),
      answered: nullableBoolean(row.answered),
      mentioned: nullableBoolean(row.mentioned),
      cited: nullableBoolean(row.brand_cited),
      answer: answerText.slice(0, 6000),
      truncated: answerText.length > 6000,
    });
  },
};

export const getScanSourcesTool: ToolDefinition = {
  name: "get_scan_sources",
  description: "Group citations from a scan by domain.",
  input: sourcesInput,
  output: sourcesOutput,
  handler: async (ctx, raw) => {
    const input = sourcesInput.parse(raw);
    await getOwnedScan(ctx.admin, ctx.brand.brandKey, input.scanId);

    const loaded = await read<Row[]>(
      ctx.admin
        .from("citations")
        .select("domain,url,domain_type,content_type,is_self,engine,result_id")
        // Ownership was checked through getOwnedScan; citations.brand holds
        // the legacy brand slug, not the workspace brand_key.
        .eq("scan_id", input.scanId),
    );
    const citations = Array.isArray(loaded) ? loaded : [];
    let absentResultIds = new Set<string>();

    if (input.onlyWhereBrandAbsent && citations.length > 0) {
      const resultIds = [...new Set(citations.map((row) => row.result_id).filter(Boolean))];
      const results = await read<Row[]>(
        ctx.admin.from("prompt_results").select("id,mentioned").in("id", resultIds),
      );
      absentResultIds = new Set(
        (Array.isArray(results) ? results : [])
          .filter((row) => row.mentioned === false)
          .map((row) => String(row.id)),
      );
    }

    const groups = new Map<
      string,
      {
        url: string;
        domainType: string | null;
        contentType: string | null;
        isOwn: boolean;
        answers: Set<string>;
        engines: Set<string>;
      }
    >();

    for (const row of citations) {
      if (input.onlyWhereBrandAbsent && !absentResultIds.has(String(row.result_id))) continue;

      const domain = domainOf(row);
      if (!domain) continue;

      let group = groups.get(domain);
      if (!group) {
        group = {
          url: String(row.url ?? ""),
          domainType: typeof row.domain_type === "string" ? row.domain_type : null,
          contentType: typeof row.content_type === "string" ? row.content_type : null,
          isOwn: row.is_self === true,
          answers: new Set(),
          engines: new Set(),
        };
        groups.set(domain, group);
      }

      if (row.result_id) group.answers.add(String(row.result_id));
      if (row.engine) group.engines.add(String(row.engine));
    }

    const ordered = [...groups.entries()].sort(([left], [right]) => left.localeCompare(right));

    return sourcesOutput.parse({
      sources: ordered.slice(0, input.limit).map(([domain, group]) => ({
        domain,
        exampleUrl: group.url,
        domainType: group.domainType,
        contentType: group.contentType,
        isOwn: group.isOwn,
        answersCiting: group.answers.size,
        engines: [...group.engines].sort(),
      })),
      totalCount: ordered.length,
      note: "Counts are answers in this scan that cited the domain.",
    });
  },
};

export const getScanStatusTool: ToolDefinition = {
  name: "get_scan_status",
  description: "Check the status and progress of a scan job in this workspace.",
  input: statusInput,
  output: statusOutput,
  handler: async (ctx, raw) => {
    const input = statusInput.parse(raw);
    const row = await read<Row | null>(
      ctx.admin
        .from("scan_jobs")
        .select("id,brand_key,status,progress_pct,result_id")
        .eq("id", input.jobId)
        .eq("brand_key", ctx.brand.brandKey)
        .maybeSingle(),
    );

    if (!row) {
      throw new AppError(404, "scan_not_found", "This scan job does not exist in this workspace.");
    }

    return statusOutput.parse({
      jobId: String(row.id),
      status: String(row.status),
      progressPct: nullableNumber(row.progress_pct),
      scanId: typeof row.result_id === "string" ? row.result_id : null,
    });
  },
};

const runScanInput = z.strictObject({
  panelKey: z.string().min(1).max(80).default("default"),
  maxUsd: z.number().positive().max(1000),
});

const runScanOutput = z.looseObject({
  jobId: z.string(),
  status: z.literal("pending"),
  approvedMaxUsd: z.number(),
});

export type RunScanDeps = ScanStartDeps & {
  requireApprovedPrice?: typeof requireApprovedPrice;
  startCustomerScan?: typeof startCustomerScan;
};

export function createRunScanTool(deps: RunScanDeps = {}): ToolDefinition {
  return {
    name: "run_scan",
    description:
      "Start a paid AI-visibility scan of the workspace's approved question panel.",
    input: runScanInput,
    output: runScanOutput,
    handler: async (ctx, raw) => {
      const input = runScanInput.parse(raw);
      const pricingCtx: PricingContext = {
        brandKey: ctx.brand.brandKey,
        admin: ctx.admin,
        env: process.env,
        now: new Date(),
      };
      const approveFn = deps.requireApprovedPrice ?? requireApprovedPrice;
      const approval = await approveFn(
        "ai_visibility.scan.run",
        pricingCtx,
        { panelKey: input.panelKey },
        input.maxUsd,
      );

      const startFn = deps.startCustomerScan ?? startCustomerScan;
      const result = await startFn(
        {
          admin: ctx.admin,
          brandKey: ctx.brand.brandKey,
          userId: ctx.userId,
          quote: approval.quote,
          approvedMaxUsd: approval.approvedMaxUsd,
          source: "dialog",
          panelKey: input.panelKey,
          brandDisplayName: ctx.brand.display_name,
          url: ctx.brand.website || "",
        },
        deps,
      );

      return runScanOutput.parse({
        jobId: result.jobId,
        status: "pending",
        approvedMaxUsd: result.approvedMaxUsd,
      });
    },
  };
}

export const runScanTool = createRunScanTool();

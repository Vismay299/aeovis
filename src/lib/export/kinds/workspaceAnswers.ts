// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/ai-visibility/services/aiVisibilityExport.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AppError } from "../../http/errors.ts";
import { safeHttpUrl } from "../../../shared/safe-url.ts";
import { exportFilename } from "../filenames.ts";
import type { ExportKind } from "./index.ts";

export const WORKSPACE_ANSWERS_MAX_ROWS = 50_000;
export const WORKSPACE_ANSWERS_SCAN_LIMIT = 500;
export const WORKSPACE_ANSWERS_PROMPT_CHUNK = 100;
/**
 * Rows per PostgREST request. Supabase caps every response at `max_rows`
 * (1,000 by default) and truncates silently, so each chunk is paged with
 * `.range()` over a total order instead of trusting one response.
 */
export const WORKSPACE_ANSWERS_PAGE_SIZE = 1_000;
export const WORKSPACE_ANSWERS_RANGE_MESSAGE =
  "Choose a date range of up to 92 days that ends today or earlier.";
export const WORKSPACE_ANSWERS_TOO_LARGE_MESSAGE =
  "This export has more than 50,000 rows. Choose a shorter date range.";

const DAY_MS = 86_400_000;

function utcMidnight(value: string): number | null {
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Date range for `workspace_answers`. Dates are calendar days in UTC; the
 * maximum is 92 inclusive days (`from` to `to`), and `to` may not be in the
 * future. Route parsing already enforces the `YYYY-MM-DD` shape and unknown
 * keys, so the only refusals here are range refusals.
 */
export const workspaceAnswersParams = z
  .strictObject({
    from: z.iso.date(),
    to: z.iso.date(),
  })
  .superRefine((value, ctx) => {
    const from = utcMidnight(value.from);
    const to = utcMidnight(value.to);
    const today = utcMidnight(new Date().toISOString().slice(0, 10));
    if (from === null || to === null || today === null) return;
    if (from > to || to > today || (to - from) / DAY_MS > 91) {
      ctx.addIssue({ code: "custom", message: WORKSPACE_ANSWERS_RANGE_MESSAGE });
    }
  });

export type WorkspaceAnswersParams = z.infer<typeof workspaceAnswersParams>;

export const WORKSPACE_ANSWERS_CSV_HEADERS = [
  "scan_id",
  "scanned_at",
  "answer_id",
  "question",
  "engine",
  "status",
  "names_you",
  "cited",
  "position",
  "sentiment",
  "brands_named",
  "citation_urls",
  "answer",
] as const;

type AnswerStatus = "failed" | "answered" | "no_answer" | "unknown";

function answerStatus(row: Record<string, unknown>): AnswerStatus {
  if (row.failed) return "failed";
  if (row.answered === true) return "answered";
  if (row.answered === false) return "no_answer";
  return "unknown";
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function mentionedBrandNames(value: unknown): string[] {
  return asArray(value)
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .filter((item) => item.mentioned === true && typeof item.name === "string" && item.name.length > 0)
    .map((item) => item.name as string);
}

function citationUrls(value: unknown): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const item of asArray(value)) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const candidate = typeof record.href === "string" ? record.href : typeof record.url === "string" ? record.url : null;
    const safe = safeHttpUrl(candidate);
    if (!safe || seen.has(safe)) continue;
    seen.add(safe);
    urls.push(safe);
  }
  return urls;
}

function finiteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function csvStatus(status: AnswerStatus): string {
  return status;
}

function csvYesNo(status: AnswerStatus, value: unknown): string {
  if (status !== "answered") return "";
  return value === true ? "yes" : "no";
}

function jsonAnswer(row: Record<string, unknown>): Record<string, unknown> {
  const status = answerStatus(row);
  return {
    scan_id: row.scan_id ?? null,
    scanned_at: row.scanned_at ?? null,
    answer_id: row.id ?? null,
    question: row.query ?? "",
    engine: row.engine ?? "",
    status,
    names_you: status === "answered" ? row.mentioned === true : null,
    cited: status === "answered" ? row.brand_cited === true : null,
    position: finiteNumber(row.position),
    sentiment: row.sentiment ?? null,
    brands_named: mentionedBrandNames(row.brands),
    citation_urls: citationUrls(row.references),
    answer: typeof row.answer_text === "string" ? row.answer_text : null,
  };
}

function dayAfter(date: string): string {
  const start = utcMidnight(date);
  return new Date((start ?? 0) + DAY_MS).toISOString();
}

export const workspaceAnswersKind: ExportKind<WorkspaceAnswersParams> = {
  kind: "workspace_answers",
  feature: "workspace_answers",
  params: workspaceAnswersParams,
  maxRows: WORKSPACE_ANSWERS_MAX_ROWS,

  async load(admin: SupabaseClient, brandKey: string, params: WorkspaceAnswersParams) {
    const from = `${params.from}T00:00:00.000Z`;
    const toExclusive = dayAfter(params.to);

    const { data: scans, error: scansError } = await admin
      .from("scans")
      .select("id, scanned_at, visibility_pct, prompts_tracked, prompts_mentioned")
      .eq("brand_key", brandKey)
      .gte("scanned_at", from)
      .lt("scanned_at", toExclusive)
      .order("scanned_at", { ascending: true })
      .order("id", { ascending: true })
      .limit(WORKSPACE_ANSWERS_SCAN_LIMIT + 1);
    if (scansError) throw scansError;

    const scanRows = (Array.isArray(scans) ? scans : []) as Record<string, unknown>[];
    // More scans than the cap would silently drop the newest ones; refuse
    // instead, like the row cap, so the customer picks a shorter range.
    if (scanRows.length > WORKSPACE_ANSWERS_SCAN_LIMIT) {
      throw new AppError(413, "export_too_large", WORKSPACE_ANSWERS_TOO_LARGE_MESSAGE);
    }
    const scanIds = scanRows.map((scan) => String(scan.id));
    const scannedAt = new Map(scanRows.map((scan) => [String(scan.id), scan.scanned_at ?? null]));

    const rows: Record<string, unknown>[] = [];
    for (let offset = 0; offset < scanIds.length; offset += WORKSPACE_ANSWERS_PROMPT_CHUNK) {
      const chunk = scanIds.slice(offset, offset + WORKSPACE_ANSWERS_PROMPT_CHUNK);
      for (let start = 0; ; ) {
        const { data: answers, error: answersError } = await admin
          .from("prompt_results")
          .select(
            "id, scan_id, query, engine, answered, mentioned, brand_cited, position, sentiment, answer_text, created_at, failed:raw->error, references:raw->references, brands:raw->brands",
          )
          .in("scan_id", chunk)
          .order("scan_id", { ascending: true })
          .order("created_at", { ascending: true })
          .order("id", { ascending: true })
          .range(start, start + WORKSPACE_ANSWERS_PAGE_SIZE - 1);
        if (answersError) throw answersError;
        const page = (Array.isArray(answers) ? answers : []) as Record<string, unknown>[];
        for (const answer of page) {
          rows.push({ ...answer, scanned_at: scannedAt.get(String(answer.scan_id)) ?? null });
          if (rows.length > WORKSPACE_ANSWERS_MAX_ROWS) {
            throw new AppError(413, "export_too_large", WORKSPACE_ANSWERS_TOO_LARGE_MESSAGE);
          }
        }
        // Advance by what actually came back and stop only on an empty page:
        // a server max_rows below our page size returns short pages that are
        // not the end of the data.
        if (page.length === 0) break;
        start += page.length;
      }
    }

    return {
      rows,
      meta: {
        range: { from: params.from, to: params.to },
        scans: scanRows,
      },
    };
  },

  csvHeaders: WORKSPACE_ANSWERS_CSV_HEADERS,

  toCsvRow(row) {
    const status = answerStatus(row);
    return [
      (row.scan_id as string) ?? "",
      (row.scanned_at as string) ?? "",
      (row.id as string) ?? "",
      (row.query as string) ?? "",
      (row.engine as string) ?? "",
      csvStatus(status),
      csvYesNo(status, row.mentioned),
      csvYesNo(status, row.brand_cited),
      finiteNumber(row.position) ?? "",
      (row.sentiment as string | number | null) ?? "",
      mentionedBrandNames(row.brands).join("; "),
      citationUrls(row.references).join("; "),
      typeof row.answer_text === "string" ? row.answer_text : "",
    ];
  },

  toJson(rows, meta, ctx) {
    return {
      exportedAt: ctx.exportedAt,
      brandKey: ctx.brandKey,
      range: meta.range ?? null,
      scans: meta.scans ?? [],
      answers: rows.map(jsonAnswer),
    };
  },

  filename(brandKey, params, format) {
    return `${exportFilename([brandKey, "answers", params.from, "to", params.to])}.${format}`;
  },
};

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/ai-visibility/services/aiVisibilityResults.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.
import { AppError } from "../../../shared/http/appError.ts";
import { linkBeforeRead as defaultLinkBeforeRead } from "./links.ts";
import { summarizeBrands, type ExecutionFacts } from "./summary.ts";
import { HISTORY_MAX_EXECUTIONS } from "../../../shared/question-history.ts";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Workspace } from "../../workspace/requireWorkspace.ts";

export type HistoryQuery = {
  from?: string;
  to?: string;
  engines?: string[];
};

export type HistoryDeps = {
  linkBeforeRead?: (admin: SupabaseClient, brandKey: string) => Promise<unknown>;
  trackView?: (props: { executions: number; range: string }) => void;
};

const ENGINE_LABELS: Record<string, string> = {
  google_ai_overview: "Google AI Overviews",
  aio: "Google AI Overviews",
  openai: "ChatGPT",
  chatgpt: "ChatGPT",
  perplexity: "Perplexity",
  gemini: "Gemini",
};

export function engineLabel(engine: string): string {
  if (!engine) return "Unknown engine";
  const key = String(engine);
  if (ENGINE_LABELS[key]) return ENGINE_LABELS[key];
  return key.replace(/[_-]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

export function toBooleanOrNull(value: unknown): boolean | null {
  if (value === true) return true;
  if (value === false) return false;
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === 1) return true;
  if (value === 0) return false;
  return null;
}

export function toStatus(input: {
  state: string | null;
  answerPresent: boolean | null;
  error: string | null;
  source: string;
  legacyAnswered?: boolean | null;
}): string {
  const state = String(input.state || "");
  if (state === "blocked") return "blocked";
  if (state === "failed") return "failed";
  if (input.error) return "failed";
  if (state === "ambiguous") return "unknown";
  if (state === "valid_no_aio") return "no_answer";
  if (input.source === "legacy") {
    return input.legacyAnswered === true ? "answered" : "no_answer";
  }
  if (input.answerPresent === true) return "answered";
  if (state === "answered") return "no_answer";
  return "unknown";
}

export function toMethod(value: unknown): "consumer_capture" | "model_api" | "google_serp" | "unknown" {
  if (value === "consumer_capture" || value === "model_api" || value === "google_serp") return value;
  return "unknown";
}

type LinkRow = {
  id: string;
  source: "scan" | "explore" | "legacy";
  observation_id: string | null;
  prompt_result_id: string | null;
  scan_job_id: string | null;
  scan_id: string | null;
  explore_run_id: string | null;
  engine: string;
  asked_text: string;
  collected_at: string;
};

async function readAll<T>(query: unknown): Promise<T[]> {
  const result = (await query) as { data: T[] | null; error: unknown };
  if (result.error) throw result.error;
  return Array.isArray(result.data) ? result.data : [];
}

async function readMaybe<T>(query: unknown): Promise<T | null> {
  const result = (await query) as { data: T | null; error: unknown };
  if (result.error) throw result.error;
  return (result.data ?? null) as T | null;
}

export async function getQuestionHistory(
  ws: Workspace,
  questionId: string,
  q: HistoryQuery = {},
  deps: HistoryDeps = {},
): Promise<{
  question: Record<string, unknown>;
  range: { from: string | null; to: string | null };
  executions: Record<string, unknown>[];
  summary: Record<string, unknown>[];
  coverage: Record<string, unknown>;
  truncated: boolean;
  latestScanId: string | null;
}> {
  const admin = ws.admin as unknown as SupabaseClient;
  const brandKey = ws.brandKey;

  const link = deps.linkBeforeRead ?? defaultLinkBeforeRead;
  await link(admin, brandKey);

  const from = q.from ?? null;
  const to = q.to ?? null;
  if (from && to && from > to) {
    throw new AppError(400, "invalid_range", "Choose a start date on or before the end date.");
  }
  for (const value of [from, to]) {
    if (value !== null && Number.isNaN(Date.parse(value))) {
      throw new AppError(400, "invalid_request", "Check the query and try again.");
    }
  }
  const engines = Array.isArray(q.engines) ? q.engines.filter((entry) => typeof entry === "string" && entry.length > 0) : [];

  let questionRow: Record<string, unknown> | null = null;
  let replacedBy: Record<string, unknown> | null = null;
  let replaces: Array<Record<string, unknown>> = [];
  try {
    questionRow = await readMaybe<Record<string, unknown>>(
      admin.from("workspace_questions").select("*").eq("brand_key", brandKey).eq("id", questionId).maybeSingle(),
    );
    if (questionRow && questionRow.replaced_by) {
      const replacement = await readMaybe<Record<string, unknown>>(
        admin
          .from("workspace_questions")
          .select("id,text")
          .eq("brand_key", brandKey)
          .eq("id", String(questionRow.replaced_by))
          .maybeSingle(),
      );
      if (replacement) replacedBy = replacement;
    }
    const children = await readAll<Record<string, unknown>>(
      admin.from("workspace_questions").select("id,text").eq("brand_key", brandKey).eq("replaced_by", questionId),
    );
    replaces = children
      .map((row) => ({ id: String(row.id), text: String(row.text ?? "") }))
      .filter((row) => row.id && row.text);
  } catch (error) {
    console.error(`[question-history] read failed history_unavailable`);
    throw new AppError(503, "history_unavailable", "Question history could not be loaded. Please retry.", { cause: error });
  }

  if (!questionRow) {
    throw new AppError(404, "question_not_found", "This question does not exist in this workspace.");
  }

  let linkRows: LinkRow[] = [];
  try {
    let scoped: unknown = admin
      .from("question_answer_links")
      .select("*")
      .eq("question_id", questionId)
      .eq("brand_key", brandKey);
    const scopedChain = scoped as {
      gte(col: string, value: string): unknown;
      lte(col: string, value: string): unknown;
      in(col: string, values: string[]): unknown;
      order(col: string, opts: { ascending: boolean }): unknown;
      limit(n: number): unknown;
    };
    if (from) scoped = scopedChain.gte("collected_at", from);
    if (to) scoped = (scoped as typeof scopedChain).lte("collected_at", to);
    if (engines.length > 0) scoped = (scoped as typeof scopedChain).in("engine", engines);
    scoped = (scoped as typeof scopedChain).order("collected_at", { ascending: false });
    scoped = (scoped as typeof scopedChain).limit(HISTORY_MAX_EXECUTIONS + 1);
    linkRows = await readAll<LinkRow>(scoped);
  } catch (error) {
    if (error instanceof AppError) throw error;
    console.error(`[question-history] read failed history_unavailable`);
    throw new AppError(503, "history_unavailable", "Question history could not be loaded. Please retry.", { cause: error });
  }

  const truncated = linkRows.length > HISTORY_MAX_EXECUTIONS;
  const page = truncated ? linkRows.slice(0, HISTORY_MAX_EXECUTIONS) : linkRows;

  const observationIds = page.filter((row) => row.observation_id).map((row) => String(row.observation_id));
  const legacyIds = page.filter((row) => row.prompt_result_id).map((row) => String(row.prompt_result_id));
  const scanJobIds = [...new Set(page.map((row) => row.scan_job_id).filter(Boolean))] as string[];

  const observationById = new Map<string, Record<string, unknown>>();
  const legacyById = new Map<string, Record<string, unknown>>();
  let scheduledJobIds = new Set<string>();
  try {
    for (let index = 0; index < observationIds.length; index += 100) {
      const batch = observationIds.slice(index, index + 100);
      const rows = await readAll<Record<string, unknown>>(
        admin
          .from("probe_observations")
          .select(
            "id,purpose,state,reason,observed_at,total_cost,answer_present:result->>answer_present,aio_present:result->>aio_present,serp_state:result->>serp_state,error:result->>error,mention_state:result->entity_evidence->>mention_state,own_mentioned:result->>brand_mentioned_in_text,own_cited:result->>brand_cited,brands:result->brands,competitors_cited:result->competitors_cited,method:result->>measurement_method,is_branded:result->>is_branded_query",
          )
          .in("id", batch),
      );
      for (const row of rows) observationById.set(String(row.id), row);
    }
    for (let index = 0; index < legacyIds.length; index += 100) {
      const batch = legacyIds.slice(index, index + 100);
      const rows = await readAll<Record<string, unknown>>(
        admin
          .from("prompt_results")
          .select("id,answered,mentioned,brand_cited,error:raw->>error,brands:raw->brands,competitors_cited:raw->competitors_cited,method:raw->>measurement_method")
          .in("id", batch),
      );
      for (const row of rows) legacyById.set(String(row.id), row);
    }
    if (scanJobIds.length > 0) {
      for (let index = 0; index < scanJobIds.length; index += 100) {
        const batch = scanJobIds.slice(index, index + 100);
        const rows = await readAll<Record<string, unknown>>(
          admin.from("measurement_windows").select("job_id").in("job_id", batch),
        );
        for (const row of rows) {
          if (row.job_id) scheduledJobIds.add(String(row.job_id));
        }
      }
    }
  } catch (error) {
    console.error(`[question-history] read failed history_unavailable`);
    throw new AppError(503, "history_unavailable", "Question history could not be loaded. Please retry.", { cause: error });
  }

  const executions: Record<string, unknown>[] = [];
  const facts: ExecutionFacts[] = [];
  let answered = 0;
  let noAnswer = 0;
  let failed = 0;
  let explore = 0;
  let legacy = 0;

  for (const linkRow of page) {
    const source = linkRow.source;
    if (source === "explore") explore += 1;
    if (source === "legacy") legacy += 1;
    const engine = String(linkRow.engine || "");
    const collectedAt = String(linkRow.collected_at);
    let status = "unknown";
    let ownMentioned: boolean | null = null;
    let ownCited: boolean | null = null;
    let method: "consumer_capture" | "model_api" | "google_serp" | "unknown" = "unknown";
    let trigger: "manual" | "scheduled" | "explore" | "legacy" = "manual";
    let factBrands: ExecutionFacts["brands"] = [];
    let competitorsCited: string[] | null = null;
    let mentionState: string | null = null;
    let quality: "measured" | "legacy_unknown" = "measured";

    if (source === "legacy") {
      const legacyRow = linkRow.prompt_result_id ? legacyById.get(String(linkRow.prompt_result_id)) : undefined;
      const answeredFlag = (legacyRow?.answered as boolean | null) ?? null;
      const error = (legacyRow?.error as string | null) ?? null;
      status = toStatus({ state: null, answerPresent: null, error, source, legacyAnswered: answeredFlag });
      ownMentioned = toBooleanOrNull(legacyRow?.mentioned);
      ownCited = toBooleanOrNull(legacyRow?.brand_cited);
      method = toMethod(legacyRow?.method);
      trigger = "legacy";
      quality = "legacy_unknown";
      const rawBrands = Array.isArray(legacyRow?.brands) ? (legacyRow?.brands as Array<Record<string, unknown>>) : [];
      factBrands = rawBrands
        .map((entry) => ({
          name: String(entry.name ?? ""),
          isSelf: Boolean(entry.is_self ?? entry.isSelf ?? false),
          mentioned: toBooleanOrNull(entry.mentioned),
        }))
        .filter((entry) => entry.name);
      competitorsCited = Array.isArray(legacyRow?.competitors_cited) ? (legacyRow?.competitors_cited as string[]) : null;
    } else {
      const observation = linkRow.observation_id ? observationById.get(String(linkRow.observation_id)) : undefined;
      const state = (observation?.state as string | null) ?? null;
      const error = (observation?.error as string | null) ?? null;
      const answerRaw = observation?.answer_present as unknown;
      const answerPresent = answerRaw === true || answerRaw === "true" ? true : answerRaw === false || answerRaw === "false" ? false : null;
      status = toStatus({ state, answerPresent, error, source });
      ownMentioned = toBooleanOrNull(observation?.own_mentioned);
      ownCited = toBooleanOrNull(observation?.own_cited);
      method = toMethod(observation?.method);
      mentionState = (observation?.mention_state as string | null) ?? null;
      if (source === "explore") {
        trigger = "explore";
      } else {
        trigger = linkRow.scan_job_id && scheduledJobIds.has(String(linkRow.scan_job_id)) ? "scheduled" : "manual";
      }
      const resultBrands = Array.isArray(observation?.brands) ? (observation?.brands as Array<Record<string, unknown>>) : [];
      factBrands = resultBrands
        .map((entry) => ({
          name: String(entry.name ?? ""),
          isSelf: Boolean(entry.is_self ?? entry.isSelf ?? false),
          mentioned: toBooleanOrNull(entry.mentioned),
        }))
        .filter((entry) => entry.name);
      competitorsCited = Array.isArray(observation?.competitors_cited) ? (observation?.competitors_cited as string[]) : null;
    }

    if (status === "answered") answered += 1;
    else if (status === "no_answer") noAnswer += 1;
    else if (status === "failed" || status === "blocked") failed += 1;

    facts.push({
      status,
      source,
      brands: factBrands,
      ownMentioned,
      ownCited,
      competitorsCited,
      selfName: String(ws.brand.display_name || ws.brandKey),
      mentionState,
    });

    executions.push({
      answerId: linkRow.id,
      source,
      engine,
      engineLabel: engineLabel(engine),
      collectedAt,
      trigger,
      status,
      ownMentioned,
      ownCited,
      askedText: String(linkRow.asked_text ?? ""),
      scanId: linkRow.scan_id ? String(linkRow.scan_id) : null,
      exploreRunId: linkRow.explore_run_id ? String(linkRow.explore_run_id) : null,
      method,
      quality,
    });
  }

  const summary = summarizeBrands(facts.filter((fact) => fact.source !== "explore"));
  const latestScanId = page.find((row) => row.scan_id)?.scan_id ? String(page.find((row) => row.scan_id)?.scan_id) : null;

  const rangePreset = from || to ? "custom" : "all";
  try {
    deps.trackView?.({ executions: executions.length, range: rangePreset });
  } catch {
    // Telemetry must never fail a read.
  }

  return {
    question: {
      id: String(questionRow.id),
      text: String(questionRow.text ?? ""),
      topic: (questionRow.topic as string | null) ?? null,
      status: String(questionRow.status ?? "active"),
      branded: Boolean(questionRow.branded ?? false),
      origin: String(questionRow.origin ?? "manual"),
      replacedBy: replacedBy ? { id: String(replacedBy.id), text: String(replacedBy.text ?? "") } : null,
      replaces,
    },
    range: { from, to },
    executions,
    summary,
    coverage: { total: executions.length, answered, noAnswer, failed, explore, legacy },
    truncated,
    latestScanId,
  };
}

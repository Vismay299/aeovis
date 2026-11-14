// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/ai-visibility/services/aiVisibilityResults.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.
import { AppError } from "../../http/appError.ts";
import { ANSWER_DISPLAY_LIMIT } from "../../../shared/question-history.ts";
import { safeHttpUrl } from "../../../shared/safe-url.ts";
import { getBrandAliases } from "../../scoring/aliases.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Workspace } from "../../workspace/requireWorkspace.ts";
import { engineLabel, toBooleanOrNull, toMethod, toStatus } from "./history.ts";

export type AnswerDeps = {
  trackOpen?: (props: { engine: string; source: string }) => void;
};

function domainMatches(candidate: string, target: string): boolean {
  if (!candidate || !target) return false;
  return candidate === target || candidate.endsWith(`.${target}`);
}

function normalizeHost(value: string): string {
  return String(value || "").trim().toLowerCase().replace(/^www\./, "");
}

function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

function competitorForDomain(domain: string, competitorsCited: string[] | null): string | null {
  if (!domain || !Array.isArray(competitorsCited)) return null;
  for (const competitor of competitorsCited) {
    const aliases = getBrandAliases(String(competitor), "").map((alias) => String(alias).toLowerCase());
    const parts = domain.split(".");
    const brandWord = parts[parts.length - 2] || parts[0] || "";
    const hit = aliases.some((alias) => {
      if (!alias || alias.length < 3) return false;
      if (alias.includes(".")) return domainMatches(domain, alias);
      return brandWord === alias || parts.includes(alias);
    });
    if (hit) return String(competitor);
  }
  return null;
}

function normalizeSpan(span: unknown, textLength: number): { start: number; end: number } | null {
  if (!span || typeof span !== "object") return null;
  const record = span as { start?: unknown; end?: unknown };
  const start = Number(record.start);
  const end = Number(record.end);
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
  if (!(0 <= start && start < end && end <= textLength)) return null;
  return { start, end };
}

function methodLabelOf(method: string): string {
  if (method === "consumer_capture") return "Consumer app";
  if (method === "model_api") return "Model API";
  if (method === "google_serp") return "Google search";
  return "Unknown method";
}

function publicErrorFor(status: string, state: string | null): string | null {
  if (status === "failed") return "Collection failed. This answer was not measured.";
  if (status === "blocked") return "Collection was not attempted (blocked before a request).";
  if (state === "ambiguous") return "The result of this request is unknown; it may have been charged and will be reconciled.";
  return null;
}

async function readMaybe<T>(query: unknown): Promise<T | null> {
  const result = (await query) as { data: T | null; error: unknown };
  if (result.error) throw result.error;
  return (result.data ?? null) as T | null;
}

async function readAll<T>(query: unknown): Promise<T[]> {
  const result = (await query) as { data: T[] | null; error: unknown };
  if (result.error) throw result.error;
  return Array.isArray(result.data) ? result.data : [];
}

export async function getQuestionAnswer(
  ws: Workspace,
  questionId: string,
  answerId: string,
  deps: AnswerDeps = {},
): Promise<Record<string, unknown>> {
  const admin = ws.admin as unknown as SupabaseClient;
  const brandKey = ws.brandKey;

  let linkRow: Record<string, unknown> | null = null;
  try {
    linkRow = await readMaybe<Record<string, unknown>>(
      admin
        .from("question_answer_links")
        .select("*")
        .eq("id", answerId)
        .eq("question_id", questionId)
        .eq("brand_key", brandKey)
        .maybeSingle(),
    );
  } catch (error) {
    console.error(`[question-history] read failed history_unavailable`);
    throw new AppError(503, "history_unavailable", "Question history could not be loaded. Please retry.", { cause: error });
  }
  if (!linkRow) {
    throw new AppError(404, "answer_not_found", "This answer does not exist in this workspace.");
  }

  const source = String(linkRow.source || "scan");
  const engine = String(linkRow.engine || "");
  const askedText = String(linkRow.asked_text ?? "");
  const collectedAt = String(linkRow.collected_at);

  if (source === "legacy") {
    const legacyId = String(linkRow.prompt_result_id || "");
    let legacyRow: Record<string, unknown> | null = null;
    try {
      legacyRow = await readMaybe<Record<string, unknown>>(
        admin.from("prompt_results").select("*").eq("id", legacyId).maybeSingle(),
      );
    } catch (error) {
      console.error(`[question-history] read failed history_unavailable`);
      throw new AppError(503, "history_unavailable", "Question history could not be loaded. Please retry.", { cause: error });
    }
    const text = String((legacyRow?.answer_text as string | null) ?? "");
    const display = text.length > ANSWER_DISPLAY_LIMIT ? text.slice(0, ANSWER_DISPLAY_LIMIT) : text;
    const truncated = text.length > ANSWER_DISPLAY_LIMIT;
    const legacyRaw = (legacyRow?.raw ?? {}) as Record<string, unknown>;
    const legacyError = (legacyRaw.error as string | null) ?? null;
    const status = toStatus({
      state: null,
      answerPresent: null,
      error: legacyError,
      source,
      legacyAnswered: (legacyRow?.answered as boolean | null) ?? null,
    });
    const legacyMethod = toMethod(legacyRaw.measurement_method);
    try {
      deps.trackOpen?.({ engine, source });
    } catch {
      // Telemetry must never fail a read.
    }
    return {
      execution: {
        answerId: String(linkRow.id),
        source,
        engine,
        engineLabel: engineLabel(engine),
        collectedAt,
        trigger: "legacy",
        status,
        ownMentioned: toBooleanOrNull(legacyRow?.mentioned),
        ownCited: toBooleanOrNull(legacyRow?.brand_cited),
        askedText,
        scanId: linkRow.scan_id ? String(linkRow.scan_id) : null,
        exploreRunId: null,
        method: legacyMethod,
        quality: "legacy_unknown",
      },
      text: display || null,
      markdown: null,
      truncated,
      citations: [],
      brands: [],
      provenance: {
        method: legacyMethod,
        methodLabel: methodLabelOf(legacyMethod),
        gateway: null,
        requestedModel: null,
        returnedModel: null,
        requestedLocation: null,
        searchUsed: "unknown",
      },
      evidence: { state: "legacy_unknown", captures: [] },
      error: publicErrorFor(status, null),
    };
  }

  const observationId = String(linkRow.observation_id || "");
  let observation: Record<string, unknown> | null = null;
  try {
    observation = await readMaybe<Record<string, unknown>>(
      admin.from("probe_observations").select("id,state,reason,result").eq("id", observationId).maybeSingle(),
    );
  } catch (error) {
    console.error(`[question-history] read failed history_unavailable`);
    throw new AppError(503, "history_unavailable", "Question history could not be loaded. Please retry.", { cause: error });
  }
  if (!observation) {
    throw new AppError(404, "answer_not_found", "This answer does not exist in this workspace.");
  }

  const state = String(observation.state || "");
  const result = (observation.result ?? {}) as Record<string, unknown>;
  // Spans index into the plain text; AI Overview rows keep it in `aio_text`.
  const text = String((result.text as string | null) ?? (result.aio_text as string | null) ?? "");
  const markdown = typeof result.answer_markdown === "string" && result.answer_markdown ? result.answer_markdown : null;
  const displaySource = markdown ?? text;
  const truncated = displaySource.length > ANSWER_DISPLAY_LIMIT;
  const cut = (value: string) => (value.length > ANSWER_DISPLAY_LIMIT ? value.slice(0, ANSWER_DISPLAY_LIMIT) : value);

  const errorText = (result.error as string | null) ?? null;
  const answerRaw = result.answer_present;
  const answerPresent = answerRaw === true || answerRaw === "true" ? true : answerRaw === false || answerRaw === "false" ? false : null;
  // Same rule as the history list, so a row and its detail never disagree.
  const status = toStatus({ state, answerPresent, error: errorText, source });
  const publicError = publicErrorFor(status, state);

  let trigger: "manual" | "scheduled" | "explore" = source === "explore" ? "explore" : "manual";
  if (source !== "explore" && linkRow.scan_job_id) {
    try {
      const windowRows = await readAll<Record<string, unknown>>(
        admin.from("measurement_windows").select("job_id").eq("job_id", String(linkRow.scan_job_id)).limit(1),
      );
      if (windowRows.length > 0) trigger = "scheduled";
    } catch (error) {
      console.error(`[question-history] read failed history_unavailable`);
      throw new AppError(503, "history_unavailable", "Question history could not be loaded. Please retry.", { cause: error });
    }
  }

  // Pipelines store `{ href, title, source, domain }` (enginePipeline.js); AI
  // Overview rows keep them in `aio_references`.
  const referenceList = Array.isArray(result.references)
    ? result.references
    : Array.isArray(result.aio_references)
      ? result.aio_references
      : [];
  const references = referenceList as Array<Record<string, unknown>>;
  const competitorsCited = Array.isArray(result.competitors_cited) ? (result.competitors_cited as string[]) : [];
  const host = normalizeHost(String(ws.brand.website_host || ""));
  const citations: Array<Record<string, unknown>> = [];
  references.forEach((entry, index) => {
    const rawUrl = typeof entry.href === "string" ? entry.href : typeof entry.url === "string" ? entry.url : null;
    const url = safeHttpUrl(rawUrl);
    if (!url) return;
    const domain = hostnameOf(url);
    if (!domain) return;
    citations.push({
      url,
      domain,
      title: typeof entry.title === "string" && entry.title ? entry.title : null,
      position: index + 1,
      owned: host ? domainMatches(domain, host) : false,
      competitor: competitorForDomain(domain, competitorsCited),
    });
  });

  const entityEvidence = (result.entity_evidence ?? {}) as Record<string, unknown>;
  const selfMentionedRaw = entityEvidence.mentioned as boolean | null | undefined;
  const selfMentioned = selfMentionedRaw === true ? true : selfMentionedRaw === false ? false : null;
  const selfCited = (result.brand_cited as boolean | null) ?? null;
  const selfSpansRaw = Array.isArray(entityEvidence.spans) ? (entityEvidence.spans as unknown[]) : [];
  const brandsRaw = Array.isArray(result.brands) ? (result.brands as Array<Record<string, unknown>>) : [];
  const selfName = String(ws.brand.display_name || brandKey);

  const brands: Array<Record<string, unknown>> = [];
  brands.push({
    name: selfName,
    isSelf: true,
    mentioned: selfMentioned,
    cited: selfCited,
    position: null,
    relationship: null,
    sentimentLabel: null,
    spans: selfSpansRaw
      .map((span) => normalizeSpan(span, text.length))
      .filter(Boolean)
      .sort((a, b) => (a as { start: number }).start - (b as { start: number }).start)
      .filter((span, index, list) => index === 0 || JSON.stringify(span) !== JSON.stringify(list[index - 1])),
  });
  for (const entry of brandsRaw) {
    if (entry.is_self ?? entry.isSelf) continue;
    const name = String(entry.name ?? "").trim();
    if (!name) continue;
    const spansRaw = Array.isArray(entry.spans) ? (entry.spans as unknown[]) : [];
    brands.push({
      name,
      isSelf: false,
      mentioned: entry.mentioned === true ? true : entry.mentioned === false ? false : null,
      cited: entry.cited === true ? true : entry.cited === false ? false : null,
      position: Number.isInteger(entry.position) ? entry.position : null,
      relationship: typeof entry.relationship === "string" ? entry.relationship : null,
      sentimentLabel: typeof entry.sentiment_label === "string" ? entry.sentiment_label : typeof entry.sentimentLabel === "string" ? entry.sentimentLabel : null,
      spans: spansRaw
        .map((span) => normalizeSpan(span, text.length))
        .filter(Boolean)
        .sort((a, b) => (a as { start: number }).start - (b as { start: number }).start)
        .filter((span, index, list) => index === 0 || JSON.stringify(span) !== JSON.stringify(list[index - 1])),
    });
  }

  const provenance = (result.provenance ?? {}) as Record<string, unknown>;
  const method = toMethod(result.measurement_method ?? provenance.method);
  const methodLabel = methodLabelOf(method);
  const searchStateRaw = String((provenance.search_state as string | null) ?? "unknown");
  const searchUsed = searchStateRaw === "observed_used" || searchStateRaw === "observed_not_used" ? searchStateRaw : "unknown";

  // Mapped as src/app/api/customer/measurement/route.js (captureView /
  // evidence_state): withdrawn > expired > any capture not stored > stored.
  const resultEvidenceState = typeof result.evidence_state === "string" ? result.evidence_state : null;
  let evidenceState: string = resultEvidenceState === "stored" ? "incomplete" : "none";
  let captures: Array<Record<string, unknown>> = [];
  const attemptToken = (result.attempt_id as string | null) ?? null;
  if (attemptToken) {
    let rows: Array<Record<string, unknown>> = [];
    try {
      rows = await readAll<Record<string, unknown>>(
        admin
          .from("measurement_evidence")
          .select("observation_id,attempt_token,capture_index,state,expires_at,reason")
          .eq("observation_id", observationId)
          .eq("attempt_token", attemptToken),
      );
    } catch (error) {
      console.error(`[question-history] read failed history_unavailable`);
      throw new AppError(503, "history_unavailable", "Question history could not be loaded. Please retry.", { cause: error });
    }
    const now = Date.now();
    const views = rows
      .map((capture) => {
        const index = Number(capture.capture_index ?? 0);
        const reason = (capture.reason as string | null) ?? null;
        const expiresAt = capture.expires_at ? String(capture.expires_at) : null;
        let captureState = String(capture.state || "incomplete");
        if (captureState === "stored" && (!expiresAt || !Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= now)) {
          captureState = "expired";
        }
        if (reason === "redaction_retracted") captureState = "withdrawn";
        return { index, reason, state: captureState, expiresAt };
      })
      .sort((x, y) => x.index - y.index);
    if (views.some((view) => view.reason === "redaction_retracted")) evidenceState = "withdrawn";
    else if (views.some((view) => view.state === "expired")) evidenceState = "expired";
    else if (views.some((view) => view.state !== "stored")) evidenceState = "incomplete";
    else if (views.length > 0) evidenceState = "stored";
    captures = views.map((view) => ({
      index: view.index,
      state: view.state,
      href:
        view.state === "stored"
          ? `/api/customer/measurement/evidence?brand_key=${encodeURIComponent(brandKey)}&observation=${encodeURIComponent(observationId)}&attempt=${encodeURIComponent(attemptToken)}&index=${view.index}`
          : null,
      expiresAt: view.expiresAt,
    }));
  }

  try {
    deps.trackOpen?.({ engine, source });
  } catch {
    // Telemetry must never fail a read.
  }

  return {
    execution: {
      answerId: String(linkRow.id),
      source,
      engine,
      engineLabel: engineLabel(engine),
      collectedAt,
      trigger,
      status,
      ownMentioned: toBooleanOrNull(result.brand_mentioned_in_text),
      ownCited: toBooleanOrNull(result.brand_cited),
      askedText,
      scanId: linkRow.scan_id ? String(linkRow.scan_id) : null,
      exploreRunId: linkRow.explore_run_id ? String(linkRow.explore_run_id) : null,
      method,
      quality: "measured",
    },
    text: text ? cut(text) : null,
    markdown: markdown ? cut(markdown) : null,
    truncated,
    citations,
    brands,
    provenance: {
      method,
      methodLabel,
      gateway: (provenance.gateway as string | null) ?? (result.gateway as string | null) ?? null,
      requestedModel: (provenance.requested_model as string | null) ?? (result.requested_model as string | null) ?? null,
      returnedModel: (provenance.returned_model as string | null) ?? (result.returned_model as string | null) ?? null,
      requestedLocation: (provenance.requested_location as string | null) ?? (result.requested_location as string | null) ?? null,
      searchUsed,
    },
    evidence: { state: evidenceState, captures },
    error: publicError,
  };
}

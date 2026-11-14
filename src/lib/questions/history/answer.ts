// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/ai-visibility/services/aiVisibilityResults.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.
import { AppError } from "../../http/appError.ts";
import { ANSWER_DISPLAY_LIMIT } from "../../../shared/question-history.ts";
import { safeHttpUrl } from "../../../shared/safe-url.ts";
import { getBrandAliases } from "../../scoring/aliases.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Workspace } from "../../workspace/requireWorkspace.ts";

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
    const answeredFlag = (legacyRow?.answered as boolean | null) ?? null;
    const status = answeredFlag === true ? "answered" : "no_answer";
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
        engineLabel: engine,
        collectedAt,
        trigger: "legacy",
        status,
        ownMentioned: null,
        ownCited: null,
        askedText,
        scanId: linkRow.scan_id ? String(linkRow.scan_id) : null,
        exploreRunId: null,
        method: "unknown",
        quality: "legacy_unknown",
      },
      text: display || null,
      markdown: null,
      truncated,
      citations: [],
      brands: [],
      provenance: {
        method: "unknown",
        methodLabel: "Unknown method",
        gateway: null,
        requestedModel: null,
        returnedModel: null,
        requestedLocation: null,
        searchUsed: "unknown",
      },
      evidence: { state: "legacy_unknown", captures: [] },
      error: null,
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
  const text = String((result.text as string | null) ?? "");
  const markdown = (result.answer_markdown as string | null) ?? null;
  const displaySource = markdown ?? text;
  const truncated = displaySource.length > ANSWER_DISPLAY_LIMIT;
  const displayText = displaySource.length > ANSWER_DISPLAY_LIMIT ? displaySource.slice(0, ANSWER_DISPLAY_LIMIT) : displaySource;

  const errorText = (result.error as string | null) ?? null;
  let status: string = "unknown";
  if (state === "blocked") status = "blocked";
  else if (state === "failed") status = "failed";
  else if (errorText) status = "failed";
  else if (state === "ambiguous") status = "unknown";
  else if (state === "valid_no_aio") status = "no_answer";
  else if (state === "answered" && text) status = "answered";
  else if (state === "answered") status = "no_answer";

  let publicError: string | null = null;
  if (status === "failed") publicError = "Collection failed. This answer was not measured.";
  else if (status === "blocked") publicError = "Collection was not attempted (blocked before a request).";
  else if (status === "unknown") publicError = "The result of this request is unknown; it may have been charged and will be reconciled.";

  const references = Array.isArray(result.references) ? (result.references as Array<Record<string, unknown>>) : [];
  const competitorsCited = Array.isArray(result.competitors_cited) ? (result.competitors_cited as string[]) : [];
  const host = normalizeHost(String(ws.brand.website_host || ""));
  const citations: Array<Record<string, unknown>> = [];
  references.forEach((entry, index) => {
    const url = safeHttpUrl(typeof entry.url === "string" ? entry.url : null);
    if (!url) return;
    const domain = hostnameOf(url);
    if (!domain) return;
    citations.push({
      url,
      domain,
      title: typeof entry.title === "string" ? entry.title : null,
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
  const methodRaw = String((result.measurement_method as string | null) ?? (provenance.method as string | null) ?? "unknown");
  const method = methodRaw === "consumer_capture" || methodRaw === "model_api" || methodRaw === "google_serp" ? methodRaw : "unknown";
  const methodLabel = method === "consumer_capture" ? "Consumer app" : method === "model_api" ? "Model API" : method === "google_serp" ? "Google search" : "Unknown method";
  const searchStateRaw = String((provenance.search_state as string | null) ?? "unknown");
  const searchUsed = searchStateRaw === "observed_used" || searchStateRaw === "observed_not_used" ? searchStateRaw : "unknown";

  let evidenceState: string = "incomplete";
  let captures: Array<Record<string, unknown>> = [];
  const attemptToken = (result.attempt_id as string | null) ?? null;
  if (attemptToken) {
    try {
      const rows = await readAll<Record<string, unknown>>(
        admin
          .from("measurement_evidence")
          .select("observation_id,attempt_token,capture_index,state,expires_at,reason")
          .eq("observation_id", observationId)
          .eq("attempt_token", attemptToken),
      );
      const now = Date.now();
      captures = rows.map((capture) => {
        const index = Number(capture.capture_index ?? 0);
        const reason = (capture.reason as string | null) ?? null;
        let captureState = String(capture.state || "incomplete");
        if (reason === "redaction_retracted") captureState = "withdrawn";
        else if (captureState === "stored") {
          const expiresAt = capture.expires_at ? String(capture.expires_at) : null;
          const remaining = expiresAt ? Date.parse(expiresAt) - now : NaN;
          if (!expiresAt || !Number.isFinite(remaining) || remaining < 1000) captureState = "expired";
        }
        const stored = captureState === "stored";
        return {
          index,
          state: captureState,
          href: stored
            ? `/api/customer/measurement/evidence?brand_key=${encodeURIComponent(brandKey)}&observation=${encodeURIComponent(observationId)}&attempt=${encodeURIComponent(attemptToken)}&index=${index}`
            : null,
          expiresAt: capture.expires_at ? String(capture.expires_at) : null,
        };
      });
      if (captures.some((capture) => capture.reason === "redaction_retracted" || capture.state === "withdrawn")) {
        evidenceState = "withdrawn";
      } else if (captures.some((capture) => capture.state === "expired")) {
        evidenceState = "expired";
      } else if (captures.some((capture) => capture.state === "stored")) {
        evidenceState = "stored";
      } else {
        evidenceState = "incomplete";
      }
    } catch (error) {
      console.error(`[question-history] read failed history_unavailable`);
      throw new AppError(503, "history_unavailable", "Question history could not be loaded. Please retry.", { cause: error });
    }
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
      engineLabel: engine,
      collectedAt,
      trigger: source === "explore" ? "explore" : "manual",
      status,
      ownMentioned: selfMentioned,
      ownCited: selfCited,
      askedText,
      scanId: linkRow.scan_id ? String(linkRow.scan_id) : null,
      exploreRunId: linkRow.explore_run_id ? String(linkRow.explore_run_id) : null,
      method,
      quality: "measured",
    },
    text: displayText || null,
    markdown: markdown ? (markdown.length > ANSWER_DISPLAY_LIMIT ? markdown.slice(0, ANSWER_DISPLAY_LIMIT) : markdown) : null,
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

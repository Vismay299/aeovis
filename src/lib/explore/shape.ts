// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/ai-search/services/promptExplorer.ts:198-359
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { createHash } from "node:crypto";
import { safeHttpUrl, safeHostname } from "../../shared/safe-url.ts";
import {
  type ExploreCitation,
  type ExploreErrorResult,
  type ExploreModel,
  type ExploreSuccessResult,
  exploreModelLabel,
  normalizePrompt,
} from "../../shared/explore.ts";

export function hashPrompt(prompt: string): string {
  return createHash("sha256").update(normalizePrompt(prompt)).digest("hex");
}

export type RawLlmSection = {
  text?: string | null;
  annotations?: Array<{ title?: string | null; url?: string | null }> | null;
};

export type RawLlmItem = {
  type?: string | null;
  sections?: RawLlmSection[] | null;
};

export type RawLlmResponse = {
  model_name?: string | null;
  items?: RawLlmItem[] | null;
  fan_out_queries?: string[] | null;
  output_tokens?: number | null;
  web_search?: boolean | null;
  text?: string | null;
  references?: Array<{ href?: string | null; url?: string | null; title?: string | null; source?: string | null }> | null;
  citations?: string[] | null;
  choices?: Array<{ message?: { content?: string | null; annotations?: Array<{ title?: string | null; url?: string | null }> | null } }> | null;
  usage?: { completion_tokens?: number | null; cost?: number | null; server_tool_use?: { web_search_requests?: number | null } } | null;
  search_requests?: number | null;
  cost?: number | null;
  meta?: { fanOut?: string[] | null } | null;
};

export function extractText(response: RawLlmResponse | null | undefined): string {
  if (!response) return "";

  if (Array.isArray(response.items)) {
    const textParts: string[] = [];
    for (const item of response.items) {
      if (item?.type !== "message") continue;
      for (const section of item?.sections ?? []) {
        if (typeof section?.text === "string" && section.text.length > 0) {
          textParts.push(section.text);
        }
      }
    }
    const joined = textParts.join("\n\n").trim();
    if (joined) return joined;
  }

  if (typeof response.text === "string" && response.text.trim()) {
    return response.text.trim();
  }

  if (Array.isArray(response.choices) && response.choices[0]?.message?.content) {
    return response.choices[0].message.content.trim();
  }

  return "";
}

export function extractCitations(response: RawLlmResponse | null | undefined): ExploreCitation[] {
  if (!response) return [];

  const seen = new Set<string>();
  const citations: ExploreCitation[] = [];

  // Extract from items -> sections -> annotations
  if (Array.isArray(response.items)) {
    for (const item of response.items) {
      if (item?.type !== "message") continue;
      for (const section of item?.sections ?? []) {
        for (const annotation of section?.annotations ?? []) {
          const rawUrl = annotation?.url;
          const safeUrl = safeHttpUrl(rawUrl);
          if (!safeUrl || seen.has(safeUrl)) continue;
          seen.add(safeUrl);
          citations.push({
            url: safeUrl,
            domain: safeHostname(safeUrl),
            title: annotation?.title ?? null,
            matchedBrand: false,
          });
        }
      }
    }
  }

  // Extract from choices -> message -> annotations
  if (Array.isArray(response.choices)) {
    for (const choice of response.choices) {
      for (const annotation of choice?.message?.annotations ?? []) {
        const rawUrl = annotation?.url;
        const safeUrl = safeHttpUrl(rawUrl);
        if (!safeUrl || seen.has(safeUrl)) continue;
        seen.add(safeUrl);
        citations.push({
          url: safeUrl,
          domain: safeHostname(safeUrl),
          title: annotation?.title ?? null,
          matchedBrand: false,
        });
      }
    }
  }

  // Extract from references
  if (Array.isArray(response.references)) {
    for (const ref of response.references) {
      const rawUrl = ref?.href ?? ref?.url;
      const safeUrl = safeHttpUrl(rawUrl);
      if (!safeUrl || seen.has(safeUrl)) continue;
      seen.add(safeUrl);
      citations.push({
        url: safeUrl,
        domain: safeHostname(safeUrl),
        title: ref?.title ?? null,
        matchedBrand: false,
      });
    }
  }

  return citations.slice(0, 25);
}

export function matchesBrand(
  url: string,
  title: string | null | undefined,
  brand: string | null | undefined,
): boolean {
  if (!brand || !brand.trim()) return false;
  const needle = brand.trim().toLowerCase();
  const haystack = `${url} ${title ?? ""}`.toLowerCase();
  return haystack.includes(needle);
}

export function mentionRegex(brand: string): RegExp {
  const trimmed = brand.trim();
  if (!trimmed) return /(?!)/;
  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const firstEscaped = trimmed[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const lastEscaped = trimmed[trimmed.length - 1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const leading = /^\w/.test(trimmed) ? "\\b" : `(?<!${firstEscaped})`;
  const trailing = /\w$/.test(trimmed) ? "\\b" : `(?!${lastEscaped})`;
  return new RegExp(`${leading}${escaped}${trailing}`, "i");
}

export function computeBrandMentioned(
  text: string,
  citations: ExploreCitation[],
  brand: string | null | undefined,
): boolean | null {
  if (!brand || !brand.trim()) return null;
  if (citations.some((c) => matchesBrand(c.url, c.title, brand))) return true;
  return mentionRegex(brand).test(text);
}

export function computeWorkspaceBrandMentioned(
  text: string,
  citations: ExploreCitation[],
  aliases: string[] | null | undefined,
): boolean {
  if (!aliases || aliases.length === 0) return false;
  for (const alias of aliases) {
    if (computeBrandMentioned(text, citations, alias) === true) {
      return true;
    }
  }
  return false;
}

export function shapeExploreSuccess(params: {
  model: ExploreModel;
  route: "dataforseo" | "openrouter";
  modelName: string | null;
  response: RawLlmResponse;
  highlightBrand?: string | null;
  workspaceAliases?: string[];
  countryHint?: string | null;
  costUsd: number;
  costState: "measured" | "estimated" | "zero" | "unknown";
  reusedFrom?: { observationId: string; runId: string; observedAt: string } | null;
  observationId: string;
  observedAt?: string | null;
}): ExploreSuccessResult {
  const text = extractText(params.response);
  const rawCitations = extractCitations(params.response);

  const citations = rawCitations.map((c) => ({
    ...c,
    matchedBrand: matchesBrand(c.url, c.title, params.highlightBrand),
  }));

  const fanOut =
    params.response.fan_out_queries ??
    params.response.meta?.fanOut ??
    [];
  const fanOutQueries = fanOut.slice(0, 20);
  const fanOutReported = Array.isArray(params.response.fan_out_queries) && params.response.fan_out_queries.length > 0;

  const rawTokens = params.response.output_tokens ?? params.response.usage?.completion_tokens;
  const outputTokens = typeof rawTokens === "number" && !Number.isNaN(rawTokens) ? Math.round(rawTokens) : null;

  const webSearch =
    params.response.web_search ??
    (typeof params.response.search_requests === "number" && params.response.search_requests > 0) ??
    (typeof params.response.usage?.server_tool_use?.web_search_requests === "number" &&
      params.response.usage.server_tool_use.web_search_requests > 0) ??
    false;

  const brandMentioned = params.highlightBrand
    ? computeBrandMentioned(text, citations, params.highlightBrand) === true
    : false;

  const workspaceBrandMentioned = computeWorkspaceBrandMentioned(
    text,
    citations,
    params.workspaceAliases,
  );

  return {
    status: "success",
    model: params.model,
    label: exploreModelLabel(params.model),
    route: params.route,
    modelName: params.modelName ?? params.response.model_name ?? null,
    text,
    truncated: false,
    citations,
    fanOutQueries,
    fanOutReported,
    brandMentioned,
    workspaceBrandMentioned,
    outputTokens,
    webSearch,
    countryHint: params.countryHint ?? null,
    costUsd: params.costUsd,
    costState: params.costState,
    reusedFrom: params.reusedFrom ?? null,
    observationId: params.observationId,
    observedAt: params.observedAt ?? null,
  };
}

export function shapeExploreError(params: {
  model: ExploreModel;
  errorCode: "UPSTREAM_ERROR" | "UNSUPPORTED_COUNTRY" | "NOT_AVAILABLE" | "COLLECTION_PAUSED";
  message: string;
  costUsd?: number;
}): ExploreErrorResult {
  return {
    status: "error",
    model: params.model,
    label: exploreModelLabel(params.model),
    errorCode: params.errorCode,
    message: params.message,
    costUsd: params.costUsd ?? 0,
  };
}

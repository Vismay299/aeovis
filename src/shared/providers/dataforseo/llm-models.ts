// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/lib/dataforseo/llm-models.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { z } from "zod";
import { dataforseoGet, type DataforseoRequestOptions } from "./core.ts";
import { assertOk } from "./envelope.ts";

export type LlmResponseModelSlug =
  | "chat_gpt"
  | "claude"
  | "gemini"
  | "perplexity";

export const FALLBACK_MODEL_NAMES: Record<LlmResponseModelSlug, string[]> = {
  chat_gpt: ["gpt-5.6-luna", "gpt-5.5", "gpt-5.4", "gpt-5.2", "gpt-5.1", "gpt-5"],
  claude: ["claude-sonnet-5", "claude-sonnet-4-6", "claude-sonnet-4-5"],
  gemini: ["gemini-2.5-pro"],
  perplexity: ["sonar-reasoning-pro", "sonar-pro", "sonar"],
};

export const PINNED_MODEL_NAMES: Partial<Record<LlmResponseModelSlug, string>> = {
  chat_gpt: "gpt-5.6-luna",
  claude: "claude-sonnet-5",
};

const LATEST_RULES: Record<LlmResponseModelSlug, RegExp> = {
  chat_gpt: /^gpt-(\d+(?:\.\d+)*)$/,
  claude: /^claude-sonnet-(\d+(?:-\d+)*)$/,
  gemini: /^gemini-(\d+(?:\.\d+)*)-pro$/,
  perplexity: /^sonar-reasoning-pro$/,
};

const catalogRowSchema = z.looseObject({ model_name: z.string() });
const CATALOG_TTL_MS = 60 * 60 * 1000;

export type LlmModelCatalogCache = Map<
  LlmResponseModelSlug,
  { names: string[]; fetchedAt: number }
>;

export type LlmModelDependencies = {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  now?: () => number;
  cache?: LlmModelCatalogCache;
};

const catalogCache: LlmModelCatalogCache = new Map();

function compareVersions(a: number[], b: number[]): number {
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function pickLatest(slug: LlmResponseModelSlug, names: string[]): string {
  const pinned = PINNED_MODEL_NAMES[slug];
  if (pinned && names.includes(pinned)) return pinned;

  const rule = LATEST_RULES[slug];
  let best: { name: string; version: number[] } | null = null;
  for (const name of names) {
    const match = rule.exec(name);
    if (!match) continue;
    const version = (match[1] ?? "0").split(/[.-]/).map(Number);
    if (!best || compareVersions(version, best.version) > 0) {
      best = { name, version };
    }
  }

  const fallback = FALLBACK_MODEL_NAMES[slug];
  return best?.name ?? fallback.find((name) => names.includes(name)) ?? fallback[0];
}

function requestOptions(deps: LlmModelDependencies): DataforseoRequestOptions {
  return { env: deps.env, fetchImpl: deps.fetchImpl };
}

function currentTime(deps: LlmModelDependencies): number {
  return deps.now?.() ?? Date.now();
}

async function getModelNames(
  slug: LlmResponseModelSlug,
  deps: LlmModelDependencies,
): Promise<string[]> {
  const cache = deps.cache ?? catalogCache;
  const now = currentTime(deps);
  const cached = cache.get(slug);
  if (cached && now - cached.fetchedAt < CATALOG_TTL_MS) return cached.names;

  try {
    const response = await dataforseoGet(
      "/v3/ai_optimization/" + slug + "/llm_responses/models",
      requestOptions(deps),
    );
    const task = assertOk(response);
    const names = (task.result ?? []).flatMap((row) => {
      const parsed = catalogRowSchema.safeParse(row);
      return parsed.success ? [parsed.data.model_name] : [];
    });
    if (names.length === 0) return FALLBACK_MODEL_NAMES[slug];
    cache.set(slug, { names, fetchedAt: currentTime(deps) });
    return names;
  } catch {
    return FALLBACK_MODEL_NAMES[slug];
  }
}

function listedOverride(
  slug: LlmResponseModelSlug,
  names: string[],
  deps: LlmModelDependencies,
): string | null {
  const env = deps.env ?? process.env;
  const name = env["DATAFORSEO_LLM_MODEL_" + slug.toUpperCase()]?.trim();
  if (!name) return null;
  if (names.includes(name)) return name;
  console.warn("[dataforseo] model override not in catalogue", { slug });
  return null;
}

export async function resolveLatestLlmModelName(
  slug: LlmResponseModelSlug,
  deps: LlmModelDependencies = {},
): Promise<string> {
  const names = await getModelNames(slug, deps);
  return listedOverride(slug, names, deps) ?? pickLatest(slug, names);
}

export async function isKnownLlmModelName(
  slug: LlmResponseModelSlug,
  name: string,
  deps: LlmModelDependencies = {},
): Promise<boolean> {
  return (await getModelNames(slug, deps)).includes(name);
}

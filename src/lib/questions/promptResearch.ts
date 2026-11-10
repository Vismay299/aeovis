// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/ai-visibility/services/aiPromptResearch.ts:38-335
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { createHash } from "node:crypto";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Workspace } from "../workspace/requireWorkspace.ts";
import { AppError } from "../http/errors.ts";
import { cached } from "../cache/providerCache.ts";
import { createDataforseoClient } from "../providers/dataforseo/client.ts";
import { llmObject } from "../llm/index.ts";
import { RELEVANCE_SYSTEM } from "./setup/prompts.ts";
import { canonicalQuestionText, normalizeQuestionText, listWorkspaceQuestions, readQuestionSettings } from "./workspaceQuestions.ts";
import { matchesBrandAlias } from "../repairs/workflow.js";
import { getBrandAliases } from "../scoring/aliases.js";
import { createProjectContextRepository } from "../projectContext/repository.ts";
import { appendResearch, findRecentResearch } from "../projectContext/service.ts";

export const researchBody = z.strictObject({
  brand_key: z.string().min(1).max(200).optional(),
  requestId: z.string().uuid(),
  keyword: z.string().trim().min(1).max(100),
  maxUsd: z.number().positive().max(1000).optional(),
});

export type ResearchBody = z.infer<typeof researchBody>;

export type ResearchSource = {
  domain: string;
  url: string;
  title: string;
  own: boolean;
};

export type ResearchedQuestion = {
  text: string;
  variants: string[];
  sources: ResearchSource[];
  ownDomainCited: boolean;
  brandMentioned: boolean;
  tracked: boolean;
};

export type ResearchResult = {
  keyword: string;
  questions: ResearchedQuestion[];
  recent: { entryDate: string; summary: string } | null;
  dataset: "us-en";
};

export type PromptResearchDeps = {
  dataforseoClient?: ReturnType<typeof createDataforseoClient>;
  llmObject?: typeof llmObject;
  cached?: typeof cached;
  appendResearch?: typeof appendResearch;
  findRecentResearch?: typeof findRecentResearch;
  listWorkspaceQuestions?: typeof listWorkspaceQuestions;
  readQuestionSettings?: typeof readQuestionSettings;
  repo?: ReturnType<typeof createProjectContextRepository>;
};

export function words(text: string): string[] {
  return normalizeQuestionText(text)
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((word) =>
      word.length > 3 && word.endsWith("s") && !word.endsWith("ss")
        ? word.slice(0, -1)
        : word,
    );
}

export function mergeKey(question: string): string {
  return words(question.replace(/\b(?:in\s+|for\s+)?(?:19|20)\d{2}\b/g, " "))
    .filter((word) => !["a", "an", "any", "the"].includes(word))
    .join(" ");
}

export function capitalize(text: string): string {
  if (!text) return "";
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function mergeNearDuplicates<T extends { question: string; volume: number }>(prompts: T[]): T[][] {
  const sorted = [...prompts].sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0));
  const groups = new Map<string, T[]>();
  for (const prompt of sorted) {
    const key = mergeKey(prompt.question);
    const existing = groups.get(key);
    if (existing) {
      existing.push(prompt);
    } else {
      groups.set(key, [prompt]);
    }
  }
  return [...groups.values()];
}

const cachedMentionItemSchema = z.object({
  question: z.string(),
  answer: z.string().optional(),
  volume: z.number().default(0),
  sources: z
    .array(
      z.object({
        domain: z.string(),
        url: z.string(),
        title: z.string().optional(),
      }),
    )
    .default([]),
});

type CachedMentionItem = z.infer<typeof cachedMentionItemSchema>;

const cachedDatasetSchema = z.array(cachedMentionItemSchema);

function normalizeDomain(raw: string): string {
  let host = raw.trim().toLowerCase();
  if (host.startsWith("http://") || host.startsWith("https://")) {
    try {
      host = new URL(host).hostname;
    } catch {
      // ignore
    }
  }
  return host.replace(/^www\./, "");
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export async function researchQuestions(
  admin: SupabaseClient,
  ws: Workspace,
  input: ResearchBody,
  deps?: PromptResearchDeps,
): Promise<ResearchResult> {
  const keyword = input.keyword.trim();
  const keywordNormalized = normalizeQuestionText(keyword);
  const keywordWords = words(keyword);
  const matchType = keywordWords.length <= 3 ? ("partial_match" as const) : ("word_match" as const);

  const client = deps?.dataforseoClient ?? createDataforseoClient();
  const cacheFn = deps?.cached ?? cached;
  const llmObjectFn = deps?.llmObject ?? llmObject;

  // 1. Fetch or cache the global dataset
  let datasetHit = false;
  let dataset: CachedMentionItem[] = [];
  try {
    const datasetOutcome = await cacheFn<CachedMentionItem[]>(
      {
        namespace: "questions.research.dataset",
        version: 1,
        keyParts: [keywordNormalized, "chat_gpt", 2840, "en"],
        ttlSeconds: 86400,
        schema: cachedDatasetSchema,
        scope: "global",
      },
      async () => {
        const raw = await client.aiSearch.mentionsSearch(
          {
            brandKey: ws.brandKey,
            feature: "questions.research",
            idempotencyKey: `questions.research:${input.requestId}:dataset`,
            maxUsd: input.maxUsd,
          },
          {
            target: {
              keyword,
              search_scope: ["question", "answer"],
              match_type: matchType,
            },
            platform: "chat_gpt",
            locationCode: 2840,
            languageCode: "en",
            limit: 100,
            orderBy: ["ai_search_volume,desc"],
          },
        );

        return (raw || []).map((item) => ({
          question: item.question ?? "",
          answer: item.answer ?? "",
          volume: item.ai_search_volume ?? 0,
          sources: (item.sources || []).map((s) => ({
            domain: s.domain ?? "",
            url: s.url ?? "",
            title: s.title ?? "",
          })),
        }));
      },
    );
    datasetHit = datasetOutcome.hit;
    dataset = datasetOutcome.value;
  } catch (err: any) {
    if (err?.code === "duplicate_paid_call" || err?.status === 402 || err?.status === 403) {
      throw err;
    }
    throw new AppError(
      502,
      "research_unavailable",
      "Question research is unavailable right now. Please retry.",
      { cause: err },
    );
  }

  // Read F07 overview for relevance filtering
  const repo = deps?.repo ?? createProjectContextRepository(admin);
  const sections = await repo.listSections(ws.brandKey);
  const overviewSection = sections.find((s) => s.key === "business_overview");
  const overview = (overviewSection?.content ?? "").slice(0, 3500);

  // Read previous research before appending
  const findRecent = deps?.findRecentResearch ?? findRecentResearch;
  const recentRow = await findRecent(admin, {
    brandKey: ws.brandKey,
    kind: "questions.research",
    researchKey: keyword,
    days: 90,
  });

  const recent = recentRow
    ? {
        entryDate: recentRow.entryDate,
        summary: recentRow.summary,
      }
    : null;

  // If dataset returned no items, return empty questions early
  if (dataset.length === 0) {
    if (!datasetHit) {
      const appendFn = deps?.appendResearch ?? appendResearch;
      try {
        await appendFn(admin, {
          brandKey: ws.brandKey,
          kind: "questions.research",
          researchKey: keyword,
          summary: `Question research for "${keyword}": 0 relevant questions.`,
          author: "user",
          actorUserId: ws.user.id,
        });
      } catch {
        // Best-effort logging does not turn a measured zero into an outage.
      }
    }
    return {
      keyword,
      questions: [],
      recent,
      dataset: "us-en",
    };
  }

  // 2. Relevance check
  const relevancePromptPayload = {
    overview,
    keyword,
    questions: dataset.map((item, index) => ({
      id: String(index),
      question: item.question,
      answerSnippet: (item.answer || "").slice(0, 300),
    })),
  };
  const promptJson = JSON.stringify(relevancePromptPayload);
  const promptHash = sha256(promptJson);

  let relevanceHit = false;
  let relevantIds: string[] = [];
  try {
    const relevanceOutcome = await cacheFn<string[]>(
      {
        namespace: "questions.research.relevance",
        version: 1,
        keyParts: [promptHash],
        ttlSeconds: 86400,
        schema: z.array(z.string()),
        scope: "workspace",
        brandKey: ws.brandKey,
      },
      async () => {
        const { object } = await llmObjectFn<{ relevantIds: string[] }>({
          brandKey: ws.brandKey,
          feature: "questions.research",
          schema: z.strictObject({
            relevantIds: z.array(z.string()),
          }),
          system: RELEVANCE_SYSTEM,
          prompt: promptJson,
          maxOutputTokens: 4000,
          timeoutMs: 60000,
          idempotencyKey: `questions.research:${input.requestId}:relevance`,
          maxUsd: input.maxUsd,
        });
        return object.relevantIds;
      },
    );
    relevanceHit = relevanceOutcome.hit;
    relevantIds = relevanceOutcome.value;
  } catch (err: any) {
    if (err?.code === "duplicate_paid_call" || err?.status === 402 || err?.status === 403) {
      throw err;
    }
    throw new AppError(
      502,
      "research_unavailable",
      "Question research is unavailable right now. Please retry.",
      { cause: err },
    );
  }

  const relevantSet = new Set(relevantIds);
  const filteredPrompts = dataset.filter((_item, index) => relevantSet.has(String(index)));

  // Read unarchived workspace questions and aliases for flags
  const listQuestions = deps?.listWorkspaceQuestions ?? listWorkspaceQuestions;
  const allWorkspaceQuestions = await listQuestions(admin, ws.brandKey);
  const unarchived = allWorkspaceQuestions.filter((q) => q.status !== "archived");
  const trackedNormalized = new Set(unarchived.map((q) => q.textNormalized));

  const aliases = ws.brand.aliases?.length
    ? ws.brand.aliases
    : getBrandAliases(ws.brand.display_name, ws.brand.website);
  const ownHost = normalizeDomain(ws.brand.website_host || ws.brand.website || "");

  // Near duplicate merge
  const groups = mergeNearDuplicates(filteredPrompts);

  const questions: ResearchedQuestion[] = groups.slice(0, 100).map((group) => {
    const lead = group[0];
    const text = capitalize(lead.question);
    const variants = group.slice(1).map((g) => capitalize(g.question));

    // Unique sources by URL
    const sourceMap = new Map<string, ResearchSource>();
    for (const item of group) {
      for (const s of item.sources) {
        if (!sourceMap.has(s.url)) {
          const sDomain = normalizeDomain(s.domain);
          const own = Boolean(
            ownHost && (sDomain === ownHost || sDomain.endsWith("." + ownHost)),
          );
          sourceMap.set(s.url, {
            domain: s.domain,
            url: s.url,
            title: s.title || s.domain,
            own,
          });
        }
      }
    }
    const sources = Array.from(sourceMap.values());
    const ownDomainCited = sources.some((s) => s.own);
    const brandMentioned = group.some((item) =>
      Boolean(item.answer && matchesBrandAlias(item.answer, aliases)),
    );
    const tracked = trackedNormalized.has(normalizeQuestionText(lead.question));

    return {
      text,
      variants,
      sources,
      ownDomainCited,
      brandMentioned,
      tracked,
    };
  });

  // If either cache missed, append research log (F08-AC-18)
  if (!datasetHit || !relevanceHit) {
    const appendFn = deps?.appendResearch ?? appendResearch;
    try {
      await appendFn(admin, {
        brandKey: ws.brandKey,
        kind: "questions.research",
        researchKey: keyword,
        summary: `Question research for "${keyword}": ${questions.length} relevant questions.`,
        author: "user",
        actorUserId: ws.user.id,
      });
    } catch {
      // best-effort append
    }
  }

  return {
    keyword,
    questions,
    recent,
    dataset: "us-en",
  };
}

export async function listResearchKeywords(
  admin: SupabaseClient,
  brandKey: string,
  deps?: PromptResearchDeps,
): Promise<{ keywords: string[] }> {
  const readSettings = deps?.readQuestionSettings ?? readQuestionSettings;
  const listQuestions = deps?.listWorkspaceQuestions ?? listWorkspaceQuestions;

  const [settings, questions] = await Promise.all([
    readSettings(admin, brandKey),
    listQuestions(admin, brandKey, { statuses: ["active"] }),
  ]);

  const keywords: string[] = [];
  const seen = new Set<string>();

  const add = (raw: string) => {
    const k = raw.trim();
    if (!k) return;
    const norm = k.toLowerCase();
    if (seen.has(norm)) return;
    seen.add(norm);
    keywords.push(k);
  };

  for (const k of settings.researchKeywords || []) {
    add(k);
  }

  for (const q of questions) {
    if (q.topic && q.topic.trim().toLowerCase() !== "general") {
      add(q.topic);
    }
  }

  return { keywords: keywords.slice(0, 45) };
}

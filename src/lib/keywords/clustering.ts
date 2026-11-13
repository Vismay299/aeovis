// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   .agents/skills/keyword-clustering/SKILL.md (ideas only)
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { z } from "zod";
import { llmObject } from "../llm/index.ts";
import type { LlmDeps } from "../llm/index.ts";
import { appendResearch } from "../projectContext/service.ts";
import { getProjectContextByKey, renderProjectContextMarkdown } from "../projectContext/service.ts";
import { createSavedKeywordsRepository, type SavedKeywordsRepository } from "./repository.ts";
import { getSupabaseAdmin } from "../supabase/admin.js";
import { AppError } from "../http/errors.ts";
import { LONG_PAID_STEP } from "../jobs/stepConfigs.ts";
import { jobStepKey } from "../jobs/runner.ts";

export const CLUSTER_SYSTEM =
  "You group search keywords into page-level topics for one website. Put keywords together only when one page could satisfy all of them: same searcher intent and buyer stage. Similar words do not guarantee the same topic. Name each topic in 2–5 plain words. Use every keyword index exactly once. If a page from the site context fits a topic, give its URL as targetPage; otherwise use null. Do not invent volumes.";

export const clusterOutputSchema = z.strictObject({
  clusters: z
    .array(
      z.strictObject({
        name: z.string().min(1).max(64),
        intent: z.enum([
          "informational",
          "commercial",
          "transactional",
          "navigational",
          "mixed",
        ]),
        priority: z.enum(["high", "medium", "low"]),
        targetPage: z.string().max(300).nullable(),
        rationale: z.string().max(300),
        keywordIndexes: z.array(z.number().int().min(0)).min(1),
      }),
    )
    .min(1)
    .max(60),
});

export type ClusterOutput = z.infer<typeof clusterOutputSchema>;

export type ValidatedCluster = {
  name: string;
  intent: ClusterOutput["clusters"][number]["intent"];
  priority: ClusterOutput["clusters"][number]["priority"];
  targetPage: string | null;
  rationale: string;
  keywordIndexes: number[];
};

export type ClusterJobResult = {
  clusters: Array<{
    name: string;
    intent: ValidatedCluster["intent"];
    priority: ValidatedCluster["priority"];
    targetPage: string | null;
    rationale: string;
    savedKeywordIds: string[];
  }>;
  unsorted: string[];
  model: string;
  usd: number | null;
};

export type ClusterKeywordRow = {
  id: string;
  keyword: string;
  searchVolume: number | null;
  keywordDifficulty: number | null;
  intent: string;
};

export function validateClusters(
  output: ClusterOutput,
  n: number,
): { clusters: ValidatedCluster[]; unsorted: number[] } {
  const used = new Set<number>();
  const clusters: ValidatedCluster[] = [];
  const seenNames = new Set<string>();

  for (const c of output.clusters) {
    const idxs: number[] = [];
    for (const i of c.keywordIndexes) {
      if (i < 0 || i >= n) continue;
      if (used.has(i)) continue;
      used.add(i);
      idxs.push(i);
    }
    if (idxs.length === 0) continue;

    let name = c.name.trim().replace(/\s+/g, " ");
    const lower = name.toLowerCase();
    if (seenNames.has(lower)) {
      name = `${name} (2)`;
    }
    seenNames.add(name.toLowerCase());

    clusters.push({
      name,
      intent: c.intent,
      priority: c.priority,
      targetPage: c.targetPage,
      rationale: c.rationale,
      keywordIndexes: idxs,
    });
  }

  const unsorted: number[] = [];
  for (let i = 0; i < n; i++) {
    if (!used.has(i)) unsorted.push(i);
  }

  return { clusters, unsorted };
}

export function buildClusterPrompt(
  keywords: Array<{
    keyword: string;
    searchVolume: number | null;
    keywordDifficulty: number | null;
    intent: string;
  }>,
  contextMarkdown: string,
): string {
  const lines = keywords
    .map(
      (r, i) =>
        `${i} | ${r.keyword} | vol ${r.searchVolume ?? "unknown"} | kd ${r.keywordDifficulty ?? "unknown"} | ${r.intent}`,
    )
    .join("\n");
  const ctx = contextMarkdown?.trim()
    ? `\n\nSite context:\n${contextMarkdown.trim()}`
    : "";
  return `Keywords:\n${lines}${ctx}`;
}

export function estimateClusterPromptChars(
  keywords: Array<{ keyword: string }>,
): number {
  return keywords.reduce((sum, k) => sum + k.keyword.length + 24, 0);
}

export type ClusterJobDeps = {
  admin?: any;
  repo?: SavedKeywordsRepository;
  llmObject?: typeof llmObject;
  getProjectContextByKey?: typeof getProjectContextByKey;
  renderProjectContextMarkdown?: typeof renderProjectContextMarkdown;
  appendResearch?: typeof appendResearch;
  now?: () => Date;
};

export async function runClusterJob(
  ctx: {
    jobId: string;
    brandKey: string;
    payload: { savedKeywordIds: string[]; approvedMaxUsd: number; requestedBy: string };
    step?: { do<T>(name: string, options: unknown, fn: () => Promise<T>): Promise<T> };
  },
  deps?: ClusterJobDeps,
): Promise<{ status: "completed"; result: ClusterJobResult }> {
  const admin =
    deps?.admin ??
    (typeof getSupabaseAdmin === "function" ? getSupabaseAdmin() : null);
  const repo =
    deps?.repo ?? (admin ? createSavedKeywordsRepository(admin) : null);
  if (!repo) {
    throw new Error("Saved keywords repository is unavailable.");
  }
  const doLlmObject = deps?.llmObject ?? llmObject;
  const doGetContext = deps?.getProjectContextByKey ?? getProjectContextByKey;
  const doRender = deps?.renderProjectContextMarkdown ?? renderProjectContextMarkdown;
  const doAppend = deps?.appendResearch ?? appendResearch;

  const brandKey = ctx.brandKey;
  const ids = ctx.payload.savedKeywordIds;
  const approvedMaxUsd = ctx.payload.approvedMaxUsd;
  const requestedBy = ctx.payload.requestedBy;

  // Spec §6.3: one billed, single-attempt "cluster" step. A replayed job
  // gets the memoised proposal back instead of paying for the call again.
  const runStep = async () => {
    // Read saved keywords (with metrics) via repository list, filter by ids.
    const listed = await repo.list({
      brandKey,
      pageSize: 5000,
    });
    const idSet = new Set(ids);
    const rows = listed.rows
      .filter((r) => idSet.has(r.id))
      .sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));

    const keywordRows: ClusterKeywordRow[] = rows.map((r) => ({
      id: r.id,
      keyword: r.keyword,
      searchVolume: r.searchVolume ?? null,
      keywordDifficulty: r.keywordDifficulty ?? null,
      intent: r.intent ?? "unknown",
    }));

    const n = keywordRows.length;

    // project context markdown (truncated 3500)
    let contextMarkdown = "";
    if (admin) {
      try {
        const ctxObj = await doGetContext(admin, brandKey);
        const md = doRender(ctxObj);
        contextMarkdown = md.slice(0, 3500);
      } catch {
        contextMarkdown = "";
      }
    }

    const prompt = buildClusterPrompt(keywordRows, contextMarkdown);

    const result = await doLlmObject({
      brandKey,
      feature: "keywords.clustering",
      schema: clusterOutputSchema,
      system: CLUSTER_SYSTEM,
      prompt,
      maxUsd: approvedMaxUsd,
      idempotencyKey: jobStepKey(ctx, "cluster"),
      maxOutputTokens: 8000,
      timeoutMs: 180000,
    });

    const validated = validateClusters(result.object, n);

    const clusters = validated.clusters.map((c) => ({
      name: c.name,
      intent: c.intent,
      priority: c.priority,
      targetPage: c.targetPage,
      rationale: c.rationale,
      savedKeywordIds: c.keywordIndexes.map((i) => keywordRows[i].id),
    }));

    const unsortedIds = validated.unsorted.map((i) => keywordRows[i].id);

    return {
      n,
      clusters,
      unsorted: unsortedIds,
      model: result.model,
      usd: result.usd,
    };
  };
  const stepped = ctx.step
    ? await ctx.step.do("cluster", LONG_PAID_STEP, runStep)
    : await runStep();
  const { n, clusters, unsorted: unsortedIds } = stepped;

  // log
  try {
    await doAppend(admin, {
      brandKey,
      kind: "keywords.clustering",
      summary: `Grouped ${n} keywords into ${clusters.length} topics.`,
      jobId: ctx.jobId,
      author: "user",
      actorUserId: requestedBy,
    });
  } catch {
    // ignore
  }

  return {
    status: "completed",
    result: {
      clusters,
      unsorted: unsortedIds,
      model: stepped.model,
      usd: stepped.usd,
    },
  };
}

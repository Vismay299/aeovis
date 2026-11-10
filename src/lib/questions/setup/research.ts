// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/projects/services/websiteResearch.ts:66-405,
//   src/server/features/ai-visibility/services/aiResearchKeywords.ts:143-191
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import type { SupabaseClient } from "@supabase/supabase-js";
import { defineJob, getJobDefinition } from "../../jobs/registry.ts";
import { DB_STEP, READ_STEP, SINGLE_ATTEMPT, LONG_PAID_STEP } from "../../jobs/stepConfigs.ts";
import { jobStepKey } from "../../jobs/runner.ts";
import type { JobContext, JobResult } from "../../jobs/types.ts";
import { AppError } from "../../http/appError.ts";
import { getSupabaseAdmin } from "../../supabase/admin.js";
import { createProjectContextRepository } from "../../projectContext/repository.ts";
import { appendResearch } from "../../projectContext/service.ts";
import { readQuestionSettings, listWorkspaceQuestions } from "../workspaceQuestions.ts";
import { getBrandAliases } from "../../scoring/aliases.js";
import { discoverSiteUrls, readPagesFree, readPageFirecrawl, type ScrapedPage } from "./readSite.ts";
import { promptgenCandidates } from "./promptgenSource.ts";
import { assembleCandidates } from "./candidates.ts";
import {
  buildDraftSystem,
  PICK_SYSTEM,
  VERIFY_SYSTEM,
} from "./prompts.ts";
import {
  setupPayloadSchema,
  setupReviewSchema,
  draftOutputSchema,
  pickOutputSchema,
  verifyOutputSchema,
  researchKeywordSchema,
  type SetupPayload,
  type SetupReview,
  MAX_SUGGESTED_KEYWORDS,
} from "./schemas.ts";
import { llmObject } from "../../llm/index.ts";
import { estimateLlmUsd } from "../../llm/openrouter.ts";
import { getLlmModel } from "../../llmConfig.js";
import { createDataforseoClient } from "../../providers/dataforseo/client.ts";
import { dataforseoMarket } from "../../providers/dataforseo/locations.ts";
import { dataforseoPricing } from "../../pricing/dataforseo.ts";
import { firecrawlScrapeUsd } from "../../pricing/firecrawl.ts";
import { serpQueryUsd } from "../../pricing/perceev.ts";
import { metered } from "../../spend/index.ts";
import type { MeterFunction, ReadSiteDeps } from "./readSite.ts";

export { setupPayloadSchema };

export function normalizeCompetitorDomain(raw: string): string {
  let host = String(raw).trim().toLowerCase();
  if (host.startsWith("http://") || host.startsWith("https://")) {
    try {
      host = new URL(host).hostname;
    } catch {
      // ignore
    }
  } else {
    const slashIdx = host.indexOf("/");
    if (slashIdx !== -1) host = host.slice(0, slashIdx);
  }
  return host.replace(/^www\./, "");
}

export type SetupDeps = {
  admin?: SupabaseClient;
  repo?: ReturnType<typeof createProjectContextRepository>;
  discoverSiteUrls?: typeof discoverSiteUrls;
  readPagesFree?: typeof readPagesFree;
  readPageFirecrawl?: typeof readPageFirecrawl;
  readSiteDeps?: ReadSiteDeps;
  metered?: typeof metered;
  llmObject?: typeof llmObject;
  dataforseoClient?: ReturnType<typeof createDataforseoClient>;
  promptgenCandidates?: typeof promptgenCandidates;
  appendResearch?: typeof appendResearch;
  env?: Record<string, string | undefined>;
  model?: string;
};

export async function runQuestionSetup(
  ctx: JobContext<SetupPayload>,
  deps?: SetupDeps,
): Promise<JobResult> {
  const env = deps?.env ?? (process.env as Record<string, string | undefined>);
  const admin = deps?.admin ?? getSupabaseAdmin();
  if (!admin) {
    throw new AppError(503, "workspace_unavailable", "Supabase admin is unavailable.");
  }
  const payload = ctx.payload;
  let model = deps?.model ?? env.LLM_HELPER_MODEL;
  if (!model) {
    try {
      model = getLlmModel(env as NodeJS.ProcessEnv);
    } catch {
      model = "openrouter/auto";
    }
  }

  let accumulatedEstimateUsd = 0;
  const warnings: Array<{ code: string; message: string }> = [];

  function checkBudget(stepEstimateUsd: number): boolean {
    if (accumulatedEstimateUsd + stepEstimateUsd > payload.approvedMaxUsd) {
      if (!warnings.some((w) => w.code === "budget_reached")) {
        warnings.push({
          code: "budget_reached",
          message: "Research stopped early to stay within the approved amount.",
        });
      }
      return false;
    }
    accumulatedEstimateUsd += stepEstimateUsd;
    return true;
  }

  // 1. load (DB_STEP, always)
  type LoadOutput = {
    missing: { overview: boolean; competitors: boolean };
    overviewText: string | null;
    competitors: Array<{ name: string; domain: string; notes: string; sourceUrl: string | null }>;
    existingQuestions: Array<{
      id: string;
      text: string;
      textNormalized: string;
      status: "active" | "paused" | "archived";
    }>;
    unarchivedRoom: number;
    aliases: string[];
  };

  const loadData = await ctx.step.do<LoadOutput>("load", DB_STEP, async () => {
    const repo = deps?.repo ?? createProjectContextRepository(admin);
    const [sections, competitors, questions] = await Promise.all([
      repo.listSections(payload.brandKey),
      repo.listCompetitors(payload.brandKey),
      listWorkspaceQuestions(admin, payload.brandKey),
    ]);

    const overviewSection = sections.find((s) => s.key === "business_overview");
    const overviewContent = overviewSection?.content?.trim() || null;
    const hasOverview = Boolean(overviewContent);
    const hasCompetitors = competitors.length > 0;

    const unarchivedCount = questions.filter((q) => q.status !== "archived").length;
    const unarchivedRoom = Math.max(0, 100 - unarchivedCount);
    const aliases = getBrandAliases(payload.displayName, payload.website);

    return {
      missing: {
        overview: !hasOverview,
        competitors: !hasCompetitors,
      },
      overviewText: overviewContent,
      competitors: competitors.map((c) => ({
        name: c.name?.trim() || c.domain,
        domain: c.domain,
        notes: c.notes ?? "",
        sourceUrl: c.sourceUrl ?? null,
      })),
      existingQuestions: questions.map((q) => ({
        id: q.id,
        text: q.text,
        textNormalized: q.textNormalized,
        status: q.status,
      })),
      unarchivedRoom,
      aliases,
    };
  });

  const { missing } = loadData;

  // 2. site-free (READ_STEP, runs when missing.overview)
  let sitePages: ScrapedPage[] = [];

  if (missing.overview) {
    await ctx.progress(1, 5, "Reading your website");
    const discoverFn = deps?.discoverSiteUrls ?? discoverSiteUrls;
    const readFreeFn = deps?.readPagesFree ?? readPagesFree;

    const urls = await discoverFn(payload.website, 3, deps?.readSiteDeps);
    const siteUrls = urls.length > 0 ? urls : [payload.website];
    const freeRes = await ctx.step.do("site-free", READ_STEP, async () => {
      return await readFreeFn(siteUrls, 3, deps?.readSiteDeps);
    });

    sitePages = [...freeRes.pages];

    // 3. site-firecrawl (SINGLE_ATTEMPT, runs when missing.overview and step 2 returned 0 pages)
    if (sitePages.length === 0) {
      const urlsToScrape = freeRes.failed.slice(0, 3);
      const firecrawlUnitUsd = firecrawlScrapeUsd(env);
      const estFirecrawl = urlsToScrape.length * firecrawlUnitUsd;

      if (urlsToScrape.length > 0 && checkBudget(estFirecrawl)) {
        const scrapeFn = deps?.readPageFirecrawl ?? readPageFirecrawl;
        const firecrawlRes = await ctx.step.do<{ pages: ScrapedPage[]; estimateUsd: number }>(
          "site-firecrawl",
          SINGLE_ATTEMPT,
          async () => {
            const scraped: ScrapedPage[] = [];
            for (let i = 0; i < urlsToScrape.length; i += 1) {
              const u = urlsToScrape[i];
              const meterFn: MeterFunction = (opts, call) =>
                (deps?.metered ?? metered)(
                  {
                    brandKey: payload.brandKey,
                    feature: "questions.setup",
                    estimateUsd: opts.estimateUsd,
                    maxUsd: payload.approvedMaxUsd,
                    idempotencyKey: `${jobStepKey(ctx, "site-firecrawl")}:${i + 1}`,
                    jobId: ctx.jobId,
                  },
                  call,
                );
              const { page } = await scrapeFn(u, meterFn, {
                ...deps?.readSiteDeps,
                firecrawlScrapeUsd: () => firecrawlUnitUsd,
              });
              if (page) scraped.push(page);
            }
            return { pages: scraped, estimateUsd: estFirecrawl };
          },
        );
        sitePages = firecrawlRes.pages;
      }
    }

    if (sitePages.length === 0) {
      throw new AppError(422, "website_unreadable", "We couldn't read this website.");
    }
  }

  // 4. draft (SINGLE_ATTEMPT, always)
  await ctx.progress(3, 5, "Drafting questions");
  const draftEstUsd = estimateLlmUsd(model, 18000, 6000, env);
  if (!checkBudget(draftEstUsd)) {
    throw new AppError(402, "budget_reached", "Research stopped early to stay within the approved amount.");
  }

  const llmObjectCaller = deps?.llmObject ?? llmObject;
  const draftRes = await ctx.step.do<{ draft: any; estimateUsd: number }>(
    "draft",
    SINGLE_ATTEMPT,
    async () => {
      const system = buildDraftSystem(missing);
      const schema = draftOutputSchema(missing);
      const promptObj = {
        domain: payload.ownHost,
        name: payload.displayName,
        website: payload.website,
        market: payload.market,
        overview: missing.overview ? undefined : loadData.overviewText,
        competitors: missing.competitors ? undefined : loadData.competitors,
        sitePages: sitePages.map((p) => ({
          url: p.url,
          title: p.title,
          content: p.content.slice(0, 4000),
        })),
      };

      const { object } = await llmObjectCaller({
        brandKey: payload.brandKey,
        feature: "questions.setup",
        schema,
        system,
        prompt: JSON.stringify(promptObj),
        maxOutputTokens: 6000,
        timeoutMs: 120_000,
        idempotencyKey: `${jobStepKey(ctx, "draft")}:1`,
        maxUsd: payload.approvedMaxUsd,
      });

      return { draft: object, estimateUsd: draftEstUsd };
    },
  );

  const draft = draftRes.draft;
  let finalOverviewText = loadData.overviewText || (draft.overview ? String(draft.overview).trim() : "");

  // 5. serp-1, serp-2 (SINGLE_ATTEMPT each, runs when missing.competitors, one per drafted query)
  let organicSerpResults: Array<{ title: string; url: string; description: string }> = [];
  let serpSearchOutage = false;

  if (missing.competitors && draft.searchQueries && draft.searchQueries.length > 0) {
    await ctx.progress(2, 5, "Finding competitors");
    const queries: string[] = draft.searchQueries.slice(0, 2);
    const m = dataforseoMarket({
      country: payload.market.country,
      language: payload.market.language,
    });
    const dClient = deps?.dataforseoClient ?? createDataforseoClient();

    let attemptedQueries = 0;
    let failedQueries = 0;

    for (let qIdx = 0; qIdx < queries.length; qIdx += 1) {
      const q = queries[qIdx];
      const serpStepName = `serp-${qIdx + 1}`;
      const serpEstUsd = dataforseoPricing.serp.live({ depth: 10, keyword: q });

      if (checkBudget(serpEstUsd)) {
        attemptedQueries += 1;
        try {
          const serpRes = await ctx.step.do<{
            items: Array<{ title: string; url: string; description: string }>;
            estimateUsd: number;
          }>(serpStepName, SINGLE_ATTEMPT, async () => {
            const raw = await dClient.serp.live(
              {
                brandKey: payload.brandKey,
                feature: "questions.setup",
                jobId: ctx.jobId,
                idempotencyKey: `${jobStepKey(ctx, serpStepName)}:1`,
                maxUsd: payload.approvedMaxUsd,
              },
              {
                keyword: q,
                locationCode: m.locationCode,
                languageCode: m.languageCode,
                depth: 10,
              },
            );

            const organic = (raw || [])
              .filter((item: any) => item.type === "organic" || item.url)
              .map((item: any) => ({
                title: String(item.title || ""),
                url: String(item.url || ""),
                description: String(item.description || ""),
              }));
            return { items: organic, estimateUsd: serpEstUsd };
          });
          organicSerpResults.push(...serpRes.items);
        } catch {
          failedQueries += 1;
        }
      }
    }

    if (attemptedQueries > 0 && failedQueries === attemptedQueries) {
      serpSearchOutage = true;
      warnings.push({
        code: "search_unavailable",
        message: "Live search was unavailable, so add competitors yourself.",
      });
    }
  }

  // 6. pick (SINGLE_ATTEMPT, runs when >= 1 organic result)
  let pickedDomains: string[] = [];
  if (missing.competitors && !serpSearchOutage && organicSerpResults.length > 0) {
    const pickEstUsd = estimateLlmUsd(model, 8000, 1000, env);
    if (checkBudget(pickEstUsd)) {
      const pickRes = await ctx.step.do<{ domains: string[]; estimateUsd: number }>(
        "pick",
        SINGLE_ATTEMPT,
        async () => {
          const { object } = await llmObjectCaller({
            brandKey: payload.brandKey,
            feature: "questions.setup",
            schema: pickOutputSchema,
            system: PICK_SYSTEM,
            prompt: JSON.stringify({
              businessName: payload.displayName,
              domain: payload.ownHost,
              market: payload.market,
              organicResults: organicSerpResults,
            }),
            maxOutputTokens: 1000,
            timeoutMs: 60_000,
            idempotencyKey: `${jobStepKey(ctx, "pick")}:1`,
            maxUsd: payload.approvedMaxUsd,
          });
          return { domains: object.domains, estimateUsd: pickEstUsd };
        },
      );

      const seen = new Set<string>();
      const ownHostNorm = normalizeCompetitorDomain(payload.ownHost);
      for (const d of pickRes.domains) {
        const norm = normalizeCompetitorDomain(d);
        if (norm && norm !== ownHostNorm && !seen.has(norm)) {
          seen.add(norm);
          pickedDomains.push(norm);
          if (pickedDomains.length >= 5) break;
        }
      }
    }
  }

  // 7. competitor-free-<i> (READ_STEP per picked domain)
  const competitorPagesByDomain = new Map<string, ScrapedPage[]>();
  const discoverFn = deps?.discoverSiteUrls ?? discoverSiteUrls;
  const readFreeFn = deps?.readPagesFree ?? readPagesFree;

  for (let i = 0; i < pickedDomains.length; i += 1) {
    const domain = pickedDomains[i];
    const stepName = `competitor-free-${i + 1}`;
    const freeRes = await ctx.step.do<ScrapedPage[]>(stepName, READ_STEP, async () => {
      const urls = await discoverFn(`https://${domain}`, 2, deps?.readSiteDeps);
      const res = await readFreeFn(
        urls.length > 0 ? urls : [`https://${domain}`],
        2,
        deps?.readSiteDeps,
      );
      return res.pages;
    });
    competitorPagesByDomain.set(domain, freeRes);
  }

  // 8. competitor-firecrawl (SINGLE_ATTEMPT, runs for picked domains with 0 free pages)
  const domainsNeedingFirecrawl = pickedDomains.filter(
    (d) => (competitorPagesByDomain.get(d) || []).length === 0,
  );
  if (domainsNeedingFirecrawl.length > 0) {
    const firecrawlUnitUsd = firecrawlScrapeUsd(env);
    const estCompetitorFirecrawl = domainsNeedingFirecrawl.length * firecrawlUnitUsd;

    if (domainsNeedingFirecrawl.length > 0 && checkBudget(estCompetitorFirecrawl)) {
      const scrapeFn = deps?.readPageFirecrawl ?? readPageFirecrawl;
      const firecrawlRes = await ctx.step.do<{
        pagesByDomain: Record<string, ScrapedPage[]>;
        estimateUsd: number;
      }>("competitor-firecrawl", SINGLE_ATTEMPT, async () => {
        const map: Record<string, ScrapedPage[]> = {};
        for (let i = 0; i < domainsNeedingFirecrawl.length; i += 1) {
          const d = domainsNeedingFirecrawl[i];
          const meterFn: MeterFunction = (opts, call) =>
            (deps?.metered ?? metered)(
              {
                brandKey: payload.brandKey,
                feature: "questions.setup",
                estimateUsd: opts.estimateUsd,
                maxUsd: payload.approvedMaxUsd,
                idempotencyKey: `${jobStepKey(ctx, "competitor-firecrawl")}:${i + 1}`,
                jobId: ctx.jobId,
              },
              call,
            );
          const { page } = await scrapeFn(`https://${d}`, meterFn, {
            ...deps?.readSiteDeps,
            firecrawlScrapeUsd: () => firecrawlUnitUsd,
          });
          if (page) map[d] = [page];
        }
        return { pagesByDomain: map, estimateUsd: estCompetitorFirecrawl };
      });

      for (const [d, pages] of Object.entries(firecrawlRes.pagesByDomain)) {
        competitorPagesByDomain.set(d, pages);
      }
    }
  }

  // Collect all competitor pages
  const allCompetitorPages: ScrapedPage[] = [];
  for (const pages of competitorPagesByDomain.values()) {
    allCompetitorPages.push(...pages);
  }

  // 9. verify (SINGLE_ATTEMPT, runs when >= 1 competitor page read)
  let verifiedCompetitors: Array<{
    name: string;
    domain: string;
    notes: string;
    sourceUrl: string;
  }> = [];

  if (missing.competitors && allCompetitorPages.length > 0) {
    const verifyEstUsd = estimateLlmUsd(model, 40000, 2000, env);
    if (checkBudget(verifyEstUsd)) {
      const verifyRes = await ctx.step.do<{
        competitors: Array<{ name: string; domain: string; notes: string; sourceUrl: string }>;
        estimateUsd: number;
      }>("verify", SINGLE_ATTEMPT, async () => {
        const { object } = await llmObjectCaller({
          brandKey: payload.brandKey,
          feature: "questions.setup",
          schema: verifyOutputSchema,
          system: VERIFY_SYSTEM,
          prompt: JSON.stringify({
            businessName: payload.displayName,
            domain: payload.ownHost,
            pages: allCompetitorPages.map((p) => ({
              url: p.url,
              title: p.title,
              content: p.content.slice(0, 4000),
            })),
          }),
          maxOutputTokens: 2000,
          timeoutMs: 60_000,
          idempotencyKey: `${jobStepKey(ctx, "verify")}:1`,
          maxUsd: payload.approvedMaxUsd,
        });
        return { competitors: object.competitors, estimateUsd: verifyEstUsd };
      });

      const validUrls = new Set(allCompetitorPages.map((p) => p.url));
      const ownHostNorm = normalizeCompetitorDomain(payload.ownHost);
      let droppedCount = 0;

      for (const comp of verifyRes.competitors) {
        const compDomainNorm = normalizeCompetitorDomain(comp.domain);
        const sourceUrlNorm = normalizeCompetitorDomain(comp.sourceUrl);

        if (
          validUrls.has(comp.sourceUrl) &&
          compDomainNorm === sourceUrlNorm &&
          compDomainNorm !== ownHostNorm
        ) {
          verifiedCompetitors.push({
            name: comp.name.trim(),
            domain: compDomainNorm,
            notes: comp.notes.trim(),
            sourceUrl: comp.sourceUrl,
          });
        } else {
          droppedCount += 1;
        }
      }

      if (droppedCount > 0) {
        warnings.push({
          code: "competitor_unverified",
          message: `${droppedCount} suggested competitor${
            droppedCount === 1 ? "" : "s"
          } could not be checked against a page we read, so we left them out.`,
        });
      }
    }
  }

  // 10. promptgen (LONG_PAID_STEP, runs when QUESTION_SETUP_PROMPTGEN !== "off")
  await ctx.progress(4, 5, "Adding search-grounded questions");
  let promptgenItems: Array<{ text: string; topic: string; source: string }> = [];

  if (env.QUESTION_SETUP_PROMPTGEN !== "off") {
    const promptgenEstUsd =
      3 * serpQueryUsd("brightdata", 1, env) + 2 * estimateLlmUsd(model, 8000, 3000, env);

    if (checkBudget(promptgenEstUsd)) {
      const pgenFn = deps?.promptgenCandidates ?? promptgenCandidates;
      const combinedSiteText = (sitePages.length > 0 ? sitePages : [])
        .map((p) => `${p.title ?? ""}\n${p.content}`)
        .join("\n\n")
        .slice(0, 12000);

      try {
        const pgenRes = await ctx.step.do<{
          items: Array<{ text: string; topic: string; source: string }>;
          warning?: string;
        }>("promptgen", LONG_PAID_STEP, async () => {
          try {
            const items = await pgenFn(
              {
                brandKey: payload.brandKey,
                jobId: ctx.jobId,
                maxUsd: payload.approvedMaxUsd,
        idempotencyKeyPrefix: jobStepKey(ctx, "promptgen"),
                market: payload.market,
              },
              {
                brand: payload.displayName,
                website: payload.website,
                siteText: combinedSiteText,
                count: 20,
              },
            );
            return { items };
          } catch {
            return { items: [], warning: "promptgen_unavailable" };
          }
        });

        if (pgenRes.warning) {
          warnings.push({
            code: "promptgen_unavailable",
            message: "Search-grounded question discovery was unavailable.",
          });
        }
        promptgenItems = pgenRes.items;
      } catch {
        warnings.push({
          code: "promptgen_unavailable",
          message: "Search-grounded question discovery was unavailable.",
        });
      }
    }
  }

  // 11. assemble (DB_STEP, always)
  await ctx.progress(5, 5, "Preparing your review");
  const review = await ctx.step.do<SetupReview>("assemble", DB_STEP, async () => {
    // Deduplicate draft topics and prompt texts
    const seenTopicNames = new Set<string>();
    const validTopics: Array<{ name: string; questions: string[] }> = [];

    for (const t of draft.topics || []) {
      const name = String(t.name).trim();
      const normName = name.toLowerCase();
      if (!name || seenTopicNames.has(normName)) continue;
      seenTopicNames.add(normName);

      const seenQ = new Set<string>();
      const questions: string[] = [];
      for (const q of t.questions || []) {
        const text = String(q).trim();
        const normQ = text.toLowerCase();
        if (text && !seenQ.has(normQ)) {
          seenQ.add(normQ);
          questions.push(text);
        }
      }
      validTopics.push({ name, questions });
    }

    // Filter valid suggested keywords (<= 5 words, <= 100 chars)
    const validKeywords: string[] = [];
    const seenKw = new Set<string>();
    for (const kw of draft.suggestedKeywords || []) {
      const parsed = researchKeywordSchema.safeParse(kw);
      if (parsed.success) {
        const normKw = parsed.data.toLowerCase();
        if (!seenKw.has(normKw) && !seenTopicNames.has(normKw)) {
          seenKw.add(normKw);
          validKeywords.push(parsed.data);
          if (validKeywords.length >= MAX_SUGGESTED_KEYWORDS) break;
        }
      }
    }

    // Assemble candidates
    const candidates = assembleCandidates({
      researchTopics: validTopics,
      promptgenItems,
      existingQuestions: loadData.existingQuestions,
      aliases: loadData.aliases,
      unarchivedRoom: loadData.unarchivedRoom,
    });

    const candidateTopics = Array.from(new Set(candidates.map((c) => c.topic)));
    const finalCompetitorItems = missing.competitors ? verifiedCompetitors : loadData.competitors;

    const assembledReview: SetupReview = {
      version: 1,
      overview: {
        text: finalOverviewText,
        preserved: !missing.overview,
      },
      persona: String(draft.persona || "").trim(),
      competitors: {
        preserved: !missing.competitors,
        items: finalCompetitorItems,
      },
      candidates,
      topics: candidateTopics,
      suggestedKeywords: validKeywords,
      warnings,
    };

    const validated = setupReviewSchema.parse(assembledReview);
    const size = Buffer.byteLength(JSON.stringify(validated), "utf8");
    if (size > 60_000) {
      throw new AppError(500, "review_too_large", "Review payload exceeds 60 KB limit.");
    }
    return validated;
  });

  // 12. log (DB_STEP, always)
  await ctx.step.do("log", DB_STEP, async () => {
    let spendUsd: number | null = null;
    try {
      const { data: spendRows } = await admin
        .from("spend_ledger")
        .select("accounted_usd")
        .eq("job_id", ctx.jobId);
      if (spendRows && spendRows.length > 0) {
        spendUsd = spendRows.reduce(
          (sum: number, r: { accounted_usd: number | null }) => sum + Number(r.accounted_usd || 0),
          0,
        );
      }
    } catch {
      // ledger read fallback
    }

    const appendFn = deps?.appendResearch ?? appendResearch;
    await appendFn(admin, {
      brandKey: payload.brandKey,
      kind: "questions.setup",
      researchKey: payload.ownHost,
      summary: `Completed AI question setup research (${review.candidates.length} candidate questions)`,
      spendUsd,
      jobId: ctx.jobId,
      author: "system",
    });
    return { logged: true };
  });

  return { result: { review } };
}

export function registerQuestionsSetupJob(): void {
  if (getJobDefinition("questions.setup")) return;

  defineJob(
    "questions.setup",
    runQuestionSetup,
    {
      payloadSchema: setupPayloadSchema,
      pollAfterSeconds: 3,
      deadlineSeconds: 900,
      maxInvocations: 40,
    },
  );
}

import { generateUnbrandedPrompts } from "../../scoring/promptGen.js";
import { llmText } from "../../llm/index.ts";
import { fetchPeopleAlsoAsk, fetchAutocomplete } from "../../engines/serp.js";
import { metered } from "../../spend/index.ts";
import { serpQueryUsd } from "../../pricing/perceev.ts";
import { AppError } from "../../http/errors.ts";

export type PromptgenContext = {
  brandKey: string;
  jobId?: string;
  maxUsd?: number;
  idempotencyKeyPrefix?: string;
  market?: { country: string; language: string };
};

export type PromptgenCandidate = {
  text: string;
  topic: string;
  source: string;
};

export type PromptgenDeps = {
  scrapeSite?: any;
  llmText?: typeof llmText;
  fetchPeopleAlsoAsk?: typeof fetchPeopleAlsoAsk;
  fetchAutocomplete?: typeof fetchAutocomplete;
  metered?: typeof metered;
  env?: Record<string, string | undefined>;
  llmDeps?: any;
};

export async function promptgenCandidates(
  ctx: PromptgenContext,
  i: {
    brand: string;
    website: string;
    siteText: string;
    count?: number;
  },
  deps?: PromptgenDeps,
): Promise<PromptgenCandidate[]> {
  const count = i.count ?? 20;

  // Provide spy scraper that returns the provided siteText without scraping
  const scrapeSiteSpy = async () => ({
    content: i.siteText,
    state: "ok",
    source: "provided",
    state_reason: null,
    reasons: [],
    detail: null,
    degraded: false,
  });

  let llmCount = 0;
  const llmJsonAdapter = async (prompt: string, _options?: any) => {
    llmCount += 1;
    const caller = deps?.llmText ?? llmText;
    const res = await caller(
      {
        brandKey: ctx.brandKey,
        feature: "questions.setup",
        system: "You generate unbranded search queries for a brand based on its site text. Output JSON only.",
        prompt,
        maxUsd: ctx.maxUsd,
        idempotencyKey: `${ctx.idempotencyKeyPrefix ?? "questions.setup"}:llm:${llmCount}`,
        maxOutputTokens: 8000,
        timeoutMs: 60000,
      },
      deps?.llmDeps,
    );

    const clean = res.text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    try {
      return JSON.parse(clean);
    } catch {
      throw new AppError(502, "llm_bad_output", "Promptgen LLM returned invalid JSON.");
    }
  };

  let paaCount = 0;
  const paaAdapter = async (term: string | string[]) => {
    paaCount += 1;
    // OpenSEO's prompt generator can request more seed and blend terms than this
    // feature's approved quote allows. Stop at the F08 budget of three PAA calls.
    if (paaCount > 3) return [];
    const paaFetcher = deps?.fetchPeopleAlsoAsk ?? fetchPeopleAlsoAsk;
    const geo = ctx.market?.country ?? "in";
    const estimateUsd = serpQueryUsd("brightdata", 1, deps?.env ?? process.env);
    const meter = deps?.metered ?? metered;
    const termStr = Array.isArray(term) ? term[0] : term;

    return await meter(
      {
        brandKey: ctx.brandKey,
        feature: "questions.setup",
        estimateUsd,
        maxUsd: ctx.maxUsd,
        idempotencyKey: `${ctx.idempotencyKeyPrefix ?? "questions.setup"}:paa:${paaCount}`,
        jobId: ctx.jobId,
      },
      async () => {
        const results = await paaFetcher([termStr], { geo });
        return {
          value: results,
          actualUsd: null,
          provider: "brightdata",
          endpoint: "serp/paa",
          billed: true,
        };
      },
    );
  };

  const stats = { time_ms: 0, calls: 0, cost_usd: 0 };
  const rawPrompts = await generateUnbrandedPrompts(
    i.brand,
    i.website,
    "",
    stats,
    count,
    {
      // The setup job already read these pages. Never let promptGen make a
      // second network request for the workspace site.
      scrapeSite: scrapeSiteSpy,
      llmJson: llmJsonAdapter,
      fetchPeopleAlsoAsk: paaAdapter,
      fetchAutocomplete: deps?.fetchAutocomplete,
    },
  );

  const filtered = (rawPrompts || []).filter((p: any) => p && p.source !== "industry_fallback");
  return filtered.slice(0, count).map((p: any) => ({
    text: String(p.text).trim(),
    topic: (p.topic && String(p.topic).trim()) || "General",
    source: String(p.source || "llm_generated"),
  }));
}

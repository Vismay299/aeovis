import { generateUnbrandedPrompts } from "../../scoring/promptGen.js";
import { llmText } from "../../llm/index.ts";
import { fetchPeopleAlsoAsk, fetchAutocomplete } from "../../engines/serp.js";
import { metered } from "../../spend/index.ts";
import { serpQueryUsd } from "../../pricing/perceev.ts";
import { AppError } from "../../http/errors.ts";
import { getLlmModel } from "../../llmConfig.js";
import { isUnpricedModel } from "../../llmPricing.js";
import { fromMicros, toMicros, usd6 } from "../../spend/money.ts";
import { SpendRefused, UnbilledCallError } from "../../spend/errors.ts";
import {
  estimateQuestionLlmUsd,
  fitTextPrompt,
  QUESTIONS_LLM_BOUNDS,
} from "./prompts.ts";

const PROMPTGEN_LLM_SYSTEM =
  "You generate unbranded search queries for a brand based on its site text. Output JSON only.";

const PRE_RESERVATION_LLM_CODES = new Set([
  "duplicate_paid_call",
  "llm_not_configured",
  "spend_config_invalid",
  "spend_invalid",
  "spend_unavailable",
]);

function wasSettledAtEstimate(error: unknown): boolean {
  const name = error && typeof error === "object" ? (error as { name?: unknown }).name : undefined;
  if (name === "UnbilledCallError" || name === "SpendRefused" || error instanceof UnbilledCallError || error instanceof SpendRefused) {
    return false;
  }
  if (name === "UnpricedModelError" || isUnpricedModel(error)) return false;
  if (name === "AmbiguousCallError") return true;
  if (error instanceof AppError) {
    if (PRE_RESERVATION_LLM_CODES.has(error.code) || error.status < 500) return false;
    return true;
  }
  // llmText settles unexpected post-reservation failures at its estimate.
  return true;
}

export type PromptgenContext = {
  brandKey: string;
  jobId?: string;
  maxUsd?: number;
  idempotencyKeyPrefix?: string;
  market?: { country: string; language: string };
  model?: string;
  onLlmSpend?: (usd: number) => void;
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
  const env = deps?.env ?? process.env;
  let model = ctx.model ?? env.LLM_HELPER_MODEL;
  if (!model) {
    try {
      model = getLlmModel(env as NodeJS.ProcessEnv);
    } catch {
      model = "openrouter/auto";
    }
  }
  let remainingUsd = ctx.maxUsd;

  function subtractRemaining(spendUsd: number): void {
    if (remainingUsd === undefined) return;
    remainingUsd = fromMicros(Math.max(0, toMicros(remainingUsd) - toMicros(spendUsd)));
  }

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
    const boundedPrompt = fitTextPrompt(
      prompt,
      QUESTIONS_LLM_BOUNDS.promptgen.inputChars - PROMPTGEN_LLM_SYSTEM.length,
    );
    const estimateUsd = estimateQuestionLlmUsd(
      model,
      PROMPTGEN_LLM_SYSTEM.length + boundedPrompt.length,
      QUESTIONS_LLM_BOUNDS.promptgen.outputTokens,
      env,
    );
    if (remainingUsd !== undefined && toMicros(estimateUsd) > toMicros(remainingUsd)) {
      throw new AppError(402, "budget_reached", "Research stopped early to stay within the approved amount.");
    }
    let res: Awaited<ReturnType<typeof llmText>>;
    try {
      res = await caller(
        {
          brandKey: ctx.brandKey,
          feature: "questions.setup",
          system: PROMPTGEN_LLM_SYSTEM,
          prompt: boundedPrompt,
          model,
          maxUsd: remainingUsd,
          idempotencyKey: `${ctx.idempotencyKeyPrefix ?? "questions.setup"}:llm:${llmCount}`,
          maxOutputTokens: QUESTIONS_LLM_BOUNDS.promptgen.outputTokens,
          timeoutMs: 60000,
        },
        deps?.llmDeps,
      );
    } catch (error) {
      if (wasSettledAtEstimate(error)) {
        ctx.onLlmSpend?.(estimateUsd);
        subtractRemaining(estimateUsd);
      }
      throw error;
    }
    const accountedUsd =
      typeof res.usd === "number" && Number.isFinite(res.usd) && res.usd >= 0
        ? usd6(res.usd)
        : estimateUsd;
    ctx.onLlmSpend?.(accountedUsd);
    subtractRemaining(accountedUsd);

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
    // The prompt generator can request more seed and blend terms than this
    // feature's approved quote allows. Stop at the F08 budget of three PAA calls.
    if (paaCount > 3) return [];
    const paaFetcher = deps?.fetchPeopleAlsoAsk ?? fetchPeopleAlsoAsk;
    const geo = ctx.market?.country ?? "in";
    const estimateUsd = serpQueryUsd("brightdata", 1, deps?.env ?? process.env);
    const meter = deps?.metered ?? metered;
    const termStr = Array.isArray(term) ? term[0] : term;

    if (remainingUsd !== undefined && toMicros(estimateUsd) > toMicros(remainingUsd)) return [];
    const maxUsd = remainingUsd;
    subtractRemaining(estimateUsd);

    return await meter(
      {
        brandKey: ctx.brandKey,
        feature: "questions.setup",
        estimateUsd,
        maxUsd,
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

import { z } from "zod";
import { definePricedAction, type PricingContext, type PricedActionEstimateResult } from "../pricedActions.ts";
import { dataforseoPricing } from "../dataforseo.ts";
import { serpQueryUsd } from "../perceev.ts";
import { estimateQuestionLlmUsd, QUESTIONS_LLM_BOUNDS } from "../../questions/setup/prompts.ts";
import { getLlmModel } from "../../llmConfig.js";
import { firecrawlScrapeUsd } from "../firecrawl.ts";
import { toMicros, fromMicros, usd6 } from "../../spend/money.ts";

export const questionsSetupInput = z.strictObject({});

export const questionsGenerateInput = z.strictObject({
  topic: z.string().max(100).optional(),
});

export const questionsResearchInput = z.strictObject({
  keyword: z.string().min(1).max(100),
});

export const FREE_READS_FIRST_WARNING = {
  code: "free_reads_first",
  message: "Pages are read directly first; the browser service is used only when a page blocks us.",
} as const;

export const CACHE_NOTE_WARNING = {
  code: "cache_note",
  message: "Searching the same keyword again within 24 hours is free.",
} as const;

export type QuestionsQuoteDeps = {
  checkOverviewMissing?: (ctx: PricingContext) => Promise<boolean>;
  checkCompetitorsMissing?: (ctx: PricingContext) => Promise<boolean>;
  checkSetupRunning?: (ctx: PricingContext) => Promise<boolean>;
  countUnarchivedQuestions?: (ctx: PricingContext) => Promise<number>;
  model?: string;
};

function resolveModel(ctx: PricingContext, deps?: QuestionsQuoteDeps): string {
  if (deps?.model) return deps.model;
  return ctx.env.LLM_HELPER_MODEL ?? getLlmModel(ctx.env as unknown as NodeJS.ProcessEnv);
}

async function defaultCheckOverviewMissing(ctx: PricingContext): Promise<boolean> {
  if (!ctx.admin || typeof ctx.admin.from !== "function") return true;
  try {
    const { data } = await ctx.admin
      .from("project_context_sections")
      .select("content")
      .eq("brand_key", ctx.brandKey)
      .eq("key", "business_overview")
      .maybeSingle();
    return !data?.content || data.content.trim() === "";
  } catch {
    return true;
  }
}

async function defaultCheckCompetitorsMissing(ctx: PricingContext): Promise<boolean> {
  if (!ctx.admin || typeof ctx.admin.from !== "function") return true;
  try {
    const { count } = await ctx.admin
      .from("project_competitors")
      .select("id", { count: "exact", head: true })
      .eq("brand_key", ctx.brandKey);
    return (count ?? 0) === 0;
  } catch {
    return true;
  }
}

async function defaultCheckSetupRunning(ctx: PricingContext): Promise<boolean> {
  if (!ctx.admin || typeof ctx.admin.from !== "function") return false;
  try {
    const { data } = await ctx.admin
      .from("jobs")
      .select("id")
      .eq("kind", "questions.setup")
      .eq("brand_key", ctx.brandKey)
      .in("status", ["queued", "running"])
      .limit(1)
      .maybeSingle();
    return Boolean(data);
  } catch {
    return false;
  }
}

async function defaultCountUnarchivedQuestions(ctx: PricingContext): Promise<number> {
  if (!ctx.admin || typeof ctx.admin.from !== "function") return 0;
  try {
    const { count } = await ctx.admin
      .from("workspace_questions")
      .select("id", { count: "exact", head: true })
      .eq("brand_key", ctx.brandKey)
      .neq("status", "archived");
    return count ?? 0;
  } catch {
    return 0;
  }
}

export async function estimateQuestionsSetup(
  ctx: PricingContext,
  _input: z.infer<typeof questionsSetupInput>,
  deps?: QuestionsQuoteDeps,
): Promise<PricedActionEstimateResult> {
  const isRunning = await (deps?.checkSetupRunning ?? defaultCheckSetupRunning)(ctx);
  const unarchivedCount = await (deps?.countUnarchivedQuestions ?? defaultCountUnarchivedQuestions)(ctx);

  let blocked: { code: string; message: string; recovery?: string } | null = null;
  if (isRunning) {
    blocked = {
      code: "setup_running",
      message: "Setup is already running.",
    };
  } else if (unarchivedCount >= 100) {
    blocked = {
      code: "question_limit",
      message: "You can track up to 100 questions. Archive unused questions first.",
    };
  }

  const overviewMissing = await (deps?.checkOverviewMissing ?? defaultCheckOverviewMissing)(ctx);
  const competitorsMissing = await (deps?.checkCompetitorsMissing ?? defaultCheckCompetitorsMissing)(ctx);

  const model = resolveModel(ctx, deps);
  const lines: Array<{ label: string; quantity: number; unitUsd: number; totalUsd: number }> = [];

  if (overviewMissing) {
    const scrapeUsd = firecrawlScrapeUsd(ctx.env);
    lines.push({
      label: "Website pages read with a browser service",
      quantity: 3,
      unitUsd: usd6(scrapeUsd),
      totalUsd: usd6(3 * scrapeUsd),
    });
  }

  if (competitorsMissing) {
    const serpUsd = dataforseoPricing.serp.live({ depth: 10, keyword: "x" });
    lines.push({
      label: "Search results for competitors",
      quantity: 2,
      unitUsd: usd6(serpUsd),
      totalUsd: usd6(2 * serpUsd),
    });

    const compScrapeUsd = firecrawlScrapeUsd(ctx.env);
    lines.push({
      label: "Competitor pages read with a browser service",
      quantity: 10,
      unitUsd: usd6(compScrapeUsd),
      totalUsd: usd6(10 * compScrapeUsd),
    });
  }

  // AI drafting: 18k in, 6k out + (if competitors missing: 8k in, 1k out + 40k in, 2k out)
  let draftingUsd = estimateQuestionLlmUsd(
    model,
    QUESTIONS_LLM_BOUNDS.setupDraft.inputChars,
    QUESTIONS_LLM_BOUNDS.setupDraft.outputTokens,
    ctx.env,
  );
  if (competitorsMissing) {
    draftingUsd +=
      estimateQuestionLlmUsd(
        model,
        QUESTIONS_LLM_BOUNDS.setupPick.inputChars,
        QUESTIONS_LLM_BOUNDS.setupPick.outputTokens,
        ctx.env,
      ) +
      estimateQuestionLlmUsd(
        model,
        QUESTIONS_LLM_BOUNDS.setupVerify.inputChars,
        QUESTIONS_LLM_BOUNDS.setupVerify.outputTokens,
        ctx.env,
      );
  }
  lines.push({
    label: "AI drafting",
    quantity: 1,
    unitUsd: usd6(draftingUsd),
    totalUsd: usd6(draftingUsd),
  });

  // Search-grounded questions: 3 x Bright Data + 2 x (8k in, 3k out)
  if (ctx.env.QUESTION_SETUP_PROMPTGEN !== "off") {
    const searchGroundedUsd =
      3 * serpQueryUsd("brightdata", 1, ctx.env) +
      2 * estimateQuestionLlmUsd(
        model,
        QUESTIONS_LLM_BOUNDS.promptgen.inputChars,
        QUESTIONS_LLM_BOUNDS.promptgen.outputTokens,
        ctx.env,
      );
    lines.push({
      label: "Search-grounded questions",
      quantity: 1,
      unitUsd: usd6(searchGroundedUsd),
      totalUsd: usd6(searchGroundedUsd),
    });
  }

  const totalUsd = fromMicros(lines.reduce((s, l) => s + toMicros(l.totalUsd), 0));

  return {
    totalUsd,
    expectedUsd: null,
    units: [],
    lines,
    monthly: null,
    warnings: [{ ...FREE_READS_FIRST_WARNING }],
    blocked,
  };
}

export async function estimateQuestionsGenerate(
  ctx: PricingContext,
  _input: z.infer<typeof questionsGenerateInput>,
  deps?: QuestionsQuoteDeps,
): Promise<PricedActionEstimateResult> {
  const model = resolveModel(ctx, deps);
  const draftingUsd = usd6(
    estimateQuestionLlmUsd(
      model,
      QUESTIONS_LLM_BOUNDS.generate.inputChars,
      QUESTIONS_LLM_BOUNDS.generate.outputTokens,
      ctx.env,
    ),
  );
  const lines = [
    {
      label: "AI drafting",
      quantity: 1,
      unitUsd: draftingUsd,
      totalUsd: draftingUsd,
    },
  ];

  return {
    totalUsd: draftingUsd,
    expectedUsd: draftingUsd,
    units: [],
    lines,
    monthly: null,
    warnings: [],
    blocked: null,
  };
}

export async function estimateQuestionsResearch(
  ctx: PricingContext,
  _input: z.infer<typeof questionsResearchInput>,
  deps?: QuestionsQuoteDeps,
): Promise<PricedActionEstimateResult> {
  const model = resolveModel(ctx, deps);
  const datasetUsd = usd6(dataforseoPricing.aiSearch.mentionsSearch({ limit: 100 }));
  const relevanceUsd = usd6(estimateQuestionLlmUsd(model, 40000, 4000, ctx.env));

  const lines = [
    {
      label: "Question dataset search",
      quantity: 1,
      unitUsd: datasetUsd,
      totalUsd: datasetUsd,
    },
    {
      label: "Relevance check",
      quantity: 1,
      unitUsd: relevanceUsd,
      totalUsd: relevanceUsd,
    },
  ];

  const totalUsd = fromMicros(toMicros(datasetUsd) + toMicros(relevanceUsd));

  return {
    totalUsd,
    expectedUsd: totalUsd,
    units: [],
    lines,
    monthly: null,
    warnings: [{ ...CACHE_NOTE_WARNING }],
    blocked: null,
  };
}

export const questionsSetupAction = definePricedAction({
  key: "questions.setup.run",
  feature: "questions.setup",
  input: questionsSetupInput,
  requireApproval: true,
  estimate: (ctx, input) => estimateQuestionsSetup(ctx, input),
});

export const questionsGenerateAction = definePricedAction({
  key: "questions.generate.run",
  feature: "questions.generate",
  input: questionsGenerateInput,
  requireApproval: false,
  estimate: (ctx, input) => estimateQuestionsGenerate(ctx, input),
});

export const questionsResearchAction = definePricedAction({
  key: "questions.research.run",
  feature: "questions.research",
  input: questionsResearchInput,
  requireApproval: false,
  estimate: (ctx, input) => estimateQuestionsResearch(ctx, input),
});

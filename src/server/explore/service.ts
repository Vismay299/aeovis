// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/ai-search/services/promptExplorer.ts:104-182
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import crypto from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AppError } from "../../shared/http/errors.ts";
import { isFeatureEnabled } from "../features/flags.ts";
import {
  type ExploreModel,
  type ExploreRunInput,
  type ExploreModelResult,
  exploreRunInputSchema,
  exploreModelLabel,
  countryLabel,
} from "../../shared/explore.ts";
import { checkExploreRateLimits, type RateLimitDeps } from "./rateLimit.ts";
import { resolveExploreRoutes, type ExploreRouteDecision } from "./routes.ts";
import { hashPrompt, shapeExploreSuccess, shapeExploreError } from "./shape.ts";
import {
  type ExploreStore,
  type ExplorePlanEntry,
  type ExploreRunRow,
  type ExploreRunSummary,
  type ExploreRoute,
  type ReusableExploreObservation,
  type ExploreObservationRow,
  createExploreStore,
} from "./store.ts";
import { quote, requireApprovedPrice, recordApproval, type PricingContext } from "../../shared/pricing/pricedActions.ts";
import type { PriceQuote } from "../../shared/pricing.ts";
import { reserveSpend, releaseSpend } from "../../shared/spend/index.ts";
import { enqueueJob } from "../jobs/index.ts";
import { hashIdentity } from "../db/probeDispatch.js";
import { captureServerEvent } from "../../shared/telemetry/server.ts";
import { addWorkspaceQuestion } from "../questions/workspaceQuestions.ts";
import "../../shared/pricing/actions/index.ts";

export type ExploreServiceDeps = {
  store?: ExploreStore;
  workspaceAliases?: string[];
  isFeatureEnabled?: (name: string, brandKey?: string) => Promise<boolean>;
  rateLimits?: RateLimitDeps;
  resolveRoutes?: (params: {
    models: ExploreModel[];
    country?: string | null;
    webSearch?: boolean;
    env?: Record<string, string | undefined>;
    openCircuits?: Set<string> | string[];
    isFeatureEnabled?: (feature: string) => Promise<boolean> | boolean;
  }) => Promise<ExploreRouteDecision[]>;
  quote?: (key: string, ctx: PricingContext, input: unknown) => Promise<PriceQuote>;
  requireApprovedPrice?: typeof requireApprovedPrice;
  reserveSpend?: typeof reserveSpend;
  releaseSpend?: typeof releaseSpend;
  enqueueJob?: typeof enqueueJob;
  recordApproval?: typeof recordApproval;
  captureServerEvent?: typeof captureServerEvent;
  addWorkspaceQuestion?: typeof addWorkspaceQuestion;
  now?: () => Date;
  env?: Record<string, string | undefined>;
};

export type StartExploreRunResult = {
  runId: string;
  jobId: string | null;
  status: "queued" | "completed";
  pollAfterSeconds: number | null;
};

export type ExploreRunView = {
  runId: string;
  status: ExploreRunRow["status"];
  pollAfterSeconds: number | null;
  prompt: string;
  highlightBrand: string | null;
  webSearch: boolean;
  country: string | null;
  createdAt: string;
  finishedAt: string | null;
  approvedMaxUsd: number;
  cost: { knownUsd: number; unknownModels: number };
  questionId: string | null;
  results: ExploreModelResult[];
};

export async function startExploreRun(
  client: SupabaseClient,
  params: {
    brandKey: string;
    userId: string;
    body: unknown;
  },
  deps?: ExploreServiceDeps,
): Promise<StartExploreRunResult> {
  const env = deps?.env ?? process.env;
  const now = deps?.now ? deps.now() : new Date();
  const store = deps?.store ?? createExploreStore(client);

  // 1. Feature flag check
  const checkFeature = deps?.isFeatureEnabled ?? isFeatureEnabled;
  const enabled = await checkFeature("prompt_explorer", params.brandKey);
  if (!enabled) {
    throw new AppError(403, "feature_disabled", "Prompt Explorer is not enabled for this workspace.");
  }

  // 2. Validate input
  const input = exploreRunInputSchema.parse(params.body);

  // 3. Rate limits & active run check
  await checkExploreRateLimits(
    client,
    {
      brandKey: params.brandKey,
      userId: params.userId,
      now,
      env,
    },
    deps?.rateLimits,
  );

  // 4. Quote and pricing approval
  const quoteInput = {
    prompt: input.prompt,
    models: input.models,
    webSearch: input.webSearch,
    country: input.country,
    highlightBrand: input.highlightBrand,
    fresh: input.fresh,
  };

  const pricingCtx: PricingContext = {
    brandKey: params.brandKey,
    admin: client,
    env,
    now,
  };

  const quoteFn = deps?.quote ?? quote;
  const q = await quoteFn("ai_visibility.explore.run", pricingCtx, quoteInput);

  if (q.blocked !== null) {
    throw new AppError(409, q.blocked.code, q.blocked.message, {
      recovery: q.blocked.recovery,
      details: { quote: q },
    });
  }

  let approvedMaxUsd = 0;
  if (q.totalUsd > 0) {
    const approveFn = deps?.requireApprovedPrice ?? requireApprovedPrice;
    const approval = await approveFn(
      "ai_visibility.explore.run",
      pricingCtx,
      quoteInput,
      input.maxUsd,
    );
    approvedMaxUsd = approval.approvedMaxUsd;
  }

  // 5. Spend hold reservation
  const runId = crypto.randomUUID();
  let holdId: string | null = null;

  if (q.totalUsd > 0) {
    const reserveFn = deps?.reserveSpend ?? reserveSpend;
    const hold = await reserveFn({
      brandKey: params.brandKey,
      feature: "ai_visibility.explore",
      estimateUsd: q.totalUsd,
      maxUsd: approvedMaxUsd,
      idempotencyKey: `explore:${runId}`,
      ttlSeconds: 1800,
      subject: { kind: "explore_run", id: runId },
    });
    holdId = hold.holdId;
  }

  // 6. Build plan and insert explore_runs row
  const routeDecisions = deps?.resolveRoutes
    ? await deps.resolveRoutes({
        models: input.models,
        country: input.country,
        webSearch: input.webSearch,
        env,
      })
    : await resolveExploreRoutes({
        models: input.models,
        country: input.country,
        webSearch: input.webSearch,
        env,
      });

  const routesForStore: ExploreRoute[] = routeDecisions.map((d) => ({
    model: d.model,
    route: d.route,
    modelName: d.modelName,
  }));

  const promptHash = hashPrompt(input.prompt);
  let reusableMap = new Map<ExploreModel, ReusableExploreObservation>();
  if (!input.fresh) {
    const days = Number(env.EXPLORE_REUSE_DAYS || 7);
    reusableMap = await store.findReusable({
      brandKey: params.brandKey,
      promptHash,
      routes: routesForStore,
      webSearch: input.webSearch,
      country: input.country,
      days,
      now,
    });
  }

  const plan: ExplorePlanEntry[] = input.models.map((model) => {
    const decision = routeDecisions.find((d) => d.model === model);
    const reused = !input.fresh ? reusableMap.get(model) : null;
    const observationId = hashIdentity({ exploreRunId: runId, model });

    return {
      model,
      route: decision?.route ?? null,
      modelName: decision?.modelName ?? null,
      reserveUsd: reused ? 0 : decision?.reserveUsd ?? 0,
      skipped: decision?.skipped ?? null,
      reusedFrom: reused
        ? {
            observationId: reused.observationId,
            runId: reused.runId,
            observedAt: reused.observedAt,
          }
        : null,
      observationId,
    };
  });

  const needsAsking = plan.some(
    (entry) => entry.route !== null && !entry.skipped && !entry.reusedFrom,
  );

  if (!needsAsking) {
    await store.createRun({
      id: runId,
      brand_key: params.brandKey,
      created_by: params.userId,
      job_id: null,
      prompt: input.prompt,
      prompt_hash: promptHash,
      models: input.models,
      web_search: input.webSearch,
      country: input.country,
      highlight_brand: input.highlightBrand,
      status: "completed",
      plan,
      quote: q,
      approved_max_usd: approvedMaxUsd,
      hold_id: holdId,
      question_id: null,
      created_at: now.toISOString(),
      finished_at: now.toISOString(),
    });

    return {
      runId,
      jobId: null,
      status: "completed",
      pollAfterSeconds: null,
    };
  }

  // 7. Enqueue job
  await store.createRun({
    id: runId,
    brand_key: params.brandKey,
    created_by: params.userId,
    job_id: null,
    prompt: input.prompt,
    prompt_hash: promptHash,
    models: input.models,
    web_search: input.webSearch,
    country: input.country,
    highlight_brand: input.highlightBrand,
    status: "queued",
    plan,
    quote: q,
    approved_max_usd: approvedMaxUsd,
    hold_id: holdId,
    question_id: null,
    created_at: now.toISOString(),
    finished_at: null,
  });

  let jobId: string | null = null;
  const enqueueFn = deps?.enqueueJob ?? enqueueJob;
  try {
    const job = await enqueueFn(
      "explore.run",
      { runId },
      {
        brandKey: params.brandKey,
        trigger: "manual",
        singleActiveKey: `explore:${params.brandKey}:${params.userId}`,
        createdBy: params.userId,
      },
    );
    jobId = job.jobId;
    await store.updateRun(params.brandKey, runId, { job_id: jobId });
  } catch (err: any) {
    if (err?.code === "job_already_running") {
      if (holdId) {
        const releaseFn = deps?.releaseSpend ?? releaseSpend;
        try {
          await releaseFn(holdId, "explore_already_running");
        } catch {}
      }
      await store.deleteRun(params.brandKey, runId);
      throw new AppError(
        409,
        "explore_already_running",
        "Your previous question is still being answered.",
        { details: { activeRunId: runId } },
      );
    }
    throw err;
  }

  // 8. Record approval
  if (approvedMaxUsd > 0) {
    const recordFn = deps?.recordApproval ?? recordApproval;
    try {
      await recordFn(client, {
        brandKey: params.brandKey,
        action: "ai_visibility.explore.run",
        approvedMaxUsd,
        quote: q,
        source: "dialog",
        subject: { kind: "explore_run", id: runId },
        approvedBy: params.userId,
      });
    } catch {
      console.error(`[explore] approval record failed ${runId}`);
    }
  }

  // 9. Telemetry
  const captureFn = deps?.captureServerEvent ?? captureServerEvent;
  try {
    await captureFn({
      name: "prompt_explorer:run_started",
      props: {
        models: input.models.length,
        reused: plan.some((p) => p.reusedFrom !== null),
        web_search: input.webSearch,
        has_country: Boolean(input.country),
      },
      userId: params.userId,
      brandKey: params.brandKey,
    });
  } catch {}

  return {
    runId,
    jobId,
    status: "queued",
    pollAfterSeconds: 3,
  };
}

export async function getExploreRun(
  client: SupabaseClient,
  brandKey: string,
  runId: string,
  deps?: ExploreServiceDeps,
): Promise<ExploreRunView> {
  const store = deps?.store ?? createExploreStore(client);
  const run = await store.getRun(brandKey, runId);
  if (!run) {
    throw new AppError(
      404,
      "explore_run_not_found",
      "This question does not exist in this workspace.",
    );
  }

  const runObservations = await store.listRunObservations(brandKey, runId);

  // Load reusable observations if any plan entry reuses from another run
  const reusedObsMap = new Map<string, ExploreObservationRow>();
  for (const entry of run.plan) {
    if (entry.reusedFrom) {
      const reusedObsList = await store.listRunObservations(brandKey, entry.reusedFrom.runId);
      const found = reusedObsList.find((o) => o.id === entry.reusedFrom?.observationId);
      if (found) {
        reusedObsMap.set(found.id, found);
      }
    }
  }

  let knownUsd = 0;
  let unknownModels = 0;

  const results: ExploreModelResult[] = run.models.map((model) => {
    const entry = run.plan.find((p) => p.model === model);
    if (!entry) {
      return shapeExploreError({
        model,
        errorCode: "NOT_AVAILABLE",
        message: "Model plan entry missing.",
      });
    }

    if (entry.reusedFrom) {
      const reusedObs = reusedObsMap.get(entry.reusedFrom.observationId);
      if (reusedObs && typeof reusedObs.result === "object" && reusedObs.result !== null) {
        return shapeExploreSuccess({
          model,
          route: entry.route ?? "dataforseo",
          modelName: entry.modelName,
          response: reusedObs.result as any,
          highlightBrand: run.highlight_brand,
          workspaceAliases: deps?.workspaceAliases,
          countryHint: run.country,
          costUsd: 0,
          costState: "zero",
          reusedFrom: entry.reusedFrom,
          observationId: reusedObs.id,
          observedAt: reusedObs.observed_at,
        });
      }
      return shapeExploreError({
        model,
        errorCode: "UPSTREAM_ERROR",
        message: "Reused answer could not be loaded.",
      });
    }

    if (entry.skipped) {
      const msg =
        entry.skipped === "UNSUPPORTED_COUNTRY"
          ? model === "gemini"
            ? "Gemini doesn’t support country selection. Select “No country preference” above, then run again to include Gemini."
            : `${exploreModelLabel(model)} doesn’t support ${countryLabel(run.country)} as a search country. Select “No country preference” above, then run again to include ${exploreModelLabel(model)}.`
          : "This model is not available yet.";
      return shapeExploreError({
        model,
        errorCode: entry.skipped,
        message: msg,
        costUsd: 0,
      });
    }

    // Active probed model
    const obs = runObservations.find(
      (o) => o.id === entry.observationId || o.engine === model,
    );

    if (!obs) {
      return shapeExploreError({
        model,
        errorCode: "UPSTREAM_ERROR",
        message: "This model is temporarily unavailable. Please try again.",
        costUsd: 0,
      });
    }

    const obsCost = typeof obs.total_cost === "number" ? obs.total_cost : 0;
    if (obs.state === "answered" && obs.result) {
      if (obsCost > 0) {
        knownUsd += obsCost;
      }
      return shapeExploreSuccess({
        model,
        route: entry.route ?? "dataforseo",
        modelName: entry.modelName,
        response: obs.result as any,
        highlightBrand: run.highlight_brand,
        workspaceAliases: deps?.workspaceAliases,
        countryHint: run.country,
        costUsd: obsCost,
        costState: obsCost > 0 ? "measured" : "zero",
        observationId: obs.id,
        observedAt: obs.observed_at,
      });
    }

    // If still in progress
    if (["unattempted", "leased"].includes(obs.state)) {
      if (["queued", "running"].includes(run.status)) {
        // Return placeholder or error with 0 cost
        return shapeExploreError({
          model,
          errorCode: "UPSTREAM_ERROR",
          message: "Waiting for model answer...",
          costUsd: 0,
        });
      }
    }

    // Failed or ambiguous
    if (obsCost > 0) {
      knownUsd += obsCost;
    } else if (obs.unknown_cost_calls && obs.unknown_cost_calls > 0) {
      unknownModels += 1;
    }

    return shapeExploreError({
      model,
      errorCode: "UPSTREAM_ERROR",
      message: "This model is temporarily unavailable. Please try again.",
      costUsd: obsCost,
    });
  });

  return {
    runId: run.id,
    status: run.status,
    pollAfterSeconds: ["queued", "running"].includes(run.status) ? 3 : null,
    prompt: run.prompt,
    highlightBrand: run.highlight_brand,
    webSearch: run.web_search,
    country: run.country,
    createdAt: run.created_at,
    finishedAt: run.finished_at,
    approvedMaxUsd: Number(run.approved_max_usd),
    cost: {
      knownUsd: Number(knownUsd.toFixed(4)),
      unknownModels,
    },
    questionId: run.question_id,
    results,
  };
}

export async function listExploreRuns(
  client: SupabaseClient,
  brandKey: string,
  params: { limit?: number; cursor?: string },
  deps?: ExploreServiceDeps,
): Promise<{
  runs: Array<{
    id: string;
    runId: string;
    prompt: string;
    models: ExploreModel[];
    status: string;
    createdAt: string;
    created_at?: string;
    questionId: string | null;
    question_id?: string | null;
  }>;
  nextCursor: string | null;
}> {
  const store = deps?.store ?? createExploreStore(client);
  const limit = Math.max(1, Math.min(50, params.limit ?? 20));
  const res = await store.listRuns(brandKey, { limit, cursor: params.cursor });
  return {
    runs: res.runs.map((r) => ({
      id: r.id,
      runId: r.id,
      prompt: r.prompt,
      models: r.models,
      status: r.status,
      createdAt: r.created_at,
      created_at: r.created_at,
      questionId: r.question_id,
      question_id: r.question_id,
    })),
    nextCursor: res.nextCursor,
  };
}

export type TrackExploreQuestionResult = {
  questionId: string;
  created: boolean;
  status: string;
};

export async function trackExploreQuestion(
  ws: {
    admin: SupabaseClient;
    brandKey: string;
    user: { id: string };
  },
  runId: string,
  deps?: ExploreServiceDeps,
): Promise<TrackExploreQuestionResult> {
  const store = deps?.store ?? createExploreStore(ws.admin);
  const run = await store.getRun(ws.brandKey, runId);
  if (!run) {
    throw new AppError(
      404,
      "explore_run_not_found",
      "This question does not exist in this workspace.",
    );
  }

  const addFn = deps?.addWorkspaceQuestion ?? addWorkspaceQuestion;
  const res = await addFn(ws.admin, {
    brandKey: ws.brandKey,
    text: run.prompt,
    origin: "manual",
    createdBy: ws.user.id,
    sourceRef: { kind: "explore_run", id: runId },
  });

  if (run.question_id !== res.question.id) {
    await store.updateRun(ws.brandKey, runId, {
      question_id: res.question.id,
    });
  }

  return {
    questionId: res.question.id,
    created: res.created,
    status: res.question.status,
  };
}

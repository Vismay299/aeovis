import { Output, generateText } from "ai";
import type { LanguageModel } from "ai";
import type { ZodType } from "zod";
import { AppError } from "../http/errors.ts";
import {
  AmbiguousCallError,
  UnbilledCallError,
} from "../spend/errors.ts";
import { settleSpend } from "../spend/index.ts";
import type { SpendDeps } from "../spend/index.ts";
import type { SpendFeature } from "../../shared/spend-features.ts";
import { assertModelPriceable, lookupModelPrice, resolveCost } from "../llmPricing.js";
import { getLlmModel } from "../llmConfig.js";
import { buildModel, estimateLlmUsd, openRouterCostUsd } from "./openrouter.ts";

export type LlmDeps = {
  env?: Record<string, string | undefined>;
  model?: LanguageModel;
  spend?: SpendDeps;
  generateText?: typeof generateText;
};

export type LlmCallInput = {
  brandKey: string;
  feature: SpendFeature;
  system: string;
  prompt: string;
  model?: string;
  maxUsd?: number;
  idempotencyKey: string;
  maxOutputTokens?: number;
  timeoutMs?: number;
};

const DEFAULT_MAX_OUTPUT_TOKENS = 4_000;
const DEFAULT_TIMEOUT_MS = 60_000;

function llmEnv(deps?: LlmDeps): Record<string, string | undefined> {
  return deps?.env ?? process.env;
}

function targetEnv(env: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return env as unknown as NodeJS.ProcessEnv;
}

function resolveModel(i: { model?: string }, env: Record<string, string | undefined>): string {
  // Spec §6.2: Model = i.model ?? env.LLM_HELPER_MODEL ?? getContentModel().
  // The repo's provider-neutral config layer (llmConfig) owns the fallback
  // chain: LLM_HELPER_MODEL is the F01 helper's own default, then the shared
  // utility LLM_MODEL, then the built-in default. getLlmModel() here reads the
  // canonical LLM_MODEL; an explicit LLM_HELPER_MODEL check comes first so the
  // helper default wins without splitting the chain across two modules.
  return i.model ?? env.LLM_HELPER_MODEL ?? getLlmModel(targetEnv(env));
}

function providerOf(env: Record<string, string | undefined>): string {
  const base = (env.LLM_BASE_URL ?? "").trim().toLowerCase();
  if (!base || base.includes("openrouter")) return "openrouter";
  return "gateway";
}

// Pre-flight: an unpriced id is a configuration error and fails before the
// request, where it costs nothing. The gateway-reporting branch mirrors
// llmPricing.assertModelPriceable: OpenRouter echoes usage.cost, so an id
// with no table rate is still priceable there.
function assertPriceable(model: string, provider: string, env: Record<string, string | undefined>): void {
  const target = targetEnv(env);
  if (lookupModelPrice(model, target)) return;
  assertModelPriceable(model, provider, target);
}

function toUnbilledStatus(status: number | undefined): boolean {
  return status === 400 || status === 401 || status === 402 || status === 403 || status === 404;
}

function isAbort(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const record = err as { name?: unknown; code?: unknown };
  return record.name === "AbortError" || record.code === "ABORT_ERR" || record.name === "TimeoutError";
}

function statusOf(err: unknown): number | undefined {
  if (!err || typeof err !== "object") return undefined;
  const record = err as { status?: unknown; statusCode?: unknown; response?: { status?: unknown } };
  if (typeof record.status === "number") return record.status;
  if (typeof record.statusCode === "number") return record.statusCode;
  if (record.response && typeof record.response.status === "number") return record.response.status;
  return undefined;
}

// The only log line this module emits. System, prompt, output text and
// headers never reach a log — see the llm.test.ts no-leak cases.
function logFailed(model: string, code: string, deps?: LlmDeps): void {
  const logger = deps?.spend?.logger ?? console;
  logger.error("[llm] call failed", { model, code });
}

function roundedEstimate(promptChars: number, maxOutputTokens: number, env: Record<string, string | undefined>): number {
  const estimate = estimateLlmUsd("model", promptChars, maxOutputTokens, env);
  return Math.max(Math.ceil(estimate * 1_000_000) / 1_000_000, 0.000001);
}

// A null actualUsd means unknown, counted at the estimate — never a free call.
function reportedOrNull(provider: string, providerMetadata: unknown): number | null {
  if (provider !== "openrouter") return null;
  return openRouterCostUsd(providerMetadata);
}

function tableCost(
  model: string,
  provider: string,
  usage: { prompt_tokens?: number; completion_tokens?: number } | undefined,
  env: Record<string, string | undefined>,
  modelForLog: string,
  deps?: LlmDeps
): number {
  const priced = resolveCost({ model, provider, usage, env: targetEnv(env) });
  if (priced.cost_source === "gateway") {
    // A non-OpenRouter gateway never reports cost; a "gateway" source here
    // would mean the price came from nowhere, so refuse rather than settle 0.
    logFailed(modelForLog, "unpriced", deps);
    throw new AppError(500, "llm_unpriced", "The LLM cost could not be priced.");
  }
  return priced.cost;
}

export async function llmText(
  i: LlmCallInput,
  deps?: LlmDeps
): Promise<{ text: string; usd: number | null; model: string }> {
  const env = llmEnv(deps);
  if (!(env.LLM_API_KEY ?? "").trim()) {
    throw new AppError(503, "llm_not_configured", "The LLM helper is not configured.");
  }
  const model = resolveModel(i, env);
  const maxOutputTokens = i.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const timeoutMs = i.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const provider = providerOf(env);
  assertPriceable(model, provider, env);
  const promptChars = (i.system + i.prompt).length;
  const estimate = roundedEstimate(promptChars, maxOutputTokens, env);
  const endpoint = `chat:${model}`;

  const generate = deps?.generateText ?? generateText;
  const languageModel = deps?.model ?? buildModel(model, env);

  // The real cost lands below via settleSpend/settleSpendBatch, because
  // metered()'s own settle path always records cost_source provider_reported —
  // the price_table branch needs the explicit providerCostReported: false.
  const { reserveSpend: reserve } = await import("../spend/index.ts");
  const { holdId } = await reserve(
    {
      brandKey: i.brandKey,
      feature: i.feature,
      estimateUsd: estimate,
      maxUsd: i.maxUsd,
      idempotencyKey: i.idempotencyKey,
    },
    deps?.spend
  );

  let result: Awaited<ReturnType<typeof generateText>>;
  try {
    result = await generate({
      model: languageModel,
      system: i.system,
      prompt: i.prompt,
      maxOutputTokens,
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const status = statusOf(err);
    if (isAbort(err)) {
      logFailed(model, "aborted", deps);
      await settleSpend(holdId, null, { provider: providerName(provider), endpoint }, deps?.spend);
      throw new AmbiguousCallError("The LLM request was aborted; the outcome is unknown.");
    }
    if (status !== undefined && toUnbilledStatus(status)) {
      logFailed(model, `http_${status}`, deps);
      const { releaseSpend: release } = await import("../spend/index.ts");
      await release(holdId, "unbilled_error", deps?.spend);
      throw new UnbilledCallError(`The gateway refused the request (${status}).`);
    }
    await settleSpend(holdId, null, { provider: providerName(provider), endpoint }, deps?.spend);
    throw err;
  }
  const reported = reportedOrNull(provider, result.providerMetadata);
  if (reported !== null) {
    await settleSpend(holdId, reported, { provider: providerName(provider), endpoint }, deps?.spend);
    return { text: result.text, usd: reported, model };
  }
  if (provider === "openrouter") {
    // OpenRouter with no reported cost: unknown, counted at the estimate.
    await settleSpend(holdId, null, { provider: providerName(provider), endpoint }, deps?.spend);
    return { text: result.text, usd: null, model };
  }
  const actual = tableCost(model, provider, tokenUsage(result), env, model, deps);
  const { settleSpendBatch: settleBatch } = await import("../spend/index.ts");
  await settleBatch(
    holdId,
    [{ provider: providerName(provider), endpoint, actualUsd: actual, costSource: "price_table" }],
    deps?.spend
  );
  return { text: result.text, usd: actual, model };
}

export async function llmObject<T>(
  i: LlmCallInput & { schema: ZodType<T> },
  deps?: LlmDeps
): Promise<{ object: T; usd: number | null; model: string }> {
  const env = llmEnv(deps);
  if (!(env.LLM_API_KEY ?? "").trim()) {
    throw new AppError(503, "llm_not_configured", "The LLM helper is not configured.");
  }
  const model = resolveModel(i, env);
  const maxOutputTokens = i.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const timeoutMs = i.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const provider = providerOf(env);
  assertPriceable(model, provider, env);
  const promptChars = (i.system + i.prompt).length;
  const estimate = roundedEstimate(promptChars, maxOutputTokens, env);
  const endpoint = `chat:${model}`;

  const generate = deps?.generateText ?? generateText;
  const languageModel = deps?.model ?? buildModel(model, env);

  const { reserveSpend: reserveObject } = await import("../spend/index.ts");
  const created = await reserveObject(
    {
      brandKey: i.brandKey,
      feature: i.feature,
      estimateUsd: estimate,
      maxUsd: i.maxUsd,
      idempotencyKey: i.idempotencyKey,
    },
    deps?.spend
  );
  const objectHoldId = created.holdId;

  let result: Awaited<ReturnType<typeof generateText>>;
  try {
    result = await generate({
      model: languageModel,
      system: i.system,
      prompt: i.prompt,
      maxOutputTokens,
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(timeoutMs),
      output: Output.object({ schema: i.schema }),
    });
  } catch (err) {
    const status = statusOf(err);
    if (isAbort(err)) {
      logFailed(model, "aborted", deps);
      await settleSpend(objectHoldId, null, { provider: providerName(provider), endpoint }, deps?.spend);
      throw new AmbiguousCallError("The LLM request was aborted; the outcome is unknown.");
    }
    if (status !== undefined && toUnbilledStatus(status)) {
      logFailed(model, `http_${status}`, deps);
      const { releaseSpend: releaseObject } = await import("../spend/index.ts");
      await releaseObject(objectHoldId, "unbilled_error", deps?.spend);
      throw new UnbilledCallError(`The gateway refused the request (${status}).`);
    }
    await settleSpend(objectHoldId, null, { provider: providerName(provider), endpoint }, deps?.spend);
    throw err;
  }
  const output = (result as { output?: unknown }).output;
  const parsed = i.schema.safeParse(output);
  if (!parsed.success) {
    // The gateway billed for tokens it generated; a schema failure is a
    // billed failure (settled at the known cost), then a 502 to the caller.
    logFailed(model, "bad_output", deps);
    const badReported = reportedOrNull(provider, result.providerMetadata);
    const badActual =
      badReported !== null
        ? badReported
        : provider === "openrouter"
          ? null
          : tableCost(model, provider, tokenUsage(result), env, model, deps);
    if (badActual === null) {
      await settleSpend(
        objectHoldId,
        null,
        { provider: providerName(provider), endpoint },
        deps?.spend
      );
    } else if (provider === "openrouter") {
      await settleSpend(
        objectHoldId,
        badActual,
        { provider: providerName(provider), endpoint },
        deps?.spend
      );
    } else {
      const { settleSpendBatch: settleBad } = await import("../spend/index.ts");
      await settleBad(
        objectHoldId,
        [{ provider: providerName(provider), endpoint, actualUsd: badActual, costSource: "price_table" }],
        deps?.spend
      );
    }
    throw new AppError(502, "llm_bad_output", "The model returned an answer that did not match the schema.");
  }
  const reported = reportedOrNull(provider, result.providerMetadata);
  if (reported !== null) {
    await settleSpend(objectHoldId, reported, { provider: providerName(provider), endpoint }, deps?.spend);
    return { object: parsed.data as T, usd: reported, model };
  }
  if (provider === "openrouter") {
    await settleSpend(objectHoldId, null, { provider: providerName(provider), endpoint }, deps?.spend);
    return { object: parsed.data as T, usd: null, model };
  }
  const actual = tableCost(model, provider, tokenUsage(result), env, model, deps);
  const { settleSpendBatch: settleBatch } = await import("../spend/index.ts");
  await settleBatch(
    objectHoldId,
    [{ provider: providerName(provider), endpoint, actualUsd: actual, costSource: "price_table" }],
    deps?.spend
  );
  return { object: parsed.data as T, usd: actual, model };
}

function providerName(provider: string): string {
  return provider === "openrouter" ? "openrouter" : "gateway";
}

function tokenUsage(result: { usage?: { inputTokens?: number; outputTokens?: number } }): {
  prompt_tokens?: number;
  completion_tokens?: number;
} {
  return {
    prompt_tokens: result.usage?.inputTokens,
    completion_tokens: result.usage?.outputTokens,
  };
}

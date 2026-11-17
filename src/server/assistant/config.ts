import { assertModelPriceable } from "../../shared/llmPricing.js";
import { getContentModel } from "../llm.js";

export type AssistantConfig = {
  model: string;
  turnMaxUsd: number;
  maxSteps: number;
  maxOutputTokens: number;
  deadlineMs: number;
  compactAfterTokens: number;
  maxInputTokens: number;
  perUserHour: number;
  perWorkspaceDay: number;
  approvalTtlSeconds: number;
};

export type AssistantConfigured = { ok: true } | { ok: false; code: "llm_not_configured" | "model_unpriced" };

type NumericKey = Exclude<keyof AssistantConfig, "model">;

type NumericSpec = { env: string; fallback: number; min: number; max: number; integer?: boolean };

/**
 * §6.2.7 defaults. A value outside its range is a deployment mistake, not a
 * reason to run with a cap of zero: it falls back to the default and logs one
 * line naming the key (never the value).
 */
const NUMERIC: Record<NumericKey, NumericSpec> = {
  turnMaxUsd: { env: "ASSISTANT_TURN_MAX_USD", fallback: 0.5, min: 0.000001, max: 1_000 },
  maxSteps: { env: "ASSISTANT_MAX_STEPS", fallback: 25, min: 1, max: 200, integer: true },
  maxOutputTokens: {
    env: "ASSISTANT_MAX_OUTPUT_TOKENS",
    fallback: 8_000,
    min: 1,
    max: 100_000,
    integer: true,
  },
  deadlineMs: {
    env: "ASSISTANT_TURN_DEADLINE_MS",
    fallback: 240_000,
    min: 1_000,
    max: 300_000,
    integer: true,
  },
  compactAfterTokens: {
    env: "ASSISTANT_COMPACT_AFTER_TOKENS",
    fallback: 120_000,
    min: 1_000,
    max: 2_000_000,
    integer: true,
  },
  maxInputTokens: {
    env: "ASSISTANT_MAX_INPUT_TOKENS",
    fallback: 160_000,
    min: 1_000,
    max: 2_000_000,
    integer: true,
  },
  perUserHour: {
    env: "ASSISTANT_TURNS_PER_USER_HOUR",
    fallback: 30,
    min: 1,
    max: 10_000,
    integer: true,
  },
  perWorkspaceDay: {
    env: "ASSISTANT_TURNS_PER_WORKSPACE_DAY",
    fallback: 300,
    min: 1,
    max: 100_000,
    integer: true,
  },
  approvalTtlSeconds: {
    env: "ASSISTANT_APPROVAL_TTL_SECONDS",
    fallback: 900,
    min: 60,
    max: 86_400,
    integer: true,
  },
};

export function assistantProvider(env: Record<string, string | undefined>): string {
  const base = (env.LLM_BASE_URL ?? "").trim().toLowerCase();
  if (!base || base.includes("openrouter")) return "openrouter";
  return "gateway";
}

export function assistantModel(env: Record<string, string | undefined>): string {
  return env.ASSISTANT_MODEL?.trim() || env.LLM_HELPER_MODEL?.trim() || getContentModel();
}

function readNumber(
  env: Record<string, string | undefined>,
  key: NumericKey,
  warn: (key: string) => void,
): number {
  const spec = NUMERIC[key];
  const raw = env[spec.env];
  if (raw === undefined || raw === null || String(raw).trim() === "") return spec.fallback;
  const value = Number(String(raw).trim());
  const valid =
    Number.isFinite(value) &&
    value >= spec.min &&
    value <= spec.max &&
    (spec.integer !== true || Number.isInteger(value));
  if (!valid) {
    warn(key);
    return spec.fallback;
  }
  return value;
}

export function readAssistantConfig(
  env: Record<string, string | undefined> = process.env,
  deps: { warn?: (key: string) => void } = {},
): AssistantConfig {
  const warn =
    deps.warn ??
    ((key: string) => {
      console.warn("[assistant] bad config", { key });
    });
  const numbers = {} as Record<NumericKey, number>;
  for (const key of Object.keys(NUMERIC) as NumericKey[]) {
    numbers[key] = readNumber(env, key, warn);
  }
  return { model: assistantModel(env), ...numbers };
}

/**
 * Whether this deployment can answer at all: a key, a model and a model the
 * price table (or the gateway's own cost echo) can price. An unpriced model
 * would otherwise fail after the first billed step.
 */
export function assistantConfigured(
  env: Record<string, string | undefined> = process.env,
): AssistantConfigured {
  const model = assistantModel(env);
  if (!model || !(env.LLM_API_KEY ?? "").trim()) {
    return { ok: false, code: "llm_not_configured" };
  }
  try {
    assertModelPriceable(model, assistantProvider(env), env as unknown as NodeJS.ProcessEnv);
    return { ok: true };
  } catch {
    return { ok: false, code: "model_unpriced" };
  }
}

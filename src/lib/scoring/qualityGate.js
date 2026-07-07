import { Engine } from "../engines/types.js";

const OPTIONAL_PROBE_ENGINES = new Set([Engine.GOOGLE_AI_OVERVIEW]);

export function inferProbeEngine(run) {
  if (run.engine) return run.engine;
  const model = run.model_used || "";
  if (model.startsWith("google_ai_overview")) return Engine.GOOGLE_AI_OVERVIEW;
  if (model.startsWith("perplexity")) return Engine.PERPLEXITY;
  if (model.startsWith("gpt") || model.startsWith("openai")) return Engine.OPENAI;
  return Engine.GEMINI;
}

export function isProbeRunFailure(run) {
  const isFailed = run.model_used?.endsWith("-failed");
  const isEmpty = !run.raw_response?.trim();
  const isSkipped = run.model_used?.includes("skipped");
  return isFailed || (isEmpty && !isSkipped);
}

export function computeProbeFailureRate(brandRuns) {
  const requiredRuns = (brandRuns || []).filter((run) => {
    return !OPTIONAL_PROBE_ENGINES.has(inferProbeEngine(run));
  });

  const runsForGate = requiredRuns.length > 0 ? requiredRuns : brandRuns || [];
  if (runsForGate.length === 0) return 0;

  const failedProbes = runsForGate.filter(isProbeRunFailure).length;
  return failedProbes / runsForGate.length;
}

export function evaluateControlPassed(controlResult) {
  const successfulRuns = (controlResult.run_details || []).filter((run) => !isProbeRunFailure(run));
  return successfulRuns.length > 0 && successfulRuns.some((run) => run.mentioned);
}
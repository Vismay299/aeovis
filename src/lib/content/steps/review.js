import { renderStepPrompt } from "../skills/loader.js";
import { validateReview } from "../schemas.js";
import { isYmylBrief } from "../briefs/healthcareCxo.js";
import { callStepLlm } from "./shared.js";

/**
 * Review step (master accuracy agent): rubric scoring against the research
 * pack. The verdict and weighted total are recomputed in code
 * (schemas.validateReview) — the model scores, the code decides. A YMYL
 * violation always fails and can never be auto-revised into a pass.
 */
export async function runReview(ctx, deps = {}) {
  const ymylActive = isYmylBrief(ctx.brief);

  const prompt = renderStepPrompt("review", ctx.playbook, {
    brand: ctx.brand,
    brief: ctx.brief,
    work_order: ctx.workOrder,
    research_pack: ctx.researchPack,
    benchmark_notes: ctx.benchmarkNotes,
    draft: ctx.draft,
    ymyl_mode: ymylActive
      ? "ACTIVE — healthcare/YMYL rules are in force"
      : "inactive (non-YMYL vertical; score ymyl_compliance 1.0 unless a claim is clearly dangerous)",
  });

  return callStepLlm({
    step: "review",
    prompt,
    validate: (out) => validateReview(ctx.playbook, out),
    llm: deps.llm,
    stats: ctx.stats,
    temperature: 0.2,
  });
}

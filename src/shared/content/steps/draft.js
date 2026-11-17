import { renderStepPrompt } from "../skills/loader.js";
import { validateDraft } from "../schemas.js";
import { callStepLlm, formatLessons, formatAgentOverlay } from "./shared.js";

/**
 * Draft step: channel prompt pack + work order + research pack + lessons →
 * the draft. On a revision pass, ctx.critique carries the reviewer's
 * numbered fixes and the skill instructs the model to fix every point.
 */
export async function runDraft(ctx, deps = {}) {
  const prompt = renderStepPrompt("draft", ctx.playbook, {
    brand: ctx.input?.brand_name || ctx.brand,
    brief: ctx.brief,
    agent: formatAgentOverlay(ctx.agent),
    lessons: formatLessons(ctx.lessons),
    knowledge: ctx.knowledge || "(no knowledge blocks configured)",
    work_order: ctx.workOrder,
    research_pack: ctx.researchPack,
    benchmark_notes: ctx.benchmarkNotes,
    critique: ctx.critique || "(first pass — no critique yet)",
  });

  return callStepLlm({
    step: "draft",
    prompt,
    validate: (out) => validateDraft(ctx.playbook, out),
    llm: deps.llm,
    stats: ctx.stats,
    temperature: 0.6,
  });
}

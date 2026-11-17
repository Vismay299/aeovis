import { renderStepPrompt } from "../skills/loader.js";
import { validateReview } from "../schemas.js";
import { isYmylBrief } from "../briefs/healthcareCxo.js";
import { getFormat } from "../agents/formats.js";
import { callStepLlm, formatAgentOverlay } from "./shared.js";

/**
 * Review step (master accuracy agent): rubric scoring against the research
 * pack. The verdict and weighted total are recomputed in code
 * (schemas.validateReview) — the model scores, the code decides. A YMYL
 * violation always fails and can never be auto-revised into a pass.
 */
export async function runReview(ctx, deps = {}) {
  const ymylActive = isYmylBrief(ctx.brief);
  const fmt = getFormat(ctx.agent?.format);
  const formatChecklist =
    fmt.checklist && fmt.checklist.length
      ? `This agent's OUTPUT FORMAT is "${fmt.label}". The channel_checklist/format_checklist dimension MUST verify:\n` +
        fmt.checklist.map((c) => `- ${c}`).join("\n")
      : "";

  const factCheckBlock = ctx.factCheck
    ? `Independent fact-check ${ctx.factCheck.passed ? "PASSED" : "FAILED"} with ${ctx.factCheck.issues.length} issue(s):\n` +
      ctx.factCheck.issues
        .map((i) => `- [${i.kind}] "${i.claim}" — ${i.problem}`)
        .join("\n")
    : "(no independent fact-check block ran in this pipeline)";

  const prompt = renderStepPrompt("review", ctx.playbook, {
    brand: ctx.input?.brand_name || ctx.brand,
    brief: ctx.brief,
    agent: formatAgentOverlay(ctx.agent),
    format_checklist: formatChecklist || "(no format-specific checklist)",
    knowledge: ctx.knowledge || "(no knowledge blocks configured)",
    fact_check: factCheckBlock,
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
    validate: (out) => validateReview(ctx.playbook, out, ctx.agent?.rubric_emphasis),
    llm: deps.llm,
    stats: ctx.stats,
    temperature: 0.2,
  });
}

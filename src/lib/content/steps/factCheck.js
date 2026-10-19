import {bindResearchCheck} from '../../repairs/researchContract.js';
import { renderStepPrompt } from "../skills/loader.js";
import { validateFactCheck } from "../schemas.js";
import { callStepLlm } from "./shared.js";

/**
 * Fact-check block: independent claim verification of the current draft
 * against the research pack + knowledge blocks. Findings feed the Editor's
 * review prompt and land in the final rubric's violations.
 */
export async function runFactCheck(ctx, deps = {}) {
  const prompt = renderStepPrompt("fact_check", "shared", {
    brand: ctx.input?.brand_name || ctx.brand,
    draft: ctx.draft,
    research_pack: ctx.researchPack,
    knowledge: ctx.knowledge || "(no knowledge blocks)",
  });

  const verdict = await callStepLlm({
    step: "fact_check",
    prompt,
    validate: validateFactCheck,
    llm: deps.llm,
    stats: ctx.stats,
    temperature: 0.2,
  });
  return bindResearchCheck(ctx,verdict);
}

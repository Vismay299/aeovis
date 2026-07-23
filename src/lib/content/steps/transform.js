import { renderStepPrompt } from "../skills/loader.js";
import { validateDraft } from "../schemas.js";
import { getBlock } from "../agents/blocks.js";
import { callStepLlm, formatAgentOverlay } from "./shared.js";

/**
 * Generic transform runner — executes any `transform`-kind block from the
 * registry (translate, tighten, voice_polish, and whatever gets added next).
 * The block's directive (with its config interpolated) is the entire job;
 * the shared transform skill enforces fact preservation.
 */
export function renderDirective(block, agent) {
  let directive = block.directive || "";
  const schema = block.config_schema || {};
  const cfg = agent?.format_config?.[`${block.slug}`] || agent?.block_config?.[block.slug] || {};
  for (const [key, spec] of Object.entries(schema)) {
    const value = cfg[key] ?? spec.default;
    directive = directive.split(`{${key}}`).join(String(value));
  }
  return directive;
}

export async function runTransform(ctx, blockSlug, deps = {}) {
  const block = getBlock(blockSlug);
  if (!block || block.kind !== "transform") {
    throw new Error(`"${blockSlug}" is not a transform block`);
  }

  const prompt = renderStepPrompt("transform", "shared", {
    brand: ctx.brand,
    brief: ctx.brief,
    agent: formatAgentOverlay(ctx.agent),
    directive: renderDirective(block, ctx.agent),
    draft: ctx.draft,
    knowledge: ctx.knowledge || "(no knowledge blocks)",
  });

  return callStepLlm({
    step: blockSlug,
    prompt,
    validate: (out) => validateDraft(ctx.playbook, out),
    llm: deps.llm,
    stats: ctx.stats,
    temperature: 0.4,
  });
}

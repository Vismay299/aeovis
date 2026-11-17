import { loadSkill, renderStepPrompt } from "../skills/loader.js";
import { validateBenchmarkNotes } from "../schemas.js";
import {
  callStepLlm,
  formatAgentOverlay,
  rowsForQueries,
  formatCitationsByEngine,
  formatScrapedPages,
} from "./shared.js";

/**
 * Benchmark step.
 * geo_article: citation teardown — classify the format distribution of the
 * currently-cited pages and apply the decision table (one LLM call).
 * linkedin_post: STATIC channel pack parsed straight from the skill file —
 * no LLM call, no live LinkedIn data (honest v1; the lessons loop is the
 * personalization mechanism).
 */

/** Extract the first ```json fence from a skill body (static packs). */
export function parseStaticPack(skillBody) {
  const m = skillBody.match(/```json\s*([\s\S]*?)```/);
  if (!m) throw new Error("benchmark.linkedin_post skill has no ```json pack block");
  return JSON.parse(m[1]);
}

export async function runBenchmark(ctx, deps = {}) {
  if (ctx.playbook === "linkedin_post") {
    const skill = loadSkill("benchmark", "linkedin_post");
    const pack = parseStaticPack(skill.body);
    const result = validateBenchmarkNotes("linkedin_post", { pack });
    if (!result.ok) throw new Error(`Static channel pack invalid: ${result.errors.join("; ")}`);
    return result.value;
  }

  const targetQueries = ctx.workOrder?.target_queries || [];
  const rows = rowsForQueries(ctx.scan, targetQueries);

  const prompt = renderStepPrompt("benchmark", ctx.playbook, {
    brand: ctx.input?.brand_name || ctx.brand,
    brief: ctx.brief,
    agent: formatAgentOverlay(ctx.agent),
    work_order: ctx.workOrder,
    citations_by_engine: formatCitationsByEngine(rows),
    scraped_pages: formatScrapedPages(ctx.scrapedPages),
  });

  return callStepLlm({
    step: "benchmark",
    prompt,
    validate: (out) => validateBenchmarkNotes(ctx.playbook, out),
    llm: deps.llm,
    stats: ctx.stats,
    temperature: 0.2,
  });
}

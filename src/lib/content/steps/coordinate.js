import { renderStepPrompt } from "../skills/loader.js";
import { validateWorkOrder } from "../schemas.js";
import {
  callStepLlm,
  formatLessons,
  normalizeScanRows,
  formatScanAnswers,
} from "./shared.js";

/**
 * Coordinate step: input (+ latest scan) → work order.
 * Injects the brand brief + active lessons; for geo_article the work order
 * includes the query fan-out that becomes the draft's section plan.
 */

/** Compact scan context: the gap row's own answers + a sample of sibling gaps. */
export function buildScanContext(ctx) {
  const blocks = [];

  const input = ctx.input || {};
  if (input.query) {
    const gapRows = normalizeScanRows(ctx.scan).filter(
      (r) => r.prompt.toLowerCase().trim() === String(input.query).toLowerCase().trim()
    );
    if (gapRows.length > 0) {
      blocks.push("## The gap query's current AI answers\n" + formatScanAnswers(gapRows));
    } else if (input.answer_text) {
      // Trigger payloads from the dashboard ride the answer along directly.
      blocks.push(
        `## The gap query's current AI answer (from trigger payload)\n### [${input.engine || "aio"}] "${input.query}"\n` +
          String(input.answer_text).slice(0, 1400) +
          (Array.isArray(input.citations) && input.citations.length
            ? "\nCitations:\n" +
              input.citations
                .slice(0, 8)
                .map((c) => `  - ${typeof c === "string" ? c : c.href || ""}`)
                .join("\n")
            : "")
      );
    }
  }

  if (ctx.scan) {
    const siblings = normalizeScanRows(ctx.scan)
      .filter((r) => !r.is_branded_query && r.present && !r.visible)
      .filter((r) => r.prompt.toLowerCase().trim() !== String(input.query || "").toLowerCase().trim())
      .slice(0, 10)
      .map((r) => `- [${r.engine}] "${r.prompt}" (brand absent)`);
    if (siblings.length > 0) {
      blocks.push("## Sibling gap queries from the same scan (candidates for target_queries)\n" + siblings.join("\n"));
    }
  }

  return blocks.length ? blocks.join("\n\n") : "(no scan context available)";
}

export async function runCoordinate(ctx, deps = {}) {
  const prompt = renderStepPrompt("coordinate", ctx.playbook, {
    brand: ctx.brand,
    brief: ctx.brief,
    lessons: formatLessons(ctx.lessons),
    input: ctx.input,
    scan_context: buildScanContext(ctx),
  });

  return callStepLlm({
    step: "coordinate",
    prompt,
    validate: (out) => validateWorkOrder(ctx.playbook, out),
    llm: deps.llm,
    stats: ctx.stats,
    temperature: 0.4,
  });
}

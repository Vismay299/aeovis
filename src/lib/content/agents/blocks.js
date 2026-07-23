import { CREW, CREW_BY_STEP } from "./crew.js";

/**
 * Block registry — the palette of the Crew Canvas.
 *
 * A pipeline is an ordered list of block slugs. Kinds define the contract:
 *   context   — builds run context (work order, research pack, teardown)
 *   draft     — produces the draft (exactly one per pipeline)
 *   transform — rewrites the current draft (translate, tighten, polish)
 *   check     — inspects the draft (fact-check); `review` is the terminal
 *               check with the bounded revision loop and always runs last
 *
 * Adding a block here (+ a directive) makes it draggable in the canvas with
 * no further code for transforms — the generic transform runner executes it.
 */

const core = (step, kind, locked) => ({
  ...CREW_BY_STEP[step],
  slug: step,
  kind,
  locked: locked || false,
  removable: !locked,
});

export const BLOCKS = {
  coordinate: { ...core("coordinate", "context", true) },
  research: { ...core("research", "context"), blurb: "Mines AI answers + scrapes winning pages for citable facts." },
  benchmark: { ...core("benchmark", "context"), blurb: "Citation teardown → a binding format directive." },
  draft: { ...core("draft", "draft", true) },
  review: { ...core("review", "check", true) },

  translate: {
    slug: "translate",
    name: "Translator",
    emoji: "🌐",
    role: "Localization",
    kind: "transform",
    verb: "Translating the draft",
    blurb: "Rewrites the draft in another language, structure and facts intact.",
    config_schema: { language: { label: "Language", type: "text", default: "Hindi" } },
    directive:
      "Translate the ENTIRE draft into {language}. Preserve the markdown structure (headings, lists, tables), all numbers exactly, and keep brand names, product names, and proper nouns in their original script. The result must read as native {language} written by an operator, not machine translation. Title translates too.",
  },
  tighten: {
    slug: "tighten",
    name: "Tightener",
    emoji: "✂️",
    role: "Line editor",
    kind: "transform",
    verb: "Cutting the fat",
    blurb: "Cuts 20–30% of the words. Kills filler, keeps every fact.",
    directive:
      "Tighten the draft: cut 20–30% of the word count without losing a single fact, stat, or section. Kill filler phrases, merge redundant sentences, prefer verbs over noun phrases. Keep the markdown structure and all citations. The result must be punchier, not thinner.",
  },
  voice_polish: {
    slug: "voice_polish",
    name: "Voice Polisher",
    emoji: "🪞",
    role: "Brand voice",
    kind: "transform",
    verb: "Enforcing the brand voice",
    blurb: "Rewrites strictly to the brief's tone rules without touching facts.",
    directive:
      "Rewrite the draft to STRICTLY obey the brand brief's tone_rules and the agent's design rules. Do not change any fact, number, citation, or the structure — only the voice: word choice, sentence rhythm, register. Remove anything the rules ban.",
  },
  fact_check: {
    slug: "fact_check",
    name: "Fact-Checker",
    emoji: "🧾",
    role: "Verification",
    kind: "check",
    verb: "Verifying every claim",
    blurb: "Cross-checks each stat and claim against the research pack and knowledge blocks.",
  },
};

export const BLOCK_SLUGS = Object.keys(BLOCKS);

export function getBlock(slug) {
  return BLOCKS[slug] || null;
}

/** Default pipelines per base — identical to the fixed v2 crew. */
export const DEFAULT_PIPELINES = {
  geo_article: ["coordinate", "research", "benchmark", "draft", "review"],
  linkedin_post: ["coordinate", "research", "benchmark", "draft", "review"],
};

/**
 * Validate a pipeline. Rules keep the engine sound while everything between
 * the locked posts stays fully composable:
 *   - starts with coordinate, ends with review, exactly one draft
 *   - context blocks before draft; transform/check blocks after draft
 *   - no duplicate blocks, all slugs known
 */
export function validatePipeline(pipeline) {
  const errors = [];
  if (!Array.isArray(pipeline) || pipeline.length === 0) {
    return { ok: false, errors: ["pipeline must be a non-empty array"], value: null };
  }
  const slugs = pipeline.map((s) => String(s || "").trim()).filter(Boolean);

  const unknown = slugs.filter((s) => !BLOCKS[s]);
  if (unknown.length) errors.push(`unknown blocks: ${unknown.join(", ")}`);

  const dupes = slugs.filter((s, i) => slugs.indexOf(s) !== i);
  if (dupes.length) errors.push(`duplicate blocks: ${Array.from(new Set(dupes)).join(", ")}`);

  if (slugs[0] !== "coordinate") errors.push("pipeline must start with the Strategist (coordinate)");
  if (slugs[slugs.length - 1] !== "review") errors.push("pipeline must end with the Editor (review)");

  const draftIdx = slugs.indexOf("draft");
  if (draftIdx === -1) errors.push("pipeline must include the Writer (draft)");
  if (slugs.filter((s) => s === "draft").length > 1) errors.push("only one Writer block allowed");

  if (draftIdx !== -1 && !unknown.length) {
    slugs.forEach((s, i) => {
      const b = BLOCKS[s];
      if (!b) return;
      if (b.kind === "context" && i > draftIdx)
        errors.push(`${b.name} (context) must come before the Writer`);
      if ((b.kind === "transform" || s === "fact_check") && i < draftIdx)
        errors.push(`${b.name} must come after the Writer`);
    });
  }

  return { ok: errors.length === 0, errors, value: errors.length ? null : slugs };
}

/** The pipeline an agent actually runs: its own (if valid) else the base default. */
export function resolvePipeline(agent) {
  if (agent?.pipeline) {
    const v = validatePipeline(agent.pipeline);
    if (v.ok) return v.value;
    console.warn("[blocks] invalid agent pipeline, falling back to default:", v.errors.join("; "));
  }
  return DEFAULT_PIPELINES[agent?.base] || DEFAULT_PIPELINES.geo_article;
}

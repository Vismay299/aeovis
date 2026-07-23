import { FORMAT_KEYS, getFormat, baseForFormat } from "./formats.js";
import { validatePipeline } from "./blocks.js";

/**
 * Agent model — validation, normalization, and built-in seeds.
 *
 * A custom Agent is a configured content operator. It defines:
 *   - what:   format (article/listicle/comparison/faq/how_to/linkedin_post/thread)
 *   - where:  channel (website/linkedin/blog/x/…)
 *   - how:    length, design_rules, custom_instructions, format_config
 *   - focus:  rubric_emphasis (which review dimensions matter most)
 *   - target: default gap-selection strategy
 *
 * The pipeline mechanics come from `base` (geo_article | linkedin_post),
 * defaulted from the format but overridable.
 */

export const BASES = ["geo_article", "linkedin_post"];
export const CHANNELS = ["website", "blog", "linkedin", "x", "newsletter", "other"];
export const TARGETING_STRATEGIES = ["worst_gaps", "rank_not_cited", "absent", "manual"];

function slugify(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 48);
}

function asStringArray(v) {
  if (!Array.isArray(v)) return [];
  return v.map((s) => String(s || "").trim()).filter(Boolean).slice(0, 30);
}

const RUBRIC_DIMS = [
  "facts_vs_research",
  "citation_validity",
  "authority_specificity",
  "hook_strength",
  "persona_fit",
  "brand_voice",
  "channel_checklist",
  "format_checklist",
];

/** Validate + normalize an agent payload from the builder UI. */
export function normalizeAgent(input, brand) {
  const errors = [];
  const name = String(input?.name || "").trim();
  if (!name) errors.push("name is required");

  const format = FORMAT_KEYS.includes(input?.format) ? input.format : "article";
  const base = BASES.includes(input?.base) ? input.base : baseForFormat(format);
  const channel = CHANNELS.includes(input?.channel) ? input.channel : getFormat(format).base === "linkedin_post" ? "linkedin" : "website";

  const emphasis = {};
  if (input?.rubric_emphasis && typeof input.rubric_emphasis === "object") {
    for (const [dim, mult] of Object.entries(input.rubric_emphasis)) {
      if (!RUBRIC_DIMS.includes(dim)) continue;
      const m = Number(mult);
      if (Number.isFinite(m) && m > 0 && m <= 3) emphasis[dim] = Math.round(m * 100) / 100;
    }
  }

  const targeting =
    input?.targeting && TARGETING_STRATEGIES.includes(input.targeting.strategy)
      ? { strategy: input.targeting.strategy }
      : { strategy: "worst_gaps" };

  const formatConfig =
    input?.format_config && typeof input.format_config === "object" ? input.format_config : {};

  // Custom crew pipeline (Crew Canvas). Invalid pipelines are a hard error so
  // the builder surfaces the exact rule that was broken.
  let pipeline = null;
  if (input?.pipeline != null) {
    const v = validatePipeline(input.pipeline);
    if (!v.ok) errors.push(...v.errors);
    else pipeline = v.value;
  }

  // Per-block config (e.g. translate → { language: "Hindi" }).
  const blockConfig =
    input?.block_config && typeof input.block_config === "object" ? input.block_config : {};

  const agent = {
    name,
    slug: input?.slug ? slugify(input.slug) : slugify(name),
    emoji: String(input?.emoji || getFormat(format).emoji || "🤖").slice(0, 4),
    color: typeof input?.color === "string" ? input.color : "accent",
    description: String(input?.description || "").trim().slice(0, 280),
    base,
    format,
    channel,
    length_hint: String(input?.length_hint || getFormat(format).length_hint || "").trim().slice(0, 60),
    design_rules: asStringArray(input?.design_rules),
    format_config: formatConfig,
    custom_instructions: String(input?.custom_instructions || "").trim().slice(0, 1200),
    rubric_emphasis: emphasis,
    targeting,
    pipeline,
    block_config: blockConfig,
    is_builtin: input?.is_builtin === true,
    active: input?.active !== false,
  };

  return { ok: errors.length === 0, errors, agent };
}

/**
 * Built-in agents seeded per brand on first use. Users can edit or add their
 * own (e.g. a "Listicle Writer") on top of these.
 */
export function builtinAgents() {
  return [
    normalizeAgent(
      {
        name: "GEO Citation Writer",
        emoji: "📄",
        color: "accent",
        description:
          "Passage-optimized long-form engineered to become the passage AI engines cite. Grounded in scan gaps and winning-page teardowns.",
        format: "article",
        base: "geo_article",
        channel: "website",
        design_rules: [],
        custom_instructions: "",
        rubric_emphasis: { citation_validity: 1.3, authority_specificity: 1.2 },
        targeting: { strategy: "worst_gaps" },
        is_builtin: true,
      },
      ""
    ).agent,
    normalizeAgent(
      {
        name: "LinkedIn CXO",
        emoji: "💼",
        color: "info",
        description:
          "Hook-first executive-voice LinkedIn posts for senior personas. Copy-to-clipboard, human posts manually.",
        format: "linkedin_post",
        base: "linkedin_post",
        channel: "linkedin",
        design_rules: [],
        custom_instructions: "",
        rubric_emphasis: { hook_strength: 1.3, persona_fit: 1.2 },
        targeting: { strategy: "manual" },
        is_builtin: true,
      },
      ""
    ).agent,
  ];
}

/** The default agent for a base pipeline, used when a job has no agent set. */
export function defaultAgentForBase(base) {
  return base === "linkedin_post"
    ? {
        name: "LinkedIn CXO",
        emoji: "💼",
        base: "linkedin_post",
        format: "linkedin_post",
        channel: "linkedin",
        design_rules: [],
        format_config: {},
        custom_instructions: "",
        rubric_emphasis: {},
        length_hint: "150–300 words",
      }
    : {
        name: "GEO Citation Writer",
        emoji: "📄",
        base: "geo_article",
        format: "article",
        channel: "website",
        design_rules: [],
        format_config: {},
        custom_instructions: "",
        rubric_emphasis: {},
        length_hint: "900–1600 words",
      };
}

/**
 * Step-output schemas for the content pipeline.
 *
 * Every step's LLM output is validated here before the next step runs
 * (reject → retry once → fail the job with the step named). Deliberately
 * dependency-free: small hand validators beat a JSON-schema lib for six
 * fixed shapes, and error strings are written to be fed back to the model
 * on the retry pass.
 */

export const PLAYBOOKS = ["geo_article", "linkedin_post"];

export const POST_SHAPES = [
  "contrarian_take",
  "numbered_playbook",
  "war_story",
  "data_point",
  "question_frame",
];

/** Canonical rubric weights per playbook — code, not the LLM, owns these. */
export const RUBRIC_WEIGHTS = {
  geo_article: {
    facts_vs_research: 0.25,
    citation_validity: 0.2,
    authority_specificity: 0.2,
    brand_voice: 0.1,
    channel_checklist: 0.15,
    ymyl_compliance: 0.1,
  },
  linkedin_post: {
    facts_vs_research: 0.3,
    hook_strength: 0.25,
    persona_fit: 0.2,
    format_checklist: 0.15,
    ymyl_compliance: 0.1,
  },
};

/** Per-dimension floors. A floor breach fails the verdict regardless of total. */
export const RUBRIC_FLOORS = {
  geo_article: {
    facts_vs_research: 0.7,
    citation_validity: 0.6,
    authority_specificity: 0.6,
    brand_voice: 0.4,
    channel_checklist: 0.6,
  },
  linkedin_post: {
    facts_vs_research: 0.7,
    hook_strength: 0.6,
    persona_fit: 0.6,
    format_checklist: 0.6,
  },
};

export const PASS_THRESHOLD = 0.75;

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

function asStringArray(v) {
  if (!Array.isArray(v)) return [];
  return v.filter(isNonEmptyString).map((s) => s.trim());
}

function fail(errors) {
  return { ok: false, errors, value: null };
}

function pass(value) {
  return { ok: true, errors: [], value };
}

// ---------------------------------------------------------------------------
// coordinate → work_order
// ---------------------------------------------------------------------------

export function validateWorkOrder(playbook, obj) {
  if (!obj || typeof obj !== "object") return fail(["work_order is not an object"]);
  const errors = [];

  if (!isNonEmptyString(obj.angle)) errors.push("angle: required non-empty string");
  if (!isNonEmptyString(obj.title_hint)) errors.push("title_hint: required non-empty string");

  const value = {
    angle: String(obj.angle || "").trim(),
    title_hint: String(obj.title_hint || "").trim(),
    target_queries: asStringArray(obj.target_queries),
    fan_out: asStringArray(obj.fan_out),
    sections: [],
    hook_thesis: isNonEmptyString(obj.hook_thesis) ? obj.hook_thesis.trim() : "",
    post_shape: isNonEmptyString(obj.post_shape) ? obj.post_shape.trim() : "",
    notes: isNonEmptyString(obj.notes) ? obj.notes.trim() : "",
  };

  if (playbook === "geo_article") {
    if (value.target_queries.length === 0)
      errors.push("target_queries: geo_article needs at least 1 target query");
    if (value.target_queries.length > 5)
      value.target_queries = value.target_queries.slice(0, 5);
    if (value.fan_out.length < 3)
      errors.push("fan_out: geo_article needs at least 3 sub-queries (aim for 6-12)");
    const sections = Array.isArray(obj.sections) ? obj.sections : [];
    value.sections = sections
      .filter((s) => s && isNonEmptyString(s.h2))
      .map((s) => ({
        h2: s.h2.trim(),
        sub_query: isNonEmptyString(s.sub_query) ? s.sub_query.trim() : "",
        evidence_note: isNonEmptyString(s.evidence_note) ? s.evidence_note.trim() : "",
      }));
    if (value.sections.length === 0)
      errors.push("sections: geo_article needs at least 1 section with an h2");
  } else if (playbook === "linkedin_post") {
    if (!isNonEmptyString(value.hook_thesis))
      errors.push("hook_thesis: linkedin_post needs a non-empty hook thesis");
    if (!POST_SHAPES.includes(value.post_shape))
      errors.push(`post_shape: must be one of ${POST_SHAPES.join(", ")}`);
    value.target_queries = [];
  }

  return errors.length ? fail(errors) : pass(value);
}

// ---------------------------------------------------------------------------
// research → research_pack
// ---------------------------------------------------------------------------

export function validateResearchPack(obj) {
  if (!obj || typeof obj !== "object") return fail(["research_pack is not an object"]);
  const errors = [];

  const sources = (Array.isArray(obj.sources) ? obj.sources : [])
    .filter((s) => s && isNonEmptyString(s.url))
    .map((s) => ({
      url: s.url.trim(),
      title: isNonEmptyString(s.title) ? s.title.trim() : "",
      type: isNonEmptyString(s.type) ? s.type.trim() : "knowledge",
      key_points: asStringArray(s.key_points),
    }));

  // Hard anti-slop rule: a stat or quote without a source URL does not exist.
  // Enforced in code, not just in the prompt.
  const droppedStats = [];
  const stats = (Array.isArray(obj.stats) ? obj.stats : []).filter((s) => {
    const keep = s && isNonEmptyString(s.stat) && isNonEmptyString(s.source_url);
    if (!keep && s && isNonEmptyString(s.stat)) droppedStats.push(s.stat);
    return keep;
  }).map((s) => ({ stat: s.stat.trim(), source_url: s.source_url.trim() }));

  const quotes = (Array.isArray(obj.quotes) ? obj.quotes : [])
    .filter((q) => q && isNonEmptyString(q.quote) && isNonEmptyString(q.source_url))
    .map((q) => ({
      quote: q.quote.trim(),
      attribution: isNonEmptyString(q.attribution) ? q.attribution.trim() : "",
      source_url: q.source_url.trim(),
    }));

  if (sources.length === 0)
    errors.push("sources: at least 1 source with a url is required");

  const value = {
    sources,
    stats,
    quotes,
    paa: asStringArray(obj.paa),
    angles: asStringArray(obj.angles),
    unsupported_subqueries: asStringArray(obj.unsupported_subqueries),
    dropped_unsourced_stats: droppedStats,
  };

  return errors.length ? fail(errors) : pass(value);
}

// ---------------------------------------------------------------------------
// benchmark → benchmark_notes
// ---------------------------------------------------------------------------

export function validateBenchmarkNotes(playbook, obj) {
  if (!obj || typeof obj !== "object") return fail(["benchmark_notes is not an object"]);

  if (playbook === "linkedin_post") {
    if (!obj.pack || typeof obj.pack !== "object")
      return fail(["pack: linkedin_post benchmark must contain the channel pack object"]);
    return pass({ pack: obj.pack });
  }

  const errors = [];
  const dist =
    obj.format_distribution && typeof obj.format_distribution === "object"
      ? obj.format_distribution
      : null;
  if (!dist) errors.push("format_distribution: required object of format → percent");
  if (!isNonEmptyString(obj.directive))
    errors.push("directive: required one-sentence binding directive");

  const value = {
    format_distribution: dist || {},
    dominant_format: isNonEmptyString(obj.dominant_format)
      ? obj.dominant_format.trim()
      : "unknown",
    directive: String(obj.directive || "").trim(),
    earned_placement: obj.earned_placement === true,
    engine_divergence: isNonEmptyString(obj.engine_divergence)
      ? obj.engine_divergence.trim()
      : "none observed",
    structural_notes: asStringArray(obj.structural_notes),
  };

  return errors.length ? fail(errors) : pass(value);
}

// ---------------------------------------------------------------------------
// draft
// ---------------------------------------------------------------------------

const DRAFT_MIN_CHARS = { geo_article: 1500, linkedin_post: 300 };
const DRAFT_MAX_CHARS = { geo_article: 20000, linkedin_post: 2600 };

export function validateDraft(playbook, obj) {
  if (!obj || typeof obj !== "object") return fail(["draft is not an object"]);
  const errors = [];

  if (!isNonEmptyString(obj.title)) errors.push("title: required non-empty string");
  const body = typeof obj.body_md === "string" ? obj.body_md.trim() : "";
  const min = DRAFT_MIN_CHARS[playbook] ?? 300;
  const max = DRAFT_MAX_CHARS[playbook] ?? 20000;
  if (body.length < min)
    errors.push(`body_md: too short (${body.length} chars, need ≥${min} for ${playbook})`);
  if (body.length > max)
    errors.push(`body_md: too long (${body.length} chars, max ${max} for ${playbook})`);

  const value = {
    title: String(obj.title || "").trim(),
    body_md: body,
    meta_description: isNonEmptyString(obj.meta_description)
      ? obj.meta_description.trim()
      : "",
    levers_used: asStringArray(obj.levers_used),
  };

  return errors.length ? fail(errors) : pass(value);
}

// ---------------------------------------------------------------------------
// review
// ---------------------------------------------------------------------------

/**
 * Apply an agent's rubric emphasis: multiply base weights by the per-dimension
 * multiplier, then renormalize to sum 1 so the pass threshold stays comparable.
 * Floors are intentionally NOT scaled — an agent can shift emphasis but can't
 * lower a hard floor (e.g. facts_vs_research).
 */
export function applyRubricEmphasis(baseWeights, emphasis) {
  if (!emphasis || typeof emphasis !== "object" || Object.keys(emphasis).length === 0) {
    return baseWeights;
  }
  const scaled = {};
  let sum = 0;
  for (const [dim, w] of Object.entries(baseWeights)) {
    const mult = Number(emphasis[dim]);
    const val = w * (Number.isFinite(mult) && mult > 0 ? mult : 1);
    scaled[dim] = val;
    sum += val;
  }
  if (sum <= 0) return baseWeights;
  const norm = {};
  for (const [dim, w] of Object.entries(scaled)) {
    norm[dim] = Math.round((w / sum) * 1000) / 1000;
  }
  return norm;
}

export function validateReview(playbook, obj, rubricEmphasis) {
  if (!obj || typeof obj !== "object") return fail(["review is not an object"]);
  const errors = [];
  const baseWeights = RUBRIC_WEIGHTS[playbook];
  if (!baseWeights) return fail([`unknown playbook "${playbook}"`]);
  const weights = applyRubricEmphasis(baseWeights, rubricEmphasis);

  const scoresIn = obj.scores && typeof obj.scores === "object" ? obj.scores : {};
  const scores = {};
  for (const dim of Object.keys(weights)) {
    const raw = Number(scoresIn[dim]);
    if (!Number.isFinite(raw) || raw < 0 || raw > 1) {
      errors.push(`scores.${dim}: required number between 0 and 1`);
    } else {
      scores[dim] = Math.round(raw * 100) / 100;
    }
  }

  if (errors.length) return fail(errors);

  const violations = (Array.isArray(obj.violations) ? obj.violations : [])
    .filter((v) => v && (isNonEmptyString(v.rule) || isNonEmptyString(v.detail)))
    .map((v) => ({
      rule: isNonEmptyString(v.rule) ? v.rule.trim() : "unspecified",
      detail: isNonEmptyString(v.detail) ? v.detail.trim() : "",
      ymyl: v.ymyl === true,
    }));

  const ymylViolation = obj.ymyl_violation === true || violations.some((v) => v.ymyl);
  if (ymylViolation) scores.ymyl_compliance = 0;

  // Code, not the model, owns the arithmetic and the verdict. The model's
  // reported weighted_total/verdict are cross-checked and overridden here.
  const weightedTotal =
    Math.round(
      Object.entries(weights).reduce((acc, [dim, w]) => acc + scores[dim] * w, 0) * 100
    ) / 100;

  const floors = RUBRIC_FLOORS[playbook] || {};
  const floorBreaches = Object.entries(floors)
    .filter(([dim, floor]) => scores[dim] < floor)
    .map(([dim, floor]) => `${dim} ${scores[dim]} < floor ${floor}`);

  const verdict =
    !ymylViolation && weightedTotal >= PASS_THRESHOLD && floorBreaches.length === 0
      ? "pass"
      : "fail";

  const value = {
    scores,
    weighted_total: weightedTotal,
    verdict,
    ymyl_violation: ymylViolation,
    floor_breaches: floorBreaches,
    violations,
    critique: isNonEmptyString(obj.critique) ? obj.critique.trim() : "",
  };

  if (verdict === "fail" && !value.critique && !ymylViolation) {
    return fail(["critique: required when verdict is fail — numbered, executable fixes"]);
  }

  return pass(value);
}

// ---------------------------------------------------------------------------
// fact_check
// ---------------------------------------------------------------------------

const FACT_CHECK_KINDS = ["fabricated", "overstated", "banned", "unverifiable"];

export function validateFactCheck(obj) {
  if (!obj || typeof obj !== "object") return fail(["fact_check output is not an object"]);
  const errors = [];
  if (typeof obj.passed !== "boolean") errors.push("passed: required boolean");

  const issues = (Array.isArray(obj.issues) ? obj.issues : [])
    .filter((i) => i && isNonEmptyString(i.claim))
    .map((i) => ({
      claim: i.claim.trim(),
      problem: isNonEmptyString(i.problem) ? i.problem.trim() : "",
      kind: FACT_CHECK_KINDS.includes(i.kind) ? i.kind : "unverifiable",
    }));

  if (errors.length) return fail(errors);

  // Code owns the pass rule: fabricated or banned issues always fail,
  // whatever the model claimed.
  const hardFail = issues.some((i) => i.kind === "fabricated" || i.kind === "banned");
  const passed = obj.passed === true && !hardFail;

  return pass({
    passed,
    issues,
    critique: isNonEmptyString(obj.critique) ? obj.critique.trim() : "",
  });
}

// ---------------------------------------------------------------------------
// learn → lessons
// ---------------------------------------------------------------------------

export function validateLessons(obj) {
  if (!obj || typeof obj !== "object") return fail(["lessons output is not an object"]);
  const raw = Array.isArray(obj.lessons) ? obj.lessons : null;
  if (!raw) return fail(["lessons: required array (may be empty)"]);

  const value = {
    lessons: raw
      .map((l) => {
        if (typeof l === "string") return { lesson: l.trim(), supersedes: null };
        if (l && isNonEmptyString(l.lesson)) {
          return {
            lesson: l.lesson.trim(),
            supersedes: isNonEmptyString(l.supersedes) ? l.supersedes.trim() : null,
          };
        }
        return null;
      })
      .filter((l) => l && l.lesson.length > 0 && l.lesson.length <= 220)
      .slice(0, 3),
  };

  return pass(value);
}

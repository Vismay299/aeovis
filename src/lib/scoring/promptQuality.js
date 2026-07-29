/**
 * Prompt quality — is this prompt capable of measuring brand visibility at all?
 * (plan: docs/plans/2026-07-29-visibility-score-fix.md)
 *
 * THE BUG THIS EXISTS TO FIX
 * promptGen was instructed to reconstruct "the REAL Google Search Console query
 * report" — i.e. SEO keywords — and the scan then scored those as AEO probes.
 *
 * Measured on the Italica scan (36a91fbb), against the 17-vendor roster the
 * scan itself extracted: of 56 answered unbranded prompts, only 16 named ANY
 * vendor. The other 40 — "how to calculate tiles needed for room", "how much do
 * vitrified tiles cost per sqft", "can i install tiles over old tiles" — got
 * back taxonomy and how-to answers that name nobody at all.
 *
 * A brand cannot be mentioned in an answer that names nobody. Those 40 prompts
 * were guaranteed zeroes sitting in the denominator: 71% of the scan's budget
 * spent on questions that could not move the number in either direction.
 *
 * THE RULE
 * A prompt belongs in the visibility denominator only if a brand could
 * plausibly appear in its answer. Everything else is still worth scanning —
 * informational answers are exactly what the Content OS gap engine feeds on —
 * but it is measured, not scored.
 *
 * TWO SIGNALS, DELIBERATELY SEPARATE
 *   1. SHAPE (a priori, from the query text): cheap, deterministic, available
 *      before we spend anything probing. Used to build the prompt set.
 *   2. ELICITATION (a posteriori, from the answer text): the ground truth —
 *      did the model actually name any brands? A prompt whose answers never
 *      name a brand across repeated scans is a broken instrument regardless of
 *      how its text reads, and retires itself via isDudPrompt().
 *
 * Signal 2 is the one competitors don't have: it makes prompt quality an
 * observed property of the corpus rather than a guess about wording.
 *
 * Pure module — no LLM, no DB, no network. Every function is deterministic.
 */

/**
 * Query shapes that reliably make a model produce a list of vendors.
 * Ordered roughly by strength; any single hit is enough.
 */
const ELICITING_PATTERNS = [
  /\bbest\b/i,
  /\btop\s+\d*\s*\b/i,
  /\bleading\b/i,
  /\brecommend(ed|ations?)?\b/i,
  /\bwhich\b/i,
  /\bwho\s+(makes|sells|offers|provides|is)\b/i,
  /\bvs\.?\b|\bversus\b/i,
  /\bcompare(d|s)?\b|\bcomparison\b/i,
  /\balternatives?\b/i,
  /\bbrands?\b/i,
  /\bcompanies\b|\bcompany\b/i,
  /\bmanufacturers?\b/i,
  /\bsuppliers?\b/i,
  /\bproviders?\b/i,
  /\bvendors?\b/i,
  /\bagenc(y|ies)\b/i,
  /\bwhere\s+to\s+(buy|get|order)\b/i,
  /\bmost\s+(popular|trusted|reliable)\b/i,
  /\bworth\s+(it|the\s+price)\b/i,
  /\breviews?\b/i,
  // Local vendor intent — "trusted tile shop near me bangalore" is a vendor
  // question even though it uses none of the comparison vocabulary above.
  /\b(shops?|stores?|dealers?|retailers?|showrooms?|outlets?)\b/i,
  /\bnear\s+me\b/i,
];

/**
 * Shapes that look eliciting by keyword but reliably are not. Checked FIRST,
 * because "how to compare tile finishes" contains "compare" but produces a
 * methodology answer, not a vendor list.
 */
const NON_ELICITING_OVERRIDES = [
  /^\s*how\s+(to|do|does|can|much|many|long)\b/i,
  /^\s*what\s+is\s+(a|an|the)?\s*\b(?!.*\b(best|top|brand|company)\b)/i,
  /^\s*why\s+(do|does|is|are)\b/i,
  /^\s*can\s+i\b/i,
  /\bcalculat(e|or|ing)\b/i,
  /\bper\s+(sq\.?\s?ft|square\s+foot|piece|box)\b/i,
  /\bhow\s+many\b/i,
];

export const PROMPT_ROLES = ["eliciting", "diagnostic"];

/**
 * A priori classification from query text alone.
 * Returns "eliciting" (belongs in the score) or "diagnostic" (scanned, not scored).
 */
export function classifyPromptShape(text) {
  const q = String(text || "").trim();
  if (!q) return "diagnostic";

  for (const rx of NON_ELICITING_OVERRIDES) {
    if (rx.test(q)) return "diagnostic";
  }
  for (const rx of ELICITING_PATTERNS) {
    if (rx.test(q)) return "eliciting";
  }
  return "diagnostic";
}

export function isEliciting(text) {
  return classifyPromptShape(text) === "eliciting";
}

/**
 * How many roster vendors did this answer actually name?
 *
 * Takes the `result_brands` rows for ONE result — the output of
 * judgeBrandsSymmetric, already computed and persisted by every scan. This is
 * ground truth, not a guess: the roster is the real vendor set for the
 * category (for the Italica scan: Kajaria, Somany, Orientbell, NITCO, CERA,
 * H&R Johnson, …) and `mentioned` is an exact word-boundary match.
 *
 * An earlier draft of this function guessed at brands by counting capitalised
 * tokens in the answer text. Validated against real data it was badly wrong —
 * it scored a local-shop query at 27 "brands" by counting ordinary prose nouns
 * in long Perplexity answers. Roster counting costs nothing extra and cannot
 * drift, so the heuristic is gone rather than tuned.
 *
 * @param {Array<{mentioned:boolean}>} brandRows result_brands rows for one result
 */
export function countBrandsElicited(brandRows = []) {
  return (brandRows || []).filter((b) => b && b.mentioned).length;
}

/**
 * Minimum roster vendors an answer must name for the prompt to count as a
 * usable probe. One is enough: unlike the old text heuristic, a roster hit is
 * an exact match on a known vendor, so a single hit already proves the model
 * will name vendors for this question.
 */
export const MIN_BRANDS_FOR_ELICITATION = 1;

/**
 * Did this answer prove the prompt elicits vendors?
 * `null` when the prompt was never answered — no evidence either way, which is
 * different from evidence of failure and must not be counted as a dud.
 */
export function answerElicitedBrands(brandRows, answered = true) {
  if (!answered) return null;
  return countBrandsElicited(brandRows) >= MIN_BRANDS_FOR_ELICITATION;
}

/** A prompt needs this many answered observations before we dare retire it. */
export const DUD_MIN_OBSERVATIONS = 3;

/**
 * Is this prompt a broken instrument? True when it has been answered at least
 * DUD_MIN_OBSERVATIONS times and named fewer than MIN_BRANDS_FOR_ELICITATION
 * brands EVERY time — for any brand, not just ours.
 *
 * This is the self-correcting half of the design: wording heuristics decide
 * what to scan, observed elicitation decides what to keep.
 *
 * @param {Array<{answered:boolean, brands_elicited:number}>} observations
 */
export function isDudPrompt(observations = []) {
  const answered = observations.filter((o) => o && o.answered);
  if (answered.length < DUD_MIN_OBSERVATIONS) return false;
  return answered.every((o) => (o.brands_elicited || 0) < MIN_BRANDS_FOR_ELICITATION);
}

/**
 * Health of a whole generated prompt set, used as the generator's accept gate.
 * `ok` is false when too few prompts could ever produce a mention.
 */
export const MIN_ELICITING_RATIO = 0.75;

export function assessPromptSet(queries = [], { minRatio = MIN_ELICITING_RATIO } = {}) {
  const unbranded = queries.filter((q) => {
    const tier = q?.intent_tier ?? q?.intentTier;
    return tier !== "branded" && q?.source !== "branded_seed";
  });

  const eliciting = unbranded.filter((q) => isEliciting(q?.text ?? q));
  const ratio = unbranded.length ? eliciting.length / unbranded.length : 0;

  return {
    total: unbranded.length,
    eliciting: eliciting.length,
    diagnostic: unbranded.length - eliciting.length,
    ratio: Math.round(ratio * 1000) / 1000,
    ok: unbranded.length > 0 && ratio >= minRatio,
  };
}

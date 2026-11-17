/** Pure mention check (no LLM deps) — same word-boundary rules as judge.detectMention. */
function detectMention(text, aliases) {
  if (!text || !aliases || aliases.length === 0) return false;
  for (const alias of aliases) {
    const cleanAlias = String(alias).toLowerCase();
    const escaped = cleanAlias.replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&");
    const regex = new RegExp(`(?:^|[^a-zA-Z0-9_])${escaped}(?:$|[^a-zA-Z0-9_])`, "i");
    if (regex.test(text)) return true;
  }
  return false;
}

/**
 * True when the query text contains a brand alias (headline exclusion).
 */
export function isBrandedQuery(text, brandAliases) {
  if (!text) return false;
  return detectMention(text, brandAliases);
}

/**
 * Own-name / Brand Presence panel queries.
 * Distinct from isBrandedQuery — presence is intentional seeds only,
 * not every query that happens to contain a brand alias.
 */
export function isBrandPresenceQuery(query) {
  if (!query) return false;
  const source = String(query.source || "").toLowerCase();
  if (source === "branded_seed") return true;
  const tier = query.intent_tier ?? query.intentTier;
  return tier === "branded";
}

/**
 * Intent tier for persist / probe results.
 * Never promote alias-hit category queries to "branded" — that is is_branded_query's job.
 */
export function resolveQueryIntentTier(query) {
  if (!query) return "exploratory";
  if (isBrandPresenceQuery(query)) return "branded";
  const tier = query.intent_tier ?? query.intentTier;
  if (tier && tier !== "branded") return tier;
  return "exploratory";
}

/** Dedupe query objects by normalized text (first occurrence wins). */
export function dedupeQueriesByText(queries) {
  const seen = new Set();
  return (queries || []).filter((q) => {
    const key = String(q.text || "").toLowerCase().trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const MAX_BRANDED = 4;

/**
 * Builds a small set of BRANDED queries for the Brand Presence panel.
 */
export function buildBrandedQueries(brand, website) {
  const domain = (website || "")
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0];
  const set = new Set();
  const push = (t) => {
    if (t) set.add(t);
  };
  push(brand);
  push(`what is ${brand}`);
  push(`${brand} reviews`);
  push(`${brand} pricing`);
  if (domain && domain.toLowerCase() !== brand.toLowerCase()) {
    push(`${brand} vs alternatives`);
  }
  return Array.from(set)
    .slice(0, MAX_BRANDED)
    .map((text) => ({
      text,
      source: "branded_seed",
      topic: "Brand Presence",
      intent_tier: "branded",
    }));
}

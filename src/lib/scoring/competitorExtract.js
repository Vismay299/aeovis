import { getBrandAliases } from "./aliases.js";
import { extractBrandDomain } from "./citations.js";
import { citationMatchesCompetitor } from "./coMentions.js";
import { llmJson } from "../llm.js";

const MAX_TEXT_CHARS = 12000;

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

function normalizeNameKey(name) {
  const suffixes = [
    "tiles", "ceramics", "india", "ltd", "pvt", "private", "limited",
    "corporation", "corp", "inc", "llc", "co", "services", "solutions",
    "technologies", "tech", "group", "industries", "international",
  ];
  let cleaned = String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

  const parts = cleaned.split(/\s+/);
  const filtered = parts.filter((p) => !suffixes.includes(p));
  return filtered.join(" ") || cleaned;
}

function buildExtractionPrompt({ brand, text, domains }) {
  return `You are analyzing Google AI Overview answers to find real competitor / alternative
companies or products mentioned alongside "${brand}".

AI Overview text (from multiple unbranded searches, concatenated):
---
${text}
---

Cited domains seen in these results: ${domains.length ? domains.join(", ") : "(none)"}

Rules:
- Only list real company/product/brand names, never the brand "${brand}" itself.
- Do NOT list generic words like "software", "platform", "tool", "solution", "service".
- Exclude tools, marketplaces-as-tools, media sites, and software products; only direct competitors that sell what ${brand} sells.
- If you can infer the competitor's website domain from context or the cited domains list, include it.
- Return at most 15 names, most relevant first.

Return ONLY valid JSON, no commentary, in this exact shape:
[{"name": "...", "domain": "..."}]`;
}

/**
 * Discovers competitor/alternative names via one batched LLM call over all
 * non-branded AIO text + cited domains, merges with any user-supplied
 * names, then scores each against the non-branded-with-AIO pool.
 */
export async function extractCompetitors({
  results = [],
  brand,
  brandUrl,
  userCompetitors = [],
  stats,
  max = 10,
  deps = {},
}) {
  const llmJsonFn = deps.llmJson || llmJson;
  const brandDomain = extractBrandDomain(brandUrl);
  const brandAliases = getBrandAliases(brand, brandUrl);

  const nonBrandedWithAio = results.filter((r) => !r.is_branded_query && r.aio_present);

  const textParts = [];
  const domainSet = new Set();
  for (const r of nonBrandedWithAio) {
    if (r.aio_text) textParts.push(r.aio_text);
    (r.aio_references || []).forEach((ref) => {
      const domain = ref.domain || extractBrandDomain(ref.href);
      if (!domain) return;
      if (brandDomain && (domain === brandDomain || domain.endsWith("." + brandDomain))) return;
      domainSet.add(domain);
    });
  }
  const joinedText = textParts.join("\n").slice(0, MAX_TEXT_CHARS);
  const domains = Array.from(domainSet);

  let discovered = [];
  if (joinedText.trim() || domains.length) {
    const prompt = buildExtractionPrompt({ brand, text: joinedText, domains });
    const parsed = await llmJsonFn(prompt, { stats, timeout: 25000 });
    if (Array.isArray(parsed)) {
      discovered = parsed
        .filter((c) => c && typeof c.name === "string" && c.name.trim())
        .map((c) => ({ name: c.name.trim(), domain: (c.domain || "").trim() }))
        .filter((c) => !detectMention(c.name, brandAliases));
    }
  }

  const merged = new Map(); // normalizedName -> { name, domain, source }
  userCompetitors.forEach((name) => {
    const trimmed = String(name || "").trim();
    if (!trimmed) return;
    merged.set(normalizeNameKey(trimmed), { name: trimmed, domain: "", source: "user" });
  });
  discovered.forEach((c) => {
    const key = normalizeNameKey(c.name);
    if (!key) return;
    if (merged.has(key)) return;
    // Check if this key is a substring of any existing key (or vice-versa)
    // to merge suffixes like "Kajaria Tiles" into "Kajaria".
    let mergedWith = null;
    for (const [existingKey, existingVal] of merged) {
      if (key.includes(existingKey) || existingKey.includes(key)) {
        // Keep the shorter key (prefer the one without suffix)
        if (key.length >= existingKey.length) {
          mergedWith = existingKey;
        } else {
          // Replace existing with this cleaner name
          merged.set(key, { ...existingVal, name: c.name, source: existingVal.source });
          merged.delete(existingKey);
          mergedWith = key;
        }
        break;
      }
    }
    if (!mergedWith) {
      merged.set(key, { name: c.name, domain: c.domain, source: "discovered" });
    }
  });

  const competitorObjects = Array.from(merged.values()).slice(0, max + userCompetitors.length);
  return matchCompetitorsBack(nonBrandedWithAio, competitorObjects, brand);
}

/**
 * Scores each { name, domain, source } competitor against the non-branded
 * AIO pool. Denominator = nonBrandedWithAio.length (same pool the hero score
 * uses). Citation matching tolerates a missing competitor domain by falling
 * back to alias/brand-word matching against cited domains.
 */
export function matchCompetitorsBack(nonBrandedWithAio, competitors, brand) {
  const denom = nonBrandedWithAio.length || 1;

  const scored = (competitors || []).map((comp) => {
    const aliases = getBrandAliases(comp.name, comp.domain || "");
    let mentions = 0;
    let citations = 0;
    let visible = 0;
    let userAbsent = 0;

    nonBrandedWithAio.forEach((r) => {
      const text = r.aio_text || "";
      const textHit = text ? detectMention(text, aliases) : false;
      const citeHit = citationMatchesCompetitor(
        r.aio_citations || [],
        r.aio_references || [],
        aliases
      );

      if (textHit) mentions++;
      if (citeHit) citations++;
      if (textHit || citeHit) {
        visible++;
        if (!r.visible) userAbsent++;
      }
    });

    const visibilityScore = Math.round((visible / denom) * 1000) / 10;
    const citationShare = Math.round((citations / denom) * 1000) / 10;

    return {
      name: comp.name,
      source: comp.source,
      mentions,
      citations,
      prompts: visible,
      userAbsent: userAbsent > 0,
      visibilityScore,
      citationShare,
    };
  });

  return scored
    .filter((c) => c.prompts > 0 || c.source === "user")
    .sort(
      (a, b) =>
        b.visibilityScore - a.visibilityScore ||
        b.mentions - a.mentions ||
        a.name.localeCompare(b.name)
    );
}

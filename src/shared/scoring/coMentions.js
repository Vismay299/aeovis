/**
 * Blank-style co-mention competitor discovery.
 *
 * Discovers rival brands from Google AI Overview text + citation domains/titles
 * (not only from a pre-filled form list), then scores how often each appears
 * in non-branded AIOs.
 */

import { getBrandAliases } from "./aliases.js";
import { extractBrandDomain } from "./citations.js";

/** Pure mention check — avoid importing judge.js (pulls Gemini into the client). */
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

const MAX_DISCOVERED = 12;

/** Generic words that look like proper nouns but are not brands. */
const STOPWORDS = new Set(
  [
    "the",
    "this",
    "that",
    "these",
    "those",
    "with",
    "from",
    "your",
    "our",
    "their",
    "about",
    "into",
    "over",
    "under",
    "after",
    "before",
    "between",
    "among",
    "google",
    "bing",
    "yahoo",
    "youtube",
    "wikipedia",
    "amazon",
    "facebook",
    "instagram",
    "twitter",
    "linkedin",
    "reddit",
    "overview",
    "answer",
    "answers",
    "according",
    "based",
    "using",
    "including",
    "example",
    "examples",
    "people",
    "users",
    "customers",
    "business",
    "businesses",
    "company",
    "companies",
    "brand",
    "brands",
    "product",
    "products",
    "service",
    "services",
    "software",
    "platform",
    "platforms",
    "solution",
    "solutions",
    "tools",
    "tool",
    "best",
    "top",
    "leading",
    "popular",
    "major",
    "india",
    "indian",
    "usa",
    "united",
    "states",
    "europe",
    "asia",
    "global",
    "world",
    "market",
    "markets",
    "industry",
    "industries",
    "sector",
    "home",
    "house",
    "room",
    "bathroom",
    "kitchen",
    "living",
    "bedroom",
    "floor",
    "floors",
    "wall",
    "walls",
    "tile",
    "tiles",
    "ceramic",
    "ceramics",
    "porcelain",
    "vitrified",
    "design",
    "designs",
    "quality",
    "price",
    "pricing",
    "review",
    "reviews",
    "guide",
    "comparison",
    "versus",
    "alternatives",
    "option",
    "options",
    "list",
    "here",
    "there",
    "also",
    "more",
    "most",
    "some",
    "many",
    "other",
    "such",
    "well",
    "good",
    "great",
    "high",
    "low",
    "new",
    "modern",
    "premium",
    "morbi",
    "gujarat",
    "delhi",
    "mumbai",
    "bangalore",
  ].map((s) => s.toLowerCase())
);

function domainMatches(candidateDomain, target) {
  if (!candidateDomain || !target) return false;
  return candidateDomain === target || candidateDomain.endsWith("." + target);
}

function titleCaseWords(s) {
  return String(s || "")
    .split(/[\s._-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

function normalizeNameKey(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function isStopName(name) {
  const key = normalizeNameKey(name);
  if (!key || key.length < 3) return true;
  const parts = key.split(/\s+/);
  if (parts.every((p) => STOPWORDS.has(p))) return true;
  if (parts.length === 1 && STOPWORDS.has(parts[0])) return true;
  return false;
}

function isTrackedBrandName(name, brandAliases) {
  if (!name) return false;
  if (detectMention(name, brandAliases)) return true;
  const key = normalizeNameKey(name);
  return brandAliases.some((a) => {
    const ak = normalizeNameKey(a);
    return ak && (key === ak || key.includes(ak) || ak.includes(key));
  });
}

/**
 * Extract brand-like proper nouns from AIO text.
 */
export function extractNamesFromText(text) {
  if (!text || typeof text !== "string") return [];
  const found = new Set();

  // Multi-word Title Case / brand phrases: "Kajaria Ceramics", "RAK Ceramics"
  const multi =
    text.match(/\b[A-Z][A-Za-z0-9&]*(?:\s+[A-Z][A-Za-z0-9&]*)+\b/g) || [];
  multi.forEach((m) => found.add(m.trim()));

  // Single Capitalized tokens (length >= 4): "Kajaria", "Somany"
  const single = text.match(/\b[A-Z][a-z]{3,}\b/g) || [];
  single.forEach((m) => found.add(m.trim()));

  // Short ALL-CAPS brands: "RAK", "GVT" — keep 3–6 letters only
  const caps = text.match(/\b[A-Z]{3,6}\b/g) || [];
  caps.forEach((m) => {
    if (!["AIO", "API", "SEO", "CEO", "USA", "UK", "UAE"].includes(m)) {
      found.add(m.trim());
    }
  });

  return Array.from(found);
}

/**
 * Extract brand candidates from citation URLs / reference metadata.
 */
export function extractNamesFromCitations(citations = [], references = [], brandDomain = "") {
  const found = new Set();

  const addDomain = (hrefOrDomain) => {
    const domain = extractBrandDomain(hrefOrDomain);
    if (!domain) return;
    if (brandDomain && domainMatches(domain, brandDomain)) return;
    // skip pure media / generic hosts
    const host = domain.toLowerCase();
    if (
      /wikipedia|facebook|instagram|youtube|twitter|linkedin|reddit|amazon\.|google\.|apple\.com|microsoft\.com|gov\.|edu\./.test(
        host
      )
    ) {
      return;
    }
    const parts = domain.split(".");
    const sld = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
    if (!sld || sld.length < 3) return;
    if (STOPWORDS.has(sld.toLowerCase())) return;
    found.add(titleCaseWords(sld));
  };

  (citations || []).forEach((c) => {
    if (typeof c === "string") addDomain(c);
    else if (c?.href) addDomain(c.href);
    else if (c?.url) addDomain(c.url);
  });

  (references || []).forEach((ref) => {
    if (ref?.href) addDomain(ref.href);
    if (ref?.domain) addDomain(ref.domain);
    // Source / title often carries the brand ("Kajaria Ceramics")
    [ref?.source, ref?.title].forEach((s) => {
      if (!s || typeof s !== "string") return;
      extractNamesFromText(s).forEach((n) => found.add(n));
      // short source label
      const cleaned = s.replace(/\s*[-|·].*$/, "").trim();
      if (cleaned.length >= 3 && cleaned.length <= 40 && !/https?:/i.test(cleaned)) {
        found.add(cleaned);
      }
    });
  });

  return Array.from(found);
}

/**
 * Discover unique competitor display names from non-branded AIO rows.
 * Returns sorted by rough frequency (desc).
 */
export function discoverCompetitorNames(results, brand, brandUrl, userCompetitors = []) {
  const brandAliases = getBrandAliases(brand, brandUrl);
  const brandDomain = extractBrandDomain(brandUrl);
  const counts = new Map(); // key -> { name, count }

  const bump = (rawName, weight = 1) => {
    if (!rawName) return;
    const name = String(rawName).trim();
    if (name.length < 2 || name.length > 48) return;
    if (isStopName(name)) return;
    if (isTrackedBrandName(name, brandAliases)) return;
    const key = normalizeNameKey(name);
    if (!key) return;
    const prev = counts.get(key);
    if (prev) {
      prev.count += weight;
      // Prefer longer / multi-word display names
      if (name.length > prev.name.length) prev.name = name;
    } else {
      counts.set(key, { name, count: weight });
    }
  };

  userCompetitors.forEach((c) => bump(c, 0)); // register preferred labels

  const nonBrandedAio = (results || []).filter(
    (r) => !r.is_branded_query && r.aio_present
  );

  nonBrandedAio.forEach((r) => {
    extractNamesFromText(r.aio_text || r.aioText || "").forEach((n) => bump(n, 2));
    extractNamesFromCitations(
      r.aio_citations || r.aioCitations || r.citations || [],
      r.aio_references || r.aioReferences || [],
      brandDomain
    ).forEach((n) => bump(n, 3));
  });

  // Merge near-duplicates: "Kajaria" vs "Kajaria Ceramics" → keep longer if both present
  const entries = Array.from(counts.values()).sort((a, b) => b.count - a.count);
  const merged = [];
  for (const e of entries) {
    const ek = normalizeNameKey(e.name);
    const absorbed = merged.find((m) => {
      const mk = normalizeNameKey(m.name);
      return ek.includes(mk) || mk.includes(ek);
    });
    if (absorbed) {
      absorbed.count += e.count;
      if (e.name.length > absorbed.name.length) absorbed.name = e.name;
    } else {
      merged.push({ ...e });
    }
  }

  // User competitors always first (preserve order), then discovered by count
  const userKeys = new Set(userCompetitors.map((c) => normalizeNameKey(c)));
  const userOrdered = userCompetitors
    .map((c) => String(c).trim())
    .filter(Boolean);
  const discovered = merged
    .filter((m) => !userKeys.has(normalizeNameKey(m.name)))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, MAX_DISCOVERED)
    .map((m) => m.name);

  return [...userOrdered, ...discovered];
}

export function citationMatchesCompetitor(citations, references, compAliases) {
  const hrefs = [];
  (citations || []).forEach((c) => {
    if (typeof c === "string") hrefs.push(c);
    else if (c?.href) hrefs.push(c.href);
  });
  (references || []).forEach((r) => {
    if (r?.href) hrefs.push(r.href);
  });

  const aliases = (compAliases || []).map((a) => a.toLowerCase());
  for (const href of hrefs) {
    const domain = extractBrandDomain(href);
    if (!domain) continue;
    const parts = domain.split(".");
    const brandWord = parts[parts.length - 2] || parts[0] || "";
    if (
      aliases.some(
        (a) =>
          a.length >= 3 &&
          (a.includes(".")
            ? domainMatches(domain, a)
            : brandWord === a || parts.includes(a) || domain.includes(a.replace(/\s+/g, "")))
      )
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Score each competitor against non-branded AIO pool (Blank-style %).
 */
export function computeCoMentionMetrics(results, competitorNames, options = {}) {
  const userSet = new Set(
    (options.userCompetitors || []).map((c) => normalizeNameKey(c))
  );
  const nonBrandedWithAio = (results || []).filter(
    (r) => !r.is_branded_query && r.aio_present
  );
  const denom = nonBrandedWithAio.length || 1;

  const metrics = (competitorNames || []).map((comp) => {
    const aliases = getBrandAliases(comp, "");
    let mentions = 0;
    let citations = 0;
    let visible = 0;
    let userAbsent = 0;

    nonBrandedWithAio.forEach((r) => {
      const text = r.aio_text || r.aioText || "";
      const inText = text ? detectMention(text, aliases) : false;
      // Also honor precomputed probe hits when names match
      const preText = (r.competitors_found_in_text || []).some(
        (n) => normalizeNameKey(n) === normalizeNameKey(comp)
      );
      const textHit = inText || preText;

      const citeHit =
        citationMatchesCompetitor(
          r.aio_citations || r.aioCitations || r.citations || [],
          r.aio_references || r.aioReferences || [],
          aliases
        ) ||
        (r.competitors_cited || []).some(
          (n) => normalizeNameKey(n) === normalizeNameKey(comp)
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
    const isUser = userSet.has(normalizeNameKey(comp));

    return {
      name: comp,
      mentions,
      citations,
      prompts: visible,
      userAbsent: userAbsent > 0,
      visibilityScore,
      citationShare,
      source: isUser ? "user" : "discovered",
      tier: tierForScore(visibilityScore),
    };
  });

  // Drop discovered with zero signal; keep user-listed even at 0
  const filtered = metrics.filter(
    (m) => m.source === "user" || m.visibilityScore > 0 || m.mentions > 0 || m.citations > 0
  );

  return filtered.sort(
    (a, b) =>
      b.visibilityScore - a.visibilityScore ||
      b.mentions - a.mentions ||
      a.name.localeCompare(b.name)
  );
}

export function tierForScore(visibilityScore) {
  if (visibilityScore >= 15) return "Top Tier";
  if (visibilityScore >= 8) return "Mid Tier";
  if (visibilityScore > 0) return "Emerging";
  return "Tracked";
}

/**
 * Full pipeline: discover + score co-mentioned competitors.
 */
export function buildCompetitorLeaderboard({
  results,
  brand,
  brandUrl,
  userCompetitors = [],
  max = 10,
}) {
  const names = discoverCompetitorNames(results, brand, brandUrl, userCompetitors);
  const metrics = computeCoMentionMetrics(results, names, { userCompetitors });
  return metrics.slice(0, max);
}

/**
 * Re-annotate each result with competitors_found_in_text / competitors_cited
 * for the final competitor name list (user + discovered).
 */
export function enrichResultsWithCompetitors(results, competitorNames) {
  if (!results?.length || !competitorNames?.length) return results || [];
  return results.map((r) => {
    const text = r.aio_text || r.aioText || "";
    const citations = r.aio_citations || r.aioCitations || r.citations || [];
    const references = r.aio_references || r.aioReferences || [];
    const foundText = [];
    const foundCite = [];
    competitorNames.forEach((comp) => {
      const aliases = getBrandAliases(comp, "");
      if (text && detectMention(text, aliases)) foundText.push(comp);
      if (citationMatchesCompetitor(citations, references, aliases)) foundCite.push(comp);
    });
    return {
      ...r,
      competitors_found_in_text: foundText,
      competitors_cited: foundCite,
    };
  });
}

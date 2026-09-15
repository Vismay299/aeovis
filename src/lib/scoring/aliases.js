/**
 * R2.5.2 — Stoplist: common English words that should never be treated as
 * brand aliases.  A brand at "apex.com" must NOT match every prose
 * occurrence of "apex"; a brand stripped to "core" must not match every
 * mention of "core" in a technical article.
 *
 * The list is deliberately conservative — a false-positive alias match
 * fabricates a brand mention, which is a worse outcome than a missed
 * match (the latter is caught by re-scan; the former pollutes the score).
 */
export const ALIAS_STOPLIST = new Set([
  // Articles / prepositions / pronouns / conjunctions
  "a", "an", "the", "and", "or", "but", "if", "in", "on", "at", "to",
  "for", "of", "with", "by", "as", "is", "it", "its", "he", "she",
  "we", "they", "you", "me", "my", "his", "her", "our", "their",
  "this", "that", "these", "those", "not", "no", "nor",

  // Common verbs / auxiliaries that appear in domain names
  "do", "go", "be", "am", "are", "was", "has", "had", "get", "got",
  "can", "may", "let", "use", "run", "see", "put", "say", "set",
  "try", "ask", "add", "fit", "cut", "pay", "buy", "sell", "make",

  // Short tech / business words that are domain-stem magnets
  "ai", "io", "up", "app", "hub", "lab", "box", "net", "web",
  "map", "top", "pro", "fit", "tip", "job", "log", "api", "sql",
  "css", "git", "npm", "aws", "gcp", "ide", "url", "pdf",

  // Common domain-stem words — dangerous because every X.com "aliases" X
  "go", "me", "so", "am", "at", "by", "if", "it", "my", "no",
  "ok", "or", "ox", "pi", "re", "to", "us", "vs",

  // Business-y filler that appears across many brand domains
  "edge", "core", "data", "flow", "node", "link", "base", "sync",
  "dash", "grid", "loop", "mesh", "pipe", "plan", "shop", "team",
  "wave", "zone", "bolt", "beam", "grid", "rock", "vine", "zoom",
  "spark", "glow", "echo", "aura", "boon", "clue", "dart", "fame",
  "hint", "idea", "jump", "keen", "lore", "mint", "nook", "opal",
  "pace", "peak", "tide", "vibe", "apex", "apex", "calm", "dash",
  "epic", "fast", "gist", "halt", "info", "iris", "jade", "kite",
  "loom", "muse", "nest", "onyx", "prey", "rush", "sage", "tone",
  "unit", "vast", "ward", "xeno", "yarn", "zen",

  // Superlatives / generic marketing words commonly in domains
  "best", "top", "new", "old", "big", "hot", "sky", "sun", "air",
  "red", "blue", "max", "min", "all", "one", "own", "raw", "live",
  "real", "full", "free", "open", "next", "pure", "fast", "smart",
  "swift", "ultra", "prime", "go", "quest", "rally", "yield", "unity",
]);

/**
 * Minimum character length for an alias derived from domain-stem extraction
 * or corporate-suffix stripping.  Aliases shorter than this threshold need
 * explicit corroboration (the stem must appear as a whole word in the brand
 * name) to be accepted.
 *
 * Rationale: a 3-char stem like "app" from "app.com" or "lab" from
 * "lab.io" matches thousands of unrelated prose uses.  A 4-char stem
 * like "apex" from "apex.com" is only safe if the brand name itself is
 * "Apex" — not "Acme Apex Corp" (where "apex" is a random substring).
 */
const MIN_ALIAS_LENGTH = 4;

// Suffixes stripped during corporate-name cleanup.
const STRIP_SUFFIXES =
  /\b(corp|corporation|inc|incorporated|llc|co|ltd|software|technologies|systems)\b/gi;

/**
 * Returns true when `stem` appears as a standalone whole word in `brand`.
 * "Apex" in "Apex Corp" → true; "apex" in "Acme Apex Corp" → true;
 * "apex" in "Apexular" → false.
 */
function stemInBrand(stem, brand) {
  if (!stem || !brand) return false;
  const re = new RegExp(`\\b${stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
  return re.test(brand);
}

/**
 * Extracts brand aliases from a brand name and its website URL.
 * Sorted from longest to shortest to ensure precedence in matching.
 *
 * R2.5.2 — Three hardening guards:
 *   1. Stoplist: common English words are excluded from the alias set.
 *   2. Domain-stem context rule: a domain stem is accepted only when it is
 *      at least MIN_ALIAS_LENGTH chars OR appears as a whole word in the
 *      brand name.
 *   3. Short-alias guard: aliases produced by suffix-stripping that are
 *      shorter than MIN_ALIAS_LENGTH require brand-name corroboration
 *      (the stripped text must appear as a whole word in the original
 *      brand name, preventing e.g. "Acme Corp" → "Acme" from matching
 *      every prose "acme" when "acme" is a substring but not a word).
 */
export function getBrandAliases(brand, website) {
  const aliases = new Set();
  const brandLower = (brand || "").trim().toLowerCase();

  if (brand && typeof brand === "string") {
    const trimmedBrand = brand.trim();
    if (trimmedBrand) {
      aliases.add(trimmedBrand);
      aliases.add(trimmedBrand.toLowerCase());

      // Remove suffixes like Corp, Inc, LLC, Software, Co, Ltd
      const cleaned = trimmedBrand.replace(STRIP_SUFFIXES, "").trim();
      if (cleaned && cleaned !== trimmedBrand) {
        const cleanedLower = cleaned.toLowerCase();
        // R2.5.2 short-alias guard: suffix-stripped aliases shorter than
        // MIN_ALIAS_LENGTH need whole-word corroboration in the brand name.
        // "Acme Corp" → "Acme" (4 chars) → accepted (passes length check).
        // "Co Inc" → "" → already filtered by the empty check.
        // "Bio Systems Inc" → "Bio" (3 chars) → only accepted if "Bio" is
        //   a whole word in the brand name (it is — "Bio Systems").
        if (
          cleanedLower.length >= MIN_ALIAS_LENGTH ||
          stemInBrand(cleanedLower, trimmedBrand)
        ) {
          aliases.add(cleaned);
          aliases.add(cleanedLower);
        }
      }
    }
  }

  if (website && typeof website === "string") {
    try {
      let cleanedUrl = website.trim().toLowerCase();
      if (!/^https?:\/\//i.test(cleanedUrl)) {
        cleanedUrl = "http://" + cleanedUrl;
      }
      const parsed = new URL(cleanedUrl);
      const hostname = parsed.hostname.replace(/^www\./i, "");
      aliases.add(hostname);

      const domainStem = hostname.split(".")[0];
      // R2.5.2 domain-stem context rule: the stem must be at least
      // MIN_ALIAS_LENGTH characters OR appear as a whole word in the brand
      // name.  This prevents "apex.com" from generating the alias "apex"
      // when the brand is "Acme Apex Corp" — "apex" IS a whole word there,
      // so it passes.  But a brand at "top.io" with brand name "Acme Corp"
      // would NOT get the alias "top" because "top" is not a whole word in
      // "Acme Corp" and "top" is only 3 chars.
      if (
        domainStem &&
        (domainStem.length >= MIN_ALIAS_LENGTH || stemInBrand(domainStem, brand || ""))
      ) {
        aliases.add(domainStem);
      }
    } catch (e) {
      // ignore
    }
  }

  return Array.from(aliases)
    .filter(
      (alias) =>
        alias &&
        alias.length >= 2 &&
        !ALIAS_STOPLIST.has(alias.toLowerCase())
    )
    .sort((a, b) => b.length - a.length);
}

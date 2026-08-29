import { extractBrandDomain, aggregateTopDomains, computeCompetitorCitationShare } from "../lib/scoring/citations.js";
import { buildCompetitorLeaderboard } from "../lib/scoring/coMentions.js";

export function saveScan(result) {
  try {
    sessionStorage.setItem("aeo_last_scan", JSON.stringify(result));
  } catch {}
}

export function loadScan() {
  try {
    const raw = sessionStorage.getItem("aeo_last_scan");
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function clearScan() {
  try {
    sessionStorage.removeItem("aeo_last_scan");
  } catch {}
}

export async function fetchIndustries() {
  const res = await fetch("/api/industries");
  if (!res.ok) throw new Error("Failed to fetch industries");
  return res.json();
}

export async function fetchScanHistory(brand) {
  try {
    const res = await fetch(`/api/scans/${encodeURIComponent(brand)}`);
    if (!res.ok) return [];
    const data = await res.json();
    return data.scans || [];
  } catch {
    return [];
  }
}

/** Non-branded query count for history chips — matches normalizeResult.promptsAnalyzed. */
export function getHistoryNonBrandedCount(scan) {
  if (!scan) return 0;
  const summary = scan.summary_stats || scan.raw_results?.summary_stats;
  if (summary?.non_branded_queries != null) {
    return summary.non_branded_queries;
  }
  if (scan.prompts_tracked != null) return scan.prompts_tracked;
  const results = (scan.results ?? scan.raw_results?.results ?? []).filter(
    (r) => !r.is_control
  );
  return results.filter((r) => !getIsBrandedQuery(r)).length;
}

/**
 * Transforms an AIO-only scan record (from the API or DB) into the shape
 * the dashboard components expect.
 */
function round1(n) {
  return Math.round(n * 1000) / 10;
}

/** Dual-key readers: API rows use snake_case; re-normalized UI rows use camelCase. */
function getIsBrandedQuery(r) {
  return !!(r.is_branded_query ?? r.isBrandedQuery);
}

function getIntentTier(r) {
  return r.intent_tier ?? r.intentTier ?? null;
}

function getEngine(r) {
  return r.engine ?? r.engineName ?? null;
}

/** Brand Presence panel: intentional own-name seeds / intent, not every alias hit. */
function isBrandPresenceResult(r) {
  const source = r.source || "";
  const intentTier = getIntentTier(r);
  return source === "branded_seed" || intentTier === "branded";
}

// Use || not ??: text-engine rows carry an explicit `aio_present: false`
// alongside `answer_present: true` — a nullish fallback would stop at the
// false and misreport every ChatGPT/Perplexity answer as "no answer".
function getAnswerPresent(r) {
  return !!(r.answer_present || r.aio_present || r.aioPresent);
}

function getAioPresent(r) {
  return !!(r.aio_present || r.aioPresent || r.answer_present);
}

function getBrandMentionedInText(r) {
  return !!(r.brand_mentioned_in_text ?? r.brandMentionedInText ?? r.brandMentioned);
}

function getBrandCited(r) {
  return !!(r.brand_cited ?? r.brandCited);
}

function getAioCitations(r) {
  return r.aio_citations ?? r.aioCitations ?? r.citations ?? [];
}

// Use || not ??: a false brand_mentioned must not hide a true brand_cited
// when visible is missing (citation-only AIO rows).
function getVisible(r) {
  return !!(
    r.visible ||
    getBrandMentionedInText(r) ||
    getBrandCited(r) ||
    r.mentioned
  );
}

/**
 * Multi-engine scans emit one row per (prompt, engine). Any count that means
 * "how many PROMPTS" must dedupe by prompt text, or a 30-prompt scan on two
 * engines reads as 60 prompts in the UI. Single-engine rows are one per
 * prompt, so unique counts are identical there.
 */
function promptKeyOf(r) {
  return String(r.prompt || "").toLowerCase().trim();
}

function uniquePromptCount(rows) {
  return new Set(rows.map(promptKeyOf)).size;
}

function groupRowsByPrompt(rows) {
  const map = new Map();
  rows.forEach((r) => {
    const k = promptKeyOf(r);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(r);
  });
  return map;
}

function hasSnakeCaseResultRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return false;
  const first = rows[0];
  return (
    "is_branded_query" in first ||
    "aio_present" in first ||
    "brand_mentioned_in_text" in first
  );
}

/** Parse comma-separated competitor names from scan input. */
function parseCompetitorsRaw(raw) {
  if (raw == null) return [];
  return String(raw)
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);
}

/**
 * True when the scan has competitor data — user-supplied list and/or
 * auto-discovered co-mentions from AI Overviews (Blank-style).
 */
export function isCompetitorsConfigured(competitors = [], competitorsRaw = "") {
  if (parseCompetitorsRaw(competitorsRaw).length > 0) return true;
  return (
    Array.isArray(competitors) &&
    competitors.some((c) => String(c?.name ?? c ?? "").trim().length > 0)
  );
}

/**
 * KPI count: competitors with any signal in non-branded AIOs
 * (visibilityScore > 0, or at least one text mention or citation).
 */
export function countCompetitorsFound(competitors = []) {
  return competitors.filter(
    (c) =>
      (c.visibilityScore ?? 0) > 0 ||
      (c.mentions ?? 0) > 0 ||
      (c.citations ?? 0) > 0
  ).length;
}

function mapCompetitorRow(c) {
  return {
    name: c.name ?? c,
    mentions: c.mentions ?? 0,
    citations: c.citations ?? 0,
    prompts: c.prompts ?? c.mentions ?? 0,
    userAbsent: !!c.userAbsent,
    visibilityScore: c.visibilityScore ?? 0,
    citationShare: c.citationShare ?? 0,
    source: c.source || (c.discovered ? "discovered" : "user"),
    tier: c.tier || null,
  };
}

/**
 * Prefer stored competitor metrics; if empty, rediscover from AIO evidence
 * so older scans / form-empty runs still show co-mentions.
 *
 * NOTE — two competitor scorers coexist by design:
 *   - v8 (authoritative): competitorExtract.extractCompetitors(), one batched
 *     LLM call, run server-side in scanWorker and persisted on the scan record.
 *   - v7 (this fallback): coMentions.buildCompetitorLeaderboard(), the regex +
 *     stopword heuristic. Retained ONLY so pre-v8 scans still render a
 *     competitor table.
 *
 * A v8 scan always persists competitors, so this branch should never run for
 * new scans. If you see it firing on a fresh scan, the worker failed to persist
 * competitors — fix that rather than tuning the heuristic. Delete this fallback
 * (and coMentions' scoring exports) once pre-v8 scans age out of the database.
 */
function resolveCompetitors(data, raw, results, brand, website) {
  const stored = (data.competitors ?? raw.competitors ?? []).map(mapCompetitorRow);
  const withSignal = countCompetitorsFound(stored);
  if (withSignal > 0 || stored.some((c) => c.source === "discovered")) {
    return stored;
  }

  const userList = parseCompetitorsRaw(
    data.competitors_raw ?? raw.competitors_raw ?? data.competitorsRaw ?? ""
  );
  // If user listed names but all zero, keep them; still try discovery merge
  if (results?.length) {
    try {
      const rebuilt = buildCompetitorLeaderboard({
        results,
        brand,
        brandUrl: website,
        userCompetitors: userList,
        max: 10,
      }).map(mapCompetitorRow);
      if (rebuilt.length > 0) return rebuilt;
    } catch (err) {
      console.warn("[normalizeResult] co-mention rebuild failed:", err?.message || err);
    }
  }

  return stored;
}

function isAlreadyNormalized(data) {
  // Fresh API/DB run_record — not yet mapped to dashboard shape
  if (hasSnakeCaseResultRows(data.results)) return false;
  if (data.summary_stats?.visibility_pct != null && data.visibilityScore == null) {
    return false;
  }

  // Multi-engine records have isMultiEngine set during normalization
  if (data.isMultiEngine != null) return true;

  // Normalized UI object: visibilityScore + UI prompt arrays (rawResults may stay snake_case)
  if (data.visibilityScore == null) return false;

  return (
    Array.isArray(data.topPrompts) ||
    Array.isArray(data.nonBrandedResults) ||
    Array.isArray(data.brandedResults) ||
    Array.isArray(data.brandPresenceResults)
  );
}

function buildEngineScores(isMultiEngine, data, raw, fallbackScore) {
  if (isMultiEngine) {
    const engines = data.engines || raw.engines || {};
    const scores = {};
    for (const [key, summary] of Object.entries(engines)) {
      scores[key] = (summary && summary.share_of_ai_pct) || 0;
    }
    return scores;
  }
  return { google_ai_overview: fallbackScore };
}

function buildProbeSources(isMultiEngine, data, raw) {
  if (isMultiEngine) {
    const engines = data.engines || raw.engines || {};
    return Object.keys(engines);
  }
  return ["google_ai_overview"];
}

export function normalizeResult(data, fallbackBrand, fallbackWebsite) {
  if (isAlreadyNormalized(data)) {
    const competitorsRaw = data.competitorsRaw ?? data.competitors_raw ?? "";
    const rawResults = data.rawResults ?? data.results ?? [];
    const brand = data.brand ?? fallbackBrand;
    const website = data.website ?? fallbackWebsite;
    const competitors = resolveCompetitors(
      data,
      data.raw_results || data,
      rawResults,
      brand,
      website
    );
    const competitorsFound = countCompetitorsFound(competitors);
    const competitorsConfigured =
      competitorsFound > 0 || isCompetitorsConfigured(competitors, competitorsRaw);
    const brandPresenceResults =
      data.brandPresenceResults ??
      rawResults.filter(isBrandPresenceResult).map(mapPromptForUi);
    const brandedWithAio =
      data.brandedWithAio ??
      data.brandPresenceWithAio ??
      brandPresenceResults.filter((r) => r.aioPresent).length;
    const visibleBranded =
      data.visibleBranded ??
      brandPresenceResults.filter((r) => r.aioPresent && r.visible).length;
    const brandedPromptsCount =
      data.brandedPromptsCount ??
      rawResults.filter((r) => getIsBrandedQuery(r)).length;
    const brandPresencePromptsCount =
      data.brandPresencePromptsCount ?? brandPresenceResults.length;
    const queriesTracked =
      data.queriesTracked ??
      (Array.isArray(rawResults) && rawResults.length > 0
        ? rawResults.length
        : (data.promptsAnalyzed ?? 0) + brandedPromptsCount);

    return {
      ...data,
      brand,
      website,
      competitors,
      competitorsRaw,
      competitorsConfigured,
      competitorsFound,
      // R0.3.2/R0.3.3: how this scan's rival roster was obtained
      // ("extracted" / "carried_forward" / "unavailable"). null on scans
      // taken before R0.3.3, which are treated as measured.
      rosterSource:
        data.rosterSource ?? data.roster_source ?? (data.raw_results || {}).roster_source ?? null,
      brandPresenceResults,
      brandPresencePromptsCount,
      brandedPromptsCount,
      brandedWithAio,
      brandPresenceWithAio: data.brandPresenceWithAio ?? brandedWithAio,
      visibleBranded,
      aliasBrandedOnlyCount:
        data.aliasBrandedOnlyCount ??
        Math.max(0, brandedPromptsCount - brandPresencePromptsCount),
      queriesTracked,
    };
  }

  const raw = data.raw_results || data;
  const results = (data.results ?? raw.results ?? data.topPrompts ?? []).filter(
    (r) => !r.is_control
  );

  const brand = data.brand ?? fallbackBrand;
  const website = data.website ?? data.url ?? fallbackWebsite;

  const nonBranded = results.filter((r) => !getIsBrandedQuery(r));
  const branded = results.filter((r) => getIsBrandedQuery(r));
  const brandPresence = results.filter(isBrandPresenceResult);

  const summary = data.summary_stats || raw.summary_stats || null;

  const countNonBrandedWithAio = () => nonBranded.filter((r) => getAioPresent(r)).length;
  const countBrandPresenceWithAio = () =>
    brandPresence.filter((r) => getAioPresent(r)).length;
  const countVisibleNonBranded = () =>
    nonBranded.filter((r) => getAioPresent(r) && getVisible(r)).length;

  let nonBrandedWithAio =
    summary?.non_branded_with_aio ?? countNonBrandedWithAio();
  let brandPresenceWithAio = countBrandPresenceWithAio();
  let visibleNonBranded =
    summary?.visible_non_branded ?? countVisibleNonBranded();

  let visibilityPct =
    data.visibility_pct ?? data.visibilityScore ?? summary?.visibility_pct ?? null;
  let mentionRatePct =
    data.mention_rate_pct ??
    data.mentionRatePct ??
    summary?.mention_rate_pct ??
    raw.mention_rate_pct ??
    null;
  let citationSharePct =
    data.brand_citation_share_pct ??
    data.brandCitationSharePct ??
    summary?.citation_share_pct ??
    raw.brand_citation_share_pct ??
    null;
  let brandedVisibilityPct =
    data.branded_visibility_pct ??
    data.brandedVisibilityPct ??
    summary?.branded_visibility_pct ??
    raw.branded_visibility_pct ??
    null;
  let aioCoveragePct =
    data.aio_coverage_pct ??
    data.aioCoveragePct ??
    summary?.aio_coverage_pct ??
    raw.aio_coverage_pct ??
    null;
  let aioErrorRatePct =
    data.aio_error_rate_pct ??
    data.aioErrorRatePct ??
    summary?.error_rate_pct ??
    raw.aio_error_rate_pct ??
    null;
  let presenceRatePct =
    data.presence_rate_pct ?? data.presenceRatePct ?? summary?.presence_rate_pct ?? null;
  let shareOfAiPct =
    data.share_of_ai_pct ?? data.shareOfAiPct ?? summary?.share_of_ai_pct ?? visibilityPct;

  // Multi-engine detection: record carries an `engines` key with per-engine summaries.
  const isMultiEngine = !!(data.engines || raw.engines);

  // The pipeline (summarizeAioResults) already emits three mutually-consistent
  // metrics on one denominator each. Only recompute when the summary is
  // missing entirely (legacy scans) — never second-guess a present summary,
  // that client-side "disagreement" check was the historical source of
  // mixed-denominator bugs.
  const summaryMissing = !summary && results.length > 0;

  const recomputeFromResults = () => {
    nonBrandedWithAio = countNonBrandedWithAio();
    brandPresenceWithAio = countBrandPresenceWithAio();
    visibleNonBranded = countVisibleNonBranded();

    aioCoveragePct =
      nonBranded.length > 0
        ? round1(nonBrandedWithAio / nonBranded.length)
        : 0;
    visibilityPct =
      nonBrandedWithAio > 0
        ? round1(visibleNonBranded / nonBrandedWithAio)
        : 0;

    const visibleBrandPresence = brandPresence.filter(
      (r) => getAioPresent(r) && getVisible(r)
    ).length;
    brandedVisibilityPct =
      brandPresenceWithAio > 0
        ? round1(visibleBrandPresence / brandPresenceWithAio)
        : 0;

    const mentionedNonBranded = nonBranded.filter(
      (r) => getAioPresent(r) && getBrandMentionedInText(r)
    ).length;
    const citedNonBranded = nonBranded.filter(
      (r) => getAioPresent(r) && getBrandCited(r)
    ).length;
    mentionRatePct =
      nonBrandedWithAio > 0
        ? round1(mentionedNonBranded / nonBrandedWithAio)
        : 0;
    citationSharePct =
      nonBrandedWithAio > 0
        ? round1(citedNonBranded / nonBrandedWithAio)
        : 0;

    const errored = results.filter((r) => r.error).length;
    aioErrorRatePct =
      results.length > 0 ? round1(errored / results.length) : 0;

    presenceRatePct =
      nonBranded.length > 0 ? round1(visibleNonBranded / nonBranded.length) : 0;
    shareOfAiPct = visibilityPct;
  };

  if (summaryMissing) {
    recomputeFromResults();
  }

  // Brand Presence KPI always uses intentional own-name set, not every alias hit.
  // Prompt-level semantics: a prompt counts as answered/visible if ANY engine
  // answered / showed the brand (identical to before for single-engine rows).
  const brandPresenceByPrompt = groupRowsByPrompt(brandPresence);
  brandPresenceWithAio = [...brandPresenceByPrompt.values()].filter((rows) =>
    rows.some(getAioPresent)
  ).length;
  const visibleBrandPresence = [...brandPresenceByPrompt.values()].filter((rows) =>
    rows.some((r) => getAioPresent(r) && getVisible(r))
  ).length;
  brandedVisibilityPct =
    brandPresenceWithAio > 0
      ? round1(visibleBrandPresence / brandPresenceWithAio)
      : 0;

  nonBrandedWithAio = Number(nonBrandedWithAio) || 0;
  brandPresenceWithAio = Number(brandPresenceWithAio) || 0;
  visibleNonBranded = Number(visibleNonBranded) || 0;
  const visibleBranded = Number(visibleBrandPresence) || 0;
  visibilityPct = visibilityPct ?? 0;
  mentionRatePct = mentionRatePct ?? 0;
  citationSharePct = citationSharePct ?? 0;
  brandedVisibilityPct = brandedVisibilityPct ?? 0;
  aioCoveragePct = aioCoveragePct ?? 0;
  aioErrorRatePct = aioErrorRatePct ?? 0;
  presenceRatePct = presenceRatePct ?? 0;
  shareOfAiPct = shareOfAiPct ?? visibilityPct;
  const promptsTracked = data.prompts_tracked ?? raw.prompts_tracked ?? nonBranded.length;
  const dataSourceIssue = !!(
    data.data_source_issue ??
    data.dataSourceIssue ??
    summary?.data_source_issue ??
    raw.data_source_issue
  );
  const insufficientSample = !!(
    data.insufficient_sample ??
    data.insufficientSample ??
    summary?.insufficient_sample ??
    raw.insufficient_sample
  );

  const competitors = resolveCompetitors(data, raw, results, brand, website);
  const competitorsFound = countCompetitorsFound(competitors);
  // Auto-discovery means "configured" whenever we have co-mention data
  const competitorsConfigured =
    competitorsFound > 0 ||
    isCompetitorsConfigured(
      competitors,
      data.competitors_raw ?? raw.competitors_raw ?? ""
    );

  return {
    brand,
    website,
    industry: data.industry ?? "",
    // See the note on the already-normalized branch above.
    rosterSource: data.roster_source ?? raw.roster_source ?? null,
    visibilityScore: visibilityPct,
    /** Hero metric — same value as visibilityScore, named for the "Share of AI answers" hero. */
    shareOfAiPct,
    presenceRatePct,
    /** Denominator the hero uses: non-branded queries where Google actually returned an AIO. */
    queriesWithAio: nonBrandedWithAio,
    promptsTracked,
    visibleCount: visibleNonBranded,
    mentionRatePct,
    brandCitationSharePct: citationSharePct,
    brandedVisibilityPct,
    aioCoveragePct,
    aioErrorRatePct,
    promptsAnalyzed: uniquePromptCount(nonBranded),
    nonBrandedWithAio,
    brandedWithAio: brandPresenceWithAio,
    brandPresenceWithAio,
    visibleNonBranded,
    visibleBranded,
    brandedPromptsCount: uniquePromptCount(branded),
    brandPresencePromptsCount: uniquePromptCount(brandPresence),
    /** Alias-hit queries that are not intentional Brand Presence seeds */
    aliasBrandedOnlyCount: Math.max(
      0,
      uniquePromptCount(branded) - uniquePromptCount(brandPresence)
    ),
    /** All probed queries (non-branded + alias-branded + brand presence) */
    queriesTracked: uniquePromptCount(results),
    scanTimestamp: data.scanned_at ?? data.scanTimestamp ?? new Date().toISOString(),
    scoringVersion: data.scoring_version ?? raw.scoring_version ?? "v7-aio-only",
    seeds: data.seeds ?? raw.seeds ?? [],
    querySource: data.query_source ?? raw.query_source ?? "aio_paa_autocomplete",
    usedDynamicPrompts: !!(data.used_dynamic_prompts ?? raw.used_dynamic_prompts),
    tokensUsed: data.tokens_used ?? 0,
    costTotal: data.cost_total ?? raw.cost_total ?? 0,
    dataSourceIssue,
    insufficientSample,
    // For legacy dashboard components that key off `qualityGateFailed`
    qualityGateFailed: dataSourceIssue,
    sampleSizeAdequacy: !insufficientSample,
    topDomains: data.top_domains ?? raw.top_domains ?? [],
    competitors,
    competitorsFound,
    competitorsConfigured,
    competitorsRaw: data.competitors_raw ?? raw.competitors_raw ?? "",
    engineScores: buildEngineScores(isMultiEngine, data, raw, visibilityPct),
    probeSources: buildProbeSources(isMultiEngine, data, raw),
    serpCoveragePct: aioCoveragePct,
    visibilityIndexPct: data.visibility_index_pct ?? raw.visibility_index_pct ?? null,
    enginesCounted: data.engines_counted ?? raw.engines_counted ?? 0,
    isMultiEngine,
    perEngineSummaries: (data.engines || raw.engines) || null,
    summary: generateSummary(
      brand,
      isMultiEngine
        ? (data.visibility_index_pct ?? raw.visibility_index_pct ?? visibilityPct)
        : visibilityPct,
      aioCoveragePct,
      dataSourceIssue,
      isMultiEngine ? Object.keys(data.engines || raw.engines || {}) : null
    ),
    totalCitations: results.reduce(
      (sum, r) => sum + getAioCitations(r).length,
      0
    ),
    promptSetId: data.prompt_set_id ?? raw.prompt_set_id ?? "",
    promptSetHash: data.prompt_set_hash ?? raw.prompt_set_hash ?? "",
    rawResults: results,
    topPrompts: results.map(mapPromptForUi),
    nonBrandedResults: nonBranded.map(mapPromptForUi),
    brandedResults: branded.map(mapPromptForUi),
    brandPresenceResults: brandPresence.map(mapPromptForUi),
  };
}

function mapPromptForUi(r) {
  const aioCitations = getAioCitations(r);
  // `?? r.references` is required since P0.2: every scan (including AIO-only)
  // now probes through the v9 engine registry, whose rows carry `references`,
  // not the legacy `aio_references`. Without this fallback new AIO scans render
  // an empty source list in the per-prompt drill-down (reviewer D5). The `text`
  // and `citations` siblings already have their equivalent fallbacks.
  const aioReferences = r.aio_references ?? r.aioReferences ?? r.references ?? [];
  const brandMentionedInText = getBrandMentionedInText(r);
  const brandCited = getBrandCited(r);
  const visible = getVisible(r);
  const isBrandedQuery = getIsBrandedQuery(r);
  const aioPresent = getAioPresent(r);
  const source = r.source || "";
  // Brand Presence intent only — do not promote alias-hit rows to "branded"
  const intentTier = (() => {
    if (String(source).toLowerCase() === "branded_seed") return "branded";
    const tier = getIntentTier(r);
    if (tier === "branded") return "branded";
    if (tier) return tier;
    return "exploratory";
  })();

  const promptScore = visible ? 100 : 0;

  let rank = "—";
  if (brandMentionedInText && brandCited) rank = 1;
  else if (brandMentionedInText) rank = 2;
  else if (brandCited) rank = 3;

  return {
    prompt: r.prompt,
    engine: r.engine || null,
    rank,
    organicPosition: r.brand_organic_position ?? r.organicPosition ?? null,
    volume: source ? source.toUpperCase() : "—",
    promptScore,
    aioPresent,
    aioText: r.aio_text ?? r.aioText ?? r.text ?? "",
    aioCitations,
    aioReferences,
    brandMentioned: brandMentionedInText,
    brandCited,
    visible,
    isBrandedQuery,
    brandInPromptWarning: isBrandedQuery,
    competitorsFound: r.competitors_found_in_text || r.competitors_found || [],
    competitorsCited: r.competitors_cited || [],
    mentioned: visible,
    position: brandCited ? "cited" : brandMentionedInText ? "recommended" : "omitted",
    sentiment: "neutral",
    citations: aioCitations,
    keyPhrases: [],
    error: r.error || null,
    source,
    topic: r.topic || "General",
    intentTier,
  };
}

const ENGINE_LABELS = {
  aio: "Google AI Overviews",
  chatgpt: "ChatGPT",
  perplexity: "Perplexity",
};

function generateSummary(brand, score, coverage, dataSourceIssue, engineNames = null) {
  const surface =
    engineNames && engineNames.length > 1
      ? engineNames.map((e) => ENGINE_LABELS[e] || e).join(" and ")
      : "Google AI Overviews";
  if (dataSourceIssue) {
    return `Not enough AI answers were returned for ${brand} to compute a reliable score. This usually means either the data source (Bright Data SERP) errored or Google did not surface an AIO for most tracked queries.`;
  }
  const b = brand || "Your brand";
  if (score >= 50)
    return `${b} shows strong presence across ${surface} — appearing in the majority of relevant answers. Keep monitoring high-intent competitor queries to defend this position.`;
  if (score >= 20)
    return `${b} appears in some answers across ${surface} but is missed in most category queries. Competitors are winning the majority of AI recommendations.`;
  return `${b} is largely invisible across ${surface} for its category. Competitors dominate AI recommendations across the tracked queries.`;
}

export async function runScan({ brand, website, industry, competitors }, onProgress = () => {}) {
  onProgress(0);

  // The bare "Failed to fetch" TypeError (server unreachable / not running)
  // is meaningless to a user — translate it into an actionable message.
  const friendlyNetworkError = () =>
    new Error(
      "Couldn't reach the scanning service. Make sure the app server is running, then try again."
    );

  let res;
  try {
    res = await fetch("/api/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ brand, url: website, industry, competitors: competitors || "" }),
    });
  } catch {
    throw friendlyNetworkError();
  }

  if (!res.ok) {
    let msg = "Scan failed to initiate";
    try {
      const errData = await res.json();
      if (errData.detail) msg = errData.detail;
    } catch {}
    throw new Error(msg);
  }

  const initData = await res.json();
  const jobId = initData.job_id;
  if (!jobId) throw new Error("Invalid response from scanning service.");

  const statusToStage = {
    pending: 0,
    generating_prompts: 1,
    probing: 2,
    analyzing: 3,
    scoring: 3,
    complete: 4,
    failed: 4,
  };

  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  let attempts = 0;
  // 15 min of headroom (450 × 2s). A slow scan (Bright Data at low concurrency)
  // can run 10-12 min; the old 10-min cap could time out a still-healthy job.
  const maxAttempts = 450;
  // A single transient poll failure (dev-server hot-reload, brief network blip)
  // must not kill an otherwise-healthy multi-minute scan. Only give up after
  // several consecutive failures.
  const MAX_CONSECUTIVE_POLL_ERRORS = 5;
  let consecutivePollErrors = 0;

  while (attempts < maxAttempts) {
    await delay(2000);
    attempts++;

    let statusData;
    try {
      const pollRes = await fetch(`/api/scan/${jobId}/status`);
      if (!pollRes.ok) throw new Error(`status HTTP ${pollRes.status}`);
      statusData = await pollRes.json();
      consecutivePollErrors = 0;
    } catch (err) {
      consecutivePollErrors++;
      if (consecutivePollErrors >= MAX_CONSECUTIVE_POLL_ERRORS) {
        throw new Error(
          "Lost connection to the scanning service while the scan was running. Please try again."
        );
      }
      continue; // transient — retry on the next tick
    }

    const stage = statusToStage[statusData.status] ?? 0;
    onProgress(stage, statusData.progress_pct);

    if (statusData.status === "complete") {
      // P0.3: the canonical record now lives in the `scans` table
      // (result_id points at it) rather than riding along on the job row.
      // A later package stops the worker writing run_record entirely, so
      // prefer the DB fetch whenever result_id is present, and only fall
      // back to run_record when it's absent or the fetch doesn't pan out.
      let record = null;
      if (statusData.result_id) {
        try {
          const recordRes = await fetch(`/api/scans/by-id/${statusData.result_id}`);
          if (recordRes.ok) {
            const recordData = await recordRes.json();
            record = recordData.scan || null;
          }
        } catch {
          // Transient — fall through to run_record below.
        }
      }
      if (!record) record = statusData.run_record;
      if (!record) throw new Error("Scan finished but no record was returned.");
      return normalizeResult(record, brand, website);
    }
    if (statusData.status === "failed") {
      throw new Error(statusData.error_message || "Async scan job failed.");
    }
  }

  throw new Error("Scan timed out after 15 minutes.");
}

export async function getContentEvents(brand) {
  try {
    const res = await fetch(`/api/content-events?brand=${encodeURIComponent(brand)}`);
    if (res.ok) return await res.json();
    return [];
  } catch {
    return [];
  }
}

export async function addContentEvent({ brand, url, publishDate }) {
  try {
    const res = await fetch("/api/content-events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ brand, url, publishDate }),
    });
    if (res.ok) return await res.json();
    return null;
  } catch {
    return null;
  }
}

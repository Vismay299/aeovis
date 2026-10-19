import { extractBrandDomain, aggregateTopDomains, computeCompetitorCitationShare } from "../lib/scoring/citations.js";
import { buildCompetitorLeaderboard } from "../lib/scoring/coMentions.js";
import { isSampleRecord, assertSampleNotMutated } from "../lib/sampleIsolation.js";
import { scanHeadline } from "../lib/scoring/scanHeadline.js";

export const SAMPLE_STORAGE_KEY = "aeo_sample_scan_v1";
export const REAL_STORAGE_KEY = "aeo_last_scan";

export function saveScan(result) {
  try {
    if (result && (result.isSample || result.sample)) {
      sessionStorage.setItem(SAMPLE_STORAGE_KEY, JSON.stringify({ ...result, sample_version: "v1" }));
      return;
    }
    sessionStorage.setItem(REAL_STORAGE_KEY, JSON.stringify(result));
  } catch {}
}

export function loadScan() {
  try {
    const realRaw = sessionStorage.getItem(REAL_STORAGE_KEY);
    if (realRaw) {
      const parsed = JSON.parse(realRaw);
      if (parsed && !parsed.isSample && !parsed.sample) return parsed;
    }
    const sampleRaw = sessionStorage.getItem(SAMPLE_STORAGE_KEY);
    return sampleRaw ? JSON.parse(sampleRaw) : null;
  } catch {
    return null;
  }
}

export function clearScan() {
  try {
    sessionStorage.removeItem(REAL_STORAGE_KEY);
  } catch {}
}

export function clearSampleHandoff() {
  try {
    sessionStorage.removeItem(SAMPLE_STORAGE_KEY);
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
  // R2.1.2 — the `?? 0` these three comparisons used to carry was a no-op:
  // `null > 0` and `undefined > 0` are both false already. Dropping it changes
  // nothing at runtime and stops the file reading as though an unmeasured rival
  // had been measured at zero. The predicate is unchanged in every other way,
  // including its tolerance of numeric strings.
  return competitors.filter(
    (c) => c.visibilityScore > 0 || c.mentions > 0 || c.citations > 0
  ).length;
}

/**
 * One competitor row in the shape the dashboard reads.
 *
 * R2.1.2 — the five metrics carry `null` when the record does not have them,
 * never 0. Both producers (competitorExtract.js:173-184 and
 * coMentions.js:428-439) always emit all five as numbers, so a missing field
 * means the row predates them or was stored as a bare name string — i.e. the
 * rival's share was never computed, which is not the same fact as "this rival
 * appeared in nothing". Every current consumer (RivalsView.jsx:37/:77/:89,
 * OverviewAnalytics.jsx:31/:36, interlocking.js:81 and countCompetitorsFound
 * above) is already null-tolerant, so nothing downstream changes shape today.
 */
function mapCompetitorRow(c) {
  return {
    name: c.name ?? c,
    mentions: c.mentions ?? null,
    citations: c.citations ?? null,
    prompts: c.prompts ?? c.mentions ?? null,
    userAbsent: !!c.userAbsent,
    visibilityScore: c.visibilityScore ?? null,
    citationShare: c.citationShare ?? null,
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
  if (
    withSignal > 0 ||
    stored.some(
      (c) =>
        c.source === "discovered" ||
        c.source === "carried_forward" ||
        c.source === "configured" ||
        c.source === "user"
    )
  ) {
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
      // R2.1.2 — `|| 0` here was the `?? 0` defect wearing a different operator,
      // on the exact metric R2.1.1 made nullable: a slice with state
      // not_assessed / failed publishes `share_of_ai_pct: null`, and this turned
      // it into a per-engine score of 0. Nothing reads these values today
      // (interlocking.js:97 reads only the keys), but a zero parked in a field
      // called `engineScores` is a loaded gun.
      scores[key] = summary?.share_of_ai_pct ?? null;
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
  const headline = scanHeadline(data);
  const headlineFields = headline ? {
    headlinePct: headline.value, headlineQualified: headline.qualified,
    headlineState: headline.state, headlineReason: headline.reason,
    exploratoryIndexPct: headline.exploratory, headlineMetric: headline.metric,
    metricContractVersion: data.summary_stats?.metric_contract_version ?? data.raw_results?.summary_stats?.metric_contract_version,
  } : {};
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
        // R2.1.2 — this `?? 0` STAYS, and the guard test allows it by name.
        // `promptsAnalyzed` is a count of questions asked, not a measurement,
        // and the coalesce is a NaN guard: `undefined + brandedPromptsCount` is
        // NaN, which would render as "NaN queries tracked". (`null + n === n`,
        // so the null case was never the reason it is here.)
        : (data.promptsAnalyzed ?? 0) + brandedPromptsCount);

    return {
      ...data,
      ...headlineFields,
      ...(headline ? { visibilityScore: headline.value, visibilityIndexPct: headline.value, shareOfAiPct: headline.value } : {}),
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
      shareOfVoicePct:
        data.shareOfVoicePct ??
        data.share_of_voice_pct ??
        (data.raw_results || {}).share_of_voice_pct ??
        null,
      share_of_voice_pct:
        data.share_of_voice_pct ??
        data.shareOfVoicePct ??
        (data.raw_results || {}).share_of_voice_pct ??
        null,
      isSample: Boolean(data.isSample ?? data.sample),
      sample: Boolean(data.isSample ?? data.sample),
      illustrative: Boolean(data.illustrative ?? data.isSample),
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
  let shareOfVoicePct =
    data.share_of_voice_pct ??
    data.shareOfVoicePct ??
    summary?.share_of_voice_pct ??
    raw.share_of_voice_pct ??
    null;

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
  // R2.2.11 — NOT `?? 0`. This one line is where the citation-share fix died.
  //
  // enginePipeline's scan-level mirror and rollup.js now publish `null` when the
  // citation denominator is empty (every answered non-branded row's citation
  // list unobserved, so there is nothing to divide by), and scanWorker,
  // api/scans/_lib/scanRow.js and the `?? null` chain at :408 above all carry
  // that null intact — and then this line turned it back into a confident 0,
  // three lines before the only consumer. `?? 0` on a metric is standing rule 5
  // exactly. A measured 0 is unaffected: `0 ?? x` was already 0.
  //
  // R2.2.11 scoped itself to this one metric and left the siblings "to the tasks
  // that own them". R2.1.2 below IS that task, so the sibling assignments are
  // gone rather than converted; this statement survives only as the landmark
  // R2.2.11's evidence cites (`x ?? null` is a self-assignment and does nothing).
  citationSharePct = citationSharePct ?? null;
  /**
   * R2.1.2 (finding S1) — NO `?? 0` ON A METRIC, HERE OR ANYWHERE BELOW.
   *
   * `visibilityPct`, `mentionRatePct`, `brandedVisibilityPct`, `aioCoveragePct`,
   * `aioErrorRatePct` and `presenceRatePct` were each reassigned here as
   * `x = x ?? 0`. R2.1.1 taught the producers to publish `null` for a reading
   * that does not exist — a slice that never ran, an eliciting pool that named
   * no vendor, a read too broken to trust — and the `?? null` chains at :400-433
   * carry those nulls all the way down the function. These six statements were
   * the last thing standing between an honest null and the returned object: one
   * statement, and "the answers never named us" became "0% of answers named
   * you". Standing rules 1 and 5.
   *
   * The assignments are DELETED rather than rewritten to `?? null`, because
   * `x = x ?? null` is a self-assignment. A measured zero is untouched either
   * way: `0 ?? anything` was already 0, so no real reading moves.
   *
   * `brandedVisibilityPct`'s coalesce was already DEAD when this ran: the
   * `brandPresenceByPrompt` block twenty lines up reassigns it unconditionally,
   * so it can never be nullish by the time it got here. It made the block look
   * uniformly guarded when it was not.
   *
   * WHAT STILL PRINTS A ZERO, and whose job that is: OverviewView.jsx
   * (`Math.round(aioCoverage ?? 0)`, `Math.round(presenceRate ?? 0)`) and
   * DashboardShell.jsx (`${result.aioCoveragePct ?? 0}%`) apply their OWN
   * coalesce on the way to the screen. The normalize layer no longer lies;
   * those components still do, and R2.7.12 owns them — cited by expression
   * rather than line because that task is in flight as this lands. Do not
   * "fix" it by restoring a coalesce here: the guard test in
   * servicesApiNullMetrics.test.mjs fails if you do.
   */
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
    ...headlineFields,
    visibilityScore: headline ? headline.value : visibilityPct,
    /** Hero metric — same value as visibilityScore, named for the "Share of AI answers" hero. */
    shareOfAiPct: headline ? headline.value : shareOfAiPct,
    shareOfVoicePct,
    share_of_voice_pct: shareOfVoicePct,
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
    /**
     * R2.7.3 (finding C1) — NO `new Date()` FALLBACK HERE, EVER.
     *
     * This used to end in `?? new Date().toISOString()`, which stamped a record
     * that carried no collection time with the moment the browser happened to
     * normalize it. The dashboard then rendered "just now" for data of entirely
     * unknown age — a record that was never stamped looked identical to one
     * collected seconds ago. A missing collection time is null, and null renders
     * as an em dash plus a "no collection time" chip. See format.js/relativeTime
     * and DashboardShell's timestamp cell.
     */
    scanTimestamp:
      (data.isSample || raw.isSample || data.sample || raw.sample)
        ? (data.scanned_at ?? data.scanTimestamp ?? raw.scanned_at ?? raw.scanTimestamp ?? "2026-10-15T12:00:00.000Z")
        : (data.scanned_at ?? data.scanTimestamp ?? null),
    // R2.7.4 — the window the answers were collected in, first to last probe
    // write. Distinct from scanTimestamp, which is when finalize ran; on a
    // chunked or crash-resumed scan those can be hours apart. Null on scans
    // taken before this landed, which is what a before-corpus should show.
    collectedFrom: data.collected_from ?? raw.collected_from ?? null,
    collectedTo: data.collected_to ?? raw.collected_to ?? null,
    scoringVersion: data.scoring_version ?? raw.scoring_version ?? "v7-aio-only",
    seeds: data.seeds ?? raw.seeds ?? [],
    querySource: data.query_source ?? raw.query_source ?? "aio_paa_autocomplete",
    usedDynamicPrompts: !!(data.used_dynamic_prompts ?? raw.used_dynamic_prompts),
    // R2.1.2 — spend is a measurement too, and standing rule 3 says an unpriced
    // run fails loud rather than reporting $0. A record that never stored a
    // token count or a cost did not cost nothing; it did not say.
    tokensUsed: data.tokens_used ?? null,
    costTotal: data.cost_total ?? raw.cost_total ?? null,
    dataSourceIssue,
    /**
     * R3.2.5 (finding B3) — why `enginesCounted` fell, READ off the record.
     *
     * `summary_stats.engine_set_change` is written by the worker when a
     * checkpoint-frozen engine stopped resolving mid-scan (`shrank`) or when the
     * scan was answered by a different set than it was frozen with (`refrozen`).
     * Absent on every scan where the frozen set held, so `null` here means
     * "nothing changed", not "we did not look".
     *
     * It is exposed rather than recomputed because the client CANNOT derive it:
     * it does not know the frozen set or the live engine registry, cannot tell a
     * de-registered engine from one whose every probe errored, and cannot see a
     * refreeze at all — the substituted engines are absent from
     * `perEngineSummaries` entirely. That is the difference from
     * `dataSourceIssue`, which DashboardShell re-derives from the slices.
     */
    engineSetChange: summary?.engine_set_change ?? null,
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
    visibilityIndexPct: headline ? headline.value : (data.visibility_index_pct ?? raw.visibility_index_pct ?? null),
    /**
     * R2.1.2 — this `?? 0` STAYS, and the guard test allows it by name.
     *
     * It is an inventory count of engines, not a measurement of the brand, and
     * it is load-bearing in a way the metric coalesces were not:
     * enginePipeline.js's `describeScanDataSourceIssue` docstring ("A stored
     * engines_counted is NOT used for that: normalizeResult defaults it to 0
     * ... a defaulted 0 read as authoritative would declare an otherwise-healthy
     * scan unscoreable") describes THIS line, and that function's
     * `Number(options.enginesCounted)` treats `null` and `0` identically
     * anyway, since `Number(null) === 0`. Changing it would falsify that
     * docstring while changing no behaviour. The honest version needs
     * enginePipeline to distinguish absent from zero — filed separately, not
     * smuggled in here.
     */
    enginesCounted:
      data.engines_counted ??
      raw.engines_counted ??
      ((data.isSample || raw.isSample || data.sample || raw.sample)
        ? (data.engines ? Object.keys(data.engines).length : (raw.engines ? Object.keys(raw.engines).length : (isMultiEngine ? 4 : 1)))
        : 0),
    isMultiEngine,
    perEngineSummaries: (data.engines || raw.engines) || null,
    summary: generateSummary(
      brand,
      headline ? headline.value : isMultiEngine
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
    isSample: Boolean(data.isSample ?? raw.isSample ?? data.sample ?? raw.sample),
    sample: Boolean(data.isSample ?? raw.isSample ?? data.sample ?? raw.sample),
    illustrative: Boolean(data.illustrative ?? raw.illustrative ?? data.isSample ?? raw.isSample),
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
    /**
     * R1.5.3 — the identity a "View evidence" link needs, and nothing more.
     *
     * `resultId`/`jobId` address the prompt_results row; `evidenceScreenshotId`
     * only says WHETHER a capture exists, so the affordance can be hidden when
     * none does. The object key is never sent from here — the route reads it off
     * the row (src/lib/evidenceSignedUrl.js).
     *
     * All three are null on rows read through a path that does not carry them
     * (sample data, and scans stored before the finalize carry-through in
     * scanWorker.js). null hides the button; it never becomes "" or a guess.
     * The snake_case spellings are the stored columns, the camelCase ones are
     * already-mapped rows; `r.evidence?.screenshot_id` is the §3.7 field as it
     * sits inside the verbatim `raw` payload.
     */
    resultId: r.result_id ?? r.resultId ?? r.id ?? null,
    jobId: r.job_id ?? r.jobId ?? null,
    evidenceScreenshotId:
      r.evidence_screenshot_id ?? r.evidenceScreenshotId ?? r.evidence?.screenshot_id ?? null,
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
  /**
   * R2.1.2 — a null score must not fall through to the prose ladder below.
   *
   * `null >= 50` and `null >= 20` are both false, so before this arm a scan
   * with NO score reached the last line and told the customer it was "largely
   * invisible across Google AI Overviews for its category" — a confident
   * market verdict derived from a measurement that does not exist. That was
   * unreachable while visibilityPct was coalesced to 0 three hundred lines up;
   * deleting the coalesce makes it reachable, so it is closed in the same diff.
   */
  if (!Number.isFinite(score)) {
    return `No AI share was recorded for ${b} on this scan, so there is nothing to read yet. This is not a score of 0 — the engines either did not answer, or answered without naming any vendor at all.`;
  }
  if (score >= 50)
    return `${b} shows strong presence across ${surface} — appearing in the majority of relevant answers. Keep monitoring high-intent competitor queries to defend this position.`;
  if (score >= 20)
    return `${b} appears in some answers across ${surface} but is missed in most category queries. Competitors are winning the majority of AI recommendations.`;
  return `${b} is largely invisible across ${surface} for its category. Competitors dominate AI recommendations across the tracked queries.`;
}

/**
 * Run a scan to completion, reporting progress as it polls.
 *
 * `onProgress(stage, progressPct)` is called ONLY for real readings, and
 * `progressPct` may be null/undefined when the job has not recorded one — that
 * is "unknown", and callers must not render it as 0 (see lib/scanProgress.js).
 *
 * `onUnknown({ reason })` (R2.8.3, finding A11) is called for a poll tick that
 * produced no reading at all: a fetch/HTTP failure, the status route's
 * transient_error envelope, or a status string this client does not know. It
 * used to be silent — the transient envelope's `status: "working"` was mapped
 * to stage 0 and its null percentage rendered as "% complete", rewinding the
 * bar. Nothing is synthesised here now; the caller is told the tick was a miss
 * and keeps what it already had.
 */
export async function runScan(
  { brand, website, industry, competitors },
  onProgress = () => {},
  onUnknown = () => {}
) {
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

    const pollErrorsBeforeThisTick = consecutivePollErrors;
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
      // Transient — retry on the next tick, but SAY that this tick told us
      // nothing. Skipping silently left the UI looking live while it was blind.
      onUnknown({ reason: `poll_failed: ${err?.message || "unknown error"}` });
      continue;
    }

    // A tick that carried no reading: either the route's transient_error
    // envelope (a DB read it could not make) or a status string this client
    // has no stage for. Neither is stage 0 and neither is 0% — report it as
    // unknown and let the caller keep the progress it already has. Note the
    // error counter is deliberately NOT reset above for this case (the fetch
    // succeeded, the read did not), so an unknown tick cannot launder itself
    // into evidence that the pipeline is healthy.
    const mappedStage = statusToStage[statusData?.status];
    if (statusData?.transient_error === true || mappedStage === undefined) {
      consecutivePollErrors = pollErrorsBeforeThisTick;
      onUnknown({
        reason: statusData?.transient_error === true
          ? "status_unreadable"
          : `unknown_status: ${statusData?.status ?? "missing"}`,
      });
      continue;
    }

    // progress_pct may be null here too (the job row has not recorded one yet).
    // That is passed through as-is: unknown stays unknown downstream.
    onProgress(mappedStage, statusData.progress_pct);

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
  if (isSampleRecord({ brand })) {
    throw Object.assign(new Error("Cannot add content event on sample demonstration data: action refused"), {
      code: "SAMPLE_MUTATION_FORBIDDEN",
      isSample: true,
    });
  }
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

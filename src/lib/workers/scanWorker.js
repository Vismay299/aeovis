import crypto from "crypto";
import { insertScan, updateScanJob } from "../db.js";
import { generateUnbrandedPrompts } from "../scoring/promptGen.js";
import { extractCompetitors } from "../scoring/competitorExtract.js";
import { runAioScan, aggregateAioTopDomains } from "../scoring/aioPipeline.js";
import { runMultiEngineScan, summarizeEngineResults, resolveEnabledEngines } from "../scoring/enginePipeline.js";
import { getPromptsForBrand, upsertPrompts } from "../db/prompts.js";
import { buildBrandedQueries, isBrandedQuery } from "../scoring/aioQueryClassify.js";
import { getBrandAliases } from "../scoring/aliases.js";
import { resolveBrandKey } from "../scoring/brandKey.js";

const MAX_SOURCING_ATTEMPTS = 3;
const DEFAULT_UNBRANDED_TARGET = 30;

/**
 * Tracked-set size. Plan-limit lever: raising it (PROMPT_TARGET env) makes the
 * next scan top up ADDITIVELY — existing prompts and their histories are never
 * regenerated or replaced (prompt-set contract, 2026-07-20).
 */
export function resolvePromptTarget() {
  const raw = Number.parseInt(process.env.PROMPT_TARGET || "", 10);
  if (!Number.isFinite(raw)) return DEFAULT_UNBRANDED_TARGET;
  return Math.min(100, Math.max(10, raw));
}

function queryTextKey(text) {
  return String(text || "").toLowerCase().trim();
}

function mapDbPromptRow(p) {
  return {
    text: p.text,
    source: p.source || "db",
    topic: p.topic || "General",
    intent_tier: p.intent_tier || "informational",
  };
}

/**
 * Sources the brand's tracked unbranded prompt set (prompt-set contract):
 *
 *  - Pool is keyed by resolveBrandKey (domain-first) so brand-name casing or
 *    variants can never fragment the set. Legacy pools stored under the typed
 *    brand name are migrated to the key on first read.
 *  - FAIL-LOUD: a DB error while loading the pool aborts the scan. Silently
 *    regenerating prompts would produce a score on the wrong questions and
 *    quietly break score comparability — a failed scan is strictly better.
 *  - Generation runs only when the pool is genuinely short of target
 *    (onboarding, or an additive top-up after the target was raised).
 *  - Reuse path slices deterministically (DB ordering is created_at, id).
 *
 * Returns the full target-sized list plus only the newly generated ones
 * (so the caller persists just the delta). `deps` is test injection only.
 */
export async function sourceUnbrandedQueries(brand, url, industry, stats, brandAliases, deps = {}) {
  const getPrompts = deps.getPromptsForBrand || getPromptsForBrand;
  const upsert = deps.upsertPrompts || upsertPrompts;
  const generate = deps.generateUnbrandedPrompts || generateUnbrandedPrompts;
  const target = deps.promptTarget || resolvePromptTarget();

  const promptKey = resolveBrandKey(brand, url);

  let dbPrompts;
  try {
    dbPrompts = await getPrompts(promptKey, false, { strict: true });
  } catch (err) {
    throw new Error(
      `Couldn't load the tracked prompt set for this brand (${err.message}). ` +
        `Scan aborted to protect score comparability — please retry.`
    );
  }

  // Legacy migration: older scans stored the pool under the typed brand name.
  // Re-home those rows under the canonical key once, preserving enabled/weight.
  if ((dbPrompts || []).length === 0 && promptKey !== queryTextKey(brand)) {
    let legacyRows;
    try {
      legacyRows = await getPrompts(brand, true, { strict: true });
    } catch (err) {
      throw new Error(
        `Couldn't load the tracked prompt set for this brand (${err.message}). ` +
          `Scan aborted to protect score comparability — please retry.`
      );
    }
    if ((legacyRows || []).length > 0) {
      console.log(
        `[worker] Migrating ${legacyRows.length} legacy prompts from "${brand}" to key "${promptKey}"`
      );
      try {
        await upsert(
          promptKey,
          legacyRows.map((p) => ({
            text: p.text,
            intent_tier: p.intent_tier,
            topic: p.topic,
            weight: p.weight,
            enabled: p.enabled,
            source: p.source,
          }))
        );
        dbPrompts = await getPrompts(promptKey, false, { strict: true });
      } catch (err) {
        throw new Error(
          `Couldn't migrate the tracked prompt set to its new key (${err.message}). ` +
            `Scan aborted to protect score comparability — please retry.`
        );
      }
    }
  }

  // getPromptsForBrand returns every enabled row regardless of tier, and we
  // persist branded seeds alongside the unbranded set. Filter them out here or
  // they leak into the tracked set on the next scan and silently inflate the score.
  const existing = (dbPrompts || [])
    .filter(
      (p) =>
        p.intent_tier !== "branded" &&
        String(p.source || "").toLowerCase() !== "branded_seed" &&
        !isBrandedQuery(p.text, brandAliases)
    )
    .map(mapDbPromptRow);

  if (existing.length >= target) {
    return { queries: existing.slice(0, target), newlyGenerated: [], promptKey };
  }

  const seen = new Set(existing.map((q) => queryTextKey(q.text)));
  const merged = [...existing];

  let attempts = 0;
  while (merged.length < target && attempts < MAX_SOURCING_ATTEMPTS) {
    attempts++;
    const shortfall = target - merged.length;
    const generated = await generate(brand, url, industry, stats, shortfall);
    for (const q of generated) {
      const key = queryTextKey(q.text);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(q);
      if (merged.length >= target) break;
    }
  }

  if (merged.length < target) {
    throw new Error(
      `Could only source ${merged.length}/${target} unique unbranded prompts for this scan.`
    );
  }

  return {
    queries: merged.slice(0, target),
    newlyGenerated: merged.slice(existing.length),
    promptKey,
  };
}

/**
 * Multi-engine background scan pipeline (unbranded-only).
 *
 * States:
 *   pending -> generating_prompts -> probing -> scoring -> complete | failed
 *
 * Probes Google AIO, ChatGPT, and/or Perplexity depending on ENGINES env.
 * Prompt generation + competitor extraction go through OpenRouter's free
 * model only (see llm.js) — no Gemini/paid fallback.
 */
export async function startScanJob(jobId, brand, url, industry, competitorsRaw) {
  const stats = { cost: 0.0, tokens: 0 };

  try {
    console.log(`[worker] Starting scan job ${jobId} for brand: ${brand}`);
    await updateScanJob(jobId, { status: "generating_prompts", progress_pct: 10 });

    const competitors = (competitorsRaw || "")
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean);

    const brandAliases = getBrandAliases(brand, url);

    // 1. Source the tracked unbranded set (reuse DB pool keyed by domain,
    //    top up additively via OpenRouter only when short of target).
    const { queries: unbrandedQueries, newlyGenerated, promptKey } = await sourceUnbrandedQueries(
      brand,
      url,
      industry,
      stats,
      brandAliases
    );

    // 1b. Add a small set of own-name seeds for the Brand Presence panel.
    const brandedQueries = buildBrandedQueries(brand, url).filter((q) => {
      const key = queryTextKey(q.text);
      return !unbrandedQueries.some((u) => queryTextKey(u.text) === key);
    });

    const queries = [...unbrandedQueries, ...brandedQueries];

    const toPersist = [
      ...newlyGenerated,
      ...brandedQueries,
    ];
    if (toPersist.length > 0) {
      try {
        await upsertPrompts(
          promptKey,
          toPersist.map((q) => ({
            text: q.text,
            intent_tier: q.intent_tier,
            topic: q.topic,
            weight: 1.0,
            source: q.source,
            enabled: true,
          }))
        );
      } catch (err) {
        console.warn("[worker] Failed to persist prompts:", err.message);
      }
    }

    console.log(
      `[worker] Prepared ${queries.length} queries ` +
        `(${unbrandedQueries.length} unbranded, ${brandedQueries.length} brand-presence)`
    );

    // 2. Probe each query. Use multi-engine path when >1 engine is enabled.
    await updateScanJob(jobId, { status: "probing", progress_pct: 25 });

    const enabledEngines = resolveEnabledEngines();
    const isMultiEngine = enabledEngines.length > 1;

    let scanOutput;
    if (isMultiEngine) {
      scanOutput = await runMultiEngineScan({
        brand,
        url,
        competitors,
        queries,
        stats,
        onProgress: async (done, total) => {
          const pct = 25 + Math.round((done / total) * 60); // 25% -> 85%
          await updateScanJob(jobId, { progress_pct: pct });
        },
      });
    } else {
      scanOutput = await runAioScan({
        brand,
        url,
        competitors,
        queries,
        stats,
        onProgress: async (done, total) => {
          const pct = 25 + Math.round((done / total) * 60); // 25% -> 85%
          await updateScanJob(jobId, { progress_pct: pct });
        },
      });
    }

    // 3. Scoring / aggregation
    await updateScanJob(jobId, { status: "scoring", progress_pct: 90 });

    let results, summary, engines, headline, visibilityIndexPct, enginesCounted;

    if (isMultiEngine) {
      const multiSummary = summarizeEngineResults(scanOutput);
      results = multiSummary.results;
      summary = multiSummary.summary;
      engines = multiSummary.engines;
      headline = multiSummary.headline;
      visibilityIndexPct = headline.visibility_index_pct;
      enginesCounted = headline.engines_counted;
    } else {
      results = scanOutput.results;
      summary = scanOutput.summary;
      engines = null;
      headline = null;
      visibilityIndexPct = null;
      enginesCounted = 0;
    }

    const scannedAt = new Date().toISOString();

    // Competitor extraction: feed union of all non-branded text + citations from all engines.
    // For multi-engine, rows have `text`/`citations` instead of `aio_text`/`aio_citations`.
    // Normalize both shapes for extractCompetitors.
    const normalizedForCompetitors = results
      .filter((r) => !r.is_branded_query)
      .map((r) => ({
        is_branded_query: false,
        aio_present: r.answer_present || r.aio_present || false,
        aio_text: r.text || r.aio_text || "",
        aio_citations: r.citations || r.aio_citations || [],
        aio_references: r.references || r.aio_references || [],
        visible: r.visible || false,
        engine: r.engine,
      }));

    const competitorObjects = await extractCompetitors({
      results: normalizedForCompetitors,
      brand,
      brandUrl: url,
      userCompetitors: competitors,
      stats,
      max: 10,
    });

    // Top domains: aggregate over the normalized non-branded rows so
    // aio_references is populated (raw multi-engine rows carry `references`,
    // not `aio_references` — aggregateAioTopDomains reads the latter).
    const topDomains = aggregateAioTopDomains(
      normalizedForCompetitors.filter((r) => r.aio_present),
      url,
      competitorObjects.map((c) => c.name)
    );

    console.log(
      `[worker] Competitors: ${competitorObjects
        .map((c) => `${c.name}(${c.visibilityScore}%/${c.source})`)
        .join(", ") || "(none)"}`
    );

    // Hash the unbranded set only, so the prompt-set identity is stable and
    // comparable across scans regardless of branded seeds.
    const promptTexts = unbrandedQueries.map((q) => q.text.toLowerCase().trim()).sort();
    const prompt_set_hash = crypto
      .createHash("sha256")
      .update(promptTexts.join("|"))
      .digest("hex");
    const prompt_set_id = prompt_set_hash.slice(0, 16);

    const platform = isMultiEngine ? "multi" : "google_ai_overview";
    const scoringVersion = isMultiEngine
      ? "v9-multi-engine"
      : "v8.1-aio-unbranded-plus-presence";

    const scanRecord = {
      brand,
      url,
      industry,
      platform,
      visibility_pct: summary.visibility_pct,
      share_of_ai_pct: summary.share_of_ai_pct,
      aio_coverage_pct: summary.aio_coverage_pct,
      presence_rate_pct: summary.presence_rate_pct,
      mention_rate_pct: summary.mention_rate_pct,
      prompts_tracked: unbrandedQueries.length,
      prompts_mentioned: summary.visible_non_branded,
      competitors: competitorObjects,
      competitors_raw: competitorsRaw,
      results,
      scanned_at: scannedAt,
      used_dynamic_prompts: true,
      tokens_used: stats.tokens || 0,
      cost_total: stats.cost || 0,
      scoring_version: scoringVersion,
      prompt_set_id,
      prompt_set_hash,
      brand_citation_share_pct: summary.citation_share_pct,
      branded_visibility_pct: summary.branded_visibility_pct,
      aio_error_rate_pct: summary.error_rate_pct,
      top_domains: topDomains,
      query_source: "openrouter_unbranded",
      data_source_issue: summary.data_source_issue,
      insufficient_sample: summary.insufficient_sample,
      summary_stats: summary,
    };

    // Multi-engine specific fields
    if (isMultiEngine) {
      scanRecord.engines = engines;
      scanRecord.visibility_index_pct = visibilityIndexPct;
      scanRecord.engines_counted = enginesCounted;
    }

    let savedScanId = null;
    try {
      const savedScan = await insertScan(scanRecord);
      savedScanId = savedScan?.[0]?.id || null;
    } catch (err) {
      console.error("[worker] Database insertScan failed:", err.message);
    }

    await updateScanJob(jobId, {
      status: "complete",
      progress_pct: 100,
      result_id: savedScanId,
      run_record: scanRecord,
    });

    console.log(
      `[worker] Scan ${jobId} complete. share_of_ai=${summary.share_of_ai_pct}%  coverage=${summary.aio_coverage_pct}%  presence=${summary.presence_rate_pct}%  data_source_issue=${summary.data_source_issue}` +
        (isMultiEngine ? `  visibility_index=${visibilityIndexPct}  engines_counted=${enginesCounted}` : "")
    );
  } catch (error) {
    console.error(`[worker] Scan job ${jobId} failed:`, error);
    await updateScanJob(jobId, {
      status: "failed",
      progress_pct: 100,
      error_message: error.message || "An unexpected error occurred during scan.",
    });
  }
}

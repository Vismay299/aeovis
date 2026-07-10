import crypto from "crypto";
import { insertScan, updateScanJob } from "../db.js";
import { buildAioQueries } from "../scoring/aioPrompts.js";
import {
  runAioScan,
  aggregateAioTopDomains,
  computeCompetitorAioMetrics,
} from "../scoring/aioPipeline.js";
import { getBrandAliases } from "../scoring/aliases.js";
import { getPromptsForBrand, upsertPrompts } from "../db/prompts.js";
import { extractBrandDomain } from "../scoring/citations.js";

/**
 * AIO-only background scan pipeline.
 *
 * States:
 *   pending -> generating_prompts -> probing -> scoring -> complete | failed
 *
 * Single source of truth: BrightData Google AI Overview.
 */
export async function startScanJob(jobId, brand, url, industry, competitorsRaw) {
  const stats = { cost: 0.0, tokens: 0 };

  try {
    console.log(`[aio-worker] Starting scan job ${jobId} for brand: ${brand}`);
    await updateScanJob(jobId, { status: "generating_prompts", progress_pct: 10 });

    const competitors = (competitorsRaw || "")
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean);

    const brandAliases = getBrandAliases(brand, url);

    // 1. Build the query list (PAA + Autocomplete seeded by category + few branded)
    let queryPlan;
    let usedDbPrompts = false;
    try {
      const dbPrompts = await getPromptsForBrand(brand, false);
      if (dbPrompts && dbPrompts.length > 0) {
        usedDbPrompts = true;
        console.log(`[aio-worker] Using ${dbPrompts.length} enabled prompts from DB`);
        queryPlan = {
          seeds: [],
          queries: dbPrompts.map((p) => ({
            text: p.text,
            source: p.source || "db",
            topic: p.topic || "General",
          })),
          nonBrandedCount: dbPrompts.length,
          brandedCount: 0,
        };
      }
    } catch (err) {
      console.warn("[aio-worker] DB prompt fetch failed:", err.message);
    }

    if (!queryPlan) {
      queryPlan = await buildAioQueries(brand, url, industry, stats);

      // Persist non-branded queries so users can enable/disable in Tracked Queries UI
      if (queryPlan.queries.length > 0) {
        try {
          await upsertPrompts(
            brand,
            queryPlan.queries.map((q) => ({
              text: q.text,
              intent_tier: "exploratory",
              topic: q.topic,
              weight: 1.0,
              source: q.source,
              enabled: true,
            }))
          );
        } catch (err) {
          console.warn("[aio-worker] Failed to persist prompts:", err.message);
        }
      }
    }

    if (!queryPlan.queries || queryPlan.queries.length === 0) {
      throw new Error("Could not source any queries for this scan. Check PAA/autocomplete access.");
    }

    console.log(
      `[aio-worker] Prepared ${queryPlan.queries.length} queries (${queryPlan.nonBrandedCount} non-branded, ${queryPlan.brandedCount} branded)`
    );

    // 2. Probe each query via BrightData AIO
    await updateScanJob(jobId, { status: "probing", progress_pct: 25 });

    const scanOutput = await runAioScan({
      brand,
      url,
      competitors,
      queries: queryPlan.queries,
      stats,
      onProgress: async (done, total) => {
        const pct = 25 + Math.round((done / total) * 60); // 25% -> 85%
        await updateScanJob(jobId, { progress_pct: pct });
      },
    });

    // 3. Scoring / aggregation
    await updateScanJob(jobId, { status: "scoring", progress_pct: 90 });

    const { results, summary } = scanOutput;

    // Attach brand-in-prompt warning to non-branded results just in case
    results.forEach((r) => {
      if (r.is_branded_query) {
        r.brand_in_prompt_warning = true;
      }
    });

    // Save a lightly-cleaned scan record. We keep both the raw AIO results
    // and pre-computed KPIs for the dashboard.
    const scannedAt = new Date().toISOString();

    const nonBrandedResults = results.filter((r) => !r.is_branded_query);
    const brandedResults = results.filter((r) => r.is_branded_query);

    const topDomains = aggregateAioTopDomains(nonBrandedResults, url, competitors);
    const competitorObjects = computeCompetitorAioMetrics(results, competitors).sort(
      (a, b) => b.visibilityScore - a.visibilityScore
    );

    const promptTexts = queryPlan.queries.map((q) => q.text.toLowerCase().trim()).sort();
    const prompt_set_hash = crypto
      .createHash("sha256")
      .update(promptTexts.join("|"))
      .digest("hex");
    const prompt_set_id = prompt_set_hash.slice(0, 16);

    const scanRecord = {
      brand,
      url,
      industry,
      platform: "google_ai_overview",
      visibility_pct: summary.visibility_pct,
      mention_rate_pct: summary.mention_rate_pct,
      prompts_tracked: summary.non_branded_queries,
      prompts_mentioned: summary.visible_non_branded,
      competitors: competitorObjects,
      competitors_raw: competitorsRaw,
      results,
      scanned_at: scannedAt,
      used_dynamic_prompts: !usedDbPrompts,
      tokens_used: stats.tokens || 0,
      cost_total: stats.cost || 0,
      scoring_version: "v7-aio-only",
      prompt_set_id,
      prompt_set_hash,
      brand_citation_share_pct: summary.citation_share_pct,
      branded_visibility_pct: summary.branded_visibility_pct,
      aio_coverage_pct: summary.aio_coverage_pct,
      aio_error_rate_pct: summary.error_rate_pct,
      top_domains: topDomains,
      seeds: queryPlan.seeds,
      query_source: "aio_paa_autocomplete",
      data_source_issue: summary.data_source_issue,
      insufficient_sample: summary.insufficient_sample,
      summary_stats: summary,
    };

    let savedScan = null;
    try {
      savedScan = await insertScan(scanRecord);
    } catch (err) {
      console.error("[aio-worker] Database insertScan failed:", err.message);
    }

    const resultId = savedScan?.[0]?.id || crypto.randomUUID();

    await updateScanJob(jobId, {
      status: "complete",
      progress_pct: 100,
      result_id: resultId,
      run_record: scanRecord,
    });

    console.log(
      `[aio-worker] Scan ${jobId} complete. visibility=${summary.visibility_pct}%  coverage=${summary.aio_coverage_pct}%  data_source_issue=${summary.data_source_issue}`
    );
  } catch (error) {
    console.error(`[aio-worker] Scan job ${jobId} failed:`, error);
    await updateScanJob(jobId, {
      status: "failed",
      progress_pct: 100,
      error_message: error.message || "An unexpected error occurred during scan.",
    });
  }
}

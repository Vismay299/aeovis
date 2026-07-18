import crypto from "crypto";
import { insertScan, updateScanJob } from "../db.js";
import { generateUnbrandedPrompts } from "../scoring/promptGen.js";
import { extractCompetitors } from "../scoring/competitorExtract.js";
import { runAioScan, aggregateAioTopDomains } from "../scoring/aioPipeline.js";
import { getPromptsForBrand, upsertPrompts } from "../db/prompts.js";

const MAX_SOURCING_ATTEMPTS = 3;

function queryTextKey(text) {
  return String(text || "").toLowerCase().trim();
}

/**
 * Reuses enabled DB prompts when there are already >=30, otherwise tops up
 * with freshly generated unbranded prompts until exactly 30 unique queries
 * are collected. Returns the full 30-query list plus only the newly
 * generated ones (so the caller persists just the delta).
 */
async function sourceUnbrandedQueries(brand, url, industry, stats) {
  let dbPrompts = [];
  try {
    dbPrompts = await getPromptsForBrand(brand, false);
  } catch (err) {
    console.warn("[aio-worker] DB prompt fetch failed:", err.message);
  }

  const existing = (dbPrompts || []).map((p) => ({
    text: p.text,
    source: p.source || "db",
    topic: p.topic || "General",
    intent_tier: p.intent_tier || "informational",
  }));

  if (existing.length >= 30) {
    return { queries: existing.slice(0, 30), newlyGenerated: [] };
  }

  const seen = new Set(existing.map((q) => queryTextKey(q.text)));
  const merged = [...existing];

  let attempts = 0;
  while (merged.length < 30 && attempts < MAX_SOURCING_ATTEMPTS) {
    attempts++;
    const shortfall = 30 - merged.length;
    const generated = await generateUnbrandedPrompts(brand, url, industry, stats, shortfall);
    for (const q of generated) {
      const key = queryTextKey(q.text);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(q);
      if (merged.length >= 30) break;
    }
  }

  if (merged.length < 30) {
    throw new Error(
      `Could only source ${merged.length}/30 unique unbranded prompts for this scan.`
    );
  }

  return { queries: merged.slice(0, 30), newlyGenerated: merged.slice(existing.length) };
}

/**
 * AIO-only background scan pipeline (unbranded-only).
 *
 * States:
 *   pending -> generating_prompts -> probing -> scoring -> complete | failed
 *
 * Single source of truth: BrightData Google AI Overview, India geo.
 * Prompt generation + competitor extraction go through OpenRouter's free
 * model only (see llm.js) — no Gemini/paid fallback.
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

    // 1. Source exactly 30 unbranded queries (reuse DB prompts, top up via OpenRouter).
    const { queries, newlyGenerated } = await sourceUnbrandedQueries(brand, url, industry, stats);

    if (newlyGenerated.length > 0) {
      try {
        await upsertPrompts(
          brand,
          newlyGenerated.map((q) => ({
            text: q.text,
            intent_tier: q.intent_tier,
            topic: q.topic,
            weight: 1.0,
            source: q.source,
            enabled: true,
          }))
        );
      } catch (err) {
        console.warn("[aio-worker] Failed to persist newly generated prompts:", err.message);
      }
    }

    console.log(`[aio-worker] Prepared ${queries.length} unbranded queries`);

    // 2. Probe each query via BrightData AIO (India geo).
    await updateScanJob(jobId, { status: "probing", progress_pct: 25 });

    const scanOutput = await runAioScan({
      brand,
      url,
      competitors: [],
      queries,
      stats,
      onProgress: async (done, total) => {
        const pct = 25 + Math.round((done / total) * 60); // 25% -> 85%
        await updateScanJob(jobId, { progress_pct: pct });
      },
    });

    // 3. Scoring / aggregation
    await updateScanJob(jobId, { status: "scoring", progress_pct: 90 });

    const { results, summary } = scanOutput;

    const scannedAt = new Date().toISOString();

    // One batched OpenRouter call over all non-branded AIO text + citations.
    const competitorObjects = await extractCompetitors({
      results,
      brand,
      brandUrl: url,
      userCompetitors: competitors,
      stats,
      max: 10,
    });
    const topDomains = aggregateAioTopDomains(
      results,
      url,
      competitorObjects.map((c) => c.name)
    );
    console.log(
      `[aio-worker] Competitors: ${competitorObjects
        .map((c) => `${c.name}(${c.visibilityScore}%/${c.source})`)
        .join(", ") || "(none)"}`
    );

    const promptTexts = queries.map((q) => q.text.toLowerCase().trim()).sort();
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
      share_of_ai_pct: summary.share_of_ai_pct,
      aio_coverage_pct: summary.aio_coverage_pct,
      presence_rate_pct: summary.presence_rate_pct,
      mention_rate_pct: summary.mention_rate_pct,
      prompts_tracked: queries.length,
      prompts_mentioned: summary.visible_non_branded,
      competitors: competitorObjects,
      competitors_raw: competitorsRaw,
      results,
      scanned_at: scannedAt,
      used_dynamic_prompts: true,
      tokens_used: stats.tokens || 0,
      cost_total: stats.cost || 0,
      scoring_version: "v8-aio-unbranded",
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

    let savedScanId = null;
    try {
      const savedScan = await insertScan(scanRecord);
      savedScanId = savedScan?.[0]?.id || null;
    } catch (err) {
      console.error("[aio-worker] Database insertScan failed:", err.message);
    }

    // Only set result_id when the scan row actually persisted, otherwise the
    // scan_jobs.result_id FK (references scans.id) is violated and the job
    // status update fails. If unpersisted, keep result_id null and rely on the
    // in-memory run_record fallback.
    await updateScanJob(jobId, {
      status: "complete",
      progress_pct: 100,
      result_id: savedScanId,
      run_record: scanRecord,
    });

    console.log(
      `[aio-worker] Scan ${jobId} complete. share_of_ai=${summary.share_of_ai_pct}%  coverage=${summary.aio_coverage_pct}%  presence=${summary.presence_rate_pct}%  data_source_issue=${summary.data_source_issue}`
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

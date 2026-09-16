import crypto from "crypto";
import { getScanJob, insertScan, updateScanJob } from "../db.js";
import { buildAioQueries } from "../scoring/aioPrompts.js";
import {
  buildBrandedQueries,
  dedupeQueriesByText,
  isBrandPresenceQuery,
  isBrandedQuery,
  resolveQueryIntentTier,
} from "../scoring/aioQueryClassify.js";
import {
  runAioScan,
  summarizeAioResults,
  aggregateAioTopDomains,
} from "../scoring/aioPipeline.js";
import {
  buildCompetitorLeaderboard,
  enrichResultsWithCompetitors,
} from "../scoring/coMentions.js";
import { getBrandAliases } from "../scoring/aliases.js";
import { getPromptsForBrand, upsertPrompts } from "../db/prompts.js";
import { extractBrandDomain } from "../scoring/citations.js";
import { getBrightDataConfig } from "../engines/brightdata.js";
import { AIO_PROBES_PER_INVOCATION } from "../scoring/aioConstants.js";

function queryTextKey(text) {
  return String(text || "").toLowerCase().trim();
}

/** Dedupe branded by lowercase text; skip seeds already present in non-branded list. */
function mergeQueryLists(nonBranded, branded) {
  const nonBrandedTexts = new Set(nonBranded.map((q) => queryTextKey(q.text)));
  const seenBranded = new Set();
  const brandedOnly = [];

  for (const q of branded) {
    const key = queryTextKey(q.text);
    if (!key || seenBranded.has(key) || nonBrandedTexts.has(key)) continue;
    seenBranded.add(key);
    brandedOnly.push(q);
  }

  return {
    queries: [...nonBranded, ...brandedOnly],
    nonBrandedCount: nonBranded.length,
    brandedCount: brandedOnly.length,
  };
}

function logQueryClassification(queries, brandAliases) {
  for (const q of queries) {
    console.log(
      `[aio-worker] query classify: text="${q.text}" is_branded_query=${isBrandedQuery(
        q.text,
        brandAliases
      )} source=${q.source || "unknown"} intent_tier=${q.intent_tier || "—"}`
    );
  }
}

function finalizeQueryPlan(queries, brandAliases, seeds = []) {
  const deduped = dedupeQueriesByText(queries).map((q) => ({
    ...q,
    intent_tier: resolveQueryIntentTier(q),
  }));
  return {
    seeds,
    queries: deduped,
    nonBrandedCount: deduped.filter((q) => !isBrandedQuery(q.text, brandAliases)).length,
    brandedCount: deduped.filter(isBrandPresenceQuery).length,
  };
}

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

    const existingJob = await getScanJob(jobId);
    if (existingJob?.status === "complete" || existingJob?.status === "failed") {
      console.log(`[aio-worker] Job ${jobId} already ${existingJob.status} — skip`);
      return;
    }

    // Soft lease so concurrent status polls don't double-probe the same batch.
    const leaseUntil = existingJob?.run_record?.worker_lease_until;
    if (leaseUntil && new Date(leaseUntil).getTime() > Date.now()) {
      console.log(
        `[aio-worker] Job ${jobId} lease held until ${leaseUntil} — skip`
      );
      return;
    }

    // Fail fast if Bright Data is not configured — avoids 100% SERP error rate
    // with a generic "data source issue" banner that hides the real cause.
    try {
      const bdConfig = await getBrightDataConfig();
      if (!bdConfig?.apiKey) {
        throw new Error(
          "Bright Data SERP is not configured (set BRIGHTDATA_API_KEY in the server environment)."
        );
      }
      console.log(
        `[aio-worker] Bright Data ready (zone=${bdConfig.zone || "unknown"})`
      );
    } catch (cfgErr) {
      const msg = cfgErr?.message || String(cfgErr);
      console.error(`[aio-worker] SERP preflight failed: ${msg}`);
      await updateScanJob(jobId, {
        status: "failed",
        progress_pct: 100,
        error_message: msg,
      });
      return;
    }

    const checkpoint = existingJob?.run_record?.checkpoint || null;
    const leaseMs = 55_000;
    const nextLease = new Date(Date.now() + leaseMs).toISOString();
    await updateScanJob(jobId, {
      run_record: {
        ...(existingJob?.run_record || {}),
        checkpoint,
        worker_lease_until: nextLease,
      },
    });

    const competitors = (competitorsRaw || "")
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean);

    const brandAliases = getBrandAliases(brand, url);

    // 1. Build the query list (PAA + Autocomplete seeded by category + few branded)
    //    Resume from checkpoint when a prior invocation already prepared queries.
    let queryPlan;
    let usedDbPrompts = false;
    let partialResults = Array.isArray(checkpoint?.partial_results)
      ? checkpoint.partial_results
      : [];

    if (checkpoint?.queries?.length) {
      queryPlan = {
        queries: checkpoint.queries,
        seeds: checkpoint.seeds || [],
        nonBrandedCount: checkpoint.nonBrandedCount ?? 0,
        brandedCount: checkpoint.brandedCount ?? 0,
      };
      usedDbPrompts = !!checkpoint.usedDbPrompts;
      stats.cost = Number(checkpoint.cost || 0);
      console.log(
        `[aio-worker] Resuming checkpoint: ${partialResults.length}/${queryPlan.queries.length} probed`
      );
    } else {
    await updateScanJob(jobId, { status: "generating_prompts", progress_pct: 10 });
    try {
      const dbPrompts = await getPromptsForBrand(brand, false);
      if (dbPrompts && dbPrompts.length > 0) {
        usedDbPrompts = true;
        console.log(`[aio-worker] Using ${dbPrompts.length} enabled prompts from DB`);
        const mapped = dbPrompts.map((p) => ({
          text: p.text,
          source: p.source || "db",
          topic: p.topic || "General",
          intent_tier: p.intent_tier,
        }));
        const existingTexts = new Set(mapped.map((q) => queryTextKey(q.text)));

        let brandPresence = mapped.filter(isBrandPresenceQuery);
        let injectedBranded = [];
        if (brandPresence.length === 0) {
          injectedBranded = buildBrandedQueries(brand, url)
            .filter((q) => !existingTexts.has(queryTextKey(q.text)))
            .map((q) => ({ ...q, intent_tier: "branded" }));
          if (injectedBranded.length > 0) {
            brandPresence = injectedBranded;
            try {
              await upsertPrompts(
                brand,
                injectedBranded.map((q) => ({
                  text: q.text,
                  intent_tier: "branded",
                  topic: q.topic,
                  weight: 1.0,
                  source: q.source,
                  enabled: true,
                }))
              );
            } catch (err) {
              console.warn("[aio-worker] Failed to persist injected branded seeds:", err.message);
            }
          }
        } else if (brandPresence.some((q) => q.intent_tier !== "branded")) {
          try {
            await upsertPrompts(
              brand,
              brandPresence.map((q) => ({
                text: q.text,
                intent_tier: "branded",
                topic: q.topic,
                weight: 1.0,
                source: q.source,
                enabled: true,
              }))
            );
          } catch (err) {
            console.warn("[aio-worker] Failed to fix branded intent_tier:", err.message);
          }
        }

        queryPlan = finalizeQueryPlan(
          [...mapped, ...injectedBranded],
          brandAliases
        );
      }
    } catch (err) {
      console.warn("[aio-worker] DB prompt fetch failed:", err.message);
    }

    if (!queryPlan) {
      queryPlan = await buildAioQueries(brand, url, industry, stats);

      // Persist queries for Tracked Queries UI (intent_tier = brand presence only for seeds)
      if (queryPlan.queries.length > 0) {
        try {
          await upsertPrompts(
            brand,
            queryPlan.queries.map((q) => ({
              text: q.text,
              intent_tier: resolveQueryIntentTier(q),
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

    if (!usedDbPrompts) {
      const { nonBranded, branded } = queryPlan.queries.reduce(
        (acc, q) => {
          if (isBrandedQuery(q.text, brandAliases)) acc.branded.push(q);
          else acc.nonBranded.push(q);
          return acc;
        },
        { nonBranded: [], branded: [] }
      );
      const merged = mergeQueryLists(nonBranded, branded);
      queryPlan = finalizeQueryPlan(
        merged.queries,
        brandAliases,
        queryPlan.seeds
      );
    } else {
      queryPlan = finalizeQueryPlan(
        queryPlan.queries,
        brandAliases,
        queryPlan.seeds
      );
    }

    logQueryClassification(queryPlan.queries, brandAliases);

    console.log(
      `[aio-worker] Prepared ${queryPlan.queries.length} queries (${queryPlan.nonBrandedCount} non-branded, ${queryPlan.brandedCount} brand-presence)`
    );
    } // end else (fresh query plan)

    const buildCheckpoint = (results) => ({
      checkpoint: {
        queries: queryPlan.queries,
        seeds: queryPlan.seeds || [],
        nonBrandedCount: queryPlan.nonBrandedCount,
        brandedCount: queryPlan.brandedCount,
        usedDbPrompts,
        partial_results: results,
        cost: stats.cost || 0,
        brand,
        url,
        industry,
        competitorsRaw,
      },
      // Keep lease while we still have work so other polls don't pile on.
      worker_lease_until: new Date(Date.now() + leaseMs).toISOString(),
    });

    // Persist query plan immediately so a mid-batch kill can still resume.
    await updateScanJob(jobId, {
      status: "probing",
      progress_pct: Math.max(
        25,
        25 + Math.round((partialResults.length / Math.max(queryPlan.queries.length, 1)) * 60)
      ),
      run_record: buildCheckpoint(partialResults),
    });

    // 2. Probe via BrightData AIO in batches so Hobby-plan 60s limits can resume.
    const doneKeys = new Set(
      partialResults.map((r) => queryTextKey(r.prompt || r.text || ""))
    );
    const remaining = queryPlan.queries.filter(
      (q) => !doneKeys.has(queryTextKey(q.text))
    );
    const batch = remaining.slice(0, AIO_PROBES_PER_INVOCATION);

    if (batch.length > 0) {
      console.log(
        `[aio-worker] Probing batch of ${batch.length} (${partialResults.length} done, ${remaining.length} remaining)`
      );
      const batchOutput = await runAioScan({
        brand,
        url,
        competitors,
        queries: batch,
        stats,
        onProgress: async (done, total, lastResult) => {
          // lastResult optional — progress only
          const totalDone = partialResults.length + done;
          const pct =
            25 + Math.round((totalDone / queryPlan.queries.length) * 60);
          await updateScanJob(jobId, { progress_pct: Math.min(pct, 85) });
        },
      });
      partialResults = [...partialResults, ...batchOutput.results];
      await updateScanJob(jobId, {
        status: "probing",
        progress_pct: Math.min(
          25 + Math.round((partialResults.length / queryPlan.queries.length) * 60),
          85
        ),
        run_record: buildCheckpoint(partialResults),
      });
    }

    const stillRemaining = queryPlan.queries.length - partialResults.length;
    if (stillRemaining > 0) {
      console.log(
        `[aio-worker] Checkpoint saved — ${partialResults.length}/${queryPlan.queries.length}. Resume via status poll or cron.`
      );
      return;
    }

    // 3. Scoring / aggregation (all queries probed)
    await updateScanJob(jobId, { status: "scoring", progress_pct: 90 });

    let { results, summary } = summarizeAioResults(partialResults);

    // Never publish a "complete" scan when every probe failed due to missing config —
    // that overwrites a good dashboard with a false data-source banner.
    const configFail =
      summary.config_missing ||
      (summary.sample_errors || []).some((e) =>
        /not configured|BRIGHTDATA_API_KEY/i.test(String(e))
      );
    if (configFail && (summary.error_rate_pct || 0) >= 50) {
      const msg =
        (summary.sample_errors && summary.sample_errors[0]) ||
        "Bright Data SERP is not configured (set BRIGHTDATA_API_KEY on the server).";
      console.error(`[aio-worker] Refusing to save scan — config failure: ${msg}`);
      await updateScanJob(jobId, {
        status: "failed",
        progress_pct: 100,
        error_message: msg,
        run_record: { checkpoint: null, summary_stats: summary, results },
      });
      return;
    }

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

    // Blank-style: discover co-mentioned rivals from AIO text + citations,
    // then merge with any user-supplied competitor names.
    const competitorObjects = buildCompetitorLeaderboard({
      results,
      brand,
      brandUrl: url,
      userCompetitors: competitors,
      max: 10,
    });
    const competitorNames = competitorObjects.map((c) => c.name);
    results = enrichResultsWithCompetitors(results, competitorNames);

    const topDomains = aggregateAioTopDomains(nonBrandedResults, url, competitorNames);
    console.log(
      `[aio-worker] Co-mention competitors: ${competitorObjects
        .map((c) => `${c.name}(${c.visibilityScore}%/${c.source})`)
        .join(", ") || "(none)"}`
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
      sample_errors: summary.sample_errors || [],
      config_missing: !!summary.config_missing,
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

import { INDUSTRY_PROMPTS } from "../../data/industries.js";
import { insertScan, updateScanJob } from "../db.js";
import { generatePromptsForBrand } from "../prompts.js";
import {
  computeVisibilityScore,
  computeScanStats,
  computeIntentBreakdown,
  computeTopicScores,
  computeShareOfVoice,
  computeWinRate,
  computeCompetitorVisibility,
  computeGapScores,
  computeBrandCitationShare,
  computeCompetitorCitationShare,
  aggregateTopDomains
} from "../scoring/computeVisibilityScore.js";
import { SCORING_VERSION, SCORING_VERSION_HYBRID, PROBE_RUNS, INTENT_WEIGHTS } from "../scoring/constants.js";
import { normalizeTopic } from "../scoring/topics.js";
import { probePromptMultiple } from "../scoring/probe.js";
import { aggregateMultiEnginePromptRuns } from "../scoring/aggregate.js";
import { getPromptsForBrand, upsertPrompts } from "../db/prompts.js";
import { CONTROL_PROMPTS } from "../scoring/controlPrompts.js";
import { getBrandAliases } from "../scoring/aliases.js";
import { fetchPeopleAlsoAsk, fetchAutocomplete } from "../engines/serp.js";
import crypto from "crypto";

function mapDbPrompt(p) {
  return {
    id: p.id,
    text: p.text,
    intent_tier: p.intent_tier,
    topic: normalizeTopic(p.topic || "General"),
    weight: p.weight,
    source: p.source || "llm_generated",
  };
}

/**
 * Background worker executing the full scanning pipeline asynchronously.
 * 
 * State transitions:
 * pending -> generating_prompts -> probing -> analyzing -> scoring -> complete | failed
 */
export async function startScanJob(jobId, brand, url, industry, competitorsRaw, querySource = "llm_generated", gscQueries = []) {
  const stats = { tokens: 0 };
  
  try {
    console.log(`[worker] Starting scan job ${jobId} for brand: ${brand} (strategy: ${querySource})`);
    
    // State 1: generating_prompts (10% progress)
    await updateScanJob(jobId, { status: "generating_prompts", progress_pct: 10 });

    const hasValidIndustry = !!INDUSTRY_PROMPTS[industry];
    const competitors = competitorsRaw
      ? competitorsRaw.split(",").map(c => c.trim()).filter(Boolean)
      : [];

    let prompts = [];
    let loadedFromDb = false;
    let usedDynamicPrompts = false;

    // 1. Google Search Console Upload Sourcing
    if (querySource === "google_search_console" && Array.isArray(gscQueries) && gscQueries.length > 0) {
      console.log(`[worker] Sourcing prompts from GSC upload: ${gscQueries.length} queries`);
      prompts = gscQueries.slice(0, 20).map((q, idx) => ({
        text: q,
        intent_tier: "exploratory",
        topic: "Search Console",
        weight: 1.0,
        source: "gsc"
      }));
    }
    // 2. People Also Ask Sourcing
    else if (querySource === "people_also_ask") {
      console.log(`[worker] Sourcing prompts from People Also Ask`);
      const seedTerms = [brand, url, industry].filter(Boolean);
      try {
        const questions = await fetchPeopleAlsoAsk(seedTerms);
        if (questions && questions.length > 0) {
          prompts = questions.slice(0, 20).map(q => ({
            text: q,
            intent_tier: "exploratory",
            topic: "People Also Ask",
            weight: 1.0,
            source: "paa"
          }));
        }
      } catch (err) {
        console.warn("[worker] Failed to fetch PAA questions:", err.message);
      }
    }
    // 3. Search Autocomplete Sourcing
    else if (querySource === "search_autocomplete") {
      console.log(`[worker] Sourcing prompts from Google Autocomplete`);
      try {
        const suggestions = await fetchAutocomplete(brand);
        if (suggestions && suggestions.length > 0) {
          prompts = suggestions.slice(0, 20).map(q => ({
            text: q,
            intent_tier: "exploratory",
            topic: "Autocomplete",
            weight: 1.0,
            source: "autocomplete"
          }));
        }
      } catch (err) {
        console.warn("[worker] Failed to fetch autocomplete suggestions:", err.message);
      }
    }

    // Save non-LLM prompts to DB for persistence and management
    if (prompts.length > 0 && querySource !== "llm_generated") {
      try {
        await upsertPrompts(brand, prompts);
        const dbPrompts = await getPromptsForBrand(brand);
        if (dbPrompts && dbPrompts.length > 0) {
          prompts = dbPrompts.map(mapDbPrompt);
        }
      } catch (e) {
        console.warn("[worker] Failed to persist sourced prompts:", e.message);
      }
    }

    // 4. Default / Fallback: Load from DB or dynamically generate via LLM
    if (prompts.length === 0) {
      console.log("[worker] Sourcing prompts via standard LLM generation / DB cache");
      try {
        const allDbPrompts = await getPromptsForBrand(brand, true);
        if (allDbPrompts && allDbPrompts.length > 0) {
          loadedFromDb = true;
          const enabledDbPrompts = allDbPrompts.filter(p => p.enabled);
          
          if (enabledDbPrompts.length === 0) {
            throw new Error("All tracked queries are disabled. Please enable at least one query in Tracked Queries.");
          }

          console.log(`[worker] Loaded ${enabledDbPrompts.length} enabled prompts from database`);
          prompts = enabledDbPrompts.map(mapDbPrompt);

          // Top up if under 15
          if (prompts.length < 15) {
            console.log(`[worker] Prompt count (${prompts.length}) below minimum (15). Topping up...`);
            const generated = await generatePromptsForBrand(brand, url, industry, stats);
            if (generated && generated.length > 0) {
              const existingTexts = new Set(allDbPrompts.map(p => p.text.toLowerCase().trim()));
              const newPrompts = generated.filter(p => !existingTexts.has(p.text.toLowerCase().trim()));
              
              const needed = 15 - prompts.length;
              const topUpPrompts = newPrompts.slice(0, needed).map(p => ({ ...p, source: p.source || "llm_generated" }));
              
              if (topUpPrompts.length > 0) {
                await upsertPrompts(brand, topUpPrompts);
                const reloaded = await getPromptsForBrand(brand, false);
                prompts = reloaded.map(mapDbPrompt);
              }
            }
          }
        }
      } catch (e) {
        console.warn("[worker] DB query loading error, will generate prompts:", e.message);
      }

      if (!loadedFromDb && prompts.length === 0) {
        let generated = await generatePromptsForBrand(brand, url, industry, stats);
        if (generated && generated.length > 0) {
          generated = generated.map(p => ({ ...p, source: "llm_generated" }));

          // P13-S03: Fetch PAA questions and blend 5-10 of them into the dynamic pool
          try {
            const seedTerms = [brand, url, industry].filter(Boolean);
            const paaQuestions = await fetchPeopleAlsoAsk(seedTerms);
            if (paaQuestions && paaQuestions.length > 0) {
              console.log(`[worker] Blending ${Math.min(10, paaQuestions.length)} PAA queries into LLM dynamic prompt pool`);
              const paaPrompts = paaQuestions.slice(0, 10).map(q => ({
                text: q,
                intent_tier: "exploratory",
                topic: "People Also Ask",
                weight: 1.0,
                source: "paa"
              }));
              generated = [...paaPrompts, ...generated].slice(0, 20);
            }
          } catch (paaErr) {
            console.warn("[worker] PAA blending failed, proceeding with LLM queries only:", paaErr.message);
          }

          prompts = generated;
          usedDynamicPrompts = true;

          try {
            await upsertPrompts(brand, prompts);
            const dbPrompts = await getPromptsForBrand(brand);
            if (dbPrompts && dbPrompts.length > 0) {
              prompts = dbPrompts.map(mapDbPrompt);
            }
          } catch (e) {
            console.warn("[worker] Failed to persist generated prompts:", e.message);
          }
        } else {
          if (hasValidIndustry) {
            console.log("[worker] Fallback to static industry prompts");
            prompts = INDUSTRY_PROMPTS[industry].prompts.map(p => ({
              text: p,
              intent_tier: "exploratory",
              topic: "General",
              weight: null,
            }));

            try {
              await upsertPrompts(brand, prompts);
              const dbPrompts = await getPromptsForBrand(brand);
              if (dbPrompts && dbPrompts.length > 0) {
                prompts = dbPrompts.map(mapDbPrompt);
              }
            } catch (e) {
              console.warn("[worker] Failed to persist static fallback prompts:", e.message);
            }
          } else {
            throw new Error("No dynamic prompts generated and no valid industry for fallback.");
          }
        }
      }
    }

    // State 2: probing (30% progress)
    await updateScanJob(jobId, { status: "probing", progress_pct: 30 });

    const augmentedPrompts = [
      ...prompts.map(p => ({ ...p, is_control: false })),
      ...CONTROL_PROMPTS.map((cp, idx) => ({
        id: `control-${idx}`,
        text: cp.text,
        intent_tier: "branded",
        topic: "Control",
        is_control: true,
        expected_mention: cp.expectedMention
      }))
    ];

    const results = [];
    const chunkSize = 5;
    const totalChunks = Math.ceil(augmentedPrompts.length / chunkSize);

    for (let chunkIdx = 0; chunkIdx < totalChunks; chunkIdx++) {
      const chunk = augmentedPrompts.slice(chunkIdx * chunkSize, (chunkIdx + 1) * chunkSize);
      
      const chunkPromises = chunk.map(async (promptObj) => {
        const compList = promptObj.is_control ? [] : competitors;
        const brandToUse = promptObj.is_control ? promptObj.expected_mention : brand;

        const runs = await probePromptMultiple(promptObj.text, brandToUse, compList, url, stats, PROBE_RUNS);
        const agg = aggregateMultiEnginePromptRuns(runs);
        if (agg) {
          agg.intent_tier = promptObj.intent_tier;
          agg.topic = promptObj.topic;
          agg.weight = promptObj.weight;
          agg.is_control = promptObj.is_control;
          agg.expected_mention = promptObj.expected_mention;
        }
        return agg;
      });

      const chunkResults = await Promise.all(chunkPromises);
      for (const res of chunkResults) {
        if (res) {
          results.push(res);
        }
      }

      // Update probing progress incrementally (30% to 80% range)
      const currentProgress = 30 + Math.round(((chunkIdx + 1) / totalChunks) * 50);
      await updateScanJob(jobId, { progress_pct: currentProgress });
    }

    // State 3: analyzing (80% progress)
    await updateScanJob(jobId, { status: "analyzing", progress_pct: 80 });

    const controlResults = results.filter(r => r.is_control);
    const brandResults = results.filter(r => !r.is_control);

    // Brand injection warning check
    const brandAliases = getBrandAliases(brand, url);
    brandResults.forEach(r => {
      if (r.intent_tier !== "branded") {
        const promptLower = r.prompt.toLowerCase();
        const hasBrandAlias = brandAliases.some(alias => {
          const cleanAlias = alias.toLowerCase();
          const escaped = cleanAlias.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
          const regex = new RegExp(`(?:^|[^a-zA-Z0-9_])${escaped}(?:$|[^a-zA-Z0-9_])`, "i");
          return regex.test(promptLower);
        });
        if (hasBrandAlias) {
          r.brand_in_prompt_warning = true;
        }
      }
    });

    // Judge disagreement count
    const judgeDisagreementCount = results.reduce((sum, r) => {
      const runsCount = (r.run_details || []).filter(run => run.judge_disagreement).length;
      return sum + runsCount;
    }, 0);

    const promptsTracked = brandResults.length;
    const visibilityPct = computeVisibilityScore(brandResults, url);
    const promptsMentioned = brandResults.filter(r => r.mentioned).length;
    const mentionRatePct = promptsTracked
      ? Math.round((promptsMentioned / promptsTracked) * 1000) / 10
      : 0.0;

    // Quality gates checks
    const controlPromptsPassed = controlResults.filter(r => r.control_passed).length;
    const controlPromptsTotal = controlResults.length;
    const controlPassed = controlPromptsTotal > 0 ? (controlPromptsPassed === controlPromptsTotal) : true;

    const brandRuns = brandResults.flatMap(r => r.run_details || []);
    const failedProbes = brandRuns.filter(run => {
      const isFailed = run.model_used?.endsWith("-failed");
      const isEmpty = !run.raw_response?.trim();
      const isSkipped = run.model_used?.includes("skipped");
      return isFailed || (isEmpty && !isSkipped);
    }).length;
    const probeFailureRate = brandRuns.length > 0 ? failedProbes / brandRuns.length : 0.0;

    const qualityGateFailed = !controlPassed || probeFailureRate > 0.20;

    // State 4: scoring (90% progress)
    await updateScanJob(jobId, { status: "scoring", progress_pct: 90 });

    const judgeStats = {
      deterministic: results.reduce((sum, r) => sum + (r.run_details || []).filter(run => run.judge_method === "deterministic").length, 0),
      llm: results.reduce((sum, r) => sum + (r.run_details || []).filter(run => run.judge_method === "llm").length, 0),
      fallback: results.reduce((sum, r) => sum + (r.run_details || []).filter(run => run.judge_method === "fallback").length, 0),
      skipped: results.reduce((sum, r) => sum + (r.run_details || []).filter(run => run.judge_method === "skipped").length, 0),
    };

    computeGapScores(brandResults, competitors);
    const shareOfVoicePct = computeShareOfVoice(brandResults);
    const winRatePct = computeWinRate(brandResults, competitors);

    const brandCitationSharePct = computeBrandCitationShare(brandResults, url);
    const topDomains = aggregateTopDomains(brandResults, url, competitors);

    const enginesAvailable = brandResults.reduce((acc, r) => {
      (r.run_details || []).forEach(run => {
        if (run.engine && !run.model_used?.includes("skipped")) {
          acc.add(run.engine);
        }
      });
      return acc;
    }, new Set());
    const enginesPartial = enginesAvailable.size > 0 && enginesAvailable.size < 4;

    const engineScores = {};
    enginesAvailable.forEach(eng => {
      let totalScore = 0.0;
      let totalWeight = 0.0;
      brandResults.forEach(r => {
        const tier = r.intent_tier || "exploratory";
        const weight = r.weight ?? INTENT_WEIGHTS[tier] ?? 1.0;
        const enginePromptScore = r.engine_scores?.[eng] ?? 0.0;
        totalScore += enginePromptScore * weight;
        totalWeight += weight;
      });
      engineScores[eng] = totalWeight > 0 ? Math.round((totalScore / totalWeight) * 10) / 10 : 0.0;
    });

    const costByEngine = {};
    const activeVersion = brandResults.some(r => (r.run_details || []).some(run => run.engine === "google_ai_overview"))
      ? SCORING_VERSION_HYBRID
      : SCORING_VERSION;

    const probeSources = Array.from(enginesAvailable);

    // Cost calculations
    brandResults.forEach(r => {
      (r.run_details || []).forEach(run => {
        if (!run.engine) return;
        const cost = run.cost || 0;
        costByEngine[run.engine] = (costByEngine[run.engine] || 0) + cost;
      });
    });

    const googleOverviewRuns = brandResults.flatMap(r => (r.run_details || []).filter(run => run.engine === "google_ai_overview"));
    const serpCoveragePct = googleOverviewRuns.length > 0
      ? Math.round((googleOverviewRuns.filter(run => !run.model_used?.endsWith("-failed") && run.raw_response?.trim()).length / googleOverviewRuns.length) * 100)
      : null;

    const competitorObjects = competitors.map(comp => {
      let mentions = 0;
      let userAbsent = 0;
      brandResults.forEach(r => {
        const found = (r.competitors_found || []).some(c => c.toLowerCase() === comp.toLowerCase());
        if (found) {
          mentions++;
          if (!r.mentioned) {
            userAbsent++;
          }
        }
      });
      return {
        name: comp,
        mentions,
        prompts: mentions,
        userAbsent: userAbsent > 0,
        visibilityScore: computeCompetitorVisibility(brandResults, comp),
        citationShare: Math.round(computeCompetitorCitationShare(brandResults, comp) * 10) / 10
      };
    });
    competitorObjects.sort((a, b) => b.visibilityScore - a.visibilityScore);

    const scanStats = computeScanStats(brandResults, visibilityPct, industry);
    const intentBreakdown = computeIntentBreakdown(brandResults, url);
    const topicScores = computeTopicScores(brandResults, url);
    const scannedAt = new Date().toISOString();

    const promptTexts = prompts.map(p => p.text.toLowerCase().trim()).sort();
    const prompt_set_hash = crypto.createHash("sha256").update(promptTexts.join("|")).digest("hex");
    const prompt_set_id = prompt_set_hash.slice(0, 16);

    // Save scan
    const scanRecord = {
      brand,
      url,
      industry,
      platform: probeSources.join(", ") || "gemini",
      visibility_pct: visibilityPct,
      mention_rate_pct: mentionRatePct,
      prompts_tracked: promptsTracked,
      prompts_mentioned: promptsMentioned,
      competitors: competitorObjects,
      competitors_raw: competitorsRaw,
      results,
      scanned_at: scannedAt,
      used_dynamic_prompts: usedDynamicPrompts || loadedFromDb,
      tokens_used: stats.tokens,
      scoring_version: activeVersion,
      judge_stats: judgeStats,
      score_ci_low: scanStats.score_ci_low,
      score_ci_high: scanStats.score_ci_high,
      stability: scanStats.stability,
      sample_size_adequacy: scanStats.sample_size_adequacy,
      prompt_set_id,
      prompt_set_hash,
      intent_breakdown: intentBreakdown,
      topic_scores: topicScores,
      share_of_voice_pct: shareOfVoicePct,
      win_rate_pct: winRatePct,
      brand_citation_share_pct: brandCitationSharePct,
      top_domains: topDomains,
      engine_scores: engineScores,
      cost_by_engine: costByEngine,
      engines_partial: enginesPartial,
      serp_coverage_pct: serpCoveragePct,
      probe_sources: probeSources,
      quality_gate_failed: qualityGateFailed,
      probe_failure_rate: probeFailureRate,
      judge_disagreement_count: judgeDisagreementCount,
      control_prompts_passed: controlPromptsPassed,
      control_prompts_total: controlPromptsTotal,
      query_source: querySource
    };

    let savedScan = null;
    try {
      savedScan = await insertScan(scanRecord);
    } catch (e) {
      console.error("[worker] Database insertScan failed:", e.message);
    }

    // State 5: complete (100% progress)
    // Extract the saved ID from database response or mock it
    const resultId = savedScan && savedScan[0]?.id ? savedScan[0].id : crypto.randomUUID();
    
    // P11-S08: Store immutable run record in scan_jobs
    await updateScanJob(jobId, {
      status: "complete",
      progress_pct: 100,
      result_id: resultId,
      // Store the final scan data inside scan_jobs as run snapshot
      run_record: scanRecord
    });
    
    console.log(`[worker] Scan job ${jobId} complete! Result ID: ${resultId}`);
  } catch (error) {
    console.error(`[worker] Scan job ${jobId} failed:`, error);
    await updateScanJob(jobId, {
      status: "failed",
      progress_pct: 100,
      error_message: error.message || "An unexpected error occurred during scan."
    });
  }
}

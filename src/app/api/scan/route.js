import { NextResponse } from "next/server";
import { INDUSTRY_PROMPTS } from "@/data/industries";
import { insertScan } from "@/lib/db";
import { generatePromptsForBrand } from "@/lib/prompts";
import { computeVisibilityScore, computeScanStats, computeIntentBreakdown, computeTopicScores, computeShareOfVoice, computeWinRate, computeCompetitorVisibility, computeGapScores } from "@/lib/scoring/computeVisibilityScore";
import { SCORING_VERSION, PROBE_RUNS } from "@/lib/scoring/constants";
import { normalizeTopic } from "@/lib/scoring/topics";
import { probePromptMultiple } from "@/lib/scoring/probe";
import { aggregatePromptRuns } from "@/lib/scoring/aggregate";
import { getPromptsForBrand, upsertPrompts } from "@/lib/db/prompts";
import crypto from "crypto";

export async function POST(request) {
  try {
    const payload = await request.json();
    const stats = { tokens: 0 };
    const brand = (payload.brand || "").trim();
    const url = (payload.url || "").trim();
    const industry = (payload.industry || "").trim();
    const competitorsRaw = payload.competitors || "";

    if (!brand) {
      return NextResponse.json({ detail: "Brand name is required." }, { status: 400 });
    }
    const hasValidIndustry = !!INDUSTRY_PROMPTS[industry];

    const competitors = competitorsRaw
      ? competitorsRaw.split(",").map(c => c.trim()).filter(Boolean)
      : [];

    // P3-S07: Load existing prompts before generating new ones (count > 0 instead of >= 15)
    let prompts = [];
    let loadedFromDb = false;
    try {
      const allDbPrompts = await getPromptsForBrand(brand, true);
      if (allDbPrompts && allDbPrompts.length > 0) {
        loadedFromDb = true;
        const enabledDbPrompts = allDbPrompts.filter(p => p.enabled);
        
        if (enabledDbPrompts.length === 0) {
          return NextResponse.json({ detail: "All tracked queries are disabled. Please enable at least one query in Tracked Queries." }, { status: 400 });
        }

        console.log(`Loaded ${enabledDbPrompts.length} enabled prompts from database for brand: ${brand}`);
        prompts = enabledDbPrompts.map(p => ({
          id: p.id,
          text: p.text,
          intent_tier: p.intent_tier,
          topic: normalizeTopic(p.topic || "General"),
          weight: p.weight,
        }));

        // Optionally top up if below 15
        if (prompts.length < 15) {
          console.log(`Prompt count (${prompts.length}) below minimum (15). Topping up...`);
          const generated = await generatePromptsForBrand(brand, url, industry, stats);
          if (generated && generated.length > 0) {
            const existingTexts = new Set(allDbPrompts.map(p => p.text.toLowerCase().trim()));
            const newPrompts = generated.filter(p => !existingTexts.has(p.text.toLowerCase().trim()));
            
            const needed = 15 - prompts.length;
            const topUpPrompts = newPrompts.slice(0, needed);
            
            if (topUpPrompts.length > 0) {
              try {
                await upsertPrompts(brand, topUpPrompts);
                // Reload from DB to get the new list of enabled prompts
                const reloaded = await getPromptsForBrand(brand, false);
                prompts = reloaded.map(p => ({
                  id: p.id,
                  text: p.text,
                  intent_tier: p.intent_tier,
                  topic: normalizeTopic(p.topic || "General"),
                  weight: p.weight,
                }));
              } catch (e) {
                console.warn("Failed to persist top-up prompts:", e.message);
              }
            }
          }
        }
      }
    } catch (e) {
      console.warn("Error loading prompts from DB:", e.message);
    }

    let usedDynamicPrompts = false;
    if (!loadedFromDb) {
      // Generate prompts
      const generated = await generatePromptsForBrand(brand, url, industry, stats);
      if (generated && generated.length > 0) {
        prompts = generated;
        usedDynamicPrompts = true;

        // P3-S06: Save generated prompts to brand_prompts
        try {
          await upsertPrompts(brand, prompts);
          // Reload from DB to get the generated IDs
          const dbPrompts = await getPromptsForBrand(brand);
          if (dbPrompts && dbPrompts.length > 0) {
            prompts = dbPrompts.map(p => ({
              id: p.id,
              text: p.text,
              intent_tier: p.intent_tier,
              topic: normalizeTopic(p.topic || "General"),
              weight: p.weight,
            }));
          }
        } catch (e) {
          console.warn("Failed to persist generated prompts to DB:", e.message);
        }
      } else {
        // Fallback to static industry prompts
        if (hasValidIndustry) {
          console.log("Fallback to static industry prompts");
          prompts = INDUSTRY_PROMPTS[industry].prompts.map(p => ({
            text: p,
            intent_tier: "exploratory",
            topic: "General",
            weight: null,
          }));

          // P3-Nit: Persist fallback static prompts to brand_prompts so they are persistent
          try {
            await upsertPrompts(brand, prompts);
            const dbPrompts = await getPromptsForBrand(brand);
            if (dbPrompts && dbPrompts.length > 0) {
              prompts = dbPrompts.map(p => ({
                id: p.id,
                text: p.text,
                intent_tier: p.intent_tier,
                topic: normalizeTopic(p.topic || "General"),
                weight: p.weight,
              }));
            }
          } catch (e) {
            console.warn("Failed to persist static prompts to DB:", e.message);
          }
        } else {
          console.warn("No dynamic prompts generated and no valid industry for fallback");
          prompts = [];
        }
      }
    }

    console.log(`[scan] Used dynamic prompts: ${usedDynamicPrompts} (${prompts.length} prompts)`);

    const results = [];

    // Batch processing to reduce latency
    const chunkSize = 5;
    for (let i = 0; i < prompts.length; i += chunkSize) {
      const chunk = prompts.slice(i, i + chunkSize);
      
      const chunkPromises = chunk.map(async (promptObj) => {
        // Run prompt multiple times and aggregate
        const runs = await probePromptMultiple(promptObj.text, brand, competitors, url, stats, PROBE_RUNS);
        const agg = aggregatePromptRuns(runs);
        if (agg) {
          agg.intent_tier = promptObj.intent_tier;
          agg.topic = promptObj.topic;
          agg.weight = promptObj.weight;
        }
        return agg;
      });

      const chunkResults = await Promise.all(chunkPromises);
      for (const result of chunkResults) {
        if (result) {
          results.push(result);
        }
      }
    }

    const promptsTracked = prompts.length;
    const visibilityPct = computeVisibilityScore(results, url);
    const promptsMentioned = results.filter(r => r.mentioned).length;
    const mentionRatePct = promptsTracked
      ? Math.round((promptsMentioned / promptsTracked) * 1000) / 10
      : 0.0;

    // Compute overall judge stats from run details
    const judgeStats = {
      deterministic: results.reduce((sum, r) => sum + (r.run_details || []).filter(run => run.judge_method === "deterministic").length, 0),
      llm: results.reduce((sum, r) => sum + (r.run_details || []).filter(run => run.judge_method === "llm").length, 0),
      fallback: results.reduce((sum, r) => sum + (r.run_details || []).filter(run => run.judge_method === "fallback").length, 0),
      skipped: results.reduce((sum, r) => sum + (r.run_details || []).filter(run => run.judge_method === "skipped").length, 0),
    };

    // P6-S04: Compute gap_score per prompt result against top competitor
    computeGapScores(results, competitors);

    const shareOfVoicePct = computeShareOfVoice(results);
    const winRatePct = computeWinRate(results, competitors);

    // P6-S02: Compute competitor objects using composite scoring
    const competitorObjects = competitors.map(comp => {
      const visibilityScore = computeCompetitorVisibility(results, comp);
      let mentions = 0;
      let userAbsent = 0;
      results.forEach(r => {
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
        visibilityScore
      };
    });
    competitorObjects.sort((a, b) => b.visibilityScore - a.visibilityScore);

    const scanStats = computeScanStats(results, visibilityPct);
    const intentBreakdown = computeIntentBreakdown(results, url);
    const topicScores = computeTopicScores(results, url);
    const scannedAt = new Date().toISOString();

    // P3-S08: Add prompt_set_id and prompt_set_hash
    const promptTexts = prompts.map(p => p.text.toLowerCase().trim()).sort();
    const prompt_set_hash = crypto.createHash("sha256").update(promptTexts.join("|")).digest("hex");
    const prompt_set_id = prompt_set_hash.slice(0, 16);

    const scanRecord = {
      brand,
      url,
      industry,
      platform: "gemini",
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
      scoring_version: SCORING_VERSION,
      judge_stats: judgeStats,
      score_ci_low: scanStats.score_ci_low,
      score_ci_high: scanStats.score_ci_high,
      stability: scanStats.stability,
      prompt_set_id,
      prompt_set_hash,
      intent_breakdown: intentBreakdown,
      topic_scores: topicScores,
      share_of_voice_pct: shareOfVoicePct,
      win_rate_pct: winRatePct
    };

    try {
      await insertScan(scanRecord);
    } catch (e) {
      // ignore DB errors
    }

    return NextResponse.json(scanRecord);
  } catch (error) {
    console.error("Scanning API error:", error);
    return NextResponse.json({ detail: "Internal Server Error" }, { status: 500 });
  }
}

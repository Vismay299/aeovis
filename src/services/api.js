import { buildMockResult } from "@/data/mockData";
import { normalizeTopic, isPromptRelatedToUrl } from "../lib/scoring/topics.js";
import {
  extractBrandDomain,
  classifyCitation,
  aggregateTopDomains,
  computeBrandCitationShare,
  computeCompetitorCitationShare
} from "../lib/scoring/citations.js";

export function saveScan(result) {
  try {
    sessionStorage.setItem("aeo_last_scan", JSON.stringify(result));
  } catch {
    /* ignore */
  }
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
  } catch {
    /* ignore */
  }
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
  } catch (e) {
    return [];
  }
}

export function normalizeResult(data, fallbackBrand, fallbackWebsite) {
  // Support both direct API response (flat) and persisted DB rows (results may be under raw_results)
  let results = data.results ?? data.topPrompts ?? [];
  if ((!results || results.length === 0) && data.raw_results?.results) {
    results = data.raw_results.results;
  }
  results = results.filter(r => !r.is_control);
  const usedDynamic = !!(data.used_dynamic_prompts ?? data.usedDynamicPrompts ?? data.raw_results?.used_dynamic_prompts);

  const version = data.scoring_version ?? data.scoringVersion ?? data.raw_results?.scoring_version ?? "v1-binary";
  const promptsTracked = data.prompts_tracked ?? data.promptsAnalyzed ?? results.length ?? 0;
  const promptsMentioned = data.prompts_mentioned ?? results.filter(r => r.mentioned).length ?? 0;
  const derivedMentionRate = promptsTracked ? Math.round((promptsMentioned / promptsTracked) * 1000) / 10 : 0.0;

  const mentionRatePct = data.mention_rate_pct ?? data.mentionRatePct ?? data.raw_results?.mention_rate_pct ?? (
    version === "v1-binary"
      ? (data.visibility_pct ?? data.visibilityScore ?? 0.0)
      : derivedMentionRate
  );

  return {
    brand: data.brand ?? fallbackBrand,
    website: data.website ?? data.url ?? fallbackWebsite,
    industry: data.industry ?? "",
    visibilityScore: data.visibility_pct ?? data.visibilityScore ?? 0,
    shareOfVoicePct: (() => {
      const val = data.share_of_voice_pct ?? data.shareOfVoicePct ?? data.raw_results?.share_of_voice_pct;
      if (val !== undefined && val !== null) return val;
      const brandMentions = results.filter(r => r.mentioned).length;
      const competitorMentions = results.reduce((sum, r) => sum + (r.competitors_found || []).length, 0);
      const total = brandMentions + competitorMentions;
      return total > 0 ? Math.round((brandMentions / total) * 1000) / 10 : 0.0;
    })(),
    winRatePct: (() => {
      const val = data.win_rate_pct ?? data.winRatePct ?? data.raw_results?.win_rate_pct;
      if (val !== undefined && val !== null) return val;
      const comps = data.competitors ?? [];
      const comparisonPrompts = results.filter(r => r.intent_tier === "comparison" || r.intentTier === "comparison");
      if (comparisonPrompts.length === 0) return 0.0;
      let wins = 0;
      comparisonPrompts.forEach(r => {
        if (r.mentioned) {
          const compsFound = r.competitors_found || r.competitorsFound || [];
          const compsList = comps && comps.length ? comps.map(c => typeof c === "string" ? c : (c.name || "")) : [];
          const hasTrackedComp = compsFound.some(c => compsList.some(comp => comp.toLowerCase() === c.toLowerCase()));
          if (!hasTrackedComp) {
            wins++;
          }
        }
      });
      return Math.round((wins / comparisonPrompts.length) * 1000) / 10;
    })(),
    mentionRatePct,
    promptsAnalyzed: promptsTracked,
    scoreCiLow: data.score_ci_low ?? data.scoreCiLow ?? data.raw_results?.score_ci_low ?? (data.visibility_pct ?? data.visibilityScore ?? 0),
    scoreCiHigh: data.score_ci_high ?? data.scoreCiHigh ?? data.raw_results?.score_ci_high ?? (data.visibility_pct ?? data.visibilityScore ?? 0),
    stability: data.stability ?? data.raw_results?.stability ?? "high",
    promptSetId: data.prompt_set_id ?? data.promptSetId ?? data.raw_results?.prompt_set_id ?? "",
    promptSetHash: data.prompt_set_hash ?? data.promptSetHash ?? data.raw_results?.prompt_set_hash ?? "",
    intentBreakdown: data.intent_breakdown ?? data.intentBreakdown ?? data.raw_results?.intent_breakdown ?? {
      high_intent: 0.0,
      comparison: 0.0,
      problem_aware: 0.0,
      exploratory: 0.0,
      branded: 0.0
    },
    topicScores: data.topic_scores ?? data.topicScores ?? data.raw_results?.topic_scores ?? {},
    brandCitationSharePct: (() => {
      const val = data.brand_citation_share_pct ?? data.brandCitationSharePct ?? data.raw_results?.brand_citation_share_pct;
      if (val !== undefined && val !== null) return val;
      return computeBrandCitationShare(results, data.website ?? data.url ?? fallbackWebsite);
    })(),
    topDomains: (() => {
      const val = data.top_domains ?? data.topDomains ?? data.raw_results?.top_domains;
      if (val !== undefined && val !== null) return val;
      return aggregateTopDomains(results, data.website ?? data.url ?? fallbackWebsite, data.competitors ?? []);
    })(),
    competitorsFound:
      data.competitors_found ??
      data.competitorsFound ??
      (results.length ? new Set(results.flatMap(r => r.competitors_found || [])).size : 0),
    scanTimestamp: data.scanned_at ?? data.scanTimestamp ?? new Date().toISOString(),
    usedDynamicPrompts: usedDynamic,
    tokensUsed: data.tokens_used ?? data.tokensUsed ?? 0,
    engineScores: data.engine_scores ?? data.engineScores ?? data.raw_results?.engine_scores ?? { gemini: data.visibility_pct ?? data.visibilityScore ?? 0.0 },
    costByEngine: data.cost_by_engine ?? data.costByEngine ?? data.raw_results?.cost_by_engine ?? {},
    enginesPartial: !!(data.engines_partial ?? data.enginesPartial ?? data.raw_results?.engines_partial),
    serpCoveragePct: data.serp_coverage_pct ?? data.serpCoveragePct ?? data.raw_results?.serp_coverage_pct ?? null,
    probeSources: data.probe_sources ?? data.probeSources ?? data.raw_results?.probe_sources ?? [],
    qualityGateFailed: !!(data.quality_gate_failed ?? data.qualityGateFailed ?? data.raw_results?.quality_gate_failed),
    probeFailureRate: data.probe_failure_rate ?? data.probeFailureRate ?? data.raw_results?.probe_failure_rate ?? 0.0,
    judgeDisagreementCount: data.judge_disagreement_count ?? data.judgeDisagreementCount ?? data.raw_results?.judge_disagreement_count ?? 0,
    controlPromptsPassed: data.control_prompts_passed ?? data.controlPromptsPassed ?? data.raw_results?.control_prompts_passed ?? 0,
    controlPromptsTotal: data.control_prompts_total ?? data.controlPromptsTotal ?? data.raw_results?.control_prompts_total ?? 0,
    summary: data.summary || generateSummary(data),
    totalCitations: results.reduce((sum, r) => sum + ((r.citations || r.citations_found || []).length), 0),
    scoringVersion: version,
    querySource: data.query_source ?? data.querySource ?? data.raw_results?.query_source ?? "llm_generated",
    sampleSizeAdequacy: data.sample_size_adequacy ?? data.sampleSizeAdequacy ?? data.raw_results?.sample_size_adequacy ?? (results.length >= 30),
    // Preserve rich Phase 2 analysis fields for future UI (citations, key phrases, exact position)
    rawResults: results,
    topPrompts: results.map((p) => {
      // Handle the difference between backend response (results) and mock shape
      if (p.prompt && typeof p.position === "string") {
        let rank = "—";
        if (p.position === "recommended") rank = 1;
        else if (p.position === "compared") rank = 2;
        else if (p.position === "cited") rank = 3;
        return {
          prompt: p.prompt,
          rank: rank,
          volume: p.sentiment ? p.sentiment.charAt(0).toUpperCase() + p.sentiment.slice(1) : "—",
          // Phase 2 rich data passthrough
          position: p.position,
          sentiment: p.sentiment,
          citations: p.citations || [],
          keyPhrases: p.key_phrases || p.keyPhrases || [],
          competitorsFound: p.competitors_found || [],
          mentioned: p.mentioned,
          rawResponse: p.raw_response ?? "",
          modelUsed: p.model_used ?? "",
          probeTemperature: p.probe_temperature ?? null,
          judgeMethod: p.judge_method ?? "",
          judgeModelUsed: p.judge_model_used ?? "",
          promptScore: p.prompt_score ?? (p.mentioned ? 100.0 : 0.0),
          gapScore: p.gap_score ?? p.gapScore ?? 0.0,
          intentTier: p.intent_tier || "exploratory",
          topic: normalizeTopic(p.topic || "General"),
          brandInPromptWarning: !!(p.brand_in_prompt_warning || p.brandInPromptWarning)
        };
      }
      return {
        prompt: p.prompt,
        rank: p.rank ?? p.visibility ?? "—",
        volume: p.volume ?? "—",
        gapScore: p.gap_score ?? p.gapScore ?? 0.0,
        intentTier: p.intent_tier || "exploratory",
        topic: normalizeTopic(p.topic || "General"),
        brandInPromptWarning: !!(p.brand_in_prompt_warning || p.brandInPromptWarning)
      };
    }),
    competitors: extractCompetitors(data, results),
    competitorsRaw: data.competitors_raw || "",
    // For debug / future UI
    _debug: {
      usedDynamicPrompts: usedDynamic,
      hasCitations: results.some(r => (r.citations || []).length > 0),
      judgeStats: (() => {
        if (data.judge_stats || data.judgeStats || data.raw_results?.judge_stats) {
          return data.judge_stats ?? data.judgeStats ?? data.raw_results.judge_stats;
        }
        const hasRunDetails = results.some(r => r.run_details && r.run_details.length > 0);
        if (hasRunDetails) {
          const allRuns = results.flatMap(r => r.run_details || []);
          return {
            deterministic: allRuns.filter(run => run.judge_method === "deterministic").length,
            llm: allRuns.filter(run => run.judge_method === "llm").length,
            fallback: allRuns.filter(run => run.judge_method === "fallback").length,
            skipped: allRuns.filter(run => run.judge_method === "skipped").length,
          };
        }
        return {
          deterministic: results.filter(r => r.judge_method === "deterministic" || r.judgeMethod === "deterministic").length,
          llm: results.filter(r => r.judge_method === "llm" || r.judgeMethod === "llm").length,
          fallback: results.filter(r => r.judge_method === "fallback" || r.judgeMethod === "fallback").length,
          skipped: results.filter(r => r.judge_method === "skipped" || r.judgeMethod === "skipped").length,
        };
      })()
    },
  };
}

function extractCompetitors(data, results = []) {
  const comps = data.competitors;
  if (comps && comps.length) {
    // Handle both array of strings (from input) or array of objects (legacy/derived)
    if (typeof comps[0] === "string") {
      // Input list; actual mentions derived below from results instead
      // Fall through to results derivation which is richer
    } else {
      return comps.map(c => ({
        name: c.name ?? c.competitor ?? c,
        mentions: c.mentions ?? c.count ?? 0,
        prompts: c.prompts ?? c.seen_in ?? 0,
        userAbsent: c.user_absent ?? c.userAbsent ?? false,
        visibilityScore: c.visibilityScore ?? 0,
        citationShare: c.citationShare ?? c.citation_share ?? 0.0,
      }));
    }
  }
  const activeResults = data.results ?? results ?? [];
  if (!activeResults || activeResults.length === 0) return [];

  const compMap = {};
  activeResults.forEach(r => {
    const isBrandMentioned = r.mentioned;
    (r.competitors_found || []).forEach(c => {
      const name = c.toLowerCase();
      if (!compMap[name]) {
        compMap[name] = { name: c, mentions: 0, prompts: 0, userAbsent: 0 };
      }
      compMap[name].mentions += 1;
      compMap[name].prompts += 1; // Assuming 1 mention per prompt max
      if (!isBrandMentioned) compMap[name].userAbsent += 1;
    });
  });

  const totalPrompts = data.prompts_tracked || data.promptsAnalyzed || activeResults.length || 1;

  return Object.values(compMap)
    .sort((a, b) => b.mentions - a.mentions)
    .map(c => ({
      name: c.name,
      mentions: c.mentions,
      prompts: c.prompts,
      userAbsent: c.userAbsent > 0,
      visibilityScore: Math.round((c.mentions / totalPrompts) * 1000) / 10,
      citationShare: computeCompetitorCitationShare(activeResults, c.name)
    }));
}

function generateSummary(data) {
  const brand = data.brand || "Your brand";
  const score = data.visibility_pct ?? data.visibilityScore ?? 0;
  const version = data.scoring_version ?? data.scoringVersion ?? data.raw_results?.scoring_version ?? "v2-composite";

  const isBinary = version === "v1-binary";
  const strongThreshold = isBinary ? 70 : 50;
  const moderateThreshold = isBinary ? 40 : 25;

  if (score >= strongThreshold) {
    return `${brand} has a strong presence across AI answers in this category, frequently appearing as a recommended solution. Ensure you monitor high-intent queries to defend this position.`;
  }
  if (score >= moderateThreshold) {
    return `${brand} appears in a moderate amount of AI answers but often loses ground on comparison prompts. There is clear room to grow by targeting specific competitor gaps.`;
  }
  return `${brand} is largely invisible in AI answers for this category. Competitors are currently capturing the majority of AI-driven recommendations.`;
}

export async function runScan({ brand, website, industry, competitors, querySource, gscQueries }, onProgress = () => {}) {
  onProgress(0); // Stage 0: Submitting brand for analysis

  try {
    // 1. Submit the scan job
    const res = await fetch("/api/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        brand,
        url: website,
        industry,
        competitors: competitors || "",
        querySource: querySource || "llm_generated",
        gscQueries: gscQueries || []
      }),
    });

    if (!res.ok) {
      let msg = "Scan failed to initiate";
      try {
        const errData = await res.json();
        if (errData.detail) msg = errData.detail;
      } catch (e) {}
      throw new Error(msg);
    }

    const initData = await res.json();
    const jobId = initData.job_id;
    if (!jobId) {
      throw new Error("Invalid response from scanning service: no job ID returned.");
    }

    // 2. Poll status endpoint until completion or failure
    const statusToStage = {
      "pending": 0,
      "generating_prompts": 1,
      "probing": 2,
      "analyzing": 3,
      "scoring": 4,
      "complete": 4,
      "failed": 4
    };

    const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
    let attempts = 0;
    const maxAttempts = 300; // 10 minutes maximum time

    while (attempts < maxAttempts) {
      await delay(2000); // Poll every 2 seconds
      attempts++;

      const pollRes = await fetch(`/api/scan/${jobId}/status`);
      if (!pollRes.ok) {
        throw new Error("Failed to retrieve scan progress status.");
      }

      const statusData = await pollRes.json();
      const mappedStage = statusToStage[statusData.status] ?? 0;
      onProgress(mappedStage, statusData.progress_pct);

      if (statusData.status === "complete") {
        if (!statusData.run_record) {
          throw new Error("Scan finished but no record was returned.");
        }
        return normalizeResult(statusData.run_record, brand, website);
      }

      if (statusData.status === "failed") {
        throw new Error(statusData.error_message || "Async background scan job failed.");
      }
    }

    throw new Error("Scan timed out after 10 minutes.");
  } catch (error) {
    throw error;
  }
}

export async function getContentEvents(brand) {
  const isLocal = typeof window !== "undefined" && !process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (isLocal) {
    try {
      const stored = localStorage.getItem(`aeo_content_events_${brand.toLowerCase()}`);
      if (stored) {
        const events = JSON.parse(stored);
        
        // Compute lift client-side based on localStorage scans
        const historyStored = localStorage.getItem(`aeo_scans_${brand.toLowerCase()}`) || "[]";
        const scans = JSON.parse(historyStored);

        return events.map(event => {
          let currentScore = null;
          let previousScore = null;
          let lift = null;
          let relatedPrompts = [];

          if (scans.length > 0) {
            const latestScan = scans[0];
            const latestResults = latestScan.rawResults || latestScan.raw_results || [];
            
            const latestMatches = latestResults.filter(r => isPromptRelatedToUrl(r.prompt || r.text, event.url));
            if (latestMatches.length > 0) {
              relatedPrompts = latestMatches.map(m => m.prompt || m.text);
              const currentSum = latestMatches.reduce((sum, m) => sum + (m.prompt_score ?? 0), 0);
              currentScore = Math.round((currentSum / latestMatches.length) * 10) / 10;

              if (scans.length > 1) {
                const prevScan = scans[1];
                const prevResults = prevScan.rawResults || prevScan.raw_results || [];
                const prevMatches = prevResults.filter(r => 
                  relatedPrompts.some(pText => pText.toLowerCase().trim() === (r.prompt || r.text || "").toLowerCase().trim())
                );
                if (prevMatches.length > 0) {
                  const prevSum = prevMatches.reduce((sum, m) => sum + (m.prompt_score ?? 0), 0);
                  previousScore = Math.round((prevSum / prevMatches.length) * 10) / 10;
                  lift = Math.round((currentScore - previousScore) * 10) / 10;
                }
              }
            }
          }

          return {
            ...event,
            related_prompts: relatedPrompts,
            current_score: currentScore,
            previous_score: previousScore,
            lift: lift
          };
        });
      }
      return [];
    } catch (e) {
      console.warn("Local content events retrieval failed:", e);
      return [];
    }
  }

  try {
    const res = await fetch(`/api/content-events?brand=${encodeURIComponent(brand)}`);
    if (res.ok) {
      return await res.json();
    }
    return [];
  } catch (e) {
    console.error("Failed to fetch content events:", e);
    return [];
  }
}

export async function addContentEvent({ brand, url, publishDate }) {
  const isLocal = typeof window !== "undefined" && !process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (isLocal) {
    try {
      const key = `aeo_content_events_${brand.toLowerCase()}`;
      const stored = localStorage.getItem(key) || "[]";
      const events = JSON.parse(stored);
      
      const newEvent = {
        id: crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2),
        brand,
        url,
        publish_date: publishDate || new Date().toISOString(),
        created_at: new Date().toISOString()
      };
      
      events.push(newEvent);
      localStorage.setItem(key, JSON.stringify(events));
      return newEvent;
    } catch (e) {
      console.warn("Local content event insertion failed:", e);
      return null;
    }
  }

  try {
    const res = await fetch("/api/content-events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ brand, url, publishDate }),
    });
    if (res.ok) {
      return await res.json();
    }
    return null;
  } catch (e) {
    console.error("Failed to add content event:", e);
    return null;
  }
}

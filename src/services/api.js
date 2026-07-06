import { buildMockResult } from "@/data/mockData";
import { normalizeTopic } from "../lib/scoring/topics.js";

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
    competitorsFound:
      data.competitors_found ??
      data.competitorsFound ??
      (results.length ? new Set(results.flatMap(r => r.competitors_found || [])).size : 0),
    scanTimestamp: data.scanned_at ?? data.scanTimestamp ?? new Date().toISOString(),
    usedDynamicPrompts: usedDynamic,
    tokensUsed: data.tokens_used ?? data.tokensUsed ?? 0,
    summary: data.summary || generateSummary(data),
    totalCitations: results.reduce((sum, r) => sum + ((r.citations || r.citations_found || []).length), 0),
    scoringVersion: version,
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
          intentTier: p.intent_tier || "exploratory",
          topic: normalizeTopic(p.topic || "General")
        };
      }
      return {
        prompt: p.prompt,
        rank: p.rank ?? p.visibility ?? "—",
        volume: p.volume ?? "—",
        intentTier: p.intent_tier || "exploratory",
        topic: normalizeTopic(p.topic || "General")
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
      visibilityScore: Math.round((c.mentions / totalPrompts) * 1000) / 10
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

export async function runScan({ brand, website, industry, competitors }, onProgress = () => {}) {
  // Simulate progress steps while the fetch is happening (scrape + dynamic prompt gen + analyses)
  let stage = 0;
  onProgress(stage);

  const progressInterval = setInterval(() => {
    stage += 1;
    if (stage < 4) {
      onProgress(stage);
    }
  }, 25000);

  try {
    const res = await fetch("/api/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ brand, url: website, industry, competitors: competitors || "" }),
    });

    clearInterval(progressInterval);
    onProgress(4);

    if (!res.ok) {
      let msg = "Scan failed";
      try {
        const errData = await res.json();
        if (errData.detail) msg = errData.detail;
      } catch (e) {}
      throw new Error(msg);
    }

    const data = await res.json();
    return normalizeResult(data, brand, website);
  } catch (error) {
    clearInterval(progressInterval);
    throw error;
  }
}

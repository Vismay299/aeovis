import { buildMockResult } from "@/data/mockData";

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

export function normalizeResult(data, fallbackBrand, fallbackWebsite) {
  return {
    brand: data.brand ?? fallbackBrand,
    website: data.website ?? fallbackWebsite,
    visibilityScore: data.visibility_pct ?? data.visibilityScore ?? 0,
    promptsAnalyzed: data.prompts_tracked ?? data.promptsAnalyzed ?? 0,
    competitorsFound:
      data.competitors_found ??
      data.competitorsFound ??
      (data.results ? new Set(data.results.flatMap(r => r.competitors_found || [])).size : 0),
    scanTimestamp: data.scanned_at ?? data.scanTimestamp ?? new Date().toISOString(),
    summary: data.summary || generateSummary(data),
    topPrompts: (data.results ?? data.topPrompts ?? []).map((p) => {
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
        };
      }
      return {
        prompt: p.prompt,
        rank: p.rank ?? p.visibility ?? "—",
        volume: p.volume ?? "—",
      };
    }),
    competitors: extractCompetitors(data),
  };
}

function extractCompetitors(data) {
  if (data.competitors) {
    return data.competitors.map(c => ({
      name: c.name ?? c.competitor,
      mentions: c.mentions ?? c.count ?? 0,
      prompts: c.prompts ?? c.seen_in ?? 0,
      userAbsent: c.user_absent ?? c.userAbsent ?? false,
    }));
  }
  if (!data.results) return [];

  const compMap = {};
  data.results.forEach(r => {
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

  return Object.values(compMap)
    .sort((a, b) => b.mentions - a.mentions)
    .map(c => ({
      name: c.name,
      mentions: c.mentions,
      prompts: c.prompts,
      userAbsent: c.userAbsent > 0,
    }));
}

function generateSummary(data) {
  const brand = data.brand || "Your brand";
  const score = data.visibility_pct || 0;
  if (score >= 70) {
    return `${brand} has a strong presence across AI answers in this category, frequently appearing as a recommended solution. Ensure you monitor high-intent queries to defend this position.`;
  }
  if (score >= 40) {
    return `${brand} appears in a moderate amount of AI answers but often loses ground on comparison prompts. There is clear room to grow by targeting specific competitor gaps.`;
  }
  return `${brand} is largely invisible in AI answers for this category. Competitors are currently capturing the majority of AI-driven recommendations.`;
}

export async function runScan({ brand, website, industry }, onProgress = () => {}) {
  // Simulate progress steps while the fetch is happening (since it can take 15-30s)
  let stage = 0;
  onProgress(stage);

  const progressInterval = setInterval(() => {
    stage += 1;
    if (stage < 3) {
      onProgress(stage);
    }
  }, 4000);

  try {
    const res = await fetch("/api/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ brand, url: website, industry, competitors: "" }),
    });

    clearInterval(progressInterval);
    onProgress(3);

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

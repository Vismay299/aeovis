import { extractBrandDomain, aggregateTopDomains, computeCompetitorCitationShare } from "../lib/scoring/citations.js";

export function saveScan(result) {
  try {
    sessionStorage.setItem("aeo_last_scan", JSON.stringify(result));
  } catch {}
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

/**
 * Transforms an AIO-only scan record (from the API or DB) into the shape
 * the dashboard components expect.
 */
export function normalizeResult(data, fallbackBrand, fallbackWebsite) {
  const raw = data.raw_results || data;
  const results = (data.results ?? raw.results ?? data.topPrompts ?? []).filter(
    (r) => !r.is_control
  );

  const brand = data.brand ?? fallbackBrand;
  const website = data.website ?? data.url ?? fallbackWebsite;

  const nonBranded = results.filter((r) => !r.is_branded_query);
  const branded = results.filter((r) => r.is_branded_query);

  const summary = data.summary_stats || raw.summary_stats || null;

  const visibilityPct =
    data.visibility_pct ?? data.visibilityScore ?? summary?.visibility_pct ?? 0;
  const mentionRatePct =
    data.mention_rate_pct ?? summary?.mention_rate_pct ?? raw.mention_rate_pct ?? 0;
  const citationSharePct =
    data.brand_citation_share_pct ??
    summary?.citation_share_pct ??
    raw.brand_citation_share_pct ??
    0;
  const brandedVisibilityPct =
    data.branded_visibility_pct ??
    summary?.branded_visibility_pct ??
    raw.branded_visibility_pct ??
    0;
  const aioCoveragePct =
    data.aio_coverage_pct ?? summary?.aio_coverage_pct ?? raw.aio_coverage_pct ?? null;
  const aioErrorRatePct =
    data.aio_error_rate_pct ?? summary?.error_rate_pct ?? raw.aio_error_rate_pct ?? 0;
  const dataSourceIssue = !!(
    data.data_source_issue ??
    summary?.data_source_issue ??
    raw.data_source_issue
  );
  const insufficientSample = !!(
    data.insufficient_sample ??
    summary?.insufficient_sample ??
    raw.insufficient_sample
  );

  return {
    brand,
    website,
    industry: data.industry ?? "",
    visibilityScore: visibilityPct,
    mentionRatePct,
    brandCitationSharePct: citationSharePct,
    brandedVisibilityPct,
    aioCoveragePct,
    aioErrorRatePct,
    promptsAnalyzed: nonBranded.length,
    brandedPromptsCount: branded.length,
    scanTimestamp: data.scanned_at ?? data.scanTimestamp ?? new Date().toISOString(),
    scoringVersion: data.scoring_version ?? raw.scoring_version ?? "v7-aio-only",
    seeds: data.seeds ?? raw.seeds ?? [],
    querySource: data.query_source ?? raw.query_source ?? "aio_paa_autocomplete",
    usedDynamicPrompts: !!(data.used_dynamic_prompts ?? raw.used_dynamic_prompts),
    tokensUsed: data.tokens_used ?? 0,
    costTotal: data.cost_total ?? raw.cost_total ?? 0,
    dataSourceIssue,
    insufficientSample,
    // For legacy dashboard components that key off `qualityGateFailed`
    qualityGateFailed: dataSourceIssue,
    sampleSizeAdequacy: !insufficientSample,
    topDomains: data.top_domains ?? raw.top_domains ?? [],
    competitors: (data.competitors ?? raw.competitors ?? []).map((c) => ({
      name: c.name ?? c,
      mentions: c.mentions ?? 0,
      citations: c.citations ?? 0,
      prompts: c.prompts ?? c.mentions ?? 0,
      userAbsent: !!c.userAbsent,
      visibilityScore: c.visibilityScore ?? 0,
      citationShare: c.citationShare ?? 0,
    })),
    competitorsFound: (data.competitors ?? raw.competitors ?? []).length,
    competitorsRaw: data.competitors_raw ?? raw.competitors_raw ?? "",
    engineScores: { google_ai_overview: visibilityPct },
    probeSources: ["google_ai_overview"],
    serpCoveragePct: aioCoveragePct,
    summary: generateSummary(brand, visibilityPct, aioCoveragePct, dataSourceIssue),
    totalCitations: results.reduce(
      (sum, r) => sum + ((r.aio_citations || r.citations || []).length),
      0
    ),
    promptSetId: data.prompt_set_id ?? raw.prompt_set_id ?? "",
    promptSetHash: data.prompt_set_hash ?? raw.prompt_set_hash ?? "",
    rawResults: results,
    topPrompts: results.map(mapPromptForUi),
    nonBrandedResults: nonBranded.map(mapPromptForUi),
    brandedResults: branded.map(mapPromptForUi),
  };
}

function mapPromptForUi(r) {
  const aioCitations = r.aio_citations || r.citations || [];
  const aioReferences = r.aio_references || [];
  const brandMentionedInText = !!r.brand_mentioned_in_text;
  const brandCited = !!r.brand_cited;
  const visible = !!r.visible || brandMentionedInText || brandCited;

  const promptScore = visible ? 100 : 0;

  let rank = "—";
  if (brandMentionedInText && brandCited) rank = 1;
  else if (brandMentionedInText) rank = 2;
  else if (brandCited) rank = 3;

  return {
    prompt: r.prompt,
    rank,
    volume: r.source ? r.source.toUpperCase() : "—",
    promptScore,
    aioPresent: !!r.aio_present,
    aioText: r.aio_text || "",
    aioCitations,
    aioReferences,
    brandMentioned: brandMentionedInText,
    brandCited,
    visible,
    isBrandedQuery: !!r.is_branded_query,
    brandInPromptWarning: !!r.is_branded_query,
    competitorsFound: r.competitors_found_in_text || r.competitors_found || [],
    competitorsCited: r.competitors_cited || [],
    mentioned: visible,
    position: brandCited ? "cited" : brandMentionedInText ? "recommended" : "omitted",
    sentiment: "neutral",
    citations: aioCitations,
    keyPhrases: [],
    error: r.error || null,
    source: r.source || "",
    topic: r.topic || "General",
    intentTier: r.is_branded_query ? "branded" : "exploratory",
  };
}

function generateSummary(brand, score, coverage, dataSourceIssue) {
  if (dataSourceIssue) {
    return `Not enough Google AI Overview responses were returned for ${brand} to compute a reliable score. This usually means either the data source (Bright Data SERP) errored or Google did not surface an AIO for most tracked queries.`;
  }
  const b = brand || "Your brand";
  if (score >= 50)
    return `${b} shows strong presence in Google AI Overviews — appearing in the majority of relevant answers. Keep monitoring high-intent competitor queries to defend this position.`;
  if (score >= 20)
    return `${b} appears in some Google AI Overviews but is missed in most category queries. Competitors are winning the majority of AIO recommendations.`;
  return `${b} is largely invisible in Google AI Overviews for its category. Competitors dominate AIO recommendations across the tracked queries.`;
}

export async function runScan({ brand, website, industry, competitors }, onProgress = () => {}) {
  onProgress(0);

  const res = await fetch("/api/scan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ brand, url: website, industry, competitors: competitors || "" }),
  });

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
  const maxAttempts = 300;

  while (attempts < maxAttempts) {
    await delay(2000);
    attempts++;

    const pollRes = await fetch(`/api/scan/${jobId}/status`);
    if (!pollRes.ok) throw new Error("Failed to retrieve scan progress status.");

    const statusData = await pollRes.json();
    const stage = statusToStage[statusData.status] ?? 0;
    onProgress(stage, statusData.progress_pct);

    if (statusData.status === "complete") {
      if (!statusData.run_record) throw new Error("Scan finished but no record was returned.");
      return normalizeResult(statusData.run_record, brand, website);
    }
    if (statusData.status === "failed") {
      throw new Error(statusData.error_message || "Async scan job failed.");
    }
  }

  throw new Error("Scan timed out after 10 minutes.");
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

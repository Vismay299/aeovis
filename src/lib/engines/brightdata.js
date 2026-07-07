import { normalizeUrl } from "../scoring/citations.js";

let cachedZoneName = null;

export function getBrightDataApiKey() {
  return (process.env.BRIGHTDATA_API_KEY || "").trim() || null;
}

export async function resolveBrightDataSerpZone(apiKey = getBrightDataApiKey()) {
  const configuredZone = (process.env.BRIGHTDATA_SERP_ZONE || "").trim();
  if (configuredZone) return configuredZone;
  if (cachedZoneName) return cachedZoneName;
  if (!apiKey) return null;

  const res = await fetch("https://api.brightdata.com/zone/get_all_zones", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (!res.ok) {
    throw new Error(`Bright Data zone lookup failed: HTTP ${res.status}`);
  }

  const zones = await res.json();
  const activeSerpZone = (zones || []).find(
    (z) => z.type === "serp" && z.status === "active"
  );

  if (!activeSerpZone?.name) {
    throw new Error("No active Bright Data SERP zone found on this account.");
  }

  cachedZoneName = activeSerpZone.name;
  console.log(`[brightdata] Auto-discovered SERP zone: ${cachedZoneName}`);
  return cachedZoneName;
}

export async function getBrightDataConfig() {
  const apiKey = getBrightDataApiKey();
  if (!apiKey) return null;

  const zone = await resolveBrightDataSerpZone(apiKey);
  if (!zone) return null;

  return { apiKey, zone };
}

function normalizeBrightDataResponse(data) {
  if (!data || typeof data !== "object") return data;

  let payload = data;
  if (data.body !== undefined) {
    payload = typeof data.body === "string" ? JSON.parse(data.body) : data.body;
  }

  return payload || data;
}

function buildGoogleSearchUrl(query, { geo = "us", aiOverview = true } = {}) {
  const params = new URLSearchParams({
    q: query,
    hl: "en",
    gl: geo,
    brd_json: "1",
  });
  if (aiOverview) {
    params.set("brd_ai_overview", "2");
  }
  return `https://www.google.com/search?${params.toString()}`;
}

export async function brightDataSearch(query, options = {}) {
  const config = await getBrightDataConfig();
  if (!config) {
    throw new Error("Bright Data SERP is not configured (set BRIGHTDATA_API_KEY).");
  }

  const geo = process.env.SERP_GEO || "us";
  const timeoutMs = options.timeout || 45000;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch("https://api.brightdata.com/request", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        zone: config.zone,
        url: buildGoogleSearchUrl(query, { geo, aiOverview: options.aiOverview !== false }),
        format: "json",
        country: geo,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Bright Data HTTP ${res.status}: ${errText}`);
    }

    const data = await res.json();

    if (data.error || data.status === "error") {
      throw new Error(data.error || data.message || "Bright Data request failed");
    }

    return normalizeBrightDataResponse(data);
  } catch (err) {
    clearTimeout(timeoutId);
    throw err;
  }
}

export function extractBrightDataAiOverview(data) {
  const ao = data?.ai_overview;
  if (!ao) return { text: "", citations: [] };

  let text = "";
  if (typeof ao === "string") {
    text = ao;
  } else if (ao.text) {
    text = ao.text;
  } else if (Array.isArray(ao.text_blocks)) {
    text = ao.text_blocks
      .map((block) => block.snippet || block.text || block.header || "")
      .filter(Boolean)
      .join("\n");
  } else if (Array.isArray(ao.paragraphs)) {
    text = ao.paragraphs.map((p) => (typeof p === "string" ? p : p.text || "")).filter(Boolean).join("\n");
  } else if (ao.snippet) {
    text = ao.snippet;
  }

  const citationSources = [
    ...(ao.references || []),
    ...(ao.sources || []),
    ...(ao.citations || []),
  ];

  const citations = citationSources
    .map((ref) => (typeof ref === "string" ? ref : ref.link || ref.url || ref.href))
    .filter(Boolean)
    .map(normalizeUrl);

  return { text: text.trim(), citations: [...new Set(citations)] };
}

export function extractBrightDataPaa(data) {
  const paa = data?.people_also_ask || [];
  return paa
    .map((item) => item.question || item.text)
    .filter(Boolean);
}
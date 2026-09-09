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
    if (typeof data.body === "string") {
      const raw = data.body.trim();
      if (!raw) return data;
      try {
        payload = JSON.parse(raw);
      } catch {
        // Bright Data occasionally returns HTML/text when SERP JSON fails.
        // Surface as an error so scans count it as a SERP failure, not empty AIO.
        throw new Error(
          `Bright Data returned non-JSON SERP body (${raw.slice(0, 120).replace(/\s+/g, " ")}…)`
        );
      }
    } else {
      payload = data.body;
    }
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
  const timeoutMs = options.timeout || 30000;
  const maxAttempts = options.attempts ?? 2;
  const backoffMs = options.backoffMs ?? 1000;

  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
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
          url: buildGoogleSearchUrl(query, {
            geo,
            aiOverview: options.aiOverview !== false,
          }),
          format: "json",
          country: geo,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!res.ok) {
        const errText = await res.text();
        // Retry on 5xx (proxy errors are transient)
        if (res.status >= 500 && attempt < maxAttempts) {
          lastErr = new Error(`Bright Data HTTP ${res.status}: ${errText}`);
          await new Promise((r) => setTimeout(r, backoffMs * attempt));
          continue;
        }
        throw new Error(`Bright Data HTTP ${res.status}: ${errText}`);
      }

      const data = await res.json();
      if (data.error || data.status === "error") {
        throw new Error(data.error || data.message || "Bright Data request failed");
      }
      return normalizeBrightDataResponse(data);
    } catch (err) {
      clearTimeout(timeoutId);
      lastErr = err;
      const isAbort = err.name === "AbortError" || /abort/i.test(err.message || "");
      const is5xx = /HTTP 5\d\d/.test(err.message || "");
      if ((isAbort || is5xx) && attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, backoffMs * attempt));
        continue;
      }
      throw err;
    }
  }
  throw lastErr || new Error("Bright Data request failed after retries.");
}

function extractSnippetsFromBlock(block) {
  if (!block) return [];
  if (typeof block === "string") return [block];
  const out = [];
  if (block.snippet) out.push(block.snippet);
  if (block.text) out.push(block.text);
  if (block.header) out.push(block.header);
  if (Array.isArray(block.list)) {
    block.list.forEach((item) => {
      out.push(...extractSnippetsFromBlock(item));
    });
  }
  if (Array.isArray(block.text_blocks)) {
    block.text_blocks.forEach((tb) => {
      out.push(...extractSnippetsFromBlock(tb));
    });
  }
  if (Array.isArray(block.paragraphs)) {
    block.paragraphs.forEach((p) => {
      out.push(...extractSnippetsFromBlock(p));
    });
  }
  return out.filter(Boolean);
}

export function extractBrightDataAiOverview(data) {
  const ao = data?.ai_overview;
  if (!ao) return { text: "", citations: [], references: [] };

  let text = "";
  const parts = [];

  if (typeof ao === "string") {
    text = ao;
  } else {
    // Primary shape observed from Bright Data: ai_overview.texts (array of blocks)
    if (Array.isArray(ao.texts)) {
      ao.texts.forEach((block) => {
        parts.push(...extractSnippetsFromBlock(block));
      });
    }
    // Fallbacks for other shapes
    if (parts.length === 0 && Array.isArray(ao.text_blocks)) {
      ao.text_blocks.forEach((block) => {
        parts.push(...extractSnippetsFromBlock(block));
      });
    }
    if (parts.length === 0 && Array.isArray(ao.paragraphs)) {
      ao.paragraphs.forEach((p) => {
        parts.push(...extractSnippetsFromBlock(p));
      });
    }
    if (parts.length === 0 && typeof ao.text === "string") parts.push(ao.text);
    if (parts.length === 0 && typeof ao.snippet === "string") parts.push(ao.snippet);

    text = parts.join("\n");
  }

  // References: BrightData uses `href`, `title`, `source` in ai_overview.references
  const refSources = [
    ...(ao.references || []),
    ...(ao.sources || []),
    ...(ao.citations || []),
  ];

  const references = refSources
    .map((ref) => {
      if (typeof ref === "string") return { href: ref, title: "", source: "" };
      const href = ref.href || ref.link || ref.url || "";
      return {
        href,
        title: ref.title || "",
        source: ref.source || "",
      };
    })
    .filter((r) => r.href);

  const citations = [...new Set(references.map((r) => normalizeUrl(r.href)).filter(Boolean))];

  return {
    text: text.trim(),
    citations,
    references,
  };
}

export function extractBrightDataPaa(data) {
  const paa = data?.people_also_ask || [];
  return paa
    .map((item) => item.question || item.text)
    .filter(Boolean);
}
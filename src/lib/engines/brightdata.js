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
      try {
        payload = data.body ? JSON.parse(data.body) : data;
      } catch {
        payload = data;
      }
    } else {
      payload = data.body;
    }
  }

  return payload || data;
}

/**
 * Bright Data's proxy wraps its own session/routing failures (e.g. a
 * "no ready cookies" session-pool exhaustion for a geo) in an HTTP 200
 * envelope with an empty `body` — not a rate limit, not truncation, just
 * "this attempt got no page". Surface it with its real cause instead of
 * letting downstream code try to double-parse an empty body string.
 */
function proxySessionError(data) {
  const brdError = data?.headers?.["x-brd-error"] || data?.headers?.["x-brd-error-code"];
  const statusCode = data?.status_code;
  const bodyEmpty = data?.body === "" || data?.body === undefined;
  if (brdError && bodyEmpty) return brdError;
  if (statusCode && statusCode >= 400 && bodyEmpty) return `proxy status ${statusCode}`;
  return null;
}

function buildGoogleSearchUrl(query, { geo = "in", aiOverview = true } = {}) {
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

function isRetryableHttpStatus(status) {
  return status === 429 || status >= 500;
}

function isRateLimitResponse(data) {
  // Bright Data quota/rate-limit signals: explicit error messages,
  // 429 status from the zone proxy, or a nil/empty body for rate-limited zones.
  const msg = String(data?.error || data?.message || "").toLowerCase();
  if (msg.includes("rate limit") || msg.includes("too many requests") || msg.includes("quota")) {
    return true;
  }
  if (data?.status_code === 429) return true;
  if (data?.status === "rate_limited") return true;
  return false;
}

function innerBody(data) {
  // Bright Data wraps the Google SERP response inside data.body as a JSON
  // string. Parse it if present so truncation checks operate on the actual
  // SERP object, not the outer string.
  if (!data) return null;
  if (data.body && typeof data.body === "string") {
    try { return JSON.parse(data.body); } catch (_) { return data.body; }
  }
  if (data.body && typeof data.body === "object") return data.body;
  // No body wrapper — the SERP data sits directly on `data` (legacy zone configs).
  return data;
}

function bodyLooksTruncated(body, wantAio) {
  if (!body) return true;
  if (!wantAio) return false;
  // Google always returns at least organic + general for any valid SERP
  // response. If none of the expected sections are present and AI Overview was
  // requested but is missing, the proxy likely truncated the stream.
  const hasOrganic = Array.isArray(body.organic) && body.organic.length > 0;
  const hasGeneral = !!(body.general && body.general.query);
  const hasPaa = Array.isArray(body.people_also_ask) && body.people_also_ask.length > 0;
  const hasAio = !!body.ai_overview;
  return !hasOrganic && !hasGeneral && !hasPaa && !hasAio;
}

export async function brightDataSearch(query, options = {}) {
  const config = await getBrightDataConfig();
  if (!config) {
    throw new Error("Bright Data SERP is not configured (set BRIGHTDATA_API_KEY).");
  }

  const geo = process.env.SERP_GEO || "in";
  const timeoutMs = options.timeout || 60000;
  const maxAttempts = options.attempts ?? 2;
  const backoffMs = options.backoffMs ?? 3000;

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
          "Accept-Encoding": "identity",
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
        if (isRetryableHttpStatus(res.status) && attempt < maxAttempts) {
          lastErr = new Error(`Bright Data HTTP ${res.status}: ${errText.slice(0, 200)}`);
          const delay = res.status === 429 ? backoffMs * attempt * 3 : backoffMs * attempt;
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        throw new Error(`Bright Data HTTP ${res.status}: ${errText.slice(0, 200)}`);
      }

      const raw = await res.text();

      // HTML proxy error pages are transient — retry once.
      const trimmed = raw.trimStart();
      if (trimmed.startsWith("<") || trimmed.startsWith("<!DOCTYPE")) {
        if (attempt < maxAttempts) {
          lastErr = new Error(`Bright Data returned a non-JSON response (${raw.slice(0, 80)}...)`);
          await new Promise((r) => setTimeout(r, backoffMs * attempt * 2));
          continue;
        }
        throw new Error(`Bright Data returned an HTML proxy page instead of JSON.`);
      }

      let data;
      try {
        data = JSON.parse(raw);
      } catch (parseErr) {
        // Truncated JSON (stream cut mid-response) is transient — retry.
        if (attempt < maxAttempts) {
          lastErr = new Error(`Bright Data response was not valid JSON: ${parseErr.message}`);
          await new Promise((r) => setTimeout(r, backoffMs * attempt * 2));
          continue;
        }
        throw new Error(`Bright Data response was not valid JSON: ${parseErr.message}`);
      }

      // Rate-limit detection — stop retrying immediately.
      if (isRateLimitResponse(data)) {
        throw new Error(
          `Bright Data rate limit / quota exhausted — ${data.error || data.message || "try again later"}`
        );
      }

      if (data.error || data.status === "error") {
        throw new Error(data.error || data.message || "Bright Data request failed");
      }

      // Proxy-level session failure (e.g. "no_ready_cookies") — retryable,
      // but must not fall through to normalizeBrightDataResponse on an empty body.
      const sessionErr = proxySessionError(data);
      if (sessionErr) {
        if (attempt < maxAttempts) {
          lastErr = new Error(`Bright Data proxy session error: ${sessionErr}`);
          await new Promise((r) => setTimeout(r, backoffMs * attempt * 2));
          continue;
        }
        throw new Error(`Bright Data proxy session error: ${sessionErr}`);
      }

      // Check actual SERP body for truncation (parse inner body first).
      const parsed = innerBody(data);
      const wantAio = options.aiOverview !== false;
      if (bodyLooksTruncated(parsed, wantAio) && attempt < maxAttempts) {
        lastErr = new Error("Bright Data returned a truncated/empty AIO response");
        await new Promise((r) => setTimeout(r, backoffMs * attempt * 3));
        continue;
      }

      return normalizeBrightDataResponse(data);
    } catch (err) {
      clearTimeout(timeoutId);
      lastErr = err;

      // Rate-limit errors are not retryable — throw immediately.
      const msg = (err.message || "").toLowerCase();
      if (msg.includes("rate limit") || msg.includes("quota")) throw err;

      const isAbort = err.name === "AbortError" || /abort/i.test(err.message || "");
      const is5xx = /HTTP 5\d\d/.test(err.message || "");
      const isHtml = /non-JSON response/.test(err.message || "");
      const isJsonErr = /not valid JSON/.test(err.message || "");
      const isTruncation = /truncated/.test(err.message || "");
      if ((isAbort || is5xx || isHtml || isJsonErr || isTruncation) && attempt < maxAttempts) {
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

/**
 * Extracts top organic search results from Bright Data SERP response.
 * The data is already unwrapped by normalizeBrightDataResponse so organic
 * sits directly on the object.
 */
export function extractBrightDataOrganic(data) {
  const organic = Array.isArray(data?.organic) ? data.organic : [];
  return organic.slice(0, 10).map((result, i) => ({
    position: result.position || result.rank || i + 1,
    href: result.link || result.href || "",
    domain: (result.domain || "").replace(/^www\./i, ""),
    title: result.title || "",
  }));
}
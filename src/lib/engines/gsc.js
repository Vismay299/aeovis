import crypto from "crypto";

/**
 * Google Search Console (Search Analytics) client — service-account auth.
 *
 * Auth model: the client adds our service-account email as a Restricted user
 * on their Search Console property (Settings -> Users and permissions). No
 * OAuth flow, no per-client secrets. We sign a JWT with the service account's
 * private key and exchange it for a short-lived access token.
 *
 * Env: GSC_SERVICE_ACCOUNT_KEY — the service account's JSON key, either as
 * raw JSON or base64-encoded (easier to keep on one line in .env.local).
 */

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API_BASE = "https://searchconsole.googleapis.com/webmasters/v3";
const SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";

let cachedToken = null; // { accessToken, expiresAt }

export function getGscServiceAccount() {
  const raw = (process.env.GSC_SERVICE_ACCOUNT_KEY || "").trim();
  if (!raw) return null;

  let jsonText = raw;
  if (!raw.startsWith("{")) {
    // Assume base64-encoded JSON key.
    try {
      jsonText = Buffer.from(raw, "base64").toString("utf8");
    } catch {
      return null;
    }
  }

  try {
    const key = JSON.parse(jsonText);
    if (!key.client_email || !key.private_key) return null;
    // .env single-line keys carry literal \n sequences — restore real newlines.
    key.private_key = key.private_key.replace(/\\n/g, "\n");
    return key;
  } catch {
    return null;
  }
}

function base64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function getAccessToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.accessToken;
  }

  const account = getGscServiceAccount();
  if (!account) {
    throw new Error(
      "GSC is not configured (set GSC_SERVICE_ACCOUNT_KEY to the service account JSON key, raw or base64)."
    );
  }

  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({
      iss: account.client_email,
      scope: SCOPE,
      aud: TOKEN_URL,
      iat: now,
      exp: now + 3600,
    })
  );

  const signer = crypto.createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  const signature = signer
    .sign(account.private_key, "base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${header}.${claims}.${signature}`,
    }),
  });

  if (!res.ok) {
    throw new Error(`GSC token exchange failed: HTTP ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  cachedToken = {
    accessToken: data.access_token,
    expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
  };
  return cachedToken.accessToken;
}

async function gscFetch(path, options = {}) {
  const token = await getAccessToken();
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  if (!res.ok) {
    const body = await res.text();
    if (res.status === 403) {
      throw new Error(
        `GSC access denied for ${path} — has the service-account email been added as a user on this property? (${body.slice(0, 200)})`
      );
    }
    throw new Error(`GSC HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  return res.json();
}

/** Lists every Search Console property the service account can read. */
export async function listGscSites() {
  const data = await gscFetch("/sites");
  return (data.siteEntry || []).map((s) => ({
    siteUrl: s.siteUrl,
    permissionLevel: s.permissionLevel,
  }));
}

/**
 * Given a bare domain or URL, returns the candidate GSC property identifiers
 * to try, in preference order: domain property first, then URL-prefix.
 */
export function candidateSiteUrls(input) {
  const trimmed = String(input || "").trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("sc-domain:")) return [trimmed];

  let host = trimmed;
  try {
    host = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`).hostname;
  } catch {
    // keep as-is
  }
  const bare = host.replace(/^www\./, "");

  return [
    `sc-domain:${bare}`,
    `https://${bare}/`,
    `https://www.${bare}/`,
    `http://${bare}/`,
  ];
}

/**
 * Pulls top search queries for a property from the Search Analytics API.
 *
 * @param {string} siteUrl - GSC property id ("sc-domain:example.com" or "https://example.com/")
 * @param {Object} opts - { days = 90, rowLimit = 5000 }
 * @returns rows: [{ query, clicks, impressions, ctr, position }]
 */
export async function fetchSearchQueries(siteUrl, opts = {}) {
  const days = opts.days || 90;
  const rowLimit = Math.min(opts.rowLimit || 5000, 25000);

  const end = new Date();
  // GSC data lags ~2 days; end the window there to avoid empty tail days.
  end.setDate(end.getDate() - 2);
  const start = new Date(end);
  start.setDate(start.getDate() - days);

  const fmt = (d) => d.toISOString().slice(0, 10);

  const data = await gscFetch(
    `/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
    {
      method: "POST",
      body: JSON.stringify({
        startDate: fmt(start),
        endDate: fmt(end),
        dimensions: ["query"],
        rowLimit,
      }),
    }
  );

  return (data.rows || []).map((r) => ({
    query: r.keys?.[0] || "",
    clicks: r.clicks || 0,
    impressions: r.impressions || 0,
    ctr: r.ctr || 0,
    position: r.position || 0,
  }));
}

/**
 * Per-day, per-query Search Analytics rows for an explicit date window,
 * paginated until Google returns a short page (R4.1.1 weekly ingest).
 *
 * @param {string} siteUrl - GSC property id
 * @param {{startDate: string, endDate: string, pageSize?: number, maxRows?: number}} opts
 *   dates as YYYY-MM-DD, inclusive. maxRows bounds a runaway property.
 * @returns {Promise<{rows: Array<{date: string, query: string, clicks: number,
 *   impressions: number, ctr: number, position: number}>, truncated: boolean}>}
 *   truncated=true means maxRows was hit and rows is NOT the whole window.
 */
export async function fetchDailyQueryRows(siteUrl, opts = {}) {
  const { startDate, endDate } = opts;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate || "") || !/^\d{4}-\d{2}-\d{2}$/.test(endDate || "")) {
    throw new Error(`fetchDailyQueryRows needs YYYY-MM-DD startDate/endDate, got ${startDate}..${endDate}`);
  }
  const pageSize = Math.min(opts.pageSize || 25000, 25000);
  const maxRows = opts.maxRows || 250000;

  const rows = [];
  for (let startRow = 0; ; startRow += pageSize) {
    const data = await gscFetch(`/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`, {
      method: "POST",
      body: JSON.stringify({
        startDate,
        endDate,
        dimensions: ["date", "query"],
        rowLimit: pageSize,
        startRow,
      }),
    });
    const page = data.rows || [];
    for (const r of page) {
      rows.push({
        date: r.keys?.[0] || "",
        query: r.keys?.[1] || "",
        clicks: r.clicks || 0,
        impressions: r.impressions || 0,
        ctr: r.ctr || 0,
        position: r.position || 0,
      });
    }
    if (page.length < pageSize) return { rows, truncated: false };
    if (rows.length >= maxRows) return { rows, truncated: true };
  }
}

/**
 * Convenience: resolve a brand URL to whichever property the service account
 * can actually read, then pull its queries. Returns { siteUrl, rows }.
 */
export async function fetchSearchQueriesForUrl(input, opts = {}) {
  const candidates = candidateSiteUrls(input);
  let lastErr = null;
  for (const siteUrl of candidates) {
    try {
      const rows = await fetchSearchQueries(siteUrl, opts);
      return { siteUrl, rows };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error(`No accessible GSC property found for "${input}".`);
}

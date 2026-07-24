import { NextResponse } from "next/server";
import { AI_BOTS } from "@/lib/crawlers/bots";
import { auditDomain } from "@/lib/crawlers/robots";
import { extractBrandDomain } from "@/lib/scoring/citations";

// A live audit hits the brand's own (and rivals') robots.txt on every call —
// never statically cache (same reasoning as the sibling metrics/schedule
// routes: this must always reflect the site's CURRENT robots.txt, not a
// build-time snapshot).
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const FETCH_TIMEOUT_MS = 8000;
const LLMS_TXT_TIMEOUT_MS = 6000;
const MAX_COMPARE_DOMAINS = 5;
const CRAWLABILITY_USER_AGENT =
  "Mozilla/5.0 (compatible; PerceevCrawlabilityAudit/1.0; +https://perceev.ai)";

/**
 * GET /api/brands/[brand]/crawlability — plan.md P5.
 *
 * Brand-keying contract: identical to metrics/schedule — the `[brand]` path
 * param is ALREADY a resolveBrandKey() domain (see src/lib/scoring/brandKey.js);
 * used verbatim (decoded) here, and — unlike the DB-backed routes — also used
 * literally as the hostname to fetch `https://{domain}/robots.txt` from.
 *
 * Query params (all optional):
 *   url     — a path to test instead of "/" (e.g. "/blog/post-1"). A full
 *             URL is also accepted; only its pathname+search is used.
 *   compare — comma-separated rival domains (or full URLs — parsed the same
 *             way brand domains are elsewhere via extractBrandDomain) to
 *             audit alongside the primary brand, capped at 5.
 *
 * Response 200: {
 *   brand, domain, url,
 *   fetched_ok, robots_txt_status ("found"|"missing"|"error"), robots_malformed, fetch_error,
 *   llms_txt_present,
 *   summary: { open, partial, blocked, total },
 *   bots: [{ name, operator, platform, purpose, status, matchedGroup, reason }],
 *   compare: [{ domain, fetched_ok, summary }],
 * }
 *
 * Fail-safe by design: an unreachable domain, a missing robots.txt (404), or
 * an unparseable robots.txt never throws — each degrades to a well-defined,
 * clearly-flagged state (see fetchRobotsTxt/auditOneDomain below) so the
 * route always returns 200 with a usable payload instead of a 500 for what
 * is normal, expected variance across real websites.
 *
 * Errors: 400 on a missing/non-domain-shaped brand; 500 only on a genuine
 * unexpected failure in this route's own logic (never echoes raw errors).
 */
export async function GET(request, { params }) {
  try {
    const { brandKey, error: brandError } = requireBrandKey(params);
    if (brandError) {
      return NextResponse.json({ error: brandError }, { status: 400 });
    }
    const domain = brandKey.toLowerCase();
    if (!isSafeDomain(domain)) {
      return NextResponse.json(
        { error: "Brand must resolve to a valid public domain to audit crawlability." },
        { status: 400 }
      );
    }

    const { searchParams } = new URL(request.url);
    const testPath = normalizeTestPath(searchParams.get("url"));
    const compareDomains = parseCompareDomains(searchParams.get("compare"), domain);

    let primary;
    try {
      primary = await auditOneDomain(domain, testPath);
    } catch (err) {
      console.error(`Error auditing crawlability for "${domain}":`, err);
      return NextResponse.json({ error: "Failed to audit crawlability." }, { status: 500 });
    }

    let compare = [];
    if (compareDomains.length) {
      compare = await Promise.all(
        compareDomains.map(async (rivalDomain) => {
          try {
            const rival = await auditOneDomain(rivalDomain, testPath);
            return { domain: rivalDomain, fetched_ok: rival.fetched_ok, summary: rival.summary };
          } catch (err) {
            console.error(`Error auditing compare domain "${rivalDomain}":`, err);
            return {
              domain: rivalDomain,
              fetched_ok: false,
              summary: { open: 0, partial: 0, blocked: 0, total: AI_BOTS.length },
            };
          }
        })
      );
    }

    return NextResponse.json(
      {
        brand: domain,
        domain,
        url: testPath,
        fetched_ok: primary.fetched_ok,
        robots_txt_status: primary.robots_txt_status,
        robots_malformed: primary.robots_malformed,
        fetch_error: primary.fetch_error,
        llms_txt_present: primary.llms_txt_present,
        summary: primary.summary,
        bots: primary.bots,
        compare,
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    console.error("Error in GET /api/brands/[brand]/crawlability:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function requireBrandKey(params) {
  const { brand } = params || {};
  if (!brand) return { brandKey: null, error: "Brand is required." };
  let brandKey;
  try {
    brandKey = decodeURIComponent(brand);
  } catch {
    return { brandKey: null, error: "Brand is required." };
  }
  if (!brandKey.trim()) return { brandKey: null, error: "Brand is required." };
  return { brandKey: brandKey.trim(), error: null };
}

/**
 * Light shape + SSRF guard. This route turns the brand/compare values
 * directly into a fetch target (`https://{domain}/robots.txt`), unlike the
 * DB-backed brand routes where the key is only ever an opaque lookup string —
 * so, unlike those routes, a minimal hostname sanity check belongs here.
 */
function isSafeDomain(domain) {
  if (!domain || typeof domain !== "string") return false;
  const d = domain.trim().toLowerCase();
  if (!d || /\s/.test(d) || d.includes("://") || d.includes("@") || d.includes("/")) return false;
  if (["localhost", "127.0.0.1", "0.0.0.0", "::1"].includes(d)) return false;
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(d)) return false; // literal private IPv4
  if (!/^[a-z0-9.-]+$/i.test(d)) return false;
  if (!d.includes(".")) return false; // require a real-looking hostname
  return true;
}

/** Accepts a bare path, a path missing its leading slash, or a full URL — always returns a leading-slash path. */
function normalizeTestPath(raw) {
  if (!raw) return "/";
  let value = String(raw).trim();
  if (!value) return "/";
  if (/^https?:\/\//i.test(value)) {
    try {
      const u = new URL(value);
      value = `${u.pathname}${u.search}` || "/";
    } catch {
      // not actually a valid URL despite the scheme prefix — fall through and treat as a literal path
    }
  }
  if (!value.startsWith("/")) value = `/${value}`;
  return value;
}

function parseCompareDomains(raw, primaryDomain) {
  if (!raw) return [];
  const seen = new Set([primaryDomain]);
  const out = [];
  for (const part of String(raw).split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const candidate = extractBrandDomain(trimmed) || trimmed.toLowerCase();
    if (!candidate || seen.has(candidate) || !isSafeDomain(candidate)) continue;
    seen.add(candidate);
    out.push(candidate);
    if (out.length >= MAX_COMPARE_DOMAINS) break;
  }
  return out;
}

/**
 * Fetches `https://{domain}/robots.txt`.
 *
 * Deliberately does not gate on Content-Type: a non-text response (an HTML
 * error page, a binary blob) simply produces text that parseRobotsTxt's own
 * "no recognizable directive" heuristic flags as malformed — one fail-safe
 * path instead of two, and the caller still gets a clear, flagged result
 * either way.
 */
async function fetchRobotsTxt(domain) {
  const url = `https://${domain}/robots.txt`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": CRAWLABILITY_USER_AGENT },
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (res.status === 404) {
      return { ok: true, text: "", status: 404 };
    }
    if (!res.ok) {
      return { ok: false, text: "", status: res.status, error: `http_${res.status}` };
    }
    const text = await res.text();
    return { ok: true, text, status: res.status };
  } catch (err) {
    const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
    return { ok: false, text: "", status: null, error: timedOut ? "timeout" : "network_error" };
  }
}

/** HEAD (falling back to GET) for llms.txt — any 2xx counts as present. Never throws. */
async function checkLlmsTxt(domain) {
  const url = `https://${domain}/llms.txt`;
  try {
    let res = await fetch(url, {
      method: "HEAD",
      headers: { "User-Agent": CRAWLABILITY_USER_AGENT },
      signal: AbortSignal.timeout(LLMS_TXT_TIMEOUT_MS),
    });
    if (res.status === 405 || res.status === 501) {
      // Some servers reject HEAD outright — retry with GET before giving up.
      res = await fetch(url, {
        method: "GET",
        headers: { "User-Agent": CRAWLABILITY_USER_AGENT },
        signal: AbortSignal.timeout(LLMS_TXT_TIMEOUT_MS),
      });
    }
    return res.ok;
  } catch {
    return false;
  }
}

async function auditOneDomain(domain, testPath) {
  const [fetchResult, llmsTxtPresent] = await Promise.all([fetchRobotsTxt(domain), checkLlmsTxt(domain)]);

  const { results, summary, malformed } = auditDomain(fetchResult.text || "", AI_BOTS, testPath);

  return {
    domain,
    fetched_ok: fetchResult.ok,
    robots_txt_status: fetchResult.status === 404 ? "missing" : fetchResult.ok ? "found" : "error",
    robots_malformed: !!malformed,
    fetch_error: fetchResult.ok ? null : fetchResult.error || "network_error",
    llms_txt_present: llmsTxtPresent,
    summary,
    bots: results.map((r) => ({
      name: r.name,
      operator: r.operator,
      platform: r.platform,
      purpose: r.purpose,
      status: r.status,
      matchedGroup: r.matchedGroup,
      reason: r.reason,
      unknown: !!r.unknown,
    })),
  };
}

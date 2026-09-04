import { NextResponse } from "next/server";
import { AI_BOTS } from "@/lib/crawlers/bots";
import { auditDomain } from "@/lib/crawlers/robots";
import { extractBrandDomain } from "@/lib/scoring/citations";
import {
  SsrfBlockedError,
  bareHostname,
  classifyAddress,
  isPolicyRefusal,
  normalizeTargetUrl,
  safeFetch,
} from "@/lib/ssrfGuard";

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
 * One message for every refusal, whatever the reason. Deliberately says nothing
 * about whether the name resolved, what it resolved to, or which range it fell
 * in — the reason code is a log line, not a response body, because the response
 * body is an oracle an attacker can query.
 */
const BLOCKED_DOMAIN_MESSAGE =
  "Brand must resolve to a valid public domain to audit crawlability.";

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
 *   compare: [{ domain, fetched_ok, blocked, fetch_error, summary }],
 * }
 *
 * Fail-safe by design: an unreachable domain, a missing robots.txt (404), or
 * an unparseable robots.txt never throws — each degrades to a well-defined,
 * clearly-flagged state (see fetchRobotsTxt/auditOneDomain below) so the
 * route always returns 200 with a usable payload instead of a 500 for what
 * is normal, expected variance across real websites.
 *
 * SSRF (R3.7.4, finding C12): the `[brand]` param and every `compare` entry
 * become a server-side fetch target, and POST /api/scan is anonymous, so this
 * is a stranger-controlled URL. Two gates, both src/lib/ssrfGuard.js:
 *   1. screenDomain() — shape plus classifyAddress(), no DNS, gives a 400.
 *   2. safeFetch() — resolves the name and checks EVERY answer, then follows
 *      redirects by hand and re-validates each hop.
 * A refusal is NOT fail-safe variance: it never degrades to `fetched_ok: false`
 * with an all-open summary, because an empty robots.txt reads as "every
 * crawler welcome" and a refusal would render as a perfect score.
 *
 * STILL OPEN, and this route inherits it: TOCTOU / DNS rebinding at connect
 * time. safeFetch() resolves the hostname and vets every address, then hands
 * the NAME to fetch(), which resolves it a second time; a 0-TTL attacker can
 * answer public first and private second. Narrowed (a statically-private name
 * is refused and the window is milliseconds), not closed. Closing it needs the
 * vetted address pinned at connect time — an undici Dispatcher whose
 * `connect.lookup` only returns addresses the guard approved, or a raw
 * node:http(s) request with `lookup` + `servername` and manual redirects.
 * undici is not a declared dependency and Next's global fetch is not swappable
 * per call, so it is recorded rather than faked. Full write-up:
 * src/lib/ssrfGuard.js:28-49.
 *
 * Errors: 400 on a missing/non-domain-shaped brand and on any policy refusal;
 * 500 only on a genuine unexpected failure in this route's own logic (never
 * echoes raw errors).
 *
 * @param {Request} request
 * @param {{ params: { brand: string } }} context
 * @param {{ lookup?: Function, fetchImpl?: Function }} [deps] injected by tests
 *        so the suite makes no DNS query and no network call. Next.js only ever
 *        passes two arguments; this is the same seam scrapeForSummary() uses.
 */
export async function GET(request, { params }, deps = {}) {
  try {
    const { brandKey, error: brandError } = requireBrandKey(params);
    if (brandError) {
      return NextResponse.json({ error: brandError }, { status: 400 });
    }
    const domain = brandKey.toLowerCase();
    const screened = screenDomain(domain);
    if (!screened.ok) {
      console.warn(`[crawlability] refused brand domain "${domain}": ${screened.reason}`);
      return NextResponse.json({ error: BLOCKED_DOMAIN_MESSAGE }, { status: 400 });
    }

    const { searchParams } = new URL(request.url);
    const testPath = normalizeTestPath(searchParams.get("url"));
    const { targets: compareTargets, refused: refusedCompare } = parseCompareDomains(
      searchParams.get("compare"),
      domain
    );

    let primary;
    try {
      primary = await auditOneDomain(domain, screened.origin, testPath, deps);
    } catch (err) {
      console.error(`Error auditing crawlability for "${domain}":`, err);
      return NextResponse.json({ error: "Failed to audit crawlability." }, { status: 500 });
    }

    // The guard refused the target at DNS or at a redirect hop — something the
    // cheap screen above cannot see. Reporting 200 here would be the worst
    // possible answer: robots.txt came back empty, and an empty robots.txt
    // means "every crawler is open", so a refusal would render as a perfect
    // score. It is the caller's URL that is the problem, so 400.
    if (primary.blocked) {
      return NextResponse.json({ error: BLOCKED_DOMAIN_MESSAGE }, { status: 400 });
    }

    const audited = await Promise.all(
      compareTargets.map(async ({ domain: rivalDomain, origin }) => {
        try {
          const rival = await auditOneDomain(rivalDomain, origin, testPath, deps);
          if (rival.blocked) {
            return {
              domain: rivalDomain,
              fetched_ok: false,
              blocked: true,
              fetch_error: "blocked",
              summary: unauditedSummary(),
            };
          }
          return {
            domain: rivalDomain,
            fetched_ok: rival.fetched_ok,
            blocked: false,
            fetch_error: rival.fetch_error,
            summary: rival.summary,
          };
        } catch (err) {
          console.error(`Error auditing compare domain "${rivalDomain}":`, err);
          return {
            domain: rivalDomain,
            fetched_ok: false,
            blocked: false,
            fetch_error: "network_error",
            summary: unauditedSummary(),
          };
        }
      })
    );

    const compare = [
      ...audited,
      ...refusedCompare.map(({ domain: rivalDomain }) => ({
        domain: rivalDomain,
        fetched_ok: false,
        blocked: true,
        fetch_error: "blocked",
        summary: unauditedSummary(),
      })),
    ];

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
 * Screens a brand/compare value that is about to BECOME a fetch target
 * (`https://{domain}/robots.txt`), unlike the DB-backed brand routes where the
 * key is only ever an opaque lookup string.
 *
 * This is gate one of two, and it owns NO address knowledge of its own — every
 * range decision is delegated to classifyAddress() in src/lib/ssrfGuard.js.
 * The denylist that used to live here (four string literals plus one regex for
 * 10/8, 192.168/16 and 172.16/12) was deleted in R3.7.4: it allowed
 * 169.254.169.254, 127.0.0.2, 127.1, 0177.0.0.1, 100.64.0.1, 198.18.0.1 and
 * 224.0.0.1 — 7 of 11 adversarial hosts — and a second, weaker copy of a
 * decision the guard already makes is a trap, not a defence. Do not add one
 * back here; add the range to IPV4_BLOCKED/classifyIpv6 instead.
 *
 * What this gate DOES decide is shape: a brand key must be a hostname, not a
 * URL with a path, credentials, a query or a non-https scheme, and not a
 * single-label name that a DNS search domain could expand into an intranet
 * host. It runs no DNS, so it is cheap and gives a 400 rather than a hung
 * request. Gate two is safeFetch() below, which resolves the name, checks
 * EVERY address it answers with, and re-validates every redirect hop.
 *
 * @returns {{ ok: boolean, reason: string|null, origin: string|null }}
 *          `origin` is the normalized `https://host[:port]` to build paths on
 *          — never interpolate the raw input into a URL string.
 */
function screenDomain(domain) {
  if (typeof domain !== "string") return { ok: false, reason: "malformed", origin: null };
  const raw = domain.trim().toLowerCase();
  // Reject the URL-ish shapes before normalizeTargetUrl can quietly absorb
  // them into a path/query/userinfo we would then throw away.
  if (!raw || /[\s/@?#\\]/.test(raw)) return { ok: false, reason: "malformed", origin: null };

  let url;
  try {
    url = normalizeTargetUrl(raw);
  } catch (error) {
    if (error instanceof SsrfBlockedError) return { ok: false, reason: error.code, origin: null };
    throw error;
  }
  // A brand key is a bare hostname, so normalizeTargetUrl's https upgrade is
  // the only protocol we can arrive at; anything else means the input carried
  // its own scheme.
  if (url.protocol !== "https:") return { ok: false, reason: "scheme", origin: null };

  const host = bareHostname(url);
  const verdict = classifyAddress(host);
  if (verdict.blocked) return { ok: false, reason: verdict.reason, origin: null };
  // Not an IP literal in any notation, so it must look like a real registered
  // name. "localhost", "metadata" and friends never get a DNS query out of us.
  if (!verdict.ip && !host.includes(".")) return { ok: false, reason: "not_a_domain", origin: null };

  return { ok: true, reason: null, origin: url.origin };
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

/**
 * Splits the `compare` param into auditable rivals plus the ones we refused.
 *
 * A refused rival is RETURNED, not dropped. It used to be filtered out
 * silently, so a caller comparing five rivals could get four rows back and
 * nothing anywhere saying the fifth had been screened out — an empty state
 * that looked like a clean one (rule 1). Refused rivals come back as ordinary
 * compare rows carrying `blocked: true`, which the UI already renders as a
 * "couldn't reach" state rather than as a score.
 *
 * @returns {{ targets: {domain: string, origin: string}[], refused: {domain: string, reason: string}[] }}
 */
function parseCompareDomains(raw, primaryDomain) {
  if (!raw) return { targets: [], refused: [] };
  const seen = new Set([primaryDomain]);
  const targets = [];
  const refused = [];
  for (const part of String(raw).split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const candidate = extractBrandDomain(trimmed) || trimmed.toLowerCase();
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    const screened = screenDomain(candidate);
    if (!screened.ok) {
      console.warn(`[crawlability] refused compare domain "${candidate}": ${screened.reason}`);
      refused.push({ domain: candidate, reason: screened.reason });
    } else {
      targets.push({ domain: candidate, origin: screened.origin });
    }
    if (targets.length + refused.length >= MAX_COMPARE_DOMAINS) break;
  }
  return { targets, refused };
}

/** The summary shape used when we have no audited answer at all — never a score. */
function unauditedSummary() {
  return { open: 0, partial: 0, blocked: 0, total: AI_BOTS.length };
}

/**
 * Turns a thrown fetch failure into the state the response has to show.
 *
 * The three outcomes must not be collapsed into one, because they mean
 * different things to the caller and to us:
 *   - `blocked`   — we REFUSED this on purpose (metadata range, a name that
 *                   resolves inward, a redirect hop into a private range).
 *                   Never reported as "we couldn't reach the site": a security
 *                   refusal that looks like a flaky network is a refusal
 *                   nobody ever investigates.
 *   - `unresolved`— SsrfBlockedError with an UNUSABLE code (NXDOMAIN, empty
 *                   answer). The customer's domain is a typo or is dead. Not a
 *                   security event, and it must not turn into one.
 *   - timeout / network_error — the ordinary, expected variance this route was
 *                   already designed to survive.
 */
function classifyFetchFailure(err, target) {
  if (isPolicyRefusal(err)) {
    // Logged, never echoed: err.message names the address it resolved to.
    console.error(`[ssrf-guard] refused crawlability target ${target} (${err.code}): ${err.message}`);
    return { ok: false, blocked: true, text: "", status: null, error: "blocked" };
  }
  if (err instanceof SsrfBlockedError) {
    console.warn(`[ssrf-guard] unusable crawlability target ${target} (${err.code}): ${err.message}`);
    return { ok: false, blocked: false, text: "", status: null, error: "unresolved" };
  }
  const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
  return { ok: false, blocked: false, text: "", status: null, error: timedOut ? "timeout" : "network_error" };
}

/**
 * Fetches `{origin}/robots.txt` through the SSRF guard.
 *
 * safeFetch() forces `redirect: "manual"` and re-runs the full address check on
 * every hop, so an attacker's robots.txt can no longer 302 us into the metadata
 * range — the hole this route shipped with. Do not pass `redirect` here; a raw
 * fetch with `redirect: "follow"` is exactly the bug.
 *
 * Deliberately does not gate on Content-Type: a non-text response (an HTML
 * error page, a binary blob) simply produces text that parseRobotsTxt's own
 * "no recognizable directive" heuristic flags as malformed — one fail-safe
 * path instead of two, and the caller still gets a clear, flagged result
 * either way.
 */
async function fetchRobotsTxt(origin, deps) {
  const url = `${origin}/robots.txt`;
  try {
    const res = await safeFetch(
      url,
      {
        headers: { "User-Agent": CRAWLABILITY_USER_AGENT },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      },
      deps
    );

    if (res.status === 404) {
      return { ok: true, blocked: false, text: "", status: 404 };
    }
    if (!res.ok) {
      return { ok: false, blocked: false, text: "", status: res.status, error: `http_${res.status}` };
    }
    const text = await res.text();
    return { ok: true, blocked: false, text, status: res.status };
  } catch (err) {
    return classifyFetchFailure(err, url);
  }
}

/**
 * HEAD (falling back to GET) for llms.txt — any 2xx counts as present.
 *
 * Never throws, but never reports a REFUSAL as an absence either: a blocked
 * target returns `present: null` and `blocked: true`, because "we were not
 * allowed to look" is not the same fact as "the file is not there" (rule 1).
 */
async function checkLlmsTxt(origin, deps) {
  const url = `${origin}/llms.txt`;
  const init = {
    headers: { "User-Agent": CRAWLABILITY_USER_AGENT },
    signal: AbortSignal.timeout(LLMS_TXT_TIMEOUT_MS),
  };
  try {
    let res = await safeFetch(url, { ...init, method: "HEAD" }, deps);
    if (res.status === 405 || res.status === 501) {
      // Some servers reject HEAD outright — retry with GET before giving up.
      res = await safeFetch(url, { ...init, method: "GET" }, deps);
    }
    return { present: res.ok, blocked: false };
  } catch (err) {
    const failure = classifyFetchFailure(err, url);
    return { present: failure.blocked ? null : false, blocked: failure.blocked };
  }
}

async function auditOneDomain(domain, origin, testPath, deps) {
  const [fetchResult, llmsTxt] = await Promise.all([
    fetchRobotsTxt(origin, deps),
    checkLlmsTxt(origin, deps),
  ]);

  const blocked = fetchResult.blocked || llmsTxt.blocked;
  const { results, summary, malformed } = auditDomain(fetchResult.text || "", AI_BOTS, testPath);

  return {
    domain,
    blocked,
    fetched_ok: fetchResult.ok,
    robots_txt_status: fetchResult.status === 404 ? "missing" : fetchResult.ok ? "found" : "error",
    robots_malformed: !!malformed,
    fetch_error: fetchResult.ok ? null : fetchResult.error || "network_error",
    llms_txt_present: llmsTxt.present,
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

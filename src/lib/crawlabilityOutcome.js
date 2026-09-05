/**
 * R3.7.7 (finding C12) — the words the crawlability UI uses for a rival that
 * produced no audit.
 *
 * R3.7.4 taught GET /api/brands/[brand]/crawlability to tell three failures
 * apart and carried the difference into every compare row:
 *
 *   { domain, fetched_ok, blocked, fetch_error, summary }
 *
 *   - blocked: true,  fetch_error: "blocked"        WE refused the target. Two
 *       paths produce it and they are deliberately indistinguishable to the
 *       client: parseCompareDomains() screened the name before any socket
 *       opened, or safeFetch() refused an address at DNS or at a redirect hop.
 *       (route.js:139-147 and :170-176.) The row's `summary` is the unaudited
 *       all-zero shape, NOT a score.
 *   - blocked: false, fetch_error: "unresolved"     DNS answered with nothing —
 *       NXDOMAIN or an empty answer. A typo or a dead competitor domain, not a
 *       security event, and it must never be dressed as one. (route.js:351-354.)
 *   - blocked: false, fetch_error: "timeout" | "network_error"   the ordinary
 *       variance this route was always built to survive. (route.js:355-356,
 *       and the catch at :155-164.)
 *   - blocked: false, fetch_error: "http_<status>"  the fourth shape the same
 *       route already emits (route.js:389) when robots.txt answers non-2xx. We
 *       DID reach the server, so calling it unreachable is the same lie in a
 *       smaller font; it gets its own words here.
 *
 * The UI rendered all of them as one line — "Unreachable — treated as fully
 * open, unverified" — so a security refusal was invisible at the only surface a
 * human looks at, and an operator who typed an internal address saw exactly
 * what an operator whose rival was merely down saw.
 *
 * COPY RULES THAT ARE NOT STYLE (this text is security-adjacent):
 *   1. A refusal must read as OUR decision. Never phrase it so the rival's
 *      server sounds broken, offline, or at fault.
 *   2. A refusal must say nothing about WHY. One message for every refusal —
 *      whether the name resolved, what it resolved to, and which range it fell
 *      in are log lines, never response text, because a response that varies is
 *      an oracle an attacker can query. That is the same reason route.js has a
 *      single BLOCKED_DOMAIN_MESSAGE (route.js:27-34), and the wording here
 *      stays at that same altitude.
 *   3. "unresolved" is the CUSTOMER'S typo. It must not be worded as a refusal,
 *      or every mistyped competitor looks like an attack.
 *
 * Kept out of the component so the strings can be executed by the suite: this
 * repo has no component-render harness (see degradedEngineBanner.test.mjs), so
 * a decision that lives inside JSX is a decision no test can read.
 */

// Relative, not "@/": `npm run test:scoring` is a bare `node --test` with no
// bundler resolving the alias, and every other module under src/lib imports
// this way for exactly that reason.
import { extractBrandDomain } from "./scoring/citations.js";

/**
 * Mirrors MAX_COMPARE_DOMAINS in
 * src/app/api/brands/[brand]/crawlability/route.js:23. Duplicated rather than
 * imported because a client component must not pull in a server route module.
 * The drift is not left to trust: crawlabilityRivalOutcome.test.mjs reads the
 * route source and fails if the two numbers stop matching.
 */
export const MAX_COMPARE_DOMAINS = 5;

/**
 * Describes a compare row whose audit did not happen, or returns null when the
 * row carries a real audit and should render its meter.
 *
 * @param {{ fetched_ok?: boolean, blocked?: boolean, fetch_error?: string|null }} row
 * @returns {{ kind: string, label: string, detail: string, tone: "crit"|"warn"|"muted" }|null}
 */
export function describeRivalCrawlOutcome(row) {
  if (!row || typeof row !== "object") {
    return {
      kind: "missing",
      label: "No result for this rival",
      detail: "The audit returned nothing for this domain. Refresh to try again.",
      tone: "muted",
    };
  }

  const fetchError = typeof row.fetch_error === "string" ? row.fetch_error : null;

  // Rule 1 above: the refusal is checked FIRST and on either signal, so a row
  // can never fall through into "couldn't reach" wording.
  if (row.blocked === true || fetchError === "blocked") {
    return {
      kind: "refused",
      label: "Not audited — we refused this domain",
      detail:
        "Perceev only audits rivals that resolve to a valid public domain, so this one was never fetched. " +
        "That is our decision, not a fault with the site.",
      tone: "crit",
    };
  }

  if (row.fetched_ok === true) return null;

  if (fetchError === "unresolved") {
    return {
      kind: "unresolved",
      label: "Domain didn't resolve",
      detail: "DNS returned no address for this name — check the spelling on this competitor. Nothing was audited.",
      tone: "muted",
    };
  }

  const httpStatus = fetchError && /^http_(\d{3})$/.exec(fetchError);
  if (httpStatus) {
    return {
      kind: "http_error",
      label: `Its server answered ${httpStatus[1]}`,
      detail: "We reached the site, but robots.txt came back as an error, so nothing was audited.",
      tone: "warn",
    };
  }

  if (fetchError === "timeout") {
    return {
      kind: "timeout",
      label: "Couldn't reach it — timed out",
      detail: "Its robots.txt did not answer in time, so nothing was audited.",
      tone: "warn",
    };
  }

  return {
    kind: "network_error",
    label: "Couldn't reach it — network error",
    detail: "The request for its robots.txt failed, so nothing was audited.",
    tone: "warn",
  };
}

/**
 * Explains rivals the caller asked about that came back with no row at all.
 *
 * R3.7.4 made a refused rival CONSUME one of MAX_COMPARE_DOMAINS instead of
 * being skipped for free — deliberately, because a refusal is a result — so one
 * refused domain plus five good ones now yields four audits, and the sixth
 * name simply is not in the response. Showing four rows where the operator
 * asked for six is an empty state dressed as a clean one (standing rule 1), so
 * the difference between "asked for" and "came back" is stated, with the reason.
 *
 * @param {{ requested?: string[], compared?: Array<{domain?: string}>, primaryDomain?: string }} args
 * @returns {{ limit: number, dropped: {domain: string, reason: "self"|"budget"|"unmatched"}[], message: string }|null}
 */
export function describeCompareBudget({ requested, compared, primaryDomain } = {}) {
  const asked = normalizeDomainList(requested);
  if (asked.length === 0) return null;

  const returned = new Set(
    normalizeDomainList((Array.isArray(compared) ? compared : []).map((row) => row?.domain))
  );
  const you = normalizeDomain(primaryDomain);
  // Only blame the cap when the cap was actually reached. A domain missing from
  // a SHORT response was dropped for some other reason, and inventing "we only
  // audit five" for it would be a confident wrong answer where an honest vague
  // one is available.
  const capReached = returned.size >= MAX_COMPARE_DOMAINS;

  const dropped = [];
  for (const domain of asked) {
    if (returned.has(domain)) continue;
    const reason = domain === you ? "self" : capReached ? "budget" : "unmatched";
    dropped.push({ domain, reason });
  }
  if (dropped.length === 0) return null;

  const byReason = (reason) => dropped.filter((d) => d.reason === reason).map((d) => d.domain);
  const budgeted = byReason("budget");
  const self = byReason("self");
  const unmatched = byReason("unmatched");

  const sentences = [];
  if (budgeted.length) {
    sentences.push(
      `${formatList(budgeted)} ${budgeted.length === 1 ? "was" : "were"} not audited: this run compares at most ` +
        `${MAX_COMPARE_DOMAINS} rivals, and a domain we refuse still uses one of those ${MAX_COMPARE_DOMAINS} slots.`
    );
  }
  if (unmatched.length) {
    sentences.push(
      `${formatList(unmatched)} ${unmatched.length === 1 ? "was" : "were"} not audited: this run returned no result ` +
        `for ${unmatched.length === 1 ? "it" : "them"} at all.`
    );
  }
  if (self.length) {
    sentences.push(`${formatList(self)} is your own domain, so it is shown as "you" rather than as a rival.`);
  }

  return { limit: MAX_COMPARE_DOMAINS, dropped, message: sentences.join(" ") };
}

function normalizeDomain(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  return extractBrandDomain(trimmed) || trimmed.toLowerCase();
}

function normalizeDomainList(values) {
  if (!Array.isArray(values)) return [];
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const domain = normalizeDomain(value);
    if (!domain || seen.has(domain)) continue;
    seen.add(domain);
    out.push(domain);
  }
  return out;
}

function formatList(items) {
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

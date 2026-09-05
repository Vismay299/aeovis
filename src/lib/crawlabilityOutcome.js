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
 * Appended to every primary failure detail. When robots.txt was not read, the
 * bot table below is still fully populated — from the default-open assumption,
 * not from anything measured. A degraded read that does not say it is degraded
 * is the empty state dressed as a clean one, so this sentence is part of the
 * derivation and not something the JSX can forget to render.
 */
export const UNVERIFIED_NOTE =
  "Every crawler listed below is shown as default-open because your robots.txt was never read — those statuses are assumptions, not measurements.";

/**
 * R3.7.8 — the same distinction, one level up: the banner for the customer's OWN
 * domain.
 *
 * The compare rows learned to tell a refusal, a dead name, a timeout, a network
 * fault and a non-2xx robots.txt apart in R3.7.7. The primary banner did not: it
 * rendered one line — "Couldn't reach {domain}/robots.txt ({fetch_error with
 * underscores swapped for spaces})" — for every one of them. Two problems, and
 * the second is the one that costs the customer an afternoon:
 *
 *   1. The parenthetical was a machine slug leaking into written copy.
 *   2. "Couldn't reach" is a claim about the NETWORK. When the real fact is
 *      "DNS has no address for that name", it sends a customer who mistyped
 *      their own domain to go and check their server, their firewall and their
 *      CDN — all of which are fine. A typo is theirs to fix; a timeout or a
 *      blocked egress is OURS, and telling them apart is the whole point.
 *
 * WHY THIS IS A SECOND FUNCTION AND NOT describeRivalCrawlOutcome():
 *   - The payloads differ. The primary body has no `blocked` field at all
 *     (route.js:179-194) because a refused brand domain never reaches a 200 —
 *     it is a 400 (route.js:131-133) — whereas a refused RIVAL is a row.
 *   - The audience differs. A rival that does not resolve is "check the spelling
 *     on this competitor"; the customer's own domain not resolving means every
 *     number on the page is about a site that does not exist.
 *   - The consequence differs, and it has to be said out loud: when robots.txt
 *     was never read, the bot table below still lists every crawler as open.
 *     That is an assumption, not a measurement (standing rule 1), so
 *     UNVERIFIED_NOTE is appended to every failure detail rather than left to
 *     whoever writes the JSX.
 *
 * `actionable` is the fact the finding is actually about, exposed as data so QA
 * and the suite can read it without parsing prose: "you" = the customer can fix
 * this, "us" = they cannot and must not be sent looking.
 *
 * @param {{ domain?: string, fetched_ok?: boolean, blocked?: boolean, fetch_error?: string|null }} payload
 * @returns {{ kind: string, label: string, detail: string, tone: "crit"|"warn", actionable: "you"|"us" }|null}
 *          null when robots.txt really was read — there is nothing to warn about.
 */
export function describePrimaryCrawlOutcome(payload) {
  if (!payload || typeof payload !== "object") return null;
  if (payload.fetched_ok === true) return null;

  const site = typeof payload.domain === "string" && payload.domain.trim() ? payload.domain.trim() : "your domain";
  const fetchError = typeof payload.fetch_error === "string" ? payload.fetch_error : null;

  // Defence in depth: the route turns a refused brand domain into a 400 before
  // any of this renders (route.js:131-133), so this branch should be dead. It
  // exists because the alternative — falling through — would tell a customer
  // whose domain WE declined to fetch that their server is unreachable, which is
  // the exact lie this function was written to delete. Copy rules from the
  // header apply: our decision, and no reason given.
  if (payload.blocked === true || fetchError === "blocked") {
    return {
      kind: "refused",
      label: `We didn't fetch ${site}`,
      detail:
        `Perceev only audits domains that resolve to a valid public address, so ${site} was never requested. ` +
        `That is our decision, not a fault with the site. ${UNVERIFIED_NOTE}`,
      tone: "crit",
      actionable: "us",
    };
  }

  if (fetchError === "unresolved") {
    return {
      kind: "unresolved",
      // Deliberately never "couldn't reach": nothing was reached for, because
      // there was no address to reach.
      label: `${site} doesn't resolve — check the spelling`,
      detail:
        `DNS returned no address for this name, so there was no server to ask. This is usually a typo in the domain ` +
        `on file, or a name that is not registered or whose DNS has not been published yet — not an outage, and ` +
        `nothing to debug on your server. ${UNVERIFIED_NOTE}`,
      tone: "crit",
      actionable: "you",
    };
  }

  const httpStatus = fetchError && /^http_(\d{3})$/.exec(fetchError);
  if (httpStatus) {
    return {
      kind: "http_error",
      label: `${site} answered ${httpStatus[1]} for /robots.txt`,
      detail:
        `The name resolved and your server replied, so the domain is right — it returned an error status instead of ` +
        `a robots.txt file. ${UNVERIFIED_NOTE}`,
      tone: "warn",
      actionable: "you",
    };
  }

  if (fetchError === "timeout") {
    return {
      kind: "timeout",
      label: `${site} didn't answer in time`,
      detail:
        `The name resolved, so the domain is spelled right — the request for robots.txt ran out of time before a ` +
        `reply came back. Retry; nothing on your side needs changing to make this audit work. ${UNVERIFIED_NOTE}`,
      tone: "warn",
      actionable: "us",
    };
  }

  if (fetchError === "network_error") {
    return {
      kind: "network_error",
      label: `We couldn't reach ${site}`,
      detail:
        `The name resolved, so the domain is spelled right — the connection to it failed before any reply came ` +
        `back. That is a network fault between us and the server, not something to fix by editing your site. ` +
        `${UNVERIFIED_NOTE}`,
      tone: "warn",
      actionable: "us",
    };
  }

  // fetched_ok is not true and the route named no reason. route.js:439 always
  // supplies one, so this shape should be unreachable — which is exactly why it
  // must not be dressed as a known cause. Guessing "network error" here would
  // re-create the finding in a smaller font, and guessing "typo" would send the
  // customer after a problem we never observed. Say we do not know.
  return {
    kind: "unknown_error",
    label: `We couldn't read robots.txt on ${site}`,
    detail:
      `This audit reported a failure without a reason, so we can't tell you whether the domain is wrong or the ` +
      `request failed. Retry, and report it if it keeps happening. ${UNVERIFIED_NOTE}`,
    tone: "warn",
    actionable: "us",
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

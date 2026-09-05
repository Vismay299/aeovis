/**
 * R3.7.7 (finding C12) — the crawlability UI must not show a refused rival as
 * unreachable.
 *
 * R3.7.4 taught the route to tell three failures apart and put the difference
 * on every compare row. CrawlabilityView read `fetched_ok` and nothing else, so
 * all three collapsed into one line — "Unreachable — treated as fully open,
 * unverified". An operator who typed an internal address and an operator whose
 * rival was merely down saw identical text, which means a security refusal was
 * invisible at the only surface a human looks at.
 *
 * WHAT THIS FILE PROVES, AND HOW.
 *
 * This repo has no component-render harness — no jsdom, no testing-library;
 * `npm run test:scoring` is a bare `node --test` over .test.mjs (see
 * degradedEngineBanner.test.mjs, which says the same thing). So the proof is
 * split in two, and neither half is a stand-in for the API:
 *
 *   1. The rows are REAL. Every fixture below comes out of the actual route
 *      handler, driven through its `deps` seam with an injected lookup and
 *      fetch. Nothing here hand-writes what "the API emits"; if route.js
 *      changes the field names or values, these tests stop compiling their
 *      fixtures and fail. NO NETWORK AND NO DNS: every target is an IP literal
 *      the guard settles without a query, or an injected stub.
 *   2. The words are EXECUTED. describeRivalCrawlOutcome() is the one place the
 *      copy is decided, so the suite runs it on those real rows and asserts the
 *      three outcomes come back distinguishable — different kind, different
 *      label, different detail.
 *
 * A source guard over CrawlabilityView.jsx then proves the component defers to
 * that function instead of re-typing the old one-size line. The guard cannot
 * prove React mounted it; it CAN prove the three ways this fix could rot: the
 * import going away, the copy being re-inlined, and the row being narrowed back
 * to a bare `fetched_ok` boolean.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "node:module";

import {
  MAX_COMPARE_DOMAINS,
  describeCompareBudget,
  describeRivalCrawlOutcome,
} from "../../lib/crawlabilityOutcome.js";

register("../../lib/cronAuth.route.hooks.mjs", import.meta.url);

let importError = null;
let GET = null;
try {
  ({ GET } = await import("../../app/api/brands/[brand]/crawlability/route.js"));
} catch (error) {
  importError = error;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../..");
const VIEW_PATH = path.join(HERE, "CrawlabilityView.jsx");
const VIEW = readFileSync(VIEW_PATH, "utf8");
const ROUTE = readFileSync(
  path.join(REPO, "src/app/api/brands/[brand]/crawlability/route.js"),
  "utf8"
);

// ---------------------------------------------------------------------------
// Harness — same seam and same stub shapes as crawlabilitySsrf.route.test.mjs.
// ---------------------------------------------------------------------------

const BRAND = "brand-example.com";
const PUBLIC_ADDRESS = "93.184.216.34";

function textResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    async text() {
      return body;
    },
  };
}

/**
 * @param {{ compare?: string, lookup?: Function, fetchImpl?: Function }} opts
 * @returns {Promise<object>} the parsed 200 body
 */
async function auditBody({ compare, lookup, fetchImpl }) {
  assert.equal(importError, null, `route module failed to import: ${importError?.message}`);
  assert.equal(typeof GET, "function", "GET must be exported");
  const query = compare ? `?compare=${encodeURIComponent(compare)}` : "";
  const encoded = encodeURIComponent(BRAND);
  const res = await GET(
    new Request(`https://aeovis.test/api/brands/${encoded}/crawlability${query}`),
    { params: { brand: encoded } },
    { lookup, fetchImpl }
  );
  assert.equal(res.status, 200, "the primary brand audit must succeed for these fixtures");
  return res.json();
}

/** Resolves every hostname publicly except the ones named as dead. */
function lookupExcept(dead = []) {
  return async (hostname) => {
    if (dead.includes(hostname)) {
      const err = new Error("getaddrinfo ENOTFOUND");
      err.code = "ENOTFOUND";
      throw err;
    }
    return [PUBLIC_ADDRESS];
  };
}

/** Serves robots.txt for everything except hosts routed to a per-host behaviour. */
function fetchExcept(behaviour = {}) {
  return async (url) => {
    const host = new URL(String(url)).hostname;
    const special = behaviour[host];
    if (typeof special === "function") return special(String(url));
    return textResponse("User-agent: *\nAllow: /\n");
  };
}

function rowFor(body, domain) {
  const row = (body.compare || []).find((r) => r.domain === domain);
  assert.ok(row, `the route must return a compare row for ${domain} (rule 1: never drop it silently)`);
  return row;
}

// ---------------------------------------------------------------------------
// 1. Three real outcomes, three different renderings.
// ---------------------------------------------------------------------------

/** Built once from the route so every assertion below reads the same real rows. */
async function realOutcomeRows() {
  const timeout = () => {
    const err = new Error("The operation was aborted due to timeout");
    err.name = "TimeoutError";
    throw err;
  };

  const body = await auditBody({
    // 169.254.169.254 is the metadata address: refused by the screen, never dialled.
    compare: "169.254.169.254,nxdomain-rival.com,slow-rival.com,broken-rival.com",
    lookup: lookupExcept(["nxdomain-rival.com"]),
    fetchImpl: fetchExcept({
      "169.254.169.254": () => {
        throw new Error("a refused compare domain must never be fetched");
      },
      "nxdomain-rival.com": () => {
        throw new Error("an unresolvable compare domain must never be fetched");
      },
      "slow-rival.com": timeout,
      "broken-rival.com": () => textResponse("", 503),
    }),
  });

  return {
    refused: rowFor(body, "169.254.169.254"),
    unresolved: rowFor(body, "nxdomain-rival.com"),
    timeout: rowFor(body, "slow-rival.com"),
    httpError: rowFor(body, "broken-rival.com"),
  };
}

test("R3.7.7 — the route really does emit three different failure shapes", async () => {
  const rows = await realOutcomeRows();

  // The exact field names and values the client receives. Asserted, not assumed.
  assert.deepEqual(
    { fetched_ok: rows.refused.fetched_ok, blocked: rows.refused.blocked, fetch_error: rows.refused.fetch_error },
    { fetched_ok: false, blocked: true, fetch_error: "blocked" },
    "a policy refusal"
  );
  assert.deepEqual(
    {
      fetched_ok: rows.unresolved.fetched_ok,
      blocked: rows.unresolved.blocked,
      fetch_error: rows.unresolved.fetch_error,
    },
    { fetched_ok: false, blocked: false, fetch_error: "unresolved" },
    "a dead or mistyped domain — NOT a security event"
  );
  assert.deepEqual(
    { fetched_ok: rows.timeout.fetched_ok, blocked: rows.timeout.blocked, fetch_error: rows.timeout.fetch_error },
    { fetched_ok: false, blocked: false, fetch_error: "timeout" },
    "ordinary network variance"
  );
  assert.equal(rows.httpError.fetch_error, "http_503", "and the fourth shape the same route already emits");

  // The refused row carries no score at all — its summary is the unaudited
  // zero shape, so rendering it as "treated as fully open" was doubly false.
  assert.deepEqual(
    { open: rows.refused.summary.open, partial: rows.refused.summary.partial, blocked: rows.refused.summary.blocked },
    { open: 0, partial: 0, blocked: 0 },
    "a refusal is never a score"
  );
});

test("R3.7.7 — the three outcomes render differently", async () => {
  const rows = await realOutcomeRows();

  const refused = describeRivalCrawlOutcome(rows.refused);
  const unresolved = describeRivalCrawlOutcome(rows.unresolved);
  const timedOut = describeRivalCrawlOutcome(rows.timeout);
  const httpError = describeRivalCrawlOutcome(rows.httpError);

  assert.equal(refused.kind, "refused");
  assert.equal(unresolved.kind, "unresolved");
  assert.equal(timedOut.kind, "timeout");
  assert.equal(httpError.kind, "http_error");

  // TEETH: the bug was that all of these read the same. Every visible field
  // must differ pairwise — not merely "the old sentence is gone".
  const rendered = [refused, unresolved, timedOut, httpError];
  for (const field of ["kind", "label", "detail"]) {
    const values = rendered.map((r) => r[field]);
    assert.equal(
      new Set(values).size,
      rendered.length,
      `two outcomes share a ${field}: ${JSON.stringify(values)}`
    );
  }

  // ...and the whole rendered line, tone included, is distinct for the three
  // the finding names.
  const lines = [refused, unresolved, timedOut].map((r) => `${r.tone}|${r.label} — ${r.detail}`);
  assert.equal(new Set(lines).size, 3, "a refusal, a dead domain and a timeout must look different");

  // A row that audited fine gets no failure line at all.
  assert.equal(
    describeRivalCrawlOutcome({ fetched_ok: true, blocked: false, fetch_error: null }),
    null,
    "a healthy rival still renders its meter"
  );
});

test("R3.7.7 — the refusal reads as OUR decision and leaks nothing", async () => {
  const rows = await realOutcomeRows();
  const refused = describeRivalCrawlOutcome(rows.refused);
  const line = `${refused.label} ${refused.detail}`.toLowerCase();

  // 1. Never the old wording, and never anything that blames the rival's server.
  for (const forbidden of ["unreachable", "couldn't reach", "could not reach", "down", "offline", "timed out"]) {
    assert.ok(
      !line.includes(forbidden),
      `a policy refusal must not be worded as an outage ("${forbidden}" in: ${line})`
    );
  }
  // 2. Never the false claim the old line made about a row whose summary is zeros.
  assert.ok(!line.includes("fully open"), "a refused domain was not audited, so it is not 'treated as fully open'");
  // 3. It must say plainly that WE refused.
  assert.match(refused.label, /refused/i, "the label must name the refusal");
  assert.match(refused.detail, /\bour\b/i, "the detail must attribute the decision to us");
  assert.match(refused.detail, /not a fault with the site/i, "and must clear the rival of blame");
  // 4. The response body is not a DNS oracle: the copy must not say whether the
  //    name resolved, to what, or which range it fell in. Same reason route.js
  //    keeps one BLOCKED_DOMAIN_MESSAGE for every refusal.
  for (const leak of [
    "private",
    "internal",
    "localhost",
    "loopback",
    "link-local",
    "metadata",
    "127.",
    "169.254",
    "10.0.0",
    "192.168",
    "intranet",
    "rfc1918",
  ]) {
    assert.ok(!line.includes(leak), `refusal copy must not leak network detail ("${leak}" in: ${line})`);
  }

  // The unresolved case is the CUSTOMER'S typo. Wording it as a refusal would
  // make every mistyped competitor look like an attack.
  const unresolved = describeRivalCrawlOutcome(rows.unresolved);
  assert.ok(
    !/refus|block|not allowed/i.test(`${unresolved.label} ${unresolved.detail}`),
    "a domain that simply does not resolve must not be dressed as a security event"
  );
  assert.match(unresolved.detail, /spelling/i, "it should point at the likely cause instead");
});

// ---------------------------------------------------------------------------
// 2. The compare budget — a refused rival spends a slot, and the UI says so.
// ---------------------------------------------------------------------------

test("R3.7.7 — a rival dropped from the compare budget is explained, not omitted", async () => {
  const requested = [
    "169.254.169.254", // refused: spends a slot without producing an audit
    "rival-one.com",
    "rival-two.com",
    "rival-three.com",
    "rival-four.com",
    "rival-five.com", // ...so this one never gets looked at
  ];

  const body = await auditBody({
    compare: requested.join(","),
    lookup: lookupExcept(),
    fetchImpl: fetchExcept({
      "169.254.169.254": () => {
        throw new Error("a refused compare domain must never be fetched");
      },
    }),
  });

  // The response-shape fact this half of the task exists for.
  assert.equal(body.compare.length, MAX_COMPARE_DOMAINS, "the route returns at most the budget");
  assert.equal(
    body.compare.filter((r) => r.blocked).length,
    1,
    "one of those slots went to a refusal, not to an audit"
  );
  assert.ok(
    !body.compare.some((r) => r.domain === "rival-five.com"),
    "so the sixth rival is absent from the response entirely — the case the UI must explain"
  );

  const budget = describeCompareBudget({
    requested,
    compared: body.compare,
    primaryDomain: body.domain,
  });

  assert.ok(budget, "six rivals asked, five rows back: the UI must not stay quiet");
  assert.deepEqual(budget.dropped, [{ domain: "rival-five.com", reason: "budget" }]);
  assert.match(budget.message, /rival-five\.com/, "the message names the rival that was left out");
  assert.match(budget.message, /not audited/i, "and says plainly that it was not audited");
  assert.match(
    budget.message,
    new RegExp(`at most ${MAX_COMPARE_DOMAINS} rivals`, "i"),
    "and gives the limit"
  );
  assert.match(
    budget.message,
    /refuse still uses one of those/i,
    "and names the reason the budget ran out one short"
  );
});

test("R3.7.7 — the budget note stays quiet when nothing was dropped", async () => {
  const requested = ["rival-one.com", "rival-two.com"];
  const body = await auditBody({
    compare: requested.join(","),
    lookup: lookupExcept(),
    fetchImpl: fetchExcept(),
  });

  assert.equal(
    describeCompareBudget({ requested, compared: body.compare, primaryDomain: body.domain }),
    null,
    "every rival came back, so there is nothing to explain"
  );

  // A rival that IS the brand is dropped by the route's dedupe, not by the
  // budget, and must not be blamed on the limit.
  const self = describeCompareBudget({
    requested: [BRAND, "rival-one.com"],
    compared: [{ domain: "rival-one.com" }],
    primaryDomain: BRAND,
  });
  assert.ok(self, "a silently-deduped domain is still a domain the operator asked about");
  assert.deepEqual(self.dropped, [{ domain: BRAND, reason: "self" }]);
  assert.match(self.message, /your own domain/i);
  assert.doesNotMatch(self.message, /at most/i, "it is not a budget problem, so do not say it is");

  // And a domain missing from a SHORT response is still reported, but without
  // blaming a cap that was never reached — a confident wrong reason is worse
  // than an honest vague one.
  const unmatched = describeCompareBudget({
    requested: ["rival-one.com", "rival-two.com"],
    compared: [{ domain: "rival-one.com" }],
    primaryDomain: BRAND,
  });
  assert.deepEqual(unmatched.dropped, [{ domain: "rival-two.com", reason: "unmatched" }]);
  assert.match(unmatched.message, /not audited/i, "silence is still not an option");
  assert.doesNotMatch(unmatched.message, /at most/i, "the cap was not reached, so the cap is not the reason");
});

test("R3.7.7 GUARD — the client's copy of MAX_COMPARE_DOMAINS matches the route's", () => {
  const declared = /const MAX_COMPARE_DOMAINS = (\d+);/.exec(ROUTE);
  assert.ok(declared, "the route still declares MAX_COMPARE_DOMAINS");
  assert.equal(
    Number(declared[1]),
    MAX_COMPARE_DOMAINS,
    "the number in the UI's explanation must be the number the server actually enforces"
  );
});

// ---------------------------------------------------------------------------
// 3. Source guard — the component uses the decision instead of retyping it.
// ---------------------------------------------------------------------------

test("R3.7.7 GUARD — CrawlabilityView defers to describeRivalCrawlOutcome", () => {
  assert.match(
    VIEW,
    /import \{ describeCompareBudget, describeRivalCrawlOutcome \} from "@\/lib\/crawlabilityOutcome"/,
    "the component must import the one derivation, not reimplement it"
  );
  assert.match(
    VIEW,
    /const outcome = describeRivalCrawlOutcome\(row\)/,
    "every rival row's failure state comes from that function"
  );
  assert.match(VIEW, /\{outcome\.label\}/, "the label is rendered");
  assert.match(VIEW, /\{outcome\.detail\}/, "and so is the reason under it");
  assert.match(
    VIEW,
    /data-outcome=\{outcome \? outcome\.kind : "audited"\}/,
    "the outcome kind is on the row so QA can tell the three apart without reading prose"
  );

  // TEETH 1: the row must receive the WHOLE compare row. Narrowing it back to a
  // boolean is exactly how the three outcomes collapsed into one.
  assert.match(
    VIEW,
    /<RivalCrawlRow key=\{r\.domain\} label=\{r\.domain\} summary=\{r\.summary\} row=\{r\} \/>/,
    "the compare row is passed whole — blocked and fetch_error live on it"
  );
  assert.ok(
    !/fetchedOk=\{/.test(VIEW),
    "a bare fetched_ok prop cannot carry the difference between a refusal and a timeout"
  );

  // TEETH 2: the one-size-fits-all sentence must not come back as a literal.
  assert.ok(
    !/Unreachable — treated as fully open, unverified/.test(VIEW),
    "the line that made a security refusal look like a flaky network must stay gone"
  );
  assert.ok(
    !/Perceev only audits rivals/.test(VIEW),
    "the refusal copy belongs in crawlabilityOutcome.js where the suite can execute it"
  );
});

test("R3.7.7 GUARD — CrawlabilityView says when a rival was dropped from the budget", () => {
  assert.match(
    VIEW,
    /describeCompareBudget\(\{/,
    "the component must compare what it asked for against what came back"
  );
  assert.match(VIEW, /requested: rivalDomains/, "...asked for: the rivals it put in the compare param");
  assert.match(VIEW, /compared: data\.compare/, "...came back: the rows the route returned");
  assert.match(
    VIEW,
    /data-testid="crawlability-compare-budget"/,
    "the explanation needs somewhere to appear"
  );
  assert.match(VIEW, /\{compareBudget\.message\}/, "and it renders the derived sentence, not its own");
});

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
  UNVERIFIED_NOTE,
  describeCompareBudget,
  describePrimaryCrawlOutcome,
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
  // R3.7.8 added a third name to this import and wrapped it across lines, so the
  // guard now reads the import STATEMENT rather than one exact line of
  // formatting. The teeth are unchanged: the symbol must come from the shared
  // module, so a component that re-typed the copy locally still fails.
  const importBlock = /import \{([^}]*)\} from "@\/lib\/crawlabilityOutcome"/.exec(VIEW);
  assert.ok(importBlock, "the component must import the one derivation, not reimplement it");
  assert.match(importBlock[1], /\bdescribeRivalCrawlOutcome\b/, "...including the rival-row wording");
  assert.match(importBlock[1], /\bdescribeCompareBudget\b/, "...and the compare-budget explanation");
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

// ---------------------------------------------------------------------------
// 4. R3.7.8 — the SAME distinction for the brand's own domain.
//
// The banner over the customer's own audit said one thing for every failure:
// "Couldn't reach {domain}/robots.txt ({fetch_error with underscores swapped
// for spaces})". So a customer who mistyped their own domain was told their
// server was unreachable — sent to debug a network they do not have a problem
// with — and the reason they were shown was a machine slug.
//
// Same two-part proof as section 1: the payloads come out of the real route,
// and the words are executed.
// ---------------------------------------------------------------------------

/** Drives the route with the PRIMARY brand failing in one specific way. */
function timeoutThrow() {
  const err = new Error("The operation was aborted due to timeout");
  err.name = "TimeoutError";
  throw err;
}

async function realPrimaryPayloads() {
  const [unresolved, timedOut, httpError, networkError] = await Promise.all([
    // DNS answers with nothing for the brand's own name: the customer's typo.
    auditBody({ lookup: lookupExcept([BRAND]), fetchImpl: fetchExcept() }),
    auditBody({ lookup: lookupExcept(), fetchImpl: fetchExcept({ [BRAND]: timeoutThrow }) }),
    auditBody({ lookup: lookupExcept(), fetchImpl: fetchExcept({ [BRAND]: () => textResponse("", 503) }) }),
    auditBody({
      lookup: lookupExcept(),
      fetchImpl: fetchExcept({
        [BRAND]: () => {
          throw new Error("socket hang up");
        },
      }),
    }),
  ]);
  return { unresolved, timedOut, httpError, networkError };
}

test("R3.7.8 — the route emits four different primary failure shapes, and no `blocked`", async () => {
  const bodies = await realPrimaryPayloads();

  for (const [name, body] of Object.entries(bodies)) {
    assert.equal(body.fetched_ok, false, `${name}: robots.txt was not read`);
    assert.equal(body.domain, BRAND, `${name}: the banner needs the domain to name`);
    // A refused BRAND domain is a 400, never a 200 row (route.js:131-133), which
    // is why the primary body has no `blocked` field and why the primary needs
    // its own derivation instead of borrowing the rival row's.
    assert.equal(body.blocked, undefined, `${name}: the primary payload carries no blocked flag`);
  }

  assert.equal(bodies.unresolved.fetch_error, "unresolved", "DNS returned nothing — the customer's typo");
  assert.equal(bodies.timedOut.fetch_error, "timeout", "ours, not theirs");
  assert.equal(bodies.httpError.fetch_error, "http_503", "we reached the server; it answered an error");
  assert.equal(bodies.networkError.fetch_error, "network_error", "ours, not theirs");
});

test("R3.7.8 — a typo and a network problem no longer render as the same banner", async () => {
  const bodies = await realPrimaryPayloads();
  const rendered = Object.fromEntries(
    Object.entries(bodies).map(([name, body]) => [name, describePrimaryCrawlOutcome(body)])
  );

  assert.equal(rendered.unresolved.kind, "unresolved");
  assert.equal(rendered.timedOut.kind, "timeout");
  assert.equal(rendered.httpError.kind, "http_error");
  assert.equal(rendered.networkError.kind, "network_error");

  // TEETH: the finding is that all four read identically. Every visible field
  // must differ pairwise — not merely "the old sentence is gone".
  const all = Object.values(rendered);
  for (const field of ["kind", "label", "detail"]) {
    const values = all.map((r) => r[field]);
    assert.equal(new Set(values).size, all.length, `two primary outcomes share a ${field}: ${JSON.stringify(values)}`);
  }

  // The fact the task is actually about, as data rather than prose: whose
  // problem is this? A typo is the customer's; a timeout and a dead connection
  // are ours and must never be handed to them.
  assert.equal(rendered.unresolved.actionable, "you");
  assert.equal(rendered.httpError.actionable, "you", "their server answered — it is their server");
  assert.equal(rendered.timedOut.actionable, "us");
  assert.equal(rendered.networkError.actionable, "us");

  // ...and the severity differs too, so the two are not one glance apart.
  assert.equal(rendered.unresolved.tone, "crit", "a domain that does not exist makes the whole page fiction");
  assert.equal(rendered.timedOut.tone, "warn");

  // A read that succeeded raises no banner at all.
  const ok = await auditBody({ lookup: lookupExcept(), fetchImpl: fetchExcept() });
  assert.equal(ok.fetched_ok, true, "the control fixture really did read robots.txt");
  assert.equal(describePrimaryCrawlOutcome(ok), null, "nothing degraded, nothing to say");
});

test("R3.7.8 — an unresolved brand domain says check the spelling, never 'your server is down'", async () => {
  const { unresolved, timedOut, networkError } = await realPrimaryPayloads();
  const typo = describePrimaryCrawlOutcome(unresolved);
  const typoLine = `${typo.label} ${typo.detail}`.toLowerCase();

  assert.match(typo.label, /spelling/i, "the headline names the thing the customer can actually fix");
  // The exact conflation: never tell someone whose domain does not exist that we
  // could not reach their server or that it is down.
  for (const forbidden of ["couldn't reach", "could not reach", "unreachable", "timed out", "is down", "offline"]) {
    assert.ok(!typoLine.includes(forbidden), `a name that does not resolve is not an outage ("${forbidden}")`);
  }
  // Nor a security event — same rule the rival copy follows.
  assert.ok(!/refus|blocked|not allowed/i.test(typoLine), "a typo must not be dressed as a refusal");

  // The mirror image: the two failures WE own must not send the customer off to
  // proofread a domain that resolved perfectly well.
  for (const [name, body] of [
    ["timeout", timedOut],
    ["network_error", networkError],
  ]) {
    const outcome = describePrimaryCrawlOutcome(body);
    assert.doesNotMatch(
      outcome.label,
      /spelling|typo/i,
      `${name}: the name resolved, so do not lead with a spelling problem`
    );
    assert.match(outcome.detail, /resolved/i, `${name}: say plainly that the domain itself was fine`);
  }
});

test("R3.7.8 — the banner uses written copy, never the fetch_error slug", async () => {
  const bodies = await realPrimaryPayloads();

  for (const [name, body] of Object.entries(bodies)) {
    const outcome = describePrimaryCrawlOutcome(body);
    const line = `${outcome.label} ${outcome.detail}`;
    assert.ok(
      !line.includes(body.fetch_error),
      `${name}: the raw slug "${body.fetch_error}" is showing through the copy: ${line}`
    );
    assert.ok(!/[a-z]_[a-z]/i.test(line), `${name}: a machine identifier leaked into prose: ${line}`);

    // Standing rule 1: robots.txt was never read, yet the table below still
    // lists every crawler as open. That is an assumption and the banner has to
    // say so — the old line did, and losing it while fixing the wording would
    // trade one silent-degradation bug for another.
    assert.ok(line.includes(UNVERIFIED_NOTE), `${name}: the unverified default-open caveat must survive`);
  }
});

test("R3.7.8 — an unexplained failure admits it instead of guessing", () => {
  // route.js:439 always supplies a reason, so this shape should be impossible.
  // If it ever happens, the banner must not invent one: guessing "network"
  // re-creates the finding, and guessing "typo" sends the customer after a
  // problem we never saw.
  const unknown = describePrimaryCrawlOutcome({ domain: BRAND, fetched_ok: false, fetch_error: null });
  assert.equal(unknown.kind, "unknown_error");
  assert.equal(unknown.actionable, "us", "we cannot pin it on the customer without evidence");
  assert.match(unknown.detail, /can't tell you|cannot tell you/i, "it says outright that the reason is missing");
  assert.doesNotMatch(unknown.label, /spelling/i);

  // Defence in depth: a refused primary is a 400 today, but if one ever reaches
  // the banner it must read as OUR decision — not as an outage, and not as a
  // typo — and must say nothing about why (the route keeps one message for
  // every refusal for exactly this reason).
  const refused = describePrimaryCrawlOutcome({ domain: BRAND, fetched_ok: false, blocked: true });
  assert.equal(refused.kind, "refused");
  const refusedLine = `${refused.label} ${refused.detail}`.toLowerCase();
  assert.ok(!refusedLine.includes("spelling"), "a refusal is not a typo");
  for (const leak of ["private", "internal", "localhost", "loopback", "link-local", "metadata", "169.254"]) {
    assert.ok(!refusedLine.includes(leak), `refusal copy must not leak network detail ("${leak}")`);
  }

  // Junk in, no banner out — the fatal-error path owns that case.
  assert.equal(describePrimaryCrawlOutcome(null), null);
});

test("R3.7.8 GUARD — CrawlabilityView renders the derived primary outcome", () => {
  const importBlock = /import \{([^}]*)\} from "@\/lib\/crawlabilityOutcome"/.exec(VIEW);
  assert.ok(importBlock, "the component imports the shared derivation");
  assert.match(importBlock[1], /\bdescribePrimaryCrawlOutcome\b/, "including the primary banner's wording");

  assert.match(
    VIEW,
    /describePrimaryCrawlOutcome\(data\)/,
    "the banner reads the whole payload — fetch_error is what tells the outcomes apart"
  );
  assert.match(VIEW, /\{primaryOutcome\.label\}/, "the written headline is rendered");
  assert.match(VIEW, /\{primaryOutcome\.detail\}/, "and the explanation under it");
  assert.match(
    VIEW,
    /data-outcome=\{primaryOutcome\.kind\}/,
    "the kind is on the banner so QA can tell a typo from a network fault without reading prose"
  );
  assert.match(VIEW, /data-actionable=\{primaryOutcome\.actionable\}/, "and whose problem it is");
  assert.match(
    VIEW,
    /variant=\{primaryOutcome\.tone === "crit" \? "crit" : "warn"\}/,
    "the alert's severity follows the derived tone rather than being fixed at warn for everything"
  );

  // TEETH: the exact line the finding names must stay gone, in both its parts.
  assert.ok(
    !/Couldn&apos;t reach \{data\.domain\}\/robots\.txt/.test(VIEW),
    "the one-size banner that called every failure a network problem must not come back"
  );
  assert.ok(
    !/fetch_error\.replace\(/.test(VIEW),
    "a slug with its underscores swapped for spaces is not written copy"
  );
  assert.ok(
    !/!data\.fetched_ok &&/.test(VIEW),
    "the banner is decided by the derivation, not by a second bare reading of fetched_ok"
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

/**
 * R3.7.4 — GET /api/brands/[brand]/crawlability observed at the ROUTE.
 *
 * THE HOLE THIS CLOSES. The `[brand]` path param and every `compare` entry are
 * turned straight into a server-side fetch target (`https://{domain}/robots.txt`
 * and `/llms.txt`). POST /api/scan is on the anonymous allow-list, so the
 * domain on a brand is stranger-controlled. The route shipped with a private
 * `isSafeDomain` — four string literals plus one regex for 10/8, 192.168/16 and
 * 172.16/12 — and three fetches with `redirect: "follow"`. Executed verbatim
 * against the eleven-host table below it ALLOWED SEVEN, including the cloud
 * metadata address, and because redirects were followed unchecked a perfectly
 * public domain could 302 us into the metadata range and hand back the body.
 * Both reproduced before the fix; both are asserted refused here.
 *
 * NOTHING IN THIS FILE TOUCHES THE NETWORK. Every fetch is a stub and every DNS
 * lookup is injected through the route's `deps` seam (the same seam
 * scrapeForSummary uses). 169.254.169.254 is never dialled: the assertion is
 * that it is never even ASKED FOR.
 *
 * Harness: the module-resolution hooks cronAuth.route.test.mjs uses. They only
 * answer "which file is this specifier" for `@/` and `next/server`; the handler
 * body runs unmodified.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

import { classifyAddress } from "./ssrfGuard.js";

register("./cronAuth.route.hooks.mjs", import.meta.url);

function assertCorpusIntact(rows, name, { floor, required = [], rowLength = null, isTuple = true }) {
  assert.ok(Array.isArray(rows), `${name} is not an array at all, so tests assert nothing`);
  assert.ok(
    rows.length >= floor,
    `${name} holds ${rows.length} rows, under its floor of ${floor}. Rows were removed from a security ` +
      `corpus whose tests iterate over it, so assertions silently stopped running. If the removal ` +
      `was deliberate, lower the floor here in the same commit and state why.`
  );
  if (isTuple) {
    rows.forEach((row, i) => {
      assert.ok(
        Array.isArray(row) &&
          (rowLength === null ? row.length >= 2 : row.length === rowLength) &&
          typeof row[0] === "string",
        `${name}[${i}] is not a valid tuple entry with expected shape (rowLength=${rowLength ?? ">=2"}): ${JSON.stringify(row)}`
      );
      const reason = row[row.length - 1];
      assert.ok(
        typeof reason === "string" && reason.trim().length > 0,
        `${name}[${i}] (${JSON.stringify(row[0])}) carries no reason -- a row nobody can justify is a row ` +
          `the next editor deletes, and the floor above would then be met by padding`
      );
    });
  } else {
    rows.forEach((item, i) => {
      assert.ok(
        typeof item === "string",
        `${name}[${i}] is not a string: ${JSON.stringify(item)}`
      );
    });
  }
  const targets = rows.map((r) => (Array.isArray(r) ? r[0] : r));
  const dupes = [...new Set(targets.filter((t, i) => targets.indexOf(t) !== i))];
  assert.deepEqual(
    dupes,
    [],
    `${name} repeats ${JSON.stringify(dupes)}. A duplicated row holds the count up without adding ` +
      `coverage, which is how a corpus passes its floor while testing less than it did yesterday.`
  );
  const missing = required.filter((t) => !targets.includes(t));
  assert.deepEqual(
    missing,
    [],
    `${name} no longer contains ${JSON.stringify(missing)}. These rows are load-bearing security ` +
      `targets: losing one makes an SSRF bypass silent again. Removing one is a decision to stop ` +
      `defending that target -- make it in the same commit as this list.`
  );
}

test("GUARD TEETH — assertCorpusIntact enforces length floor, shape, uniqueness, and required targets", () => {
  assert.throws(
    () => assertCorpusIntact([], "TEST_CORPUS", { floor: 1, isTuple: false }),
    /under its floor of 1/
  );
  assert.throws(
    () => assertCorpusIntact(["a", "a"], "TEST_CORPUS", { floor: 1, isTuple: false }),
    /repeats/
  );
  assert.throws(
    () => assertCorpusIntact(["a"], "TEST_CORPUS", { floor: 1, required: ["b"], isTuple: false }),
    /no longer contains/
  );
  assert.throws(
    () => assertCorpusIntact([["a", ""]], "TEST_CORPUS", { floor: 1, isTuple: true, rowLength: 2 }),
    /carries no reason/
  );
});

let importError = null;
let GET = null;
try {
  ({ GET } = await import("../app/api/brands/[brand]/crawlability/route.js"));
} catch (error) {
  importError = error;
}

function handler() {
  assert.equal(importError, null, `route module failed to import: ${importError?.message}`);
  assert.equal(typeof GET, "function", "GET must be exported");
  return GET;
}

// ---------------------------------------------------------------------------
// Stubs. A fetch that is reached at all is, for most tests here, the failure.
// ---------------------------------------------------------------------------

/** A DNS lookup that must never be reached — IP literals are decided without DNS. */
const noLookup = async (hostname) => {
  throw new Error(`DNS lookup should not have happened (asked for ${hostname})`);
};
const lookupPublic = async () => ["93.184.216.34"];

function recordingFetch(handlerFn) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), redirect: init.redirect, method: init.method || "GET" });
    return handlerFn(String(url), init);
  };
  return { impl, calls };
}

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

function redirectTo(location, status = 302) {
  return {
    ok: false,
    status,
    headers: { get: (n) => (String(n).toLowerCase() === "location" ? location : null) },
    async text() {
      return "";
    },
  };
}

function call(brand, { query = "", ...deps } = {}) {
  const encoded = encodeURIComponent(brand);
  const request = new Request(`https://aeovis.test/api/brands/${encoded}/crawlability${query}`);
  return handler()(request, { params: { brand: encoded } }, deps);
}

// ---------------------------------------------------------------------------
// 1. The eleven adversarial hosts.
//
// PROVENANCE, and a discrepancy worth naming: there is no eleven-host table in
// src/lib/ssrfGuard.test.mjs or src/lib/firecrawl.test.mjs to import. Those
// files carry a 68-row BLOCKED_LITERALS table (ssrfGuard.test.mjs:33-106) and a
// 16-row SSRF_TARGETS table (firecrawl.test.mjs:51-68). The "seven of eleven"
// figure comes from the R3.7.1 implementer's ledger note, which names the seven
// isSafeDomain let through but not the four it caught. The eleven below were
// reconstructed and then CONFIRMED against the unpatched route: exactly seven
// reached a server-side fetch, and they are exactly the seven named in the
// ledger. Every row is drawn from BLOCKED_LITERALS; the `wasAllowed` column
// records what the old code did, so this table also documents the bug.
//
// The expected reason is not hardcoded trust — the first test asserts it still
// matches what classifyAddress says, so this table cannot drift away from the
// guard it is meant to be testing.
// ---------------------------------------------------------------------------

const ADVERSARIAL_HOSTS = [
  ["169.254.169.254", "link_local", true, "AWS/GCP/Azure instance metadata"],
  ["127.0.0.1", "loopback", false, "loopback, the one literal the old list had"],
  ["127.0.0.2", "loopback", true, "loopback, not the canonical address"],
  ["127.1", "loopback", true, "loopback, short form"],
  ["2130706433", "loopback", false, "loopback, decimal"],
  ["0177.0.0.1", "loopback", true, "loopback, octal first octet"],
  ["10.0.0.1", "private", false, "RFC1918 10/8"],
  ["192.168.1.1", "private", false, "RFC1918 192.168/16"],
  ["100.64.0.1", "cgnat", true, "carrier-grade NAT"],
  ["198.18.0.1", "benchmark", true, "benchmark range"],
  ["224.0.0.1", "multicast", true, "multicast"],
];

test("the adversarial table still agrees with classifyAddress (no drift)", () => {
  assert.equal(ADVERSARIAL_HOSTS.length, 11, "the table is the eleven hosts from the finding");
  assert.equal(
    ADVERSARIAL_HOSTS.filter(([, , wasAllowed]) => wasAllowed).length,
    7,
    "seven of the eleven were allowed by the deleted isSafeDomain"
  );
  for (const [host, reason, , notation] of ADVERSARIAL_HOSTS) {
    const verdict = classifyAddress(host);
    assert.equal(verdict.ip, true, `${host} (${notation}) must parse as an IP literal`);
    assert.equal(verdict.blocked, true, `${host} (${notation}) must be blocked`);
    assert.equal(verdict.reason, reason, `${host} (${notation}) reason`);
  }
});

for (const [host, reason, wasAllowed, notation] of ADVERSARIAL_HOSTS) {
  test(`brand ${host} (${notation}) is refused with 400 and never fetched`, async () => {
    const { impl, calls } = recordingFetch(() => {
      throw new Error("the guard let a blocked target through to fetch()");
    });

    const res = await call(host, { fetchImpl: impl, lookup: noLookup });

    assert.equal(res.status, 400, `${host} must be refused (${reason}); old code allowed it: ${wasAllowed}`);
    assert.deepEqual(calls, [], "no fetch of any kind may happen for a refused brand");

    const body = await res.json();
    // The refusal must not become an oracle: no address, no range, no reason.
    assert.match(body.error, /valid public domain/i);
    assert.doesNotMatch(body.error, new RegExp(host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(body.error, /resolve[sd] to|loopback|link.local|metadata/i);
  });
}

test("a blocked brand never returns a 200 with an all-open summary", async () => {
  // The regression that makes this route special: robots.txt "" parses as "no
  // rules", which the auditor reports as every crawler OPEN. A refusal that
  // degraded to 200 would render as a perfect crawlability score.
  const { impl } = recordingFetch(() => textResponse(""));
  const res = await call("169.254.169.254", { fetchImpl: impl, lookup: noLookup });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.summary, undefined, "a refused audit must not carry a summary at all");
  assert.equal(body.fetched_ok, undefined);
});

// ---------------------------------------------------------------------------
// 2. Redirects re-checked per hop — the second half of the finding
// ---------------------------------------------------------------------------

test("a public brand whose robots.txt 302s into the metadata range is refused at the hop", async () => {
  const { impl, calls } = recordingFetch((url) => {
    if (url.includes("169.254")) {
      throw new Error("the metadata address must never be requested");
    }
    return redirectTo("http://169.254.169.254/latest/meta-data/");
  });

  const res = await call("clean-example.com", { fetchImpl: impl, lookup: lookupPublic });

  assert.equal(res.status, 400, "the hop into the metadata range must fail the request");
  assert.ok(
    !calls.some((c) => c.url.includes("169.254")),
    `the metadata address must never be requested — saw ${JSON.stringify(calls.map((c) => c.url))}`
  );
  assert.ok(calls.length > 0, "the first, legitimate hop should still have been attempted");
});

test("no fetch this route makes may follow redirects on its own", async () => {
  const { impl, calls } = recordingFetch(() => textResponse("User-agent: *\nAllow: /"));
  await call("clean-example.com", { fetchImpl: impl, lookup: lookupPublic });

  assert.ok(calls.length >= 2, "robots.txt and llms.txt are both fetched");
  for (const c of calls) {
    assert.equal(
      c.redirect,
      "manual",
      `${c.method} ${c.url} must be redirect:"manual" — "follow" is the bug this task closes`
    );
  }
});

test("a redirect chain that stays public is followed, and its final body is used", async () => {
  const { impl, calls } = recordingFetch((url) => {
    if (url === "https://cdn-example.com/robots.txt") {
      return textResponse("User-agent: GPTBot\nDisallow: /");
    }
    if (url === "https://clean-example.com/robots.txt") {
      return redirectTo("https://cdn-example.com/robots.txt", 301);
    }
    return textResponse("", 404);
  });

  const res = await call("clean-example.com", { fetchImpl: impl, lookup: lookupPublic });

  assert.equal(res.status, 200, "a public-to-public redirect is ordinary web behaviour");
  const body = await res.json();
  assert.equal(body.fetched_ok, true);
  assert.ok(body.summary.blocked > 0, "the redirected robots.txt must actually have been parsed");
  assert.ok(calls.some((c) => c.url === "https://cdn-example.com/robots.txt"));
});

// ---------------------------------------------------------------------------
// 3. DNS: a string check cannot catch a name that points inward
// ---------------------------------------------------------------------------

test("a hostname that resolves to loopback is refused before any fetch", async () => {
  const { impl, calls } = recordingFetch(() => {
    throw new Error("should not fetch a name that resolves inward");
  });

  const res = await call("rebind-example.com", {
    fetchImpl: impl,
    lookup: async () => ["127.0.0.1"],
  });

  assert.equal(res.status, 400);
  assert.deepEqual(calls, []);
});

test("a name answering with one public AND one private address is refused", async () => {
  const { impl, calls } = recordingFetch(() => {
    throw new Error("should not fetch a name with a private address in its answer");
  });

  const res = await call("split-example.com", {
    fetchImpl: impl,
    lookup: async () => ["93.184.216.34", "169.254.169.254"],
  });

  assert.equal(res.status, 400);
  assert.deepEqual(calls, []);
});

test("a name that does not resolve is a 200 read failure, NOT a policy 400", async () => {
  // The distinction the guard's UNUSABLE_TARGET_CODES exists for: a customer's
  // typo or a dead domain is normal variance this route is designed to survive,
  // and turning it into a security refusal would be its own outage.
  const { impl } = recordingFetch(() => {
    throw new Error("should not fetch an unresolvable name");
  });

  const res = await call("nxdomain-example.com", {
    fetchImpl: impl,
    lookup: async () => {
      const err = new Error("getaddrinfo ENOTFOUND");
      err.code = "ENOTFOUND";
      throw err;
    },
  });

  assert.equal(res.status, 200, "an unreachable site still returns a usable payload");
  const body = await res.json();
  assert.equal(body.fetched_ok, false, "and says plainly that it never read anything");
  assert.equal(body.fetch_error, "unresolved");
  assert.equal(body.robots_txt_status, "error");
});

// ---------------------------------------------------------------------------
// 4. Legitimate domains must still work — a guard that blocks customers is a
//    worse outage than the bug.
//
//    PROVENANCE: the twenty public boundary addresses of ALLOWED_LITERALS,
//    src/lib/ssrfGuard.test.mjs:144-165, plus one real hostname = the twenty-one
//    R3.7.1 asserted. Each is deliberately adjacent to a blocked range.
// ---------------------------------------------------------------------------

const PUBLIC_BOUNDARY_HOSTS = [
  ["8.8.8.8", "public DNS"],
  ["1.1.1.1", "public DNS"],
  ["93.184.216.34", "example.com's old address"],
  ["11.0.0.1", "just past 10/8"],
  ["9.255.255.255", "just before 10/8"],
  ["126.255.255.255", "just before 127/8"],
  ["128.0.0.1", "just past 127/8"],
  ["172.15.255.255", "just before 172.16/12"],
  ["172.32.0.1", "just past 172.16/12"],
  ["169.253.255.255", "just before link-local"],
  ["169.255.0.1", "just past link-local"],
  ["192.167.255.255", "just before 192.168/16"],
  ["192.169.0.1", "just past 192.168/16"],
  ["100.63.255.255", "just before CGNAT"],
  ["100.128.0.1", "just past CGNAT"],
  ["223.255.255.255", "just before multicast"],
  ["2606:4700:4700::1111", "Cloudflare IPv6 resolver"],
  ["2a00:1450:4001:80e::200e", "Google IPv6"],
  ["64:ff9b::8.8.8.8", "NAT64 wrapping a public address"],
  ["2002:0808:0808::", "6to4 wrapping a public address"],
];

test("GUARD — PUBLIC_BOUNDARY_HOSTS security corpus is intact", () => {
  assertCorpusIntact(PUBLIC_BOUNDARY_HOSTS, "PUBLIC_BOUNDARY_HOSTS", {
    floor: 20,
    required: [
      "8.8.8.8",
      "169.253.255.255",
      "169.255.0.1",
      "2606:4700:4700::1111",
    ],
    rowLength: 2,
    isTuple: true,
  });
});

for (const [host, why] of PUBLIC_BOUNDARY_HOSTS) {
  const brand = host.includes(":") ? `[${host}]` : host;
  test(`public ${host} (${why}) is still audited, not refused`, async () => {
    const { impl, calls } = recordingFetch(() => textResponse("User-agent: *\nDisallow: /private"));
    const res = await call(brand, { fetchImpl: impl, lookup: noLookup });

    assert.equal(res.status, 200, `${host} (${why}) must NOT be blocked`);
    const body = await res.json();
    assert.equal(body.fetched_ok, true);
    assert.ok(calls.length >= 1, `${host} must actually have been fetched`);
  });
}

test("a legitimate customer domain is audited end to end", async () => {
  const robots = ["User-agent: GPTBot", "Disallow: /", "", "User-agent: *", "Allow: /"].join("\n");
  const { impl, calls } = recordingFetch((url) => {
    if (url === "https://acme-analytics.co.in/robots.txt") return textResponse(robots);
    if (url === "https://acme-analytics.co.in/llms.txt") return textResponse("# llms");
    throw new Error(`unexpected fetch: ${url}`);
  });

  const res = await call("acme-analytics.co.in", {
    fetchImpl: impl,
    lookup: async (hostname) => {
      assert.equal(hostname, "acme-analytics.co.in");
      return ["93.184.216.34", "2606:4700:4700::1111"];
    },
  });

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.domain, "acme-analytics.co.in");
  assert.equal(body.fetched_ok, true);
  assert.equal(body.robots_txt_status, "found");
  assert.equal(body.llms_txt_present, true);
  assert.ok(body.summary.total > 0);
  assert.ok(body.summary.blocked >= 1, "GPTBot is disallowed and must be counted blocked");
  assert.equal(calls.length, 2, "robots.txt and llms.txt, nothing else");
});

// ---------------------------------------------------------------------------
// 5. The `compare` param is the same fetch surface — and a refused rival is
//    REPORTED, not silently dropped (rule 1).
// ---------------------------------------------------------------------------

test("a blocked compare domain is never fetched", async () => {
  const { impl, calls } = recordingFetch((url) => {
    if (url.includes("169.254")) throw new Error("a compare domain reached the metadata address");
    return textResponse("User-agent: *\nAllow: /");
  });

  const res = await call("clean-example.com", {
    query: "?compare=169.254.169.254,127.0.0.2",
    fetchImpl: impl,
    lookup: lookupPublic,
  });

  assert.equal(res.status, 200, "the primary brand is fine; only the rivals are refused");
  assert.ok(
    !calls.some((c) => c.url.includes("169.254") || c.url.includes("127.0.0.2")),
    `blocked rivals must never be fetched — saw ${JSON.stringify(calls.map((c) => c.url))}`
  );
});

test("a blocked compare domain is reported, not dropped from the response", async () => {
  const { impl } = recordingFetch(() => textResponse("User-agent: *\nAllow: /"));

  const res = await call("clean-example.com", {
    query: "?compare=169.254.169.254",
    fetchImpl: impl,
    lookup: lookupPublic,
  });

  const body = await res.json();
  const row = (body.compare || []).find((r) => r.domain === "169.254.169.254");
  assert.ok(row, "a refused rival must still appear — a silent drop is an empty state that looks clean");
  assert.equal(row.blocked, true);
  assert.equal(row.fetched_ok, false);
  assert.equal(row.fetch_error, "blocked");
  assert.deepEqual(
    { open: row.summary.open, partial: row.summary.partial, blocked: row.summary.blocked },
    { open: 0, partial: 0, blocked: 0 },
    "a refused rival must never carry an all-open score"
  );
});

test("a compare domain that 302s into a private range is refused at the hop, not scored", async () => {
  const { impl, calls } = recordingFetch((url) => {
    if (url.includes("10.0.0.")) throw new Error("a compare redirect reached a private address");
    if (url.startsWith("https://rival-example.com/")) return redirectTo("http://10.0.0.5/robots.txt");
    return textResponse("User-agent: *\nAllow: /");
  });

  const res = await call("clean-example.com", {
    query: "?compare=rival-example.com",
    fetchImpl: impl,
    lookup: lookupPublic,
  });

  assert.equal(res.status, 200);
  const body = await res.json();
  const row = (body.compare || []).find((r) => r.domain === "rival-example.com");
  assert.ok(row, "the rival must appear");
  assert.equal(row.blocked, true, "a refused hop must not read as an unremarkable fetch failure");
  assert.equal(row.summary.open, 0, "and must never be scored as open");
  assert.ok(!calls.some((c) => c.url.includes("10.0.0.")));
});

test("a healthy compare domain is still audited normally", async () => {
  const { impl } = recordingFetch((url) =>
    url.startsWith("https://rival-example.com/robots.txt")
      ? textResponse("User-agent: *\nAllow: /")
      : textResponse("User-agent: *\nAllow: /")
  );

  const res = await call("clean-example.com", {
    query: "?compare=rival-example.com",
    fetchImpl: impl,
    lookup: lookupPublic,
  });

  const body = await res.json();
  const row = (body.compare || []).find((r) => r.domain === "rival-example.com");
  assert.ok(row);
  assert.equal(row.blocked, false);
  assert.equal(row.fetched_ok, true);
  assert.ok(row.summary.total > 0);
});

// ---------------------------------------------------------------------------
// 6. Shapes the guard, not a local denylist, now decides
// ---------------------------------------------------------------------------

const REFUSED_SHAPES = [
  ["localhost", "a single-label name a search domain could expand internally"],
  ["metadata", "single-label"],
  ["[::1]", "IPv6 loopback, bracketed"],
  ["0x7f000001", "loopback in hex"],
  ["user:pass@example.com", "credentials in the host"],
  ["example.com/../../etc", "a path smuggled into the brand key"],
  ["file:///etc/passwd", "a non-http scheme"],
  ["http://example.com", "a scheme the brand key must not carry"],
  ["exam ple.com", "whitespace"],
];

test("GUARD — REFUSED_SHAPES security corpus is intact", () => {
  assertCorpusIntact(REFUSED_SHAPES, "REFUSED_SHAPES", {
    floor: 9,
    required: [
      "localhost",
      "metadata",
      "[::1]",
      "0x7f000001",
    ],
    rowLength: 2,
    isTuple: true,
  });
});

for (const [brand, why] of REFUSED_SHAPES) {
  test(`brand ${JSON.stringify(brand)} (${why}) is refused with 400 and never fetched`, async () => {
    const { impl, calls } = recordingFetch(() => {
      throw new Error("a malformed brand key reached fetch()");
    });
    const res = await call(brand, { fetchImpl: impl, lookup: noLookup });
    assert.equal(res.status, 400);
    assert.deepEqual(calls, []);
  });
}

test("an empty brand is still a 400 about the brand, not about the guard", async () => {
  const res = await handler()(
    new Request("https://aeovis.test/api/brands//crawlability"),
    { params: { brand: "" } },
    { fetchImpl: async () => textResponse("") }
  );
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /brand is required/i);
});

// ---------------------------------------------------------------------------
// 7. Teeth: the deleted denylist must stay deleted.
// ---------------------------------------------------------------------------

test("GUARD — no second address denylist may grow back in the route", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const path = await import("node:path");
  const routePath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "../app/api/brands/[brand]/crawlability/route.js"
  );
  const source = readFileSync(routePath, "utf8");

  assert.ok(!/function\s+isSafeDomain/.test(source), "isSafeDomain must stay deleted");

  // Everything below inspects EXECUTABLE code only. The comments name the old
  // ranges and the old `fetch()` on purpose, to explain why they were removed.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  // A raw fetch with redirect:"follow" is the exact shape of the bug.
  assert.ok(
    !/[^a-zA-Z]fetch\s*\(/.test(code.replace(/safeFetch/g, "safeFetchCall")),
    "every outbound request must go through safeFetch"
  );
  assert.ok(
    !/redirect\s*:\s*["']follow["']/.test(code),
    'no request in this route may set redirect:"follow"'
  );
  assert.ok(
    !/172\\?\.\(1\[6-9\]/.test(code) && !/192\\\.168\\\./.test(code),
    "no CIDR regex may live in this route; classifyAddress owns range decisions"
  );
});

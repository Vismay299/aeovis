/**
 * R3.7.4, the two loose ends carried over from R3.7.1's implementer note.
 *
 * The guard throws SsrfBlockedError on a policy refusal. That only matters if
 * the callers above it turn the throw into something a human can act on. Two
 * did not:
 *
 *   1. POST /api/knowledge answered 500. A blocked URL is the CALLER'S input
 *      being wrong; a 500 says "we broke", pages whoever owns the alert, and
 *      buries a probe in the noise of real outages. It must be a 400, and the
 *      body must not say whether the address resolved or to what — otherwise
 *      the endpoint is a DNS oracle for anyone with a session.
 *
 *   2. generateUnbrandedPrompts swallowed the refusal into an empty website
 *      snippet and carried on producing 30 prompts. A scan we refused to fetch
 *      then looked exactly like a scan of a thin website, with one log line as
 *      the only difference. Standing rule 1: a skip is not a success.
 *
 * NOTHING HERE TOUCHES THE NETWORK. Every target is an IP LITERAL, which
 * assertPublicUrl decides without a DNS query, or an injected stub. The
 * metadata address is named but never dialled.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

import { generateUnbrandedPrompts } from "./scoring/promptGen.js";
import { SsrfBlockedError, isPolicyRefusal } from "./ssrfGuard.js";

register("./cronAuth.route.hooks.mjs", import.meta.url);

// ---------------------------------------------------------------------------
// 1. POST /api/knowledge — 400, not 500
// ---------------------------------------------------------------------------

let knowledgeImportError = null;
let POST = null;
try {
  ({ POST } = await import("../app/api/knowledge/route.js"));
} catch (error) {
  knowledgeImportError = error;
}

function knowledgePost(body) {
  assert.equal(knowledgeImportError, null, `route failed to import: ${knowledgeImportError?.message}`);
  assert.equal(typeof POST, "function", "POST must be exported");
  return POST(
    new Request("https://aeovis.test/api/knowledge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

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

/**
 * Literal targets only: assertPublicUrl settles an IP literal before it ever
 * reaches the resolver, so this suite issues no DNS query and opens no socket.
 */
const REFUSED_KNOWLEDGE_URLS = [
  ["http://169.254.169.254/latest/meta-data/iam/security-credentials/", "cloud instance metadata"],
  ["http://127.0.0.1:5432/", "loopback, a database port"],
  ["http://[::1]/", "IPv6 loopback"],
  ["http://2130706433/", "loopback in decimal"],
  ["http://10.0.0.1/internal", "RFC1918"],
  ["http://100.64.0.1/", "carrier-grade NAT"],
];

const REFUSED_SCHEMES = [
  "gopher://127.0.0.1:6379/_INFO",
  "file:///etc/passwd",
  "ftp://127.0.0.1/",
  "data:text/html,<h1>x</h1>",
  "httpx://example.com/",
];

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

test("GUARD — REFUSED_KNOWLEDGE_URLS and REFUSED_SCHEMES security corpora are intact", () => {
  assertCorpusIntact(REFUSED_KNOWLEDGE_URLS, "REFUSED_KNOWLEDGE_URLS", {
    floor: 6,
    required: [
      "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
      "http://127.0.0.1:5432/",
      "http://[::1]/",
    ],
    rowLength: 2,
    isTuple: true,
  });
  assertCorpusIntact(REFUSED_SCHEMES, "REFUSED_SCHEMES", {
    floor: 5,
    required: [
      "gopher://127.0.0.1:6379/_INFO",
      "file:///etc/passwd",
      "data:text/html,<h1>x</h1>",
    ],
    isTuple: false,
  });
});

for (const [url, why] of REFUSED_KNOWLEDGE_URLS) {
  test(`knowledge POST answers 400, not 500, for ${why}`, async () => {
    const res = await knowledgePost({ brand: "acme.io", type: "url", source_url: url });
    assert.equal(res.status, 400, `${url} is a bad request, not a server failure`);
    const body = await res.json();
    assert.match(body.detail, /publicly reachable/i);
  });
}

test("the knowledge refusal body is not a DNS oracle", async () => {
  const res = await knowledgePost({
    brand: "acme.io",
    type: "url",
    source_url: "http://169.254.169.254/latest/meta-data/",
  });
  assert.equal(res.status, 400);
  const { detail } = await res.json();
  // Nothing about resolution, the target, or which range it fell in.
  assert.doesNotMatch(detail, /169\.254|resolv|loopback|link.?local|private|metadata|127\.0\.0/i);
});

for (const source_url of REFUSED_SCHEMES) {
  test(`knowledge POST answers 400 for the scheme in ${source_url}`, async () => {
    // These used to be glued into "https://gopher://..." and sent to the
    // resolver as the single label "gopher" before answering 422. Now they are
    // decided by the parser, so this assertion also proves no DNS query is
    // made: a lookup would take far longer than a parse, and the suite would
    // be talking to the network, which it must never do.
    const res = await knowledgePost({ brand: "acme.io", type: "url", source_url });
    assert.equal(res.status, 400, `${source_url} is the caller's input, not a server failure`);
    const body = await res.json();
    assert.match(body.detail, /publicly reachable/i);
  });
}

test("a non-url knowledge block is untouched by any of this", async () => {
  // No content and no URL: the pre-existing 400 must still be the 400 it was.
  const res = await knowledgePost({ brand: "acme.io", type: "snippet", content: "" });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.detail, /content is required/i);
});

// ---------------------------------------------------------------------------
// 2. promptGen — a refusal is not an empty snippet
// ---------------------------------------------------------------------------

const llmThirty = async () =>
  Array.from({ length: 35 }, (_, i) => ({
    text: `how to choose a project tool number ${i}`,
    topic: "General",
    intent_tier: "commercial",
  }));

const noSerp = {
  fetchPeopleAlsoAsk: async () => {
    throw new Error("PAA should not be called in this test");
  },
  fetchAutocomplete: async () => {
    throw new Error("Autocomplete should not be called in this test");
  },
};

test("a POLICY refusal from the website scrape fails the run — it does not become 30 prompts", async () => {
  const refusal = new SsrfBlockedError("Refused 169.254.169.254: link_local address (169.254.0.0/16).", {
    code: "link_local",
    target: "http://169.254.169.254/",
    address: "169.254.169.254",
  });
  assert.equal(isPolicyRefusal(refusal), true, "precondition: this is a policy refusal");

  await assert.rejects(
    () =>
      generateUnbrandedPrompts("Acme", "http://169.254.169.254/", "", {}, 30, {
        ...noSerp,
        llmJson: llmThirty,
        scrapeForSummary: async () => {
          throw refusal;
        },
      }),
    (err) => {
      assert.ok(err instanceof SsrfBlockedError, `expected the refusal to surface, got ${err?.name}`);
      assert.equal(err.code, "link_local");
      return true;
    },
    "a blocked scan must not quietly produce a full prompt set"
  );
});

test("an UNUSABLE target is still best-effort — a dead website must not fail the scan", async () => {
  // The distinction UNUSABLE_TARGET_CODES exists for. scrapeForSummary already
  // returns its no-content string for a typo or an NXDOMAIN, so the realistic
  // shape is an empty snippet, not a throw. Prompts must still be produced.
  const prompts = await generateUnbrandedPrompts("Acme", "https://dead.example", "", {}, 30, {
    ...noSerp,
    llmJson: llmThirty,
    scrapeForSummary: async () => "No website content available.",
  });
  assert.equal(prompts.length, 30);
});

test("an ordinary scrape failure is still best-effort, and now says so", async () => {
  // A brand's site being momentarily down is not a reason to refuse to
  // generate prompts for it. It IS a reason to leave a line behind.
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...args) => warnings.push(args.map(String).join(" "));
  try {
    const prompts = await generateUnbrandedPrompts("Acme", "https://flaky.example", "", {}, 30, {
      ...noSerp,
      llmJson: llmThirty,
      scrapeForSummary: async () => {
        throw new Error("socket hang up");
      },
    });
    assert.equal(prompts.length, 30, "a flaky website must not fail the run");
  } finally {
    console.warn = realWarn;
  }
  assert.ok(
    warnings.some((w) => /promptGen.*scrape failed/i.test(w)),
    `the skipped scrape must leave a trace — saw ${JSON.stringify(warnings)}`
  );
});

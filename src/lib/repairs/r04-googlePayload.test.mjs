import test from "node:test";
import assert from "node:assert/strict";
import {
  FIELD_QUALITY,
  GOOGLE_PAYLOAD_PARSER_VERSION,
  SERP_STATE,
  buildParserDriftAlert,
  parseGoogleSerp,
  summarizeSerpCollection,
} from "../engines/googlePayload.js";
import {
  brightDataSearch,
  invalidateBrightDataZoneCache,
  isBrightDataDeadlineError,
  isBrightDataParseError,
  isBrightDataZoneError,
} from "../engines/brightdata.js";
import { resolveEnabledEngines, summarizeEngineSlice } from "../scoring/enginePipeline.js";

/**
 * R04 — Google payload validation before classifying AIO absence.
 *
 * Every fixture here is unmistakably synthetic (`.example` hosts, Acme/Rival).
 * No network, no provider, no database: the transport cases swap in a fetch
 * stub and the parser cases call the pure function directly. The three cases
 * that need a live provider or the QA evidence store (R04-21/23/24) are marked
 * `skip` with the reason rather than faked into a pass.
 *
 * The distinction the whole repair turns on, restated here so a future editor
 * cannot miss it: absence of an AI Overview is a MEASUREMENT
 * (`serp_state: "valid_serp"`, `aio_present: false`), and it is only ever
 * reported after a real Google SERP was affirmatively recognised. Anything the
 * parser does not understand is `unknown_schema` with `aio_present: null`.
 */

const ENV = [
  "BRIGHTDATA_API_KEY",
  "BRIGHTDATA_SERP_ZONE",
  "BRIGHTDATA_ZONE_TTL_MS",
  "ENGINES",
  "SERP_GEO",
];

function useEnv(t, env) {
  const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  t.after(() => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
}

function mockFetch(t, handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  t.after(() => {
    globalThis.fetch = original;
  });
}

/** A configured Bright Data with the zone pinned, so no discovery call fires. */
function pinZone(t) {
  useEnv(t, { BRIGHTDATA_API_KEY: "bd-EXAMPLE-NOT-A-REAL-KEY", BRIGHTDATA_SERP_ZONE: "zone_fake" });
}

/* The canonical AI Overview: two ordered blocks, two references, one shared. */
const CANONICAL_AIO = {
  general: { query: "best vitrified tiles for a bathroom" },
  organic: [{ position: 1, title: "Top tiles", link: "https://tiles.example/top" }],
  ai_overview: {
    texts: [
      { snippet: "Acme Tiles is among the larger vitrified tile makers.", reference_indexes: [0, 1] },
      { snippet: "Rival Tiles is also frequently recommended.", reference_indexes: [1] },
    ],
    references: [
      { href: "https://acme.example/collections", title: "Acme collections", source: "acme.example" },
      { href: "https://rival.example/", title: "Rival", source: "rival.example" },
    ],
  },
};

test("R04-01 — canonical AI Overview texts and references parse in order", () => {
  const out = parseGoogleSerp(CANONICAL_AIO);

  assert.equal(out.serp_state, SERP_STATE.VALID_SERP);
  assert.equal(out.aio_present, true);
  assert.deepEqual(
    out.blocks.map((b) => b.text),
    [
      "Acme Tiles is among the larger vitrified tile makers.",
      "Rival Tiles is also frequently recommended.",
    ],
    "block order is the reading order"
  );
  assert.deepEqual(out.citations, ["https://acme.example/collections", "https://rival.example"]);
  assert.equal(out.references[0].href, "https://acme.example/collections");
  assert.equal(out.references[0].title, "Acme collections");
  assert.equal(out.references[0].source, "acme.example");
  assert.equal(out.per_field_quality.text, FIELD_QUALITY.COMPLETE);
  assert.equal(out.errors.length, 0);
});

test("R04-02 — a valid organic SERP without an AIO is valid-no-AIO, with no invented text", () => {
  const out = parseGoogleSerp({
    general: { query: "how to lay vitrified tiles" },
    organic: [{ position: 1, title: "A guide", link: "https://tiles.example/guide" }],
    people_also_ask: [{ question: "Do vitrified tiles need sealing?" }],
  });

  assert.equal(out.serp_state, SERP_STATE.VALID_SERP, "a real SERP is a successful collection");
  assert.equal(out.aio_present, false, "and its absence of an AIO is the measured fact");
  assert.equal(out.ok, true);
  assert.deepEqual(out.blocks, [], "no answer text is invented for an absent AIO");
  assert.deepEqual(out.citations, []);
  assert.equal(out.per_field_quality.text, FIELD_QUALITY.ABSENT);
  assert.deepEqual(out.errors, []);
});

test("R04-03 — the direct object and its string-body envelope normalise identically", () => {
  const direct = parseGoogleSerp(CANONICAL_AIO);
  const envelope = parseGoogleSerp({ status_code: 200, body: JSON.stringify(CANONICAL_AIO) });

  assert.equal(envelope.serp_state, direct.serp_state, "the envelope must not change the verdict");
  assert.equal(envelope.aio_present, direct.aio_present);
  assert.deepEqual(envelope.blocks.map((b) => b.text), direct.blocks.map((b) => b.text));
  assert.deepEqual(envelope.citations, direct.citations);
  assert.equal(envelope.references[0].href, direct.references[0].href);
  // Each parse keeps its own evidence identity — the original bytes are not lost
  // by normalising the envelope.
  assert.ok(direct.evidence.evidence_id, "the direct payload keeps an evidence id");
  assert.ok(envelope.evidence.evidence_id, "and so does the envelope");
  assert.equal(direct.evidence.parser_version, GOOGLE_PAYLOAD_PARSER_VERSION);
});

test("R04-04 — nested list and paragraph blocks keep reading order, nothing dropped", () => {
  const out = parseGoogleSerp({
    ai_overview: {
      texts: [
        { text: "Intro line", list: [{ snippet: "Item A" }, { snippet: "Item B" }] },
        { header: "Heading", paragraphs: [{ snippet: "Para one" }, { snippet: "Para two" }] },
      ],
    },
  });

  assert.deepEqual(
    out.blocks.map((b) => b.text),
    ["Intro line", "Item A", "Item B", "Heading", "Para one", "Para two"],
    "own text first, then its nested children, in document order"
  );
});

test("R04-05 — tracking-URL and fragment variants dedupe with correct block links", () => {
  const out = parseGoogleSerp({
    ai_overview: {
      texts: [
        { snippet: "Claim one", reference_indexes: [0, 1] },
        { snippet: "Claim two", reference_indexes: [2] },
      ],
      references: [
        { href: "https://tiles.example/guide?utm_source=news&utm_campaign=x" },
        { href: "https://tiles.example/guide#section-2" },
        { href: "https://rival.example/best" },
      ],
    },
  });

  assert.equal(out.citations.length, 2, "the two tracking/fragment forms are one citation");
  assert.equal(out.citations[0], "https://tiles.example/guide");
  assert.deepEqual(out.references[0].reference_indexes, [0, 1], "both original indexes survive on the survivor");
  assert.deepEqual(out.blocks[0].citation_urls, ["https://tiles.example/guide"]);
  assert.deepEqual(out.blocks[1].citation_urls, ["https://rival.example/best"], "the second block links to its own source");
});

test("R04-06 — a reference-only AIO stays partial: citations kept, text never complete", () => {
  const out = parseGoogleSerp({
    ai_overview: { references: [{ href: "https://acme.example/proof" }] },
  });

  assert.equal(out.aio_present, true);
  assert.deepEqual(out.blocks, [], "there is no answer text to measure");
  assert.deepEqual(out.citations, ["https://acme.example/proof"], "the citation observation survives");
  assert.equal(out.per_field_quality.text, FIELD_QUALITY.PARTIAL, "missing text is explicitly partial");
  assert.notEqual(out.per_field_quality.text, FIELD_QUALITY.COMPLETE, "never a complete mention measurement");
  assert.equal(out.per_field_quality.citations, FIELD_QUALITY.COMPLETE);
});

test("R04-07 — a text-only AIO distinguishes citations-unavailable from a verified empty list", () => {
  const noCitationField = parseGoogleSerp({ ai_overview: { texts: [{ snippet: "Acme is good." }] } });
  const verifiedEmpty = parseGoogleSerp({
    ai_overview: { texts: [{ snippet: "Acme is good." }], references: [] },
  });

  assert.equal(noCitationField.per_field_quality.text, FIELD_QUALITY.COMPLETE);
  assert.equal(
    noCitationField.per_field_quality.citations,
    FIELD_QUALITY.UNAVAILABLE,
    "no citation field means the list was not observed at all"
  );
  assert.equal(noCitationField.citations_verified_empty, false);

  assert.equal(verifiedEmpty.per_field_quality.citations, FIELD_QUALITY.COMPLETE);
  assert.equal(verifiedEmpty.citations_verified_empty, true, "an explicit empty list is a verified zero");
  assert.notEqual(
    noCitationField.per_field_quality.citations,
    verifiedEmpty.per_field_quality.citations,
    "unknown and verified-empty must not collapse"
  );
});

test("R04-08 — an unexpected JSON object yields a typed parse error, never valid-no-AIO", async (t) => {
  const out = parseGoogleSerp({ unexpected_shape: "not a google result" });
  assert.equal(out.serp_state, SERP_STATE.UNKNOWN_SCHEMA);
  assert.equal(out.aio_present, null, "unknown schema is never absence");
  assert.equal(out.ok, false);

  // And on the transport, the same payload must raise, not be returned as a SERP.
  pinZone(t);
  mockFetch(t, async () => new Response(JSON.stringify({ unexpected_shape: "not a google result" }), { status: 200 }));
  await assert.rejects(
    () => brightDataSearch("audit query", { attempts: 1, timeout: 500 }),
    (err) => {
      assert.ok(isBrightDataParseError(err), `expected a typed parse error, got ${err?.name}: ${err?.message}`);
      assert.equal(err.reason, "unknown_schema");
      assert.notEqual(err.serp_state, SERP_STATE.VALID_SERP);
      return true;
    },
    "a malformed 200 must never come back as a no-AIO SERP"
  );
});

test("R04-09 — an empty body or null payload fails with a specific reason, not an empty answer", () => {
  const empty = parseGoogleSerp("");
  assert.equal(empty.serp_state, SERP_STATE.MALFORMED);
  assert.equal(empty.errors[0].code, "empty_body");
  assert.equal(empty.aio_present, null);
  assert.equal(empty.ok, false);

  const nil = parseGoogleSerp(null);
  assert.equal(nil.serp_state, SERP_STATE.MALFORMED);
  assert.equal(nil.errors[0].code, "null_payload");
  assert.equal(nil.aio_present, null);
});

test("R04-10 — truncated JSON is a decode error retained with evidence identity", async (t) => {
  const out = parseGoogleSerp('{"ai_overview": {"texts": [{"snippet": "Acme is a');
  assert.equal(out.serp_state, SERP_STATE.MALFORMED);
  assert.equal(out.errors[0].code, "json_decode_error");
  assert.ok(out.evidence.evidence_id, "the malformed bytes keep a derived identity");
  assert.equal(out.evidence.parser_version, GOOGLE_PAYLOAD_PARSER_VERSION);

  pinZone(t);
  mockFetch(t, async () => new Response('{"ai_overview": {"texts": [{"snippet": "Acme is a', { status: 200 }));
  await assert.rejects(
    () => brightDataSearch("audit query", { attempts: 1, timeout: 500 }),
    (err) => {
      assert.ok(isBrightDataParseError(err));
      assert.equal(err.reason, "json_decode_error");
      assert.ok(err.evidence?.evidence_id, "the decode failure carries evidence identity");
      return true;
    },
    "malformed bytes must never become a SERP on the final attempt"
  );
});

test("R04-11 — an HTTP-200 proxy-session failure is a provider-capacity failure, not Google output", async (t) => {
  const envelope = { status_code: 200, headers: { "x-brd-error": "no_ready_cookies" }, body: "" };
  const out = parseGoogleSerp(envelope);
  assert.equal(out.serp_state, SERP_STATE.PROVIDER_FAILURE);
  assert.equal(out.aio_present, null);
  assert.equal(out.errors[0].code, "provider_failure");

  pinZone(t);
  mockFetch(t, async () => new Response(JSON.stringify(envelope), { status: 200 }));
  await assert.rejects(
    () => brightDataSearch("audit query", { attempts: 1, timeout: 500 }),
    (err) => {
      assert.ok(isBrightDataParseError(err), `expected the provider-capacity type, got ${err?.name}`);
      assert.equal(err.reason, SERP_STATE.PROVIDER_FAILURE);
      return true;
    },
    "a 200 that carried no page must not be read as a valid no-AIO result"
  );
});

test("R04-12 — CAPTCHA / consent / login HTML is an access state with no substituted answer", async (t) => {
  const html =
    "<!DOCTYPE html><html><body><form>Our systems have detected unusual traffic. " +
    "Please solve the CAPTCHA to continue.</form></body></html>";
  const out = parseGoogleSerp(html);
  assert.equal(out.serp_state, SERP_STATE.ACCESS_STATE);
  assert.equal(out.aio_present, null);
  assert.deepEqual(out.blocks, []);
  assert.deepEqual(out.citations, []);
  assert.equal(out.errors[0].code, "access_challenge");

  pinZone(t);
  let calls = 0;
  mockFetch(t, async () => {
    calls++;
    return new Response(html, { status: 200 });
  });
  await assert.rejects(
    () => brightDataSearch("audit query", { attempts: 2, backoffMs: 0, timeout: 500 }),
    (err) => {
      assert.ok(isBrightDataParseError(err));
      assert.equal(err.serp_state, SERP_STATE.ACCESS_STATE);
      return true;
    }
  );
  assert.equal(calls, 1, "an access wall is not retried — it is not transient and no answer may be substituted");
});

test("R04-13 — unsafe/invalid reference schemes are rejected, safe links preserved", () => {
  const out = parseGoogleSerp({
    ai_overview: {
      texts: [{ snippet: "Acme is good." }],
      references: [
        { href: "javascript:alert(1)" },
        { href: "data:text/html,<b>x</b>" },
        { href: "not a url" },
        { href: "https://acme.example/safe" },
      ],
    },
  });

  assert.deepEqual(out.citations, ["https://acme.example/safe"], "only the safe link survives");
  const codes = out.errors.map((e) => e.code).sort();
  assert.deepEqual(codes, ["invalid_url", "unsafe_url_scheme", "unsafe_url_scheme"]);
  assert.ok(
    out.errors.every((e) => Number.isInteger(e.reference_index)),
    "every rejection names the reference it rejected"
  );
  assert.equal(out.per_field_quality.citations, FIELD_QUALITY.PARTIAL, "a partially-usable list is partial");
});

test("R04-14 — out-of-range reference indexes are a mapping issue, never a wrong source", () => {
  const out = parseGoogleSerp({
    ai_overview: {
      texts: [{ snippet: "A claim", reference_indexes: [5, -1] }],
      references: [{ href: "https://acme.example/a" }, { href: "https://rival.example/b" }],
    },
  });

  const mappingIssues = out.errors.filter((e) => e.code === "reference_index_out_of_range");
  assert.equal(mappingIssues.length, 2, "both bad indexes are recorded");
  assert.deepEqual(mappingIssues.map((e) => e.reference_index).sort(), [-1, 5]);
  assert.deepEqual(out.blocks[0].citation_urls, [], "no source is assigned to a block with no valid index");
  assert.equal(out.citations.length, 2, "the valid references are still listed");
});

test("R04-15 — a malformed first response then a valid one keeps both evidence records", async (t) => {
  pinZone(t);
  let calls = 0;
  mockFetch(t, async () => {
    calls++;
    const payload =
      calls === 1
        ? { unexpected_shape: "not a google result" }
        : { body: JSON.stringify({ organic: [{ link: "https://acme.example/a", domain: "acme.example", title: "Acme" }] }) };
    return new Response(JSON.stringify(payload), { status: 200 });
  });

  const out = await brightDataSearch("best crm", { attempts: 2, backoffMs: 0, timeout: 500 });

  assert.equal(calls, 2, "the malformed attempt is retried");
  assert.ok(out.organic, "the valid attempt is returned parsed");
  assert.equal(out.__brightdata.attempts.length, 2, "both attempt records are retained");
  assert.equal(out.__brightdata.attempts[0].serp_state, SERP_STATE.UNKNOWN_SCHEMA);
  assert.equal(out.__brightdata.attempts[1].serp_state, SERP_STATE.VALID_SERP);
  assert.ok(out.__brightdata.attempts[0].evidence_id, "the failed attempt keeps an evidence id");
});

test("R04-16 — every attempt malformed exhausts retries to a parse_error, never a silent accept", async (t) => {
  pinZone(t);
  let calls = 0;
  mockFetch(t, async () => {
    calls++;
    return new Response(JSON.stringify({ unexpected_shape: "not a google result" }), { status: 200 });
  });

  await assert.rejects(
    () => brightDataSearch("best crm", { attempts: 2, backoffMs: 0, timeout: 500 }),
    (err) => {
      assert.ok(isBrightDataParseError(err));
      assert.equal(err.reason, "unknown_schema");
      assert.equal(err.attempts.length, 2, "the terminal error records every attempt");
      return true;
    },
    "the final attempt must satisfy the same validation as the first"
  );
  assert.equal(calls, 2);
});

test("R04-17 — headers arrive but the body hangs; the shared deadline aborts the read", async (t) => {
  pinZone(t);
  let calls = 0;
  mockFetch(t, async (url, init) => {
    calls++;
    return {
      ok: true,
      status: 200,
      // Headers resolve immediately; the body never arrives on its own. Only the
      // still-armed abort timer can end the read.
      text: () =>
        new Promise((_, reject) => {
          init.signal.addEventListener("abort", () =>
            reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }))
          );
        }),
    };
  });

  const started = Date.now();
  await assert.rejects(
    () => brightDataSearch("best crm", { attempts: 1, timeout: 40 }),
    (err) => {
      assert.equal(err.name, "AbortError", `expected the abort to reach the caller, got ${err?.name}`);
      return true;
    }
  );
  assert.ok(Date.now() - started < 1000, "the body read must end inside the deadline, not hang");
  assert.equal(calls, 1);
});

test("R04-18 — a hanging zone lookup ends within its deadline, and no paid SERP dispatch follows", async (t) => {
  useEnv(t, { BRIGHTDATA_API_KEY: "bd-EXAMPLE-NOT-A-REAL-KEY" });
  invalidateBrightDataZoneCache("test setup");
  t.after(() => invalidateBrightDataZoneCache("test teardown"));

  let serpCalls = 0;
  mockFetch(t, async (url, init) => {
    if (String(url).includes("get_all_zones")) {
      return new Promise((_, reject) => {
        init.signal.addEventListener("abort", () =>
          reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }))
        );
      });
    }
    serpCalls++;
    return new Response(JSON.stringify({ body: JSON.stringify({ organic: [{ link: "https://x.example" }] }) }), {
      status: 200,
    });
  });

  const started = Date.now();
  await assert.rejects(
    () => brightDataSearch("best crm", { zoneLookupTimeoutMs: 30, deadlineMs: 5000, attempts: 1 }),
    (err) => {
      assert.ok(isBrightDataZoneError(err), `expected a typed zone error, got ${err?.name}: ${err?.message}`);
      assert.equal(err.reason, "lookup_failed");
      return true;
    }
  );
  assert.ok(Date.now() - started < 1000, "the lookup must end inside its deadline");
  assert.equal(serpCalls, 0, "no paid SERP request may follow a zone lookup that did not complete");
});

test("R04-19 — remaining lease/chunk time too short refuses dispatch with a reason", async (t) => {
  pinZone(t);
  let calls = 0;
  mockFetch(t, async () => {
    calls++;
    return new Response("{}", { status: 200 });
  });

  await assert.rejects(
    () => brightDataSearch("best crm", { deadlineMs: 10 }),
    (err) => {
      assert.ok(isBrightDataDeadlineError(err), `expected a deadline refusal, got ${err?.name}`);
      assert.equal(err.reason, "insufficient_time");
      return true;
    }
  );
  assert.equal(calls, 0, "a probe that cannot finish must not spend a request");
});

test("R04-20 — 30 valid no-AIO SERPs give healthy collection, zero trigger, and no conditional score", async (t) => {
  useEnv(t, {
    BRIGHTDATA_API_KEY: "bd-EXAMPLE-NOT-A-REAL-KEY",
    BRIGHTDATA_SERP_ZONE: "zone_fake",
    ENGINES: "aio",
  });
  const noAioSerp = {
    general: { query: "x" },
    organic: [{ position: 1, title: "A tiles shop", link: "https://tiles.example/a", domain: "tiles.example" }],
  };
  mockFetch(t, async () => new Response(JSON.stringify({ body: JSON.stringify(noAioSerp) }), { status: 200 }));

  const aio = resolveEnabledEngines().find((e) => e.name === "aio");
  assert.ok(aio, "the aio engine must resolve for this scan");

  const rows = [];
  const parsed = [];
  for (let i = 0; i < 30; i++) {
    rows.push(
      await aio.probe({ text: `buyer question ${i}`, topic: "General", source: "test" }, "Acme", ["Acme"], "acme.example", [], null)
    );
    parsed.push(parseGoogleSerp(noAioSerp));
  }

  // The worker's summariser: no answer and no invented score.
  const slice = summarizeEngineSlice(rows, "aio");
  assert.equal(slice.queries_with_answer, 0, "zero AIO trigger");
  assert.equal(slice.share_of_ai_pct, null, "the conditional AIO score is explicitly unavailable, not 0");

  // The collection contract over the same payloads: absence of an AIO is valid
  // collection, so completion is 100% and the trigger rate is a measured zero.
  const collection = summarizeSerpCollection(parsed);
  assert.equal(collection.planned, 30);
  assert.equal(collection.valid_serp, 30);
  assert.equal(collection.valid_no_aio, 30);
  assert.equal(collection.collection_complete, true, "30 valid no-AIO SERPs are healthy collection");
  assert.equal(collection.collection_pct, 100);
  assert.equal(collection.trigger_rate_pct, 0);
  assert.equal(collection.failed, 0);
  assert.equal(collection.conditional_aio_score, null);
  assert.equal(collection.conditional_aio_score_available, false);
});

test("R04-22 — a parser-drift alert carries version and shape but no secrets or full payload", () => {
  const out = parseGoogleSerp({
    api_key: "sk-SECRET-fake-value",
    private_note: "PRIVATE-INTERNAL-PAYLOAD-TEXT",
    unexpected_shape: { nested: true },
  });
  assert.equal(out.serp_state, SERP_STATE.UNKNOWN_SCHEMA);

  const alert = buildParserDriftAlert(out);
  assert.ok(alert, "an unknown schema must produce a drift alert");
  assert.equal(alert.parser_version, GOOGLE_PAYLOAD_PARSER_VERSION);
  assert.equal(typeof alert.shape, "object", "the shape (keys and types) is in the alert");
  assert.ok(alert.shape.api_key, "the shape lists the unexpected key names");
  assert.ok(alert.evidence_id, "the derived payload id rides the alert");

  const serialized = JSON.stringify(alert);
  assert.ok(!serialized.includes("sk-SECRET-fake-value"), "no secret value may appear in the alert");
  assert.ok(!serialized.includes("PRIVATE-INTERNAL-PAYLOAD-TEXT"), "no private payload text may appear");
});

/**
 * R04-21 is a database case (the QA evidence store) and R04-23/R04-24 are live
 * provider cases. No database work and no provider calls are permitted in this
 * pass, so they are recorded as BLOCKED rather than faked.
 */
test("R04-21 — evidence write failure after the provider response stays durable", {
  skip: "BLOCKED — requires the QA evidence store; no database work is permitted in this pass.",
}, () => {});

test("R04-23 — fixed authorized India corpus capture and manual compare", {
  skip: "BLOCKED — live authorized provider capture; no provider calls are permitted in this pass.",
}, () => {});

test("R04-24 — a real no-AIO observation at collection time", {
  skip: "BLOCKED — live provider observation; no provider calls are permitted in this pass.",
}, () => {});

import test from "node:test";
import assert from "node:assert/strict";
// The only place a Node built-in may touch this repair: the TEST side. The
// parser itself must stay importable from a browser bundle (R04 finding 1), so
// the digest it computes is compared against node:crypto HERE, where a Node
// runtime is guaranteed, rather than imported by the module under test.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import {
  FIELD_QUALITY,
  GOOGLE_PAYLOAD_PARSER_VERSION,
  SERP_STATE,
  buildParserDriftAlert,
  parseGoogleSerp,
  summarizeSerpCollection,
} from "../../shared/engines/googlePayload.js";
import {
  brightDataSearch,
  extractBrightDataAiOverview,
  invalidateBrightDataZoneCache,
  isBrightDataDeadlineError,
  isBrightDataParseError,
  isBrightDataZoneError,
} from "../../shared/engines/brightdata.js";
import { resolveEnabledEngines, summarizeEngineSlice } from "../../shared/scoring/enginePipeline.js";

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

/**
 * The AIO engine as the scan runner resolves it, and one probe on it.
 *
 * R04's last four cases are pinned THROUGH this, not through parseGoogleSerp
 * alone: the defect was that the validated parse result never reached the path
 * that produces and persists the probe row, so a test that stops at the parser
 * cannot see it.
 */
function aioEngine() {
  const aio = resolveEnabledEngines().find((e) => e.name === "aio");
  assert.ok(aio, "the aio engine must resolve for this scan");
  return aio;
}

const PROBE_QUERY = { text: "best vitrified tiles", topic: "General", source: "test" };

async function probeAioRow(aio) {
  return aio.probe(PROBE_QUERY, "Acme", ["Acme"], "acme.example", ["Rival"], null);
}

/**
 * The JSON round trip prompt_results.raw performs: scanWorker persists the
 * probe row verbatim (`raw: result`), so anything that does not survive
 * JSON.stringify does not survive to the database either.
 */
function persisted(value) {
  return JSON.parse(JSON.stringify(value));
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

/* R04 finding 4 — the fixtures driven through the real AIO ENGINE probe, so the
 * parser's verdict is exercised on the path that produces the persisted row. */
const REFERENCE_ONLY_AIO = { ai_overview: { references: [{ href: "https://acme.example/proof" }] } };
const TEXT_ONLY_AIO = { ai_overview: { texts: [{ snippet: "Acme is good." }] } };
const VERIFIED_EMPTY_AIO = {
  ai_overview: { texts: [{ snippet: "Acme is good." }], references: [] },
};
const UNSAFE_REFERENCE_AIO = {
  ai_overview: {
    texts: [{ snippet: "Acme is good." }],
    references: [{ href: "javascript:alert(1)" }, { href: "https://acme.example/safe" }],
  },
};
const MAPPING_BUG_AIO = {
  ai_overview: {
    texts: [{ snippet: "A claim", reference_indexes: [5, -1] }],
    references: [{ href: "https://acme.example/a" }, { href: "https://rival.example/b" }],
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

  // R04 finding 1 — THE EVIDENCE ID IS STILL THE SAME DIGEST.
  //
  // The parser no longer hashes with node:crypto (a static Node built-in import
  // in this module fails the Next build for every page that renders
  // DashboardShell: `UnhandledSchemeError: Reading from "node:crypto"`, import
  // trace /dashboard/page.js). Evidence ids are already written into persisted
  // evidence records, so the replacement must produce the SAME digest — a
  // cheaper hash would be shorter, faster, and would orphan every stored id.
  // node:crypto appears on the TEST side only, deliberately.
  const payload = '{"organic":[{"link":"https://tiles.example/a"}]}';
  assert.equal(
    parseGoogleSerp(payload).evidence.evidence_id,
    "bd_" + createHash("sha256").update(payload).digest("hex").slice(0, 24),
    "the browser-safe hash must be byte-identical to the one the server used"
  );

  // …and the browser-safety itself is pinned statically, because the failure it
  // guards against is a BUILD failure: nothing at runtime in this suite would
  // notice a Node built-in reappearing in the module. Only import/export
  // statements are matched, so the prose above (which names the offending
  // specifier) is not the thing being asserted about.
  const source = readFileSync(new URL("../../shared/engines/googlePayload.js", import.meta.url), "utf8");
  assert.doesNotMatch(
    source,
    /(?:^|\n)\s*(?:import|export)\b[^;]*["']node:/m,
    "googlePayload.js is imported by enginePipeline.js, which DashboardShell.jsx imports: a Node built-in here breaks the client bundle"
  );
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

test("R04-06 — a reference-only AIO stays partial: citations kept, text never complete", async (t) => {
  const out = parseGoogleSerp(REFERENCE_ONLY_AIO);

  assert.equal(out.aio_present, true);
  assert.deepEqual(out.blocks, [], "there is no answer text to measure");
  assert.deepEqual(out.citations, ["https://acme.example/proof"], "the citation observation survives");
  assert.equal(out.per_field_quality.text, FIELD_QUALITY.PARTIAL, "missing text is explicitly partial");
  assert.notEqual(out.per_field_quality.text, FIELD_QUALITY.COMPLETE, "never a complete mention measurement");
  assert.equal(out.per_field_quality.citations, FIELD_QUALITY.COMPLETE);

  // R04 finding 4 — the SAME fixture through the enabled AIO engine and through
  // the JSON that gets persisted. The parser's per-field quality used to be
  // computed and discarded, so no consumer — extraction, probe row, or the
  // persisted `raw` — could tell that this answer's text was PARTIAL rather than
  // complete. A test that stops at parseGoogleSerp cannot see that.
  pinZone(t);
  mockFetch(t, async () => new Response(JSON.stringify(REFERENCE_ONLY_AIO), { status: 200 }));

  const data = await brightDataSearch("best vitrified tiles", { attempts: 1, timeout: 500 });
  const extraction = extractBrightDataAiOverview(data);
  assert.equal(
    extraction.per_field_quality.text,
    FIELD_QUALITY.PARTIAL,
    "the extraction path reads the parser's quality instead of re-deriving the fields"
  );
  assert.equal(extraction.aio_present, true);

  const row = persisted(await probeAioRow(aioEngine()));
  assert.equal(row.answer_present, true, "citations alone are an answer");
  assert.equal(row.aio_present, true);
  assert.equal(row.text, "", "no answer text may be invented for a reference-only Overview");
  assert.deepEqual(row.citations, ["https://acme.example/proof"]);
  assert.deepEqual(row.references.map((r) => r.href), ["https://acme.example/proof"]);

  const stored = persisted(data);
  assert.equal(
    stored.serp_validation.per_field_quality.text,
    FIELD_QUALITY.PARTIAL,
    "the quality survives the JSON round trip into prompt_results.raw"
  );
  assert.equal(stored.serp_validation.parser_version, GOOGLE_PAYLOAD_PARSER_VERSION);
  assert.equal(stored.serp_validation.aio_present, true);
  assert.ok(stored.serp_validation.evidence_id, "and so does the derived evidence identity");
});

test("R04-07 — a text-only AIO distinguishes citations-unavailable from a verified empty list", async (t) => {
  const noCitationField = parseGoogleSerp(TEXT_ONLY_AIO);
  const verifiedEmpty = parseGoogleSerp(VERIFIED_EMPTY_AIO);

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

  // R04 finding 4 — both variants through the adapter and the enabled engine
  // probe. The distinction has to survive JSON serialization, or a persisted
  // row cannot say whether the citation list was unobserved or observed-empty.
  pinZone(t);
  let payload = TEXT_ONLY_AIO;
  mockFetch(t, async () => new Response(JSON.stringify(payload), { status: 200 }));

  const unavailable = persisted(
    await brightDataSearch("best vitrified tiles", { attempts: 1, timeout: 500 })
  );
  payload = VERIFIED_EMPTY_AIO;
  const empty = persisted(
    await brightDataSearch("best vitrified tiles", { attempts: 1, timeout: 500 })
  );

  assert.equal(
    unavailable.serp_validation.per_field_quality.citations,
    FIELD_QUALITY.UNAVAILABLE
  );
  assert.equal(unavailable.serp_validation.citations_verified_empty, false);
  assert.equal(empty.serp_validation.per_field_quality.citations, FIELD_QUALITY.COMPLETE);
  assert.equal(empty.serp_validation.citations_verified_empty, true);
  assert.notEqual(
    unavailable.serp_validation.per_field_quality.citations,
    empty.serp_validation.per_field_quality.citations,
    "unknown and verified-empty must not collapse in the persisted result either"
  );

  const row = persisted(await probeAioRow(aioEngine()));
  assert.equal(row.text, "Acme is good.", "the validated block text is what the probe measures");
  assert.deepEqual(row.citations, []);
  assert.equal(row.answer_present, true, "text alone is an answer");
});

/**
 * R04 finding 3 — payloads that carry a Google SERP SECTION KEY with a value the
 * section does not ship in.
 *
 * A key is not evidence. `{organic: null}`, `{organic: "not-an-array"}` and
 * `{general: null}` all parsed as `ok: true` / `valid_no_aio` on the audited
 * head: a false healthy no-AIO observation manufactured out of a payload nobody
 * could read, which is A10 re-entering through A01. Through the adapter the
 * same payloads reached `normalizeBrightDataResponse` on the final attempt.
 *
 * NOT in this list, deliberately: an empty array. A real Google page with no
 * results carries `organic: []` — right key, right type, zero results — and
 * calling THAT a failure would be A01 from the other side.
 */
const UNREADABLE_SERP_SECTIONS = [
  ["organic: null", { organic: null }],
  ["organic: a string", { organic: "not-an-array" }],
  ["general: null", { general: null }],
];

/** A payload that reports its own failure rather than a SERP. */
const SERP_ERROR_STATUS = { search_metadata: { status: "Error" } };

/**
 * A GENUINE zero-result SERP: Google answered, it answered with no results, and
 * no AI Overview. This must keep classifying as valid-no-AIO.
 */
const ZERO_RESULT_SERP = {
  search_metadata: { status: "Success" },
  search_information: { query_displayed: "zzzq asdfgh", total_results: 0 },
  organic: [],
};

test("R04-08 — an unexpected object, an unreadable section value, or a stated failure is never valid-no-AIO", async (t) => {
  const out = parseGoogleSerp({ unexpected_shape: "not a google result" });
  assert.equal(out.serp_state, SERP_STATE.UNKNOWN_SCHEMA);
  assert.equal(out.aio_present, null, "unknown schema is never absence");
  assert.equal(out.ok, false);

  // And on the transport, the same payload must raise, not be returned as a SERP.
  pinZone(t);
  let payload = { unexpected_shape: "not a google result" };
  mockFetch(t, async () => new Response(JSON.stringify(payload), { status: 200 }));
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

  // R04 finding 3 — a familiar key with an unreadable value, on the parser and
  // on the transport.
  for (const [label, unreadable] of UNREADABLE_SERP_SECTIONS) {
    const asParsed = parseGoogleSerp(unreadable);
    assert.equal(asParsed.serp_state, SERP_STATE.UNKNOWN_SCHEMA, `${label} is not a Google SERP`);
    assert.equal(asParsed.aio_present, null, `${label}: the AIO state is UNKNOWN, never absent`);
    assert.equal(asParsed.ok, false, `${label} must not be ok`);
    assert.equal(asParsed.errors[0].code, "serp_section_unusable", `${label}: named as an unreadable section`);
  }

  const asFailure = parseGoogleSerp(SERP_ERROR_STATUS);
  assert.equal(
    asFailure.serp_state,
    SERP_STATE.PROVIDER_FAILURE,
    "a capture that reports its own failure is a failure, not a SERP with no Overview"
  );
  assert.equal(asFailure.aio_present, null);
  assert.equal(asFailure.errors[0].code, "serp_error_status");

  const throughAdapter = [...UNREADABLE_SERP_SECTIONS, ["a stated failure", SERP_ERROR_STATUS]];
  for (const [label, body] of throughAdapter) {
    payload = body;
    await assert.rejects(
      () => brightDataSearch("audit query", { attempts: 1, timeout: 500 }),
      (err) => {
        assert.ok(
          isBrightDataParseError(err),
          `${label}: expected a typed parse error through the adapter, got ${err?.name}: ${err?.message}`
        );
        assert.notEqual(err.serp_state, SERP_STATE.VALID_SERP, `${label} must not be a valid SERP`);
        assert.equal(err.aio_present, null, `${label}: the AIO state is UNKNOWN, never false`);
        return true;
      },
      `${label} must fail through the adapter rather than be returned as a no-AIO SERP`
    );
  }

  // ...and the shape that must still succeed, through the same adapter.
  payload = ZERO_RESULT_SERP;
  const zeroResult = await brightDataSearch("audit query", { attempts: 1, timeout: 500 });
  assert.deepEqual(zeroResult.organic, [], "a genuine zero-result SERP is returned, not rejected");
  assert.equal(zeroResult.serp_validation.aio_present, false, "and its absence of an AIO is the measured fact");
  assert.equal(zeroResult.serp_validation.per_field_quality.text, FIELD_QUALITY.ABSENT);
  assert.deepEqual(zeroResult.serp_validation.errors, [], "nothing about a real no-results page is a defect");

  const zeroResultParsed = parseGoogleSerp(ZERO_RESULT_SERP);
  assert.equal(zeroResultParsed.serp_state, SERP_STATE.VALID_SERP);
  assert.equal(zeroResultParsed.aio_present, false);
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

test("R04-13 — unsafe/invalid reference schemes are rejected, safe links preserved", async (t) => {
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

  // R04 finding 4 — THE ONE THAT MATTERS IN PRODUCTION. The parser rejected the
  // javascript: href, but the enabled AIO engine rebuilt its references from the
  // raw payload and put it back — in the probe row, and in the `raw` JSON
  // scanWorker persists verbatim. Asserted at the row that gets persisted, not
  // at parseGoogleSerp, because that is where the validated verdict was lost.
  pinZone(t);
  mockFetch(t, async () => new Response(JSON.stringify(UNSAFE_REFERENCE_AIO), { status: 200 }));

  const data = await brightDataSearch("best vitrified tiles", { attempts: 1, timeout: 500 });
  const row = persisted(await probeAioRow(aioEngine()));

  assert.deepEqual(
    row.references.map((r) => r.href),
    ["https://acme.example/safe"],
    "a rejected href must never reappear in the persisted probe row"
  );
  assert.deepEqual(row.citations, ["https://acme.example/safe"]);
  assert.equal(row.text, "Acme is good.");
  assert.equal(row.answer_present, true);
  assert.equal(row.brand_cited, true, "the surviving reference is still matched to the brand");

  // And the validated verdict has to reach the row as a whole, not just its
  // safety-filtered hrefs: without per-field quality a stored row cannot tell
  // "the AIO carried no text" from "we could not read its text", and without a
  // parser version or an evidence identity the capture cannot be audited back to
  // the payload it came from. Compared against what the parser itself produced,
  // so this pins the wiring rather than a guess about the payload's quality.
  assert.equal(
    row.per_field_quality.citations,
    FIELD_QUALITY.PARTIAL,
    "per-field quality survives into the persisted probe row"
  );
  assert.equal(row.citations_verified_empty, out.citations_verified_empty);
  assert.equal(row.parser_version, out.parser_version, "the row says which parser version measured it");
  // Shape, not equality with `out`: `out` parses a bare in-memory payload, so it
  // has no capture identity, while the row came through brightDataSearch and must
  // name the evidence it was captured from.
  assert.match(
    row.evidence_id,
    /^bd_[0-9a-f]{24}$/,
    "the row carries the evidence identity of the capture it came from"
  );
  assert.ok(
    !JSON.stringify(row).includes("javascript:"),
    "nothing that reaches persistence may carry the rejected scheme anywhere"
  );

  const stored = persisted(data);
  assert.equal(stored.serp_validation.per_field_quality.citations, FIELD_QUALITY.PARTIAL);
  assert.ok(
    stored.serp_validation.errors.some((e) => e.code === "unsafe_url_scheme"),
    "the rejection is recorded on the persisted validation, so a dropped link is auditable rather than silently gone"
  );
  assert.deepEqual(stored.serp_validation.citations, ["https://acme.example/safe"]);
});

test("R04-14 — out-of-range reference indexes are a mapping issue, never a wrong source", async (t) => {
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

  // R04 finding 4 — the mapping defect is a property of the PERSISTED result,
  // not just of the in-memory parse: what reaches the database must show an
  // unlinked block plus two recorded index errors, never a block silently
  // attributed to a source it does not have.
  pinZone(t);
  mockFetch(t, async () => new Response(JSON.stringify(MAPPING_BUG_AIO), { status: 200 }));

  const data = await brightDataSearch("best vitrified tiles", { attempts: 1, timeout: 500 });
  const row = persisted(await probeAioRow(aioEngine()));
  assert.equal(row.text, "A claim");
  assert.deepEqual(
    row.references.map((r) => r.href),
    ["https://acme.example/a", "https://rival.example/b"],
    "the valid references survive to the row"
  );

  const stored = persisted(data);
  assert.deepEqual(
    stored.serp_validation.blocks[0].citation_urls,
    [],
    "the block keeps no citation after the round trip — the index never resolved"
  );
  assert.equal(
    stored.serp_validation.errors.filter((e) => e.code === "reference_index_out_of_range").length,
    2,
    "the mapping issue is persisted as an error, not as a wrong source"
  );
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

  // R04 finding 4 — the metadata that survives PERSISTENCE is the enumerable
  // one. `__brightdata` is non-enumerable on purpose (it keeps Object.keys of a
  // returned SERP equal to the SERP's own keys, which is the A10 signal), and
  // that is exactly why it cannot be the copy a probe result is written to the
  // database with.
  assert.equal(
    persisted(out).__brightdata,
    undefined,
    "the non-enumerable A10 metadata is not what survives JSON serialization"
  );
  assert.equal(
    persisted(out).serp_validation.serp_state,
    SERP_STATE.VALID_SERP,
    "so the validated parse result rides an enumerable key instead"
  );
});

test("R04-16 — every attempt malformed exhausts retries to a parse_error, never a silent accept", async (t) => {
  pinZone(t);
  let payload = { unexpected_shape: "not a google result" };
  let calls = 0;
  mockFetch(t, async () => {
    calls++;
    return new Response(JSON.stringify(payload), { status: 200 });
  });

  // Two different nothings are exercised here, because the LAST attempt is the
  // one that used to fall through to the normaliser: a payload with no Google
  // key at all, and a payload whose familiar key carries a value nothing can
  // read (R04 finding 3 — `{organic: null}` used to come back as a successful
  // no-AIO SERP on exactly this attempt).
  for (const body of [{ unexpected_shape: "not a google result" }, { organic: null }]) {
    payload = body;
    calls = 0;
    await assert.rejects(
      () => brightDataSearch("best crm", { attempts: 2, backoffMs: 0, timeout: 500 }),
      (err) => {
        assert.ok(isBrightDataParseError(err));
        assert.equal(err.reason, "unknown_schema");
        assert.equal(err.serp_state, SERP_STATE.UNKNOWN_SCHEMA);
        assert.equal(
          err.aio_present,
          null,
          "a capture that failed validation leaves the AIO state UNKNOWN — never a readable false"
        );
        assert.equal(err.attempts.length, 2, "the terminal error records every attempt");
        return true;
      },
      `${JSON.stringify(body)}: the final attempt must satisfy the same validation as the first`
    );
    assert.equal(calls, 2, `${JSON.stringify(body)}: every attempt was really made`);
  }
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

test("R04-18 — a zone lookup that stalls its BODY still ends inside its deadline, and dispatches nothing", async (t) => {
  // The case the fetch-stub test above cannot reach: the lookup CONNECTS and
  // sends its headers, then stalls the body. The abort timer used to be cleared
  // the moment fetch() resolved, with `await res.json()` below it, so nothing
  // bounded the read: measured here, a 150ms lookup timeout against a body
  // delayed by 600ms resolved successfully after ~616ms and went on to parse an
  // empty zone list. A REAL local server is used because the whole point is
  // whether a real socket read is bounded — a stubbed `json()` proves it only
  // for the stub.
  useEnv(t, { BRIGHTDATA_API_KEY: "bd-EXAMPLE-NOT-A-REAL-KEY" });
  invalidateBrightDataZoneCache("test setup");
  t.after(() => invalidateBrightDataZoneCache("test teardown"));

  const STALL_MS = 600;
  const LOOKUP_TIMEOUT_MS = 150;
  const realFetch = globalThis.fetch;
  const stallTimers = new Set();

  const server = createServer((req, res) => {
    // Headers now, body later — and the headers must actually LEAVE this process,
    // or the client's fetch has not resolved and the stall is not the one under
    // test: writeHead() only stages headers, flushHeaders() sends them.
    res.writeHead(200, { "Content-Type": "application/json" });
    res.flushHeaders();
    // The client aborts this read on purpose, so a reset raised on this side is
    // expected and must not crash the test process.
    res.on("error", () => {});
    const timer = setTimeout(() => {
      stallTimers.delete(timer);
      if (!res.writableEnded && !res.destroyed) res.end("[]");
    }, STALL_MS);
    stallTimers.add(timer);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  t.after(() => {
    for (const timer of stallTimers) clearTimeout(timer);
    return new Promise((resolve) => server.close(resolve));
  });

  let serpCalls = 0;
  mockFetch(t, async (url, init) => {
    if (String(url).includes("get_all_zones")) {
      return realFetch(`http://127.0.0.1:${port}/zone/get_all_zones`, init);
    }
    serpCalls++;
    throw new Error("no SERP request may be dispatched for a lookup that did not complete");
  });

  const started = Date.now();
  await assert.rejects(
    () => brightDataSearch("best crm", { zoneLookupTimeoutMs: LOOKUP_TIMEOUT_MS, deadlineMs: 5000, attempts: 1 }),
    (err) => {
      assert.ok(isBrightDataZoneError(err), `expected a typed zone error, got ${err?.name}: ${err?.message}`);
      assert.equal(err.reason, "lookup_failed", "a stalled body is a lookup that did not complete");
      return true;
    }
  );
  const elapsed = Date.now() - started;

  assert.ok(
    elapsed < STALL_MS,
    `the lookup must end before the ${STALL_MS}ms body arrives, not after it (took ${elapsed}ms)`
  );
  assert.ok(elapsed < 1000, `the lookup must end inside its deadline (took ${elapsed}ms)`);
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

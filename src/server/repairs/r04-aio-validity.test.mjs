import test from "node:test";
import assert from "node:assert/strict";
import {
  GOOGLE_PAYLOAD_PARSER_VERSION,
  SERP_STATE,
  parseGoogleSerp,
  summarizeSerpCollection,
} from "../../shared/engines/googlePayload.js";
import { brightDataSearch, isBrightDataParseError } from "../../shared/engines/brightdata.js";
import { resolveEnabledEngines } from "../../shared/scoring/enginePipeline.js";
import { buildScorePlan, deriveScanOutcome } from "../../shared/scanOutcome.js";

/**
 * R04 — the defects behind the reviewer's five reproductions, each one a way
 * for an unmeasured or unreadable capture to pass as a measurement. Every fixture
 * below is one of the reviewer's payloads, run end to end: adapter → actual
 * engine probe → JSON serialization → terminal outcome, because every one of
 * them parsed, probed and derived "correctly" in isolation while the chain
 * still reported a fully valid no-AIO observation and 100% collection.
 *
 *   1. An absent Overview (`ai_overview: null`) with no other SERP evidence, and
 *      an empty object section (`{general:{}}`), parsed as a valid SERP with no
 *      AIO: asserted absence with nothing backing it, counted as a measurement.
 *   2. An Overview with a familiar key but nothing readable in it (`{texts:null}`,
 *      `{references:"not-an-array"}`, `{texts:[{unrecognized_field:…}]}`) was
 *      read as AIO *present* — and the probe then extracted nothing and wrote it
 *      absent, so the stored row contradicted the parse while still collecting.
 *   3. The metadata only reached rows that carried text or citations, so the
 *      valid no-AIO rows — the ones that must prove they were measured — carried
 *      no SERP state, no parser version and no evidence id.
 *
 * Everything here is synthetic (`.example` hosts, Acme/Rival) and offline: the
 * transport cases swap in a fetch stub and pin the zone.
 */

const ENV = ["BRIGHTDATA_API_KEY", "BRIGHTDATA_SERP_ZONE", "BRIGHTDATA_ZONE_TTL_MS", "ENGINES", "SERP_GEO"];

function applyEnv(t, env) {
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

function pinAioEnv(t) {
  applyEnv(t, {
    BRIGHTDATA_API_KEY: "bd-EXAMPLE-NOT-A-REAL-KEY",
    BRIGHTDATA_SERP_ZONE: "zone_fake",
    ENGINES: "aio",
  });
}

/** The Bright Data envelope the transport unwraps: the SERP JSON in `body`. */
function envelope(serp) {
  return new Response(JSON.stringify({ body: JSON.stringify(serp) }), { status: 200 });
}

function aioEngine() {
  const aio = resolveEnabledEngines().find((e) => e.name === "aio");
  assert.ok(aio, "the aio engine must resolve for this scan");
  return aio;
}

async function probeAioRow(aio) {
  return aio.probe({ text: "best vitrified tiles", topic: "General", source: "test" }, "Acme", ["Acme"], "acme.example", ["Rival"], null);
}

/** The JSON round trip prompt_results.raw performs. */
function persisted(value) {
  return JSON.parse(JSON.stringify(value));
}

/** A real SERP with no Overview: an organic result list and no `ai_overview`. */
function noAioSerp() {
  return {
    general: { query: "best vitrified tiles" },
    organic: [{ position: 1, title: "A tiles shop", link: "https://tiles.example/a", domain: "tiles.example" }],
  };
}

/* ------------------------------------------------------------------ *
 * 1. The reviewer's five reproductions, end to end
 * ------------------------------------------------------------------ */

/** The five payloads, exactly as the review exercised them. */
const REVIEW_FIXTURES = [
  ["empty general object", { general: {} }],
  ["lone explicit absent Overview", { ai_overview: null }],
  [
    "null texts",
    {
      general: { query: "buyer question" },
      organic: [{ position: 1, title: "A tiles shop", link: "https://tiles.example/a" }],
      ai_overview: { texts: null },
    },
  ],
  [
    "non-array references",
    {
      general: { query: "buyer question" },
      organic: [{ position: 1, title: "A tiles shop", link: "https://tiles.example/a" }],
      ai_overview: { references: "not-an-array" },
    },
  ],
  [
    "foreign block text",
    {
      general: { query: "buyer question" },
      organic: [{ position: 1, title: "A tiles shop", link: "https://tiles.example/a" }],
      ai_overview: { texts: [{ unrecognized_field: "not answer text" }] },
    },
  ],
];

test("R04-08 — the five review reproductions never reach a measured observation", async (t) => {
  pinAioEnv(t);

  // Parser first: none may be collected, and none with a present-but-unreadable
  // Overview may be read as absent.
  for (const [label, serp] of REVIEW_FIXTURES) {
    const out = parseGoogleSerp(serp);
    assert.notEqual(
      out.serp_state,
      SERP_STATE.VALID_SERP,
      `${label}: an unreadable capture is not a measurement`
    );
    assert.equal(out.aio_present, null, `${label}: AIO presence is indeterminate, never absent`);
    assert.equal(out.blocks.length, 0, `${label}: unreadable content produces no invented text`);
  }

  // Then the whole chain the review exercised — adapter, the actual enabled AIO
  // engine probe, JSON serialization, terminal outcome. The adapter sends the
  // Google query on the wire, not the fixture label, so the stub serves the
  // payloads in request order — one refused capture per probe, in the same order
  // as the five fixtures above. Each probe in turn must fail as a refused
  // collection attempt rather than as a no-AIO observation, and the outcome
  // derivation over those refused rows can never read as healthy.
  const fixtures = REVIEW_FIXTURES.map(([, serp]) => serp);
  let calls = 0;
  mockFetch(t, async () => {
    const serp = fixtures[Math.min(calls, fixtures.length - 1)];
    calls += 1;
    return envelope(serp);
  });

  const aio = aioEngine();
  const probeRows = [];
  for (const [i, [label]] of REVIEW_FIXTURES.entries()) {
    const row = persisted(
      await aio.probe({ text: `buyer question ${i}`, topic: "General", source: "test" }, "Acme", ["Acme"], "acme.example", ["Rival"], null)
    );
    probeRows.push(row);
    assert.ok(row.error, `${label}: the probe must record a refused collection attempt`);
    assert.equal(row.answer_present ?? false, false, `${label}: it must not be an answer`);
    assert.equal(row.aio_present ?? false, false, `${label}: it must not be a measured absence either`);
  }
  // The adapter retries a refused capture once before giving up (attempts: 2 by
  // default), so five probes make more than five requests. What matters is that
  // every request served a review payload and every one was refused: no attempt
  // at any of them produced a measurement.
  assert.equal(calls, 10, "each review payload was attempted and retried, and nothing else was fetched");

  const plan = buildScorePlan({
    prompts: REVIEW_FIXTURES.map((_, i) => ({ text: `buyer question ${i}` })),
    engines: ["aio"],
  });
  const outcome = deriveScanOutcome({
    plan,
    rows: probeRows.map((row, i) => ({
      engine: "aio",
      query: `buyer question ${i}`,
      answered: false,
      raw: row,
    })),
    engineNames: ["aio"],
  });
  assert.notEqual(outcome.outcome, "complete", "five unreadable captures can never be a complete scan");
  assert.equal(outcome.counts.valid, 0, "no valid observation exists to collect");
  assert.equal(outcome.outcome, "failed", "an all-refused collection fails rather than completing");
  assert.equal(
    outcome.metrics.collection_completion_pct,
    0,
    "and collection completion is a measured zero, not 100%"
  );
});

const UNREADABLE_AIO = [
  [{}, "an empty object"],
  [[], "an array"],
  [true, "a bare boolean"],
  [7, "a number"],
  ["", "an empty string"],
];

test("R04-08 — an ai_overview that is present but unreadable is unknown, never absent", () => {
  for (const [value, label] of UNREADABLE_AIO) {
    const out = parseGoogleSerp({ ...noAioSerp(), ai_overview: value });
    assert.equal(
      out.serp_state,
      SERP_STATE.UNKNOWN_SCHEMA,
      `${label}: an Overview we cannot read must not be reported as a readable SERP`
    );
    assert.equal(out.aio_present, null, `${label}: presence is UNKNOWN, not absent`);
    const error = out.errors.find((e) => e.code === "aio_section_unreadable");
    assert.ok(error, `${label}: the unreadable section must be named, got ${JSON.stringify(out.errors)}`);
    assert.equal(error.stage, "aio", `${label}: the error names the stage it was found at`);
    assert.equal(out.blocks.length, 0, `${label}: no text may be invented for it`);
  }

  // The two honest answers stay honest — this must not turn real absence into a
  // failure, which would be the same defect pointing the other way.
  for (const aiOverview of [undefined, null, false]) {
    const out = parseGoogleSerp(
      aiOverview === undefined ? noAioSerp() : { ...noAioSerp(), ai_overview: aiOverview }
    );
    assert.equal(out.serp_state, SERP_STATE.VALID_SERP, `ai_overview: ${String(aiOverview)} is a valid SERP`);
    assert.equal(out.aio_present, false, `ai_overview: ${String(aiOverview)} is an affirmed absence`);
  }

  const zeroResults = parseGoogleSerp({
    search_metadata: { status: "Success" },
    search_information: { total_results: 0 },
    organic: [],
    ai_overview: null,
  });
  assert.equal(zeroResults.serp_state, SERP_STATE.VALID_SERP, "a genuine zero-result SERP is still a SERP");
  assert.equal(zeroResults.aio_present, false);
});

test("R04-08 — empty AIO content is unreadable, never a measurement", () => {
  const EMPTY_CONTENT_AIO = [
    [{ texts: [] }, "empty texts array"],
    [{ references: [] }, "empty references with no text"],
    [{ references: [{}] }, "reference entries with nothing readable"],
    [{ texts: [{}] }, "text blocks with nothing readable"],
    [{ texts: ["   "] }, "whitespace-only text"],
    [{ texts: [{ text: "   " }] }, "whitespace-only block text"],
    [{ texts: [{ foreign_field: "not answer text" }] }, "foreign block fields"],
  ];

  for (const [aio, label] of EMPTY_CONTENT_AIO) {
    const out = parseGoogleSerp({ ...noAioSerp(), ai_overview: aio });
    assert.equal(
      out.serp_state,
      SERP_STATE.UNKNOWN_SCHEMA,
      `${label}: an Overview with no readable content is not a measurement`
    );
    assert.equal(out.aio_present, null, `${label}: presence is UNKNOWN, not absent`);
    const error = out.errors.find((e) => e.code === "aio_section_unreadable");
    assert.ok(error, `${label}: the unreadable section must be named, got ${JSON.stringify(out.errors)}`);
    assert.equal(out.blocks.length, 0, `${label}: no text may be invented for it`);
  }

  // The honest measured cases stay measured: a null texts field beside real
  // references is reference-only presence, and real text beside an empty
  // references list is text presence — neither is an empty shape.
  const refOnly = parseGoogleSerp({
    ...noAioSerp(),
    ai_overview: { texts: null, references: [{ href: "https://acme.example/proof", title: "Proof" }] },
  });
  assert.equal(refOnly.serp_state, SERP_STATE.VALID_SERP, "texts:null with real references is a measured Overview");
  assert.equal(refOnly.aio_present, true);

  const textEmptyRefs = parseGoogleSerp({
    ...noAioSerp(),
    ai_overview: { texts: [{ snippet: "Acme is good." }], references: [] },
  });
  assert.equal(textEmptyRefs.serp_state, SERP_STATE.VALID_SERP, "real text with empty references is a measured Overview");
  assert.equal(textEmptyRefs.aio_present, true);
  assert.equal(textEmptyRefs.blocks.length, 1);
});

test("R04-08 — an asserted Overview that extracts to nothing is refused, never measured as absent", async (t) => {
  pinAioEnv(t);

  // The review thread's four fixtures: each is accepted as an Overview shape
  // but extracts to zero readable blocks and zero validated references. The
  // probe used to rewrite that empty extraction as measured absence.
  const THREAD_FIXTURES = [
    ["empty references", { references: [] }],
    ["unsafe-only reference", { references: [{ href: "javascript:alert(1)" }] }],
    ["nested empty list", { texts: [{ list: [] }] }],
    ["object-valued texts", { texts: { text: "Acme" } }],
  ];

  for (const [label, aio] of THREAD_FIXTURES) {
    const out = parseGoogleSerp({ ...noAioSerp(), ai_overview: aio });
    assert.notEqual(
      out.serp_state,
      SERP_STATE.VALID_SERP,
      `${label}: an Overview with nothing extractable is not a measurement`
    );
    assert.equal(out.aio_present, null, `${label}: presence is UNKNOWN, not absent`);
    assert.equal(out.blocks.length, 0, `${label}: no text may be invented for it`);
  }

  // The full chain the thread exercised: parser presence, stored presence and
  // collection validity must agree — none may read as measured absence.
  const fixtures = THREAD_FIXTURES.map(([, aio]) => ({ ...noAioSerp(), ai_overview: aio }));
  let calls = 0;
  mockFetch(t, async () => {
    const serp = fixtures[Math.min(calls, fixtures.length - 1)];
    calls += 1;
    return envelope(serp);
  });

  const aio = aioEngine();
  const probeRows = [];
  for (const [i, [label]] of THREAD_FIXTURES.entries()) {
    const row = persisted(
      await aio.probe({ text: `buyer question ${i}`, topic: "General", source: "test" }, "Acme", ["Acme"], "acme.example", ["Rival"], null)
    );
    probeRows.push(row);
    assert.ok(row.error, `${label}: the probe must record a refused collection attempt`);
    assert.equal(row.answer_present ?? false, false, `${label}: it must not be an answer`);
    assert.equal(row.aio_present ?? false, false, `${label}: it must not be a measured absence either`);
  }
  assert.equal(calls, 8, "each thread payload was attempted and retried, and nothing else was fetched");

  const plan = buildScorePlan({
    prompts: THREAD_FIXTURES.map((_, i) => ({ text: `buyer question ${i}` })),
    engines: ["aio"],
  });
  const outcome = deriveScanOutcome({
    plan,
    rows: probeRows.map((row, i) => ({
      engine: "aio",
      query: `buyer question ${i}`,
      answered: false,
      raw: row,
    })),
    engineNames: ["aio"],
  });
  assert.notEqual(outcome.outcome, "complete", "four unextractable captures can never be a complete scan");
  assert.equal(outcome.counts.valid, 0, "no valid observation exists to collect");
  assert.equal(outcome.outcome, "failed", "an all-refused collection fails rather than completing");
  assert.equal(
    outcome.metrics.collection_completion_pct,
    0,
    "and collection completion is a measured zero, not 100%"
  );
});

test("R04-08 — generated AIO shapes never let parser presence contradict the extraction", () => {
  const textPayloads = [
    null,
    [],
    [{}],
    [{ list: [] }],
    [{ list: [{ snippet: "Nested answer." }] }],
    [{ text_blocks: [{ snippet: "Deep answer." }] }],
    [{ paragraphs: [{ text: "Deep answer." }] }],
    [{ snippet: "Flat answer." }],
    "A bare string answer.",
  ];
  const refPayloads = [
    undefined,
    [],
    [{ href: "https://acme.example/proof" }],
    [{ href: "javascript:alert(1)" }],
  ];

  for (const texts of textPayloads) {
    for (const references of refPayloads) {
      const aio = {};
      if (texts !== undefined) aio.texts = texts;
      if (references !== undefined) aio.references = references;
      const out = parseGoogleSerp({ ...noAioSerp(), ai_overview: aio });
      const extracted = out.blocks.length > 0 || out.references.length > 0;
      assert.ok(
        !(out.serp_state === SERP_STATE.VALID_SERP && out.aio_present === true && !extracted),
        `parser presence must never contradict the extraction for ${JSON.stringify(aio)}`
      );
    }
  }

  // The nested and bare-string shapes that DO carry an answer stay measured.
  const nested = parseGoogleSerp({
    ...noAioSerp(),
    ai_overview: { texts: [{ list: [{ snippet: "Nested answer." }] }] },
  });
  assert.equal(nested.serp_state, SERP_STATE.VALID_SERP, "a nested list answer is a measured Overview");
  assert.equal(nested.aio_present, true);
  assert.equal(nested.blocks.length, 1, "the parent block with no own text yields only its nested item");
  assert.equal(nested.blocks[0].text, "Nested answer.");

  const bareString = parseGoogleSerp({ ...noAioSerp(), ai_overview: "A bare string answer." });
  assert.equal(bareString.serp_state, SERP_STATE.VALID_SERP, "a non-empty string Overview is a measured Overview");
  assert.equal(bareString.aio_present, true);
});

test("R04-08 — the adapter refuses an unreadable Overview on its final attempt", async (t) => {
  pinAioEnv(t);
  mockFetch(t, async () => envelope({ ...noAioSerp(), ai_overview: {} }));

  await assert.rejects(
    () => brightDataSearch("best vitrified tiles", { attempts: 1, timeout: 500 }),
    (err) => {
      assert.ok(isBrightDataParseError(err), `expected a typed parse error, got ${err?.message}`);
      assert.equal(err.aio_present, null, "the failure carries the indeterminate AIO state, not false");
      return true;
    }
  );
});

test("R04-20 — an unreadable Overview cannot be counted as collected", async (t) => {
  pinAioEnv(t);
  const good = parseGoogleSerp(noAioSerp());
  const bad = parseGoogleSerp({ ...noAioSerp(), ai_overview: {} });
  assert.notEqual(bad.serp_state, SERP_STATE.VALID_SERP, "the malformed capture is not a measurement");

  const summary = summarizeSerpCollection([
    ...Array.from({ length: 29 }, () => good),
    bad,
  ]);
  assert.equal(summary.planned, 30);
  assert.equal(summary.valid_serp, 29);
  assert.equal(summary.collection_pct, (29 / 30) * 100, "29 of 30 is not 100%");
  assert.equal(summary.collection_complete, false, "a scan with an unreadable capture is not complete");
  assert.equal(summary.failed, 1);
  assert.equal(summary.valid_no_aio, 29, "the genuine absences are still valid collection");
  assert.equal(summary.trigger_rate_pct, 0, "and the trigger rate is a measured zero over the valid SERPs");

  // The arithmetic guard on its own: a row that claims a valid SERP while its AIO
  // state is indeterminate is never collected, whatever produced it.
  const guard = summarizeSerpCollection([{ serp_state: SERP_STATE.VALID_SERP, aio_present: null }]);
  assert.equal(guard.valid_serp, 0, "an indeterminate AIO state is not a measurement");
  assert.equal(guard.unmeasurable, 1, "and it is reported as unmeasurable rather than dropped");
  assert.equal(guard.collection_pct, 0);
});

/* ------------------------------------------------------------------ *
 * 2. A valid no-AIO row keeps its validation metadata
 * ------------------------------------------------------------------ */

test("R04-20 — a valid no-AIO row keeps its validation metadata through persistence", async (t) => {
  pinAioEnv(t);
  mockFetch(t, async () => envelope(noAioSerp()));

  const row = persisted(await probeAioRow(aioEngine()));

  // The row that carries no text and no citations is the one that has to say why:
  // a real SERP was read and it held no Overview.
  assert.equal(row.serp_state, SERP_STATE.VALID_SERP, "the row states that a real SERP was recognised");
  assert.equal(row.parser_version, GOOGLE_PAYLOAD_PARSER_VERSION, "and which parser decided it");
  assert.match(row.evidence_id, /^bd_[0-9a-f]{24}$/, "and which capture it came from");
  assert.equal(row.per_field_quality.text, "absent", "the text field is absent, not unknown");
  assert.equal(row.per_field_quality.citations, "absent");
  assert.equal(row.answer_present, false, "still not an answer");
  assert.notEqual(row.text, undefined, "the text field exists and is empty rather than missing");
});

/* ------------------------------------------------------------------ *
 * 3. A block's heading is not dropped when a snippet is present
 * ------------------------------------------------------------------ */

test("R04-04 — a block's heading survives when the block also carries a snippet", () => {
  const out = parseGoogleSerp({
    ai_overview: {
      texts: [
        {
          heading: "Acme Tiles is the top pick for vitrified tiles",
          snippet: "Rival Tiles is also frequently recommended.",
        },
      ],
    },
  });

  assert.equal(out.aio_present, true);
  const block = out.blocks[0];
  assert.match(block.text, /Acme Tiles is the top pick/, "the heading is part of the block's text");
  assert.match(block.text, /Rival Tiles is also frequently recommended/, "and so is the snippet");
  assert.ok(
    block.text.indexOf("Acme Tiles") < block.text.indexOf("Rival Tiles"),
    "the heading reads before the snippet, which is the order a reader sees"
  );

  // The measured text is what mention detection reads, so both names must reach it.
  assert.match(out.text, /Acme Tiles is the top pick/);
  assert.match(out.text, /Rival Tiles is also frequently recommended/);

  // A vendor echoing the same string in two fields must not lengthen the text.
  const echoed = parseGoogleSerp({ ai_overview: { texts: [{ heading: "Acme Tiles leads", text: "Acme Tiles leads" }] } });
  assert.equal(echoed.blocks[0].text, "Acme Tiles leads");

  // Single-field blocks are unchanged: this is a fix for dropping content, not a
  // change to how a block with one text field is read.
  const headingOnly = parseGoogleSerp({ ai_overview: { texts: [{ header: "Acme Tiles" }] } });
  assert.equal(headingOnly.blocks[0].text, "Acme Tiles");
  const snippetOnly = parseGoogleSerp({ ai_overview: { texts: [{ snippet: "Acme Tiles leads" }] } });
  assert.equal(snippetOnly.blocks[0].text, "Acme Tiles leads");
});

test("R04-04 — a brand named only in an Overview heading still reaches the persisted row", async (t) => {
  pinAioEnv(t);
  mockFetch(t, async () =>
    envelope({
      ai_overview: {
        texts: [{ heading: "Acme Tiles is the best choice for a bathroom refit", snippet: "Rival Tiles is cheaper." }],
      },
    })
  );

  const row = persisted(await probeAioRow(aioEngine()));

  assert.match(row.text, /Acme Tiles is the best choice/, "a heading-only mention is a mention");
  assert.equal(row.brand_mentioned_in_text, true, "and the row records the brand as present in the answer");
  assert.equal(row.visible, true, "which is what makes the prompt count as visible");
});

test("an empty rendered-AIO cookie pool falls back once to the standard SERP, keeps an inline Overview and labels the capture mode", async (t) => {
  pinAioEnv(t);
  const { resetRenderedAioMemo } = await import("../../shared/engines/brightdata.js");
  resetRenderedAioMemo(); t.after(resetRenderedAioMemo);
  const urls = [];
  const inline = {
    general: { query: "best oversized t-shirt brands in india" },
    organic: [{ position: 1, title: "Tees", link: "https://tees.example/", domain: "tees.example" }],
    ai_overview: { texts: [{ snippet: "Acme is a popular oversized tee label.", reference_indexes: [0] }], references: [{ href: "https://acme.example/", title: "Acme", source: "acme.example" }] },
  };
  mockFetch(t, async (_url, init) => {
    const target = JSON.parse(init.body).url; urls.push(target);
    return /brd_ai_overview=2/.test(target)
      ? new Response(JSON.stringify({ headers: { "x-brd-error": "no_ready_cookies" }, body: "" }), { status: 200 })
      : envelope(inline);
  });
  const serp = await brightDataSearch("best oversized t-shirt brands in India", { durableDispatch: true, deadlineAt: Date.now() + 70_000 });
  assert.equal(urls.length, 2, "one rendered request, then exactly one standard request");
  assert.equal(serp.serp_validation.serp_state, "valid_serp");
  assert.equal(serp.serp_validation.aio_present, true, "an Overview Google served inline is still captured");
  assert.equal(serp.serp_validation.aio_capture_mode, "standard_serp_fallback");
  const row = persisted(await probeAioRow(aioEngine()));
  assert.equal(row.aio_capture_mode, "standard_serp_fallback", "the stored row carries the capture mode");
  await brightDataSearch("best oversized t-shirt brands in India", { durableDispatch: true, deadlineAt: Date.now() + 70_000 });
  assert.equal(urls.length, 4, "the remembered empty pool skips straight to the standard SERP");
  assert.ok(urls.slice(2).every((u) => !/brd_ai_overview/.test(u)));
});

test("rendered-AIO successes are labelled rendered and never fall back", async (t) => {
  pinAioEnv(t);
  const { resetRenderedAioMemo } = await import("../../shared/engines/brightdata.js");
  resetRenderedAioMemo(); t.after(resetRenderedAioMemo);
  let calls = 0;
  mockFetch(t, async () => { calls++; return envelope(noAioSerp()); });
  const serp = await brightDataSearch("best vitrified tiles", { durableDispatch: true, deadlineAt: Date.now() + 70_000 });
  assert.equal(calls, 1);
  assert.equal(serp.serp_validation.aio_capture_mode, "rendered_ai_overview");
});

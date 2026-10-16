import test from "node:test";
import assert from "node:assert/strict";
import {
  GOOGLE_PAYLOAD_PARSER_VERSION,
  SERP_STATE,
  parseGoogleSerp,
  summarizeSerpCollection,
} from "../engines/googlePayload.js";
import { brightDataSearch, isBrightDataParseError } from "../engines/brightdata.js";
import { resolveEnabledEngines } from "../scoring/enginePipeline.js";

/**
 * R04 — the three defects that survived the first review round, each one a way
 * for an unmeasured or unreadable Overview to pass as a measurement.
 *
 *   1. A malformed `ai_overview` (an empty object, an array, `true`, a number, an
 *      empty string) parsed as a valid SERP with no AIO, so a broken capture was
 *      counted as 100% collection and read as "Google showed no Overview".
 *   2. The validation metadata was only attached to rows that carried text or
 *      citations. A valid no-AIO row has neither, so the one row that has to
 *      prove it was measured carried no SERP state, no parser version and no
 *      evidence id — "there was no Overview" was indistinguishable from "we never
 *      read one", which is A01 at the data layer.
 *   3. A block carrying both a heading and a snippet yielded only one of them, so
 *      a brand named in the heading disappeared from the measurement.
 *
 * Everything here is synthetic (`.example` hosts, Acme/Rival) and offline: the
 * transport cases swap in a fetch stub and pin the zone, exactly as the rest of
 * this repair's cases do.
 */

const ENV = ["BRIGHTDATA_API_KEY", "BRIGHTDATA_SERP_ZONE", "BRIGHTDATA_ZONE_TTL_MS", "ENGINES", "SERP_GEO"];

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

function pinAioEnv(t) {
  useEnv(t, {
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
 * 1. An unreadable Overview is unknown, never absence
 * ------------------------------------------------------------------ */

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

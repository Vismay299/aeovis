import test from "node:test";
import assert from "node:assert/strict";
import { groupPromptRows, pickScanIds } from "./promptMetrics.js";

/**
 * P2a coverage: groupPromptRows (per-prompt grouping/aggregation + null
 * handling + cross-scan delta) and pickScanIds (latest/previous scan
 * selection). Both are pure — no DB, no Next.js — per the module's own
 * docstring, so these run straight under `node --test` with no fixtures
 * beyond plain objects.
 */

// =============================================================================
// groupPromptRows
// =============================================================================

test("groupPromptRows — rows from 2 engines for one query collapse into one row", () => {
  const rows = [
    { scan_id: "s2", query: "best running shoes", engine: "aio", answered: true, mentioned: true, sentiment: 80, position: 2, intent: "informational", is_branded_query: false },
    { scan_id: "s2", query: "best running shoes", engine: "chatgpt", answered: true, mentioned: false, sentiment: null, position: null, intent: "informational", is_branded_query: false },
  ];

  const out = groupPromptRows(rows, { scanId: "s2" });

  assert.equal(out.length, 1, "two engine rows for the same query must collapse into one row");
  const row = out[0];
  assert.equal(row.query, "best running shoes");
  assert.deepEqual(row.engines.sort(), ["aio", "chatgpt"], "engines lists every engine that answered");
  assert.equal(row.answered_count, 2);
  assert.equal(row.mentioned_count, 1);
  assert.equal(row.visibility_pct, 50, "1 mentioned / 2 answered * 100");
});

test("groupPromptRows — null sentiment/position stay null when every engine row is null (never 0)", () => {
  const rows = [
    { scan_id: "s1", query: "q1", engine: "aio", answered: true, mentioned: false, sentiment: null, position: null },
    { scan_id: "s1", query: "q1", engine: "chatgpt", answered: true, mentioned: false, sentiment: null, position: null },
  ];

  const out = groupPromptRows(rows, { scanId: "s1" });

  assert.equal(out.length, 1);
  assert.strictEqual(out[0].sentiment_avg, null, "must be null, not 0");
  assert.strictEqual(out[0].position_avg, null, "must be null, not 0");
  // Sanity: null must never be confused with a real falsy zero.
  assert.notStrictEqual(out[0].sentiment_avg, 0);
  assert.notStrictEqual(out[0].position_avg, 0);
});

test("groupPromptRows — sentiment_avg/position_avg average only the non-null values across engines", () => {
  const rows = [
    { scan_id: "s1", query: "q1", engine: "aio", answered: true, mentioned: true, sentiment: 80, position: 2 },
    { scan_id: "s1", query: "q1", engine: "chatgpt", answered: true, mentioned: false, sentiment: null, position: null },
    { scan_id: "s1", query: "q1", engine: "perplexity", answered: true, mentioned: true, sentiment: 60, position: 4 },
  ];

  const out = groupPromptRows(rows, { scanId: "s1" });

  assert.equal(out[0].sentiment_avg, 70, "mean of [80, 60], the null value excluded");
  assert.equal(out[0].position_avg, 3, "mean of [2, 4], the null value excluded");
});

test("groupPromptRows — visibility_pct is 0 (not null) when no engine answered, and answered_count reports the truth", () => {
  const rows = [
    { scan_id: "s1", query: "q1", engine: "aio", answered: false, mentioned: false, sentiment: null, position: null },
    { scan_id: "s1", query: "q1", engine: "chatgpt", answered: false, mentioned: false, sentiment: null, position: null },
  ];

  const out = groupPromptRows(rows, { scanId: "s1" });

  assert.equal(out[0].visibility_pct, 0);
  assert.equal(out[0].answered_count, 0);
  assert.equal(out[0].mentioned_count, 0);
  assert.deepEqual(out[0].engines, [], "no engine answered -> engines list is empty");
});

test("groupPromptRows — delta_visibility_pct is computed across the two most recent scans for the same query", () => {
  const rows = [
    // Current scan (s2): 1/2 answered mentioned -> 50%
    { scan_id: "s2", query: "best running shoes", engine: "aio", answered: true, mentioned: true },
    { scan_id: "s2", query: "best running shoes", engine: "chatgpt", answered: true, mentioned: false },
    // Previous scan (s1): 2/2 mentioned -> 100%
    { scan_id: "s1", query: "best running shoes", engine: "aio", answered: true, mentioned: true },
    { scan_id: "s1", query: "best running shoes", engine: "chatgpt", answered: true, mentioned: true },
  ];

  const out = groupPromptRows(rows, { scanId: "s2", prevScanId: "s1" });

  assert.equal(out.length, 1);
  assert.equal(out[0].visibility_pct, 50);
  assert.equal(out[0].delta_visibility_pct, -50, "50 (current) - 100 (previous)");
});

test("groupPromptRows — delta_visibility_pct is null when there is no previous scan at all", () => {
  const rows = [{ scan_id: "s2", query: "q1", engine: "aio", answered: true, mentioned: true }];
  const out = groupPromptRows(rows, { scanId: "s2" }); // no prevScanId
  assert.strictEqual(out[0].delta_visibility_pct, null);
});

test("groupPromptRows — delta_visibility_pct is null when the query is new (absent from the previous scan)", () => {
  const rows = [
    { scan_id: "s2", query: "brand new prompt", engine: "aio", answered: true, mentioned: true },
    { scan_id: "s1", query: "an unrelated prompt", engine: "aio", answered: true, mentioned: true },
  ];
  const out = groupPromptRows(rows, { scanId: "s2", prevScanId: "s1" });
  assert.equal(out.length, 1);
  assert.strictEqual(out[0].delta_visibility_pct, null, "no prior-scan row for this exact query -> null, never a fabricated 0");
});

test("groupPromptRows — a query present only in the previous scan (removed/edited prompt) never appears in the output", () => {
  const rows = [
    { scan_id: "s2", query: "still tracked", engine: "aio", answered: true, mentioned: true },
    { scan_id: "s1", query: "no longer tracked", engine: "aio", answered: true, mentioned: true },
  ];
  const out = groupPromptRows(rows, { scanId: "s2", prevScanId: "s1" });
  assert.deepEqual(out.map((r) => r.query), ["still tracked"], "output is driven by the CURRENT scan's queries only");
});

test("groupPromptRows — branded rows are flagged is_branded_query, non-branded are not", () => {
  const rows = [
    { scan_id: "s1", query: "acme brand reviews", engine: "aio", answered: true, mentioned: true, is_branded_query: true },
    { scan_id: "s1", query: "best coffee makers", engine: "aio", answered: true, mentioned: true, is_branded_query: false },
  ];
  const out = groupPromptRows(rows, { scanId: "s1" });
  const branded = out.find((r) => r.query === "acme brand reviews");
  const nonBranded = out.find((r) => r.query === "best coffee makers");
  assert.equal(branded.is_branded_query, true);
  assert.equal(nonBranded.is_branded_query, false);
});

test("groupPromptRows — branded flag is true if ANY engine row for the query flags it (defensive OR)", () => {
  const rows = [
    { scan_id: "s1", query: "q1", engine: "aio", answered: true, mentioned: true, is_branded_query: true },
    { scan_id: "s1", query: "q1", engine: "chatgpt", answered: true, mentioned: true, is_branded_query: false },
  ];
  const out = groupPromptRows(rows, { scanId: "s1" });
  assert.equal(out[0].is_branded_query, true);
});

test("groupPromptRows — query text is matched case/whitespace-insensitively for grouping and delta join", () => {
  const rows = [
    { scan_id: "s2", query: "  Best Running Shoes ", engine: "aio", answered: true, mentioned: true },
    { scan_id: "s2", query: "best running shoes", engine: "chatgpt", answered: true, mentioned: true },
    { scan_id: "s1", query: "BEST RUNNING SHOES", engine: "aio", answered: true, mentioned: false },
  ];
  const out = groupPromptRows(rows, { scanId: "s2", prevScanId: "s1" });
  assert.equal(out.length, 1, "differently-cased/whitespaced query text must still collapse into one row");
  assert.equal(out[0].answered_count, 2);
  assert.equal(out[0].delta_visibility_pct, 100, "100% current - 0% previous, matched despite casing/whitespace drift");
});

test("groupPromptRows — engine_breakdown lists every probed engine (including ones that never answered)", () => {
  const rows = [
    { scan_id: "s1", query: "q1", engine: "aio", answered: true, mentioned: true },
    { scan_id: "s1", query: "q1", engine: "perplexity", answered: false, mentioned: false },
  ];
  const out = groupPromptRows(rows, { scanId: "s1" });
  const breakdown = out[0].engine_breakdown;
  assert.equal(breakdown.length, 2);
  assert.deepEqual(
    breakdown.find((b) => b.engine === "aio"),
    { engine: "aio", answered: true, mentioned: true }
  );
  assert.deepEqual(
    breakdown.find((b) => b.engine === "perplexity"),
    { engine: "perplexity", answered: false, mentioned: false }
  );
});

test("groupPromptRows — intent is read from whichever row carries it", () => {
  const rows = [
    { scan_id: "s1", query: "q1", engine: "aio", answered: true, mentioned: true, intent: null },
    { scan_id: "s1", query: "q1", engine: "chatgpt", answered: true, mentioned: true, intent: "comparison" },
  ];
  const out = groupPromptRows(rows, { scanId: "s1" });
  assert.equal(out[0].intent, "comparison");
});

test("groupPromptRows — empty input is empty output, no crash", () => {
  assert.deepEqual(groupPromptRows([], { scanId: "s1" }), []);
  assert.deepEqual(groupPromptRows(null, { scanId: "s1" }), []);
  assert.deepEqual(groupPromptRows(undefined), []);
});

test("groupPromptRows — omitting scanId treats every row as the target scan (pass-through mode)", () => {
  const rows = [
    { query: "q1", engine: "aio", answered: true, mentioned: true },
    { query: "q1", engine: "chatgpt", answered: true, mentioned: false },
  ];
  const out = groupPromptRows(rows);
  assert.equal(out.length, 1);
  assert.equal(out[0].answered_count, 2);
});

// =============================================================================
// pickScanIds
// =============================================================================

test("pickScanIds — no scans at all -> both null", () => {
  assert.deepEqual(pickScanIds([]), { scanId: null, prevScanId: null });
  assert.deepEqual(pickScanIds(null), { scanId: null, prevScanId: null });
});

test("pickScanIds — no scanId requested -> target is the most recent, prev is the next most recent", () => {
  const result = pickScanIds(["s3", "s2", "s1"]);
  assert.deepEqual(result, { scanId: "s3", prevScanId: "s2" });
});

test("pickScanIds — a single scan -> target is it, prev is null", () => {
  const result = pickScanIds(["s1"]);
  assert.deepEqual(result, { scanId: "s1", prevScanId: null });
});

test("pickScanIds — a requested scanId found mid-list resolves prev relative to IT, not the true latest", () => {
  const result = pickScanIds(["s3", "s2", "s1"], { scanId: "s2" });
  assert.deepEqual(result, { scanId: "s2", prevScanId: "s1" });
});

test("pickScanIds — a requested scanId not found in this brand's own list -> echoed back, prevScanId null", () => {
  const result = pickScanIds(["s3", "s2", "s1"], { scanId: "someone-elses-scan" });
  assert.deepEqual(result, { scanId: "someone-elses-scan", prevScanId: null });
});

test("pickScanIds — range=2 compares against two scans back instead of one", () => {
  const result = pickScanIds(["s4", "s3", "s2", "s1"], { range: 2 });
  assert.deepEqual(result, { scanId: "s4", prevScanId: "s2" });
});

test("pickScanIds — range running off the start of the list -> prevScanId null", () => {
  const result = pickScanIds(["s2", "s1"], { range: 5 });
  assert.deepEqual(result, { scanId: "s2", prevScanId: null });
});

test("pickScanIds — non-integer/zero/negative range falls back to 1", () => {
  assert.deepEqual(pickScanIds(["s3", "s2", "s1"], { range: 0 }), { scanId: "s3", prevScanId: "s2" });
  assert.deepEqual(pickScanIds(["s3", "s2", "s1"], { range: -1 }), { scanId: "s3", prevScanId: "s2" });
  assert.deepEqual(pickScanIds(["s3", "s2", "s1"], { range: 1.5 }), { scanId: "s3", prevScanId: "s2" });
});

// ---------------------------------------------------------------------------
// R2.6.2 — isDudPrompt -> suggested_retire, surfaced in the Queries tab
//
// Duds flag as suggested_retire and appear in the Queries tab. The flag is
// computed from prompt_results rows using `mentioned` as a proxy for
// brands_elicited, applying the same isDudPrompt logic from promptQuality.js.
// Additive-only contract: retire, never mutate.
// ---------------------------------------------------------------------------

test("R2.6.2 — a prompt answered 3+ times with no brand mention is flagged suggested_retire", () => {
  // 2 scans × 3 engines = 6 observations, all answered, none mentioning the brand.
  const rows = [
    { scan_id: "s2", query: "how to calculate tiles needed", engine: "aio", answered: true, mentioned: false },
    { scan_id: "s2", query: "how to calculate tiles needed", engine: "chatgpt", answered: true, mentioned: false },
    { scan_id: "s2", query: "how to calculate tiles needed", engine: "perplexity", answered: true, mentioned: false },
    { scan_id: "s1", query: "how to calculate tiles needed", engine: "aio", answered: true, mentioned: false },
    { scan_id: "s1", query: "how to calculate tiles needed", engine: "chatgpt", answered: true, mentioned: false },
    { scan_id: "s1", query: "how to calculate tiles needed", engine: "perplexity", answered: true, mentioned: false },
  ];
  const out = groupPromptRows(rows, { scanId: "s2", prevScanId: "s1" });
  assert.equal(out.length, 1);
  assert.equal(out[0].suggested_retire, true, "6 answered observations, zero brand mentions → dud");
});

test("R2.6.2 — a prompt that elicited even once is NOT flagged", () => {
  // 6 observations, but one mentions the brand → not a dud.
  const rows = [
    { scan_id: "s2", query: "best tile brands", engine: "aio", answered: true, mentioned: true },
    { scan_id: "s2", query: "best tile brands", engine: "chatgpt", answered: true, mentioned: false },
    { scan_id: "s2", query: "best tile brands", engine: "perplexity", answered: true, mentioned: false },
    { scan_id: "s1", query: "best tile brands", engine: "aio", answered: true, mentioned: false },
    { scan_id: "s1", query: "best tile brands", engine: "chatgpt", answered: true, mentioned: false },
    { scan_id: "s1", query: "best tile brands", engine: "perplexity", answered: true, mentioned: false },
  ];
  const out = groupPromptRows(rows, { scanId: "s2", prevScanId: "s1" });
  assert.equal(out[0].suggested_retire, false, "one mention is enough to spare the prompt");
});

test("R2.6.2 — fewer than DUD_MIN_OBSERVATIONS answered observations are not enough to flag", () => {
  // Only 2 answered observations (DUD_MIN_OBSERVATIONS is 3).
  const rows = [
    { scan_id: "s2", query: "new prompt", engine: "aio", answered: true, mentioned: false },
    { scan_id: "s2", query: "new prompt", engine: "chatgpt", answered: true, mentioned: false },
  ];
  const out = groupPromptRows(rows, { scanId: "s2" });
  assert.equal(out[0].suggested_retire, false, "only 2 observations → not enough to retire");
});

test("R2.6.2 — unanswered observations are ignored for dud detection", () => {
  // 3 unanswered + 1 answered (not mentioned) = only 1 answered observation → not enough.
  const rows = [
    { scan_id: "s2", query: "q1", engine: "aio", answered: false, mentioned: false },
    { scan_id: "s2", query: "q1", engine: "chatgpt", answered: false, mentioned: false },
    { scan_id: "s2", query: "q1", engine: "perplexity", answered: false, mentioned: false },
    { scan_id: "s1", query: "q1", engine: "aio", answered: true, mentioned: false },
  ];
  const out = groupPromptRows(rows, { scanId: "s2", prevScanId: "s1" });
  assert.equal(out[0].suggested_retire, false, "unanswered observations don't count toward the threshold");
});

test("R2.6.2 — mixed prompts: one flagged, one clean", () => {
  const rows = [
    // Dud: all answered, none mentioned
    { scan_id: "s2", query: "dud prompt", engine: "aio", answered: true, mentioned: false },
    { scan_id: "s2", query: "dud prompt", engine: "chatgpt", answered: true, mentioned: false },
    { scan_id: "s2", query: "dud prompt", engine: "perplexity", answered: true, mentioned: false },
    { scan_id: "s1", query: "dud prompt", engine: "aio", answered: true, mentioned: false },
    { scan_id: "s1", query: "dud prompt", engine: "chatgpt", answered: true, mentioned: false },
    { scan_id: "s1", query: "dud prompt", engine: "perplexity", answered: true, mentioned: false },
    // Good: has mentions
    { scan_id: "s2", query: "good prompt", engine: "aio", answered: true, mentioned: true },
    { scan_id: "s2", query: "good prompt", engine: "chatgpt", answered: true, mentioned: false },
    { scan_id: "s2", query: "good prompt", engine: "perplexity", answered: true, mentioned: true },
    { scan_id: "s1", query: "good prompt", engine: "aio", answered: true, mentioned: true },
    { scan_id: "s1", query: "good prompt", engine: "chatgpt", answered: true, mentioned: false },
    { scan_id: "s1", query: "good prompt", engine: "perplexity", answered: true, mentioned: true },
  ];
  const out = groupPromptRows(rows, { scanId: "s2", prevScanId: "s1" });
  const dud = out.find((r) => r.query === "dud prompt");
  const good = out.find((r) => r.query === "good prompt");
  assert.equal(dud.suggested_retire, true, "dud prompt flagged");
  assert.equal(good.suggested_retire, false, "good prompt not flagged");
});

test("R2.6.2 — suggested_retire is always present on every output row (boolean, never undefined)", () => {
  const rows = [
    { scan_id: "s1", query: "q1", engine: "aio", answered: true, mentioned: true },
  ];
  const out = groupPromptRows(rows, { scanId: "s1" });
  assert.equal(typeof out[0].suggested_retire, "boolean", "suggested_retire is a boolean");
});

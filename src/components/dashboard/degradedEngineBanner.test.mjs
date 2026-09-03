import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  describeScanDataSourceIssue,
  summarizeEngineSlice,
  computeHeadline,
} from "../../lib/scoring/enginePipeline.js";

/**
 * R2.2.6 (finding B3) — the dashboard half of "say which engine degraded".
 *
 * WHAT THIS FILE CAN AND CANNOT PROVE, SAID PLAINLY.
 *
 * This repo has no component-render harness: no jsdom, no testing-library, and
 * `npm run test:scoring` is a bare `node --test` over .test.mjs files. So the
 * banner's TEXT is exercised by RUNNING describeScanDataSourceIssue — that is
 * where every word of it is decided, and enginePipeline.test.mjs drives it from
 * real summarizeEngineSlice output. What this file adds is the other half: a
 * source guard proving DashboardShell.jsx defers to that function instead of
 * typing its own copy, because a decision function nothing renders is a
 * decision nobody sees. Same split R2.7.4 and R2.10.5 used.
 *
 * The guard is a text scan of the component. It cannot prove React mounted it.
 * It CAN prove the three ways this fix could rot: the import going away, the
 * banner's strings being re-typed as literals, and the suppress-the-score
 * condition drifting back to "any engine degraded".
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHELL_PATH = path.join(HERE, "DashboardShell.jsx");
const SHELL = readFileSync(SHELL_PATH, "utf8");

test("R2.2.6 GUARD — DashboardShell derives its degradation state from the pipeline", () => {
  assert.match(
    SHELL,
    /import \{ describeScanDataSourceIssue \} from "@\/lib\/scoring\/enginePipeline"/,
    "the component must import the one derivation, not reimplement it"
  );
  assert.match(
    SHELL,
    /const scanHealth = describeScanDataSourceIssue\(result\.perEngineSummaries, \{/,
    "it must be fed the per-engine slices — that is where the engine names live"
  );
  assert.match(
    SHELL,
    /fallbackIssue: result\.dataSourceIssue/,
    "records stored before per-engine slices existed must still raise their banner"
  );
});

test("R2.2.6 GUARD — the banner renders the pipeline's words, not its own", () => {
  assert.match(
    SHELL,
    /data-testid="engine-degraded-banner"/,
    "a text-only degradation needs a banner of its own to appear in"
  );
  assert.match(
    SHELL,
    /scanHealth\.severity === "partial" && \(/,
    "...rendered exactly when one engine dropped out and the index survived"
  );

  // Both banners — the partial one and the critical one — take their headline
  // and their reason from the descriptor.
  assert.equal(
    (SHELL.match(/\{scanHealth\.title\}/g) || []).length,
    2,
    "both the partial and the critical banner must state which engine degraded"
  );
  assert.equal(
    (SHELL.match(/\{scanHealth\.detail\}/g) || []).length,
    2,
    "...and both must carry the reason under it"
  );

  // TEETH: the old fixed headline said nothing about which engine or why. If it
  // comes back as a literal, the banner has gone silent again in the only way
  // that still looks like it is talking.
  assert.ok(
    !SHELL.includes("Data source issue — scan incomplete"),
    "the generic headline must come from describeScanDataSourceIssue, not be typed here"
  );
  assert.ok(
    !SHELL.includes("The engines returned no answer for the majority of tracked queries"),
    "the generic body must come from the descriptor too"
  );
});

test("R2.2.6 GUARD — only 'nothing left to score' suppresses the score", () => {
  assert.match(
    SHELL,
    /const dataSourceIssue = scanHealth\.severity === "critical";/,
    "a partial degradation must annotate the index, not blank a score we do have"
  );
  assert.ok(
    !/const dataSourceIssue = result\.dataSourceIssue;/.test(SHELL),
    "the one-bit record flag cannot decide this on its own any more"
  );
});

test("R2.2.6 GUARD — the per-engine chip marks a degraded engine", () => {
  assert.match(
    SHELL,
    /const degradedEngineKeys = new Set\(scanHealth\.degradedEngines\.map\(\(e\) => e\.engine\)\)/,
    "the chip row needs to know which engines the descriptor condemned"
  );
  assert.match(
    SHELL,
    /degradedEngineKeys\.has\(key\)\s*\?\s*`\$\{engineLabel\(key\)\} \(degraded\)`/,
    "an untrustworthy share_of_ai must not render identically to a counted one"
  );
});

test("R2.2.6 — the strings the guard proves are rendered are non-empty for the real case", () => {
  // The RUN half, kept beside the guard so this file is not only assertions
  // about text. Healthy aio + a perplexity slice answering 6 of 10.
  const answered = (i, visible) => ({
    query: `unbranded prompt ${i}`,
    is_branded_query: false,
    answer_present: true,
    error: null,
    text: "Vendors worth considering include Kajaria and Somany.",
    visible,
    brand_mentioned_in_text: visible,
    brand_cited: false,
    brands: [
      { name: "Italica", is_self: true, mentioned: visible },
      { name: "Kajaria", is_self: false, mentioned: true },
    ],
  });
  const empty = (i) => ({
    query: `unbranded prompt ${i}`,
    is_branded_query: false,
    answer_present: false,
    error: "EMPTY_ANSWER",
    text: "",
    visible: false,
    brands: [],
  });

  const engines = {
    aio: summarizeEngineSlice(
      [
        ...Array.from({ length: 2 }, (_, i) => answered(i, true)),
        ...Array.from({ length: 8 }, (_, i) => answered(100 + i, false)),
      ],
      "aio"
    ),
    perplexity: summarizeEngineSlice(
      [
        ...Array.from({ length: 6 }, (_, i) => answered(200 + i, true)),
        ...Array.from({ length: 4 }, (_, i) => empty(300 + i)),
      ],
      "perplexity"
    ),
  };
  const headline = computeHeadline(Object.values(engines));
  const scanHealth = describeScanDataSourceIssue(engines, {
    enginesCounted: headline.engines_counted,
    fallbackIssue: false,
  });

  assert.equal(scanHealth.severity, "partial", "the partial banner is the one that renders");
  assert.match(scanHealth.title, /Perplexity/);
  assert.match(scanHealth.title, /1 of 2 engines/);
  assert.ok(scanHealth.detail.length > 0);
  // The chip marker's input.
  assert.deepEqual(
    scanHealth.degradedEngines.map((e) => e.engine),
    ["perplexity"],
    "aio keeps a bare chip; perplexity gets the marker"
  );
  // Every row the banner prints must be a real number or an explicit null —
  // never a 0 standing in for a measurement (standing rule 5).
  for (const engine of scanHealth.degradedEngines) {
    assert.ok(
      engine.coverage_pct === null || Number.isFinite(engine.coverage_pct),
      "coverage is a number or an em dash, never an invented zero"
    );
    assert.ok(Number.isFinite(engine.min_coverage_pct));
  }
});

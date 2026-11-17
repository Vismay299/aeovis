import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describeRosterState, ROSTER_SOURCE } from "./rosterContinuity.js";

/**
 * R0.3.2 guard walker — the three surfaces that could render a false 100%.
 *
 * These are .jsx modules, so `node --test` cannot import and render them (no
 * JSX transform in this runner, and none of the suites beside them do it
 * either — src/components/perceev/charts/chartMath.test.mjs tests the extracted
 * math for exactly this reason). So the rendering DECISION lives in
 * describeRosterState, which is unit-tested in rosterContinuity.test.mjs, and
 * this walker proves each surface actually consults it rather than re-deriving
 * the rule — which is how three surfaces drift apart and start disagreeing.
 *
 * It lives under src/shared/scoring rather than beside the components because the
 * package.json `test:scoring` glob does not reach src/components (finding S29,
 * fixed in R0.4.3). It is a guard on the scoring contract's consumers, and it
 * keeps running wherever the glob ends up.
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (rel) => readFile(path.join(REPO, rel), "utf8");

const SURFACES = [
  { file: "src/components/perceev/charts/Donut.jsx", what: "the SOV donut" },
  { file: "src/components/dashboard/RivalsView.jsx", what: "the Rivals view" },
  { file: "src/components/dashboard/VisibilityVerdictPanel.jsx", what: "the verdict panel" },
];

for (const { file, what } of SURFACES) {
  test(`OFFLINE STATE — ${what} consults describeRosterState`, async () => {
    const src = await read(file);
    assert.match(
      src,
      /describeRosterState/,
      `${file} must import describeRosterState from lib/scoring/rosterContinuity, not re-derive the rule`
    );
    assert.match(
      src,
      /rosterState\.assessable/,
      `${file} must branch on rosterState.assessable before rendering a share number or a "no rivals" claim`
    );
  });
}

test("OFFLINE STATE — the donut cannot compute a share percentage while unassessable", async () => {
  const src = await read("src/components/perceev/charts/Donut.jsx");
  // selfPct is the exact expression that produced the false 100%: with one
  // segment, value/total is 1. It must be gated on assessability.
  assert.match(
    src,
    /const selfPct =\s*\n?\s*rosterState\.assessable &&/,
    "Donut.jsx selfPct must be gated on rosterState.assessable"
  );
});

test("OFFLINE STATE — the verdict panel checks the roster BEFORE its 'no rivals co-mentioned' clause", async () => {
  const src = await read("src/components/dashboard/VisibilityVerdictPanel.jsx");
  const rosterBranch = src.indexOf("if (!rosterState.assessable)");
  // JSX prose is line-wrapped by the formatter, so match across whitespace.
  const claim = /no rival\s+brands\s+have\s+been\s+co-mentioned/.exec(src);
  const noRivalsClaim = claim ? claim.index : -1;
  assert.ok(rosterBranch !== -1, "verdict panel must have an unassessable branch");
  assert.ok(noRivalsClaim !== -1, "the co-mention claim should still exist for the measured case");
  assert.ok(
    rosterBranch < noRivalsClaim,
    "the unassessable branch must come first, or an offline scan still asserts 'no rivals were co-mentioned'"
  );
});

test("OFFLINE STATE — rosterSource is threaded from the scan record to all three surfaces", async () => {
  const shell = await read("src/components/dashboard/DashboardShell.jsx");
  assert.match(shell, /rosterSource=\{result\.rosterSource/, "DashboardShell must pass it to RivalsView");

  const panel = await read("src/components/dashboard/RankAndSharePanel.jsx");
  assert.match(panel, /rosterSource=\{result\?\.rosterSource/, "RankAndSharePanel must pass it to the Donut");

  const verdict = await read("src/components/dashboard/VisibilityVerdictPanel.jsx");
  assert.match(verdict, /result\?\.rosterSource/, "the verdict panel reads it off the result directly");

  const api = await read("src/shared/api.js");
  assert.match(
    api,
    /rosterSource:/,
    "normalizeResult must surface roster_source, or every component above receives undefined and renders as if measured"
  );
});

test("OFFLINE STATE — all three surfaces would render the same headline", () => {
  // One string, one source. If these ever diverge the dashboard contradicts itself.
  const carried = describeRosterState(ROSTER_SOURCE.CARRIED_FORWARD);
  const unavailable = describeRosterState(ROSTER_SOURCE.UNAVAILABLE);
  assert.equal(carried.label, "Not assessed — rival extraction offline");
  assert.equal(unavailable.label, "Not assessed — rival extraction offline");
});

import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * R2.7.10 — A DASHBOARD COMPONENT THAT ONLY TESTS CAN REACH.
 *
 * WHAT HAPPENED. R2.7.6 closed a real honesty defect in
 * `src/components/dashboard/ScoreBreakdown.jsx`: the panel read
 * `result.shareOfVoicePct ?? 0` and printed a confident "0%" share of voice for
 * EVERY scan, because no pipeline stage persists a scan-level
 * `shareOfVoicePct` at all (R2.7.5). The fix was correct, it was rendered-and-
 * asserted rather than source-grepped, and the R2.7.6 verifier passed it on
 * evidence. It also reached no user, because nothing in `src/app/**` imported
 * the component — directly or transitively. The only thing that loaded
 * ScoreBreakdown.jsx was its own test file. A green suite and a fixed
 * component, and the screen was unchanged.
 *
 * That is the shape this file exists to prevent: a component whose only
 * consumer is a test reads as maintained code, so honesty work gets spent on
 * it while the surface a customer actually looks at goes unexamined. It is the
 * UI analogue of standing rule 1 — a code path that can silently do nothing
 * must say so. "Nothing renders this" is exactly such a path, and until now it
 * said nothing.
 *
 * WHAT R2.7.10 DID ABOUT IT, recorded here rather than only in the ledger,
 * because this is the file a future maintainer reaches when the guard trips:
 *
 *   - The scan-report route (`/dashboard/[brand]/[scanId]`) reaches its share
 *     of voice through DashboardShell -> OverviewView -> OverviewAnalytics ->
 *     RankAndSharePanel -> Donut, all of which read the SAME
 *     resolveShareOfVoice() that R2.7.6 wired into ScoreBreakdown. That live
 *     surface already tells a never-computed share apart from a measured zero
 *     (R2.7.1 built it that way); `liveShareOfVoiceSurface.test.mjs` renders it
 *     and proves it, including the not_computed path specifically.
 *   - So ScoreBreakdown.jsx was RETIRED (deleted), not mounted. Mounting it
 *     would have duplicated the donut's number in a second, contradicting panel
 *     drawn in the superseded dark-redesign vocabulary
 *     (`--panel-1`/`--lamp-*`/framer-motion) that the current dashboard CSS no
 *     longer defines. docs/plans/production-plan.md E2.4 had already listed it
 *     as orphaned.
 *   - R2.7.6 is CLOSED AGAINST A DELETED FILE. That is the note the ledger
 *     needs and this comment is its permanent home: R2.7.6's evidence
 *     (`ScoreBreakdown.jsx:86`, `scoreBreakdownShare.test.mjs`) no longer
 *     resolves. What survives of it is `describeShareMetric()` in
 *     src/components/perceev/charts/shareOfVoice.js, kept with its unit tests
 *     at charts/shareOfVoiceMetric.test.mjs.
 *
 * WHAT THIS FILE DOES NOT PROVE, stated rather than implied: reachability is
 * not rendering. A component can be imported by a route and sit behind a
 * condition that is never true. This walker proves the weaker fact — that an
 * import path exists — which is precisely the fact ScoreBreakdown lacked.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, "..", "..");
const APP = path.join(SRC, "app");
const DASHBOARD = path.join(SRC, "components", "dashboard");

/** Next.js file conventions that are entry points for a rendered route. */
const ROUTE_ENTRY = /^(page|layout|template|default|loading|error|global-error|not-found)\.(jsx?|tsx?)$/;

const RESOLVE_EXT = [".js", ".jsx", ".mjs", ".ts", ".tsx"];

async function listFiles(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await listFiles(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/**
 * Resolve an import specifier the way the bundler does for the two forms this
 * repo uses: the `@/*` -> `src/*` alias from jsconfig.json, and relative paths.
 * A bare package specifier resolves to null on purpose — node_modules cannot
 * import a dashboard component back.
 */
function resolveSpecifier(specifier, fromFile) {
  let base;
  if (specifier.startsWith("@/")) base = path.join(SRC, specifier.slice(2));
  else if (specifier.startsWith(".")) base = path.resolve(path.dirname(fromFile), specifier);
  else return null;

  if (existsSync(base) && statSync(base).isFile()) return base;
  for (const ext of RESOLVE_EXT) if (existsSync(base + ext)) return base + ext;
  for (const ext of RESOLVE_EXT) {
    const idx = path.join(base, "index" + ext);
    if (existsSync(idx)) return idx;
  }
  return null;
}

/** `import x from "y"`, `export * from "y"`, `export { x } from "y"`. */
const STATIC_IMPORT = /(?:^|[\s;{}()=])(?:import|export)\s+(?:[\s\S]*?\sfrom\s*)?["']([^"']+)["']/g;
/** `import("y")` with a literal specifier. */
const LITERAL_DYNAMIC = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

function specifiersIn(source) {
  const found = [];
  for (const re of [STATIC_IMPORT, LITERAL_DYNAMIC]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(source)) !== null) found.push(m[1]);
  }
  return found;
}

/** Every source file reachable from the route entry points, transitively. */
async function reachableFromRoutes() {
  const appFiles = await listFiles(APP);
  const roots = appFiles.filter((f) => ROUTE_ENTRY.test(path.basename(f)));

  const seen = new Set();
  const unresolved = [];
  const queue = [...roots];
  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    let source;
    try {
      source = await readFile(file, "utf8");
    } catch {
      continue;
    }
    for (const specifier of specifiersIn(source)) {
      const target = resolveSpecifier(specifier, file);
      if (target === null) {
        // Bare package specifiers are expected; an unresolvable relative/alias
        // specifier means the walker is blind to a real edge and must say so.
        if (specifier.startsWith(".") || specifier.startsWith("@/")) {
          unresolved.push(`${path.relative(SRC, file)} -> ${specifier}`);
        }
        continue;
      }
      if (!seen.has(target)) queue.push(target);
    }
  }
  return { roots, seen, unresolved };
}

async function dashboardComponents() {
  const files = await listFiles(DASHBOARD);
  return files.filter((f) => f.endsWith(".jsx"));
}

/**
 * Does any test file in the tree load this component? Two forms count: an
 * import specifier whose last segment is the component name, and a literal
 * "<Name>.jsx" string (how a sucrase render harness names the file it
 * compiles). A bare mention of the name is deliberately NOT enough —
 * `computeIntentBreakdown` contains "IntentBreakdown" and is a scoring
 * function, not this component.
 *
 * Comments are stripped first. A test file that DISCUSSES a component in its
 * header — this file does, and so does liveShareOfVoiceSurface.test.mjs — is
 * not loading it, and counting prose as a load produced exactly that false
 * positive on the first run of this guard.
 */
function testLoadsComponent(testSource, componentName) {
  const code = testSource.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
  const importForm = new RegExp(
    `from\\s*["'][^"']*[/"']${componentName}(?:\\.jsx)?["']`
  );
  const literalFileForm = new RegExp(`["'\`]${componentName}\\.jsx["'\`]`);
  return importForm.test(code) || literalFileForm.test(code);
}

/**
 * Dashboard components that no route reaches AND no test loads: dead in both
 * directions. Listed by docs/plans/production-plan.md E2.4 for deletion, out of
 * R2.7.10's file scope, and named here so a NEW one cannot be added silently.
 * Removing one of these (the E2.4 cleanup) does not fail this test; adding one
 * does.
 */
const KNOWN_DEAD = new Set([
  "ContentLiftPanel.jsx",
  "IntentBreakdown.jsx",
  "OpportunitiesPanel.jsx",
  "TopPromptsTable.jsx",
  "TopicBreakdown.jsx",
]);

// ---------------------------------------------------------------------------
// The walker's own teeth. If these fail, every assertion below proves nothing.
// ---------------------------------------------------------------------------

test("the walker starts from the real route entry points, including the scan report", async () => {
  const { roots } = await reachableFromRoutes();
  const names = roots.map((r) => path.relative(SRC, r).split(path.sep).join("/"));

  assert.ok(roots.length >= 4, `expected several route entries, walked from ${names.join(", ")}`);
  assert.ok(
    names.includes("app/dashboard/[brand]/[scanId]/page.js"),
    `the scan-report route must be a walk root; roots were: ${names.join(", ")}`
  );
});

test("the walker resolves every relative and aliased import it meets", async () => {
  const { unresolved } = await reachableFromRoutes();
  assert.deepEqual(
    unresolved,
    [],
    "an import this walker cannot resolve is an edge it cannot follow, which would " +
      "make a live component look orphaned. Teach resolveSpecifier() about it."
  );
});

test("the walker reaches deep into the graph, not just the first import", async () => {
  const { seen } = await reachableFromRoutes();
  const rel = (p) => path.join(SRC, ...p.split("/"));

  // DashboardShell is one hop from the route; RankAndSharePanel is four
  // (shell -> OverviewView -> OverviewAnalytics -> RankAndSharePanel) and Donut
  // is five. A walker that stopped early would still pass the shallow check.
  for (const p of [
    "components/dashboard/DashboardShell.jsx",
    "components/dashboard/OverviewView.jsx",
    "components/dashboard/OverviewAnalytics.jsx",
    "components/dashboard/RankAndSharePanel.jsx",
    "components/perceev/charts/Donut.jsx",
    "components/perceev/charts/shareOfVoice.js",
  ]) {
    assert.ok(seen.has(rel(p)), `${p} is reachable from the scan report but the walker missed it`);
  }
  assert.ok(seen.size > 40, `only ${seen.size} files reached — the walk terminated too early`);
});

test("no code-splitting form exists that this static walker cannot see", async () => {
  // A `dynamic(() => import(x))` or `React.lazy(...)` edge is invisible to a
  // regex over literal specifiers, so a component mounted that way would be
  // reported as an orphan and this guard would be lying. Today the repo uses
  // none; the day it does, this fails rather than quietly going blind.
  const files = (await listFiles(SRC)).filter(
    (f) => /\.(jsx?|mjs)$/.test(f) && !f.includes(".test.") && !f.endsWith(".testutil.mjs")
  );
  const offenders = [];
  for (const file of files) {
    const source = await readFile(file, "utf8");
    const stripped = source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
    if (/\bnext\/dynamic\b/.test(stripped) || /\bReact\.lazy\s*\(|\blazy\s*\(\s*\(\s*\)\s*=>/.test(stripped)) {
      offenders.push(path.relative(SRC, file));
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "code-splitting was introduced. Teach reachableFromRoutes() to follow it before " +
      "trusting the orphan guard below, which would otherwise call a live component dead."
  );
});

// ---------------------------------------------------------------------------
// THE ACCEPT GUARD.
// ---------------------------------------------------------------------------

test("ACCEPT — no dashboard component is reachable by tests but by no route", async () => {
  const { seen } = await reachableFromRoutes();
  const components = await dashboardComponents();
  // This file is excluded from its own scan: KNOWN_DEAD below names the
  // orphaned components as "<Name>.jsx" string literals, which is exactly the
  // form testLoadsComponent() looks for. Counting the guard's own bookkeeping
  // as a load would report every listed component as an offender — which it did
  // on the first run, before this line existed.
  const testFiles = (await listFiles(SRC)).filter(
    (f) => f.endsWith(".test.mjs") && f !== fileURLToPath(import.meta.url)
  );
  const testSources = await Promise.all(testFiles.map((f) => readFile(f, "utf8")));

  const offenders = [];
  for (const component of components) {
    if (seen.has(component)) continue;
    const name = path.basename(component, ".jsx");
    const loadedBy = testFiles.filter((_, i) => testLoadsComponent(testSources[i], name));
    if (loadedBy.length > 0) {
      offenders.push(
        `${path.relative(SRC, component)} is loaded by ${loadedBy
          .map((f) => path.relative(SRC, f))
          .join(", ")} but no route imports it`
      );
    }
  }

  assert.deepEqual(
    offenders,
    [],
    "This is R2.7.10: a component that only tests can reach looks maintained, so " +
      "correctness work gets spent on it while the surface a customer sees goes " +
      "unexamined. Either mount it on a route, or delete it and move its tests to " +
      "whatever is live — do not leave it half-alive."
  );
});

test("no NEW dead dashboard component has appeared", async () => {
  const { seen } = await reachableFromRoutes();
  const components = await dashboardComponents();

  const unexpected = components
    .filter((c) => !seen.has(c))
    .map((c) => path.basename(c))
    .filter((name) => !KNOWN_DEAD.has(name));

  assert.deepEqual(
    unexpected,
    [],
    "a dashboard component no route reaches. If it is genuinely pending, add it to " +
      "KNOWN_DEAD with a reason; do not let it accumulate unannounced."
  );
});

test("ScoreBreakdown.jsx is gone rather than orphaned — R2.7.10 retired it", async () => {
  const retired = path.join(DASHBOARD, "ScoreBreakdown.jsx");
  assert.equal(
    existsSync(retired),
    false,
    "R2.7.6's honesty fix lived here and no route ever reached it. It was deleted, " +
      "not re-mounted, because the live donut already carries the same distinction " +
      "(see liveShareOfVoiceSurface.test.mjs). If this file comes back it needs a " +
      "route, not another round of tests."
  );
  assert.equal(
    existsSync(path.join(DASHBOARD, "scoreBreakdownShare.test.mjs")),
    false,
    "the retired component's render harness went with it"
  );
  // What survives of R2.7.6, so the close is not silently erased.
  const survivor = path.join(SRC, "components", "perceev", "charts", "shareOfVoice.js");
  const source = await readFile(survivor, "utf8");
  assert.ok(
    /export function describeShareMetric/.test(source),
    "describeShareMetric() is the half of R2.7.6 that outlived ScoreBreakdown and must stay"
  );
  assert.ok(
    (await stat(path.join(SRC, "components", "perceev", "charts", "shareOfVoiceMetric.test.mjs"))).isFile(),
    "and its unit tests must have a home"
  );
});

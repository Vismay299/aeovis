import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, stat, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
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
function resolveSpecifier(specifier, fromFile, srcRoot = SRC) {
  let base;
  if (specifier.startsWith("@/")) base = path.join(srcRoot, specifier.slice(2));
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

/** Identifiers after which a `/` begins a regex literal rather than a division. */
const REGEX_PRECEDING_KEYWORDS = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void",
  "throw", "case", "do", "else", "yield", "await",
]);
/**
 * Punctuation after which a `/` begins a regex literal. An ALLOW-list, not a
 * deny-list: the deny-list version treated the `/` in a JSX closing tag
 * (`</div>`, and `/>` after a `{...}` prop) as the start of a regex, which made
 * the scanner skip the rest of that line — including a trailing
 * `// import Foo from "./Foo"`, i.e. the exact bypass this file exists to stop.
 * `<`, `>` and `}` are deliberately absent for that reason; `a < /re/.test(b)`
 * would be mis-read as division, which costs nothing here because the regex
 * branch only exists to protect a body like /https?:\/\// from the
 * comment reader.
 */
const REGEX_PRECEDING_PUNCTUATION = new Set([
  "(", ",", "=", ":", "[", "!", "&", "|", "?", "+", "-", "*", "%", "^", "~", ";", "{",
]);

/**
 * Remove comments while leaving string, template and regex literals intact.
 *
 * WHY THIS IS NOT A PAIR OF REGEXES. The R2.7.10 verifier disabled the first
 * version of this walker with ONE line: it prepended
 * `// Someday: import { X } from "./X";` to a route-reachable component, which
 * made the orphan X look imported and turned the whole guard green with a
 * test-only component sitting in the tree. Commenting out the import is the
 * single most likely way a component gets un-mounted while its test stays
 * behind, i.e. exactly the failure this file exists to catch.
 *
 * The obvious repair — the two-regex idiom that blanks block comments and then
 * everything after a double slash to end of line — over-strips in the other
 * direction: `const u = "https://x"` loses the rest of its line, and so would
 * any specifier that followed it. 41 non-test source lines across 19 files
 * carry a `//` inside a string literal today; MEASURED, none of them is
 * followed on the same line by an import, so that idiom would lose no real edge
 * on today's tree. This scanner is therefore insurance, not a bug fix, and the
 * honest reason to prefer it is that the failure it prevents is a walker
 * quietly shrinking its own graph — a live component reported dead, or worse,
 * an edge dropped somewhere the assertions below do not look.
 *
 * Because that direction is the silent one, it gets its own alarm: "comment
 * stripping never drops a real import edge" below re-scans every source file
 * and cross-checks each dropped specifier against an independent, line-oriented
 * judgement of whether it was really in a comment, so an over-strip fails
 * loudly and by name.
 */
function stripComments(source) {
  let out = "";
  let prevChar = "";
  let prevWord = "";
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];

    if (c === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      out += " ";
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i += 1;
      i += 2;
      out += " ";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      out += c;
      i += 1;
      while (i < source.length) {
        if (source[i] === "\\") {
          out += source[i] + (source[i + 1] ?? "");
          i += 2;
          continue;
        }
        out += source[i];
        const closed = source[i] === c;
        i += 1;
        if (closed) break;
      }
      prevChar = c;
      prevWord = "";
      continue;
    }
    // A `/` here is neither `//` nor `/*`, so it is a regex literal or a
    // division. Only the regex case matters: a body like /https?:\/\// ends in
    // `//`, which a comment-first reader would swallow along with the line.
    if (
      c === "/" &&
      (prevChar === "" ||
        REGEX_PRECEDING_PUNCTUATION.has(prevChar) ||
        REGEX_PRECEDING_KEYWORDS.has(prevWord))
    ) {
      out += c;
      i += 1;
      let inClass = false;
      while (i < source.length) {
        const r = source[i];
        if (r === "\\") {
          out += r + (source[i + 1] ?? "");
          i += 2;
          continue;
        }
        if (r === "\n") break;
        out += r;
        i += 1;
        if (r === "[") inClass = true;
        else if (r === "]") inClass = false;
        else if (r === "/" && !inClass) break;
      }
      prevChar = "/";
      prevWord = "";
      continue;
    }

    out += c;
    if (!/\s/.test(c)) {
      prevChar = c;
      prevWord = /[\w$]/.test(c) ? prevWord + c : "";
    }
    i += 1;
  }
  return out;
}

function specifiersIn(source) {
  const code = stripComments(source);
  const found = [];
  for (const re of [STATIC_IMPORT, LITERAL_DYNAMIC]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(code)) !== null) found.push(m[1]);
  }
  return found;
}

/**
 * Is the specifier occurrence at `index` genuinely inside a comment? Used only
 * by the "comment stripping never drops a real import edge" test, and written
 * on purpose in a different style from stripComments() — line-oriented rather
 * than a character state machine — so it is a real second opinion. Where it is
 * wrong it is wrong towards forgiveness (a block-comment opener inside a string
 * makes it call a region commented), which weakens the cross-check without ever
 * weakening the walk itself.
 */
function occurrenceIsCommented(source, index) {
  let from = 0;
  for (;;) {
    const open = source.indexOf("/*", from);
    if (open === -1 || open > index) break;
    const close = source.indexOf("*/", open + 2);
    if (close === -1) return true;
    if (index > open && index < close) return true;
    from = close + 2;
  }
  const lineStart = source.lastIndexOf("\n", index) + 1;
  const prefix = source.slice(lineStart, index);
  let quote = null;
  for (let i = 0; i < prefix.length; i += 1) {
    const c = prefix[i];
    if (quote !== null) {
      if (c === "\\") i += 1;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "/" && prefix[i + 1] === "/") return true;
  }
  return false;
}

/**
 * Every source file reachable from the route entry points, transitively.
 *
 * `srcRoot`/`appRoot` default to this repo. They are parameters so the teeth
 * tests below can point the SAME walker at a throwaway fixture tree and prove
 * what it does with a commented-out import, instead of asserting it by reading.
 */
async function reachableFromRoutes({ srcRoot = SRC, appRoot = APP } = {}) {
  const appFiles = await listFiles(appRoot);
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
      const target = resolveSpecifier(specifier, file, srcRoot);
      if (target === null) {
        // Bare package specifiers are expected; an unresolvable relative/alias
        // specifier means the walker is blind to a real edge and must say so.
        if (specifier.startsWith(".") || specifier.startsWith("@/")) {
          unresolved.push(`${path.relative(srcRoot, file)} -> ${specifier}`);
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
 * Comments are stripped first, by the same scanner the import walk uses. A test
 * file that DISCUSSES a component in its header — this file does, and so does
 * liveShareOfVoiceSurface.test.mjs — is not loading it, and counting prose as a
 * load produced exactly that false positive on the first run of this guard.
 */
function testLoadsComponent(testSource, componentName) {
  const code = stripComments(testSource);
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

test("a commented-out import is not an import edge", () => {
  // The exact line the R2.7.10 verifier used to disable the first version of
  // this walker, prepended to a route-reachable component.
  assert.deepEqual(
    specifiersIn(`// Someday: import { VerifierOrphan } from "./VerifierOrphan";\n`),
    [],
    "a commented-out import made an orphan look mounted and this whole file went green"
  );
  assert.deepEqual(specifiersIn(`/* import x from "./Dead"; */\n`), []);
  assert.deepEqual(
    specifiersIn(`/**\n * import x from "./Dead";\n */\nimport y from "./Live";\n`),
    ["./Live"],
    "a JSDoc block that quotes an import must not create an edge, and must not eat the real one after it"
  );
  // ...and the opposite direction: stripping must not swallow live code.
  assert.deepEqual(
    specifiersIn(`import a from "./A"; // import b from "./B"\n`),
    ["./A"],
    "the real import on a line with a trailing comment"
  );
  assert.deepEqual(
    specifiersIn(`const u = "https://example.com/x"; const m = import("./Live");\n`),
    ["./Live"],
    "a `//` inside a STRING is not a comment; naive stripping loses every edge after it on that line"
  );
  assert.deepEqual(
    specifiersIn("const re = /https?:\\/\\//; const m = import(\"./Live\");\n"),
    ["./Live"],
    "a regex literal ending in `\\/\\/` is not a comment either"
  );
  assert.deepEqual(
    specifiersIn('const t = `a // b`;\nimport x from "./Live";\n'),
    ["./Live"],
    "a template literal containing `//` does not comment out the next line"
  );
  // JSX, which is what the guarded files are actually made of. The `/` of a
  // closing tag must not be mistaken for the start of a regex literal, because
  // the scanner would then run past the comment on the same line and hand back
  // a dead import as a live edge.
  assert.deepEqual(
    specifiersIn('return <div></div>; // import x from "./Dead"\n'),
    [],
    "a closing JSX tag must not swallow the comment reader for the rest of the line"
  );
  assert.deepEqual(
    specifiersIn('return <Foo bar={x} />; // import y from "./Dead"\n'),
    [],
    "nor a self-closing tag that follows a `{...}` prop"
  );
  assert.deepEqual(
    specifiersIn('return (\n  <div>\n    {/* import z from "./Dead" */}\n  </div>\n);\n'),
    [],
    "a JSX block comment is still a comment"
  );
});

test("comment stripping never drops a real import edge", async () => {
  // Loudness for the OTHER direction. Over-stripping shrinks the reachable set,
  // which can make a live component look dead; caught here by name rather than
  // surfacing as a mystery orphan. The cross-check is deliberately independent
  // of stripComments(): it judges "is this occurrence commented?" line-by-line.
  const files = (await listFiles(SRC)).filter((f) => /\.(jsx?|mjs|tsx?)$/.test(f));
  const lost = [];
  let edgesExamined = 0;
  for (const file of files) {
    const raw = await readFile(file, "utf8");
    const kept = specifiersIn(raw);
    edgesExamined += kept.filter((s) => s.startsWith(".") || s.startsWith("@/")).length;
    const rawFound = [];
    for (const re of [STATIC_IMPORT, LITERAL_DYNAMIC]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(raw)) !== null) {
        // The specifier's OWN offset, not the match's. STATIC_IMPORT's lazy
        // `[\s\S]*?` can start matching lines above, so m.index frequently sits
        // on a different (uncommented) line and made this cross-check report a
        // correctly-stripped comment as a lost edge.
        rawFound.push({ specifier: m[1], index: m.index + m[0].lastIndexOf(m[1]) });
      }
    }
    for (const { specifier, index } of rawFound) {
      // Only edge-shaped specifiers matter. Scanning RAW source, STATIC_IMPORT's
      // lazy `[\s\S]*?` happily pairs the word "export" in a comment with a
      // quoted sentence three lines later; those are noise the walk already
      // discards as bare packages, and comparing them here would drown the
      // signal. A dropped "./x" or "@/x" is the real thing.
      if (!specifier.startsWith(".") && !specifier.startsWith("@/")) continue;
      if (kept.includes(specifier)) continue;
      if (occurrenceIsCommented(raw, index)) continue;
      lost.push(`${path.relative(SRC, file)} -> ${specifier}`);
    }
  }
  // An empty `lost` list means nothing if nothing was compared. Say how much was.
  assert.ok(
    files.length > 100 && edgesExamined > 200,
    `this cross-check compared ${edgesExamined} edges across ${files.length} files — too few to ` +
      "mean anything, so it is passing by doing nothing rather than by finding nothing"
  );
  assert.deepEqual(
    lost,
    [],
    "stripComments() removed a specifier that does not sit in a comment, so the walk is " +
      "now blind to a real edge and would report a live component as an orphan"
  );
});

test("the walker calls a component orphaned even when a live file mentions it in a comment", async (t) => {
  // The verifier's bypass, rebuilt as a permanent fixture: a throwaway tree with
  // a real route root, a component the route really imports, and inside that
  // component a commented-out import of a second component nothing mounts.
  const root = await mkdtemp(path.join(tmpdir(), "route-reachability-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const src = path.join(root, "src");
  const app = path.join(src, "app", "dashboard");
  const components = path.join(src, "components", "dashboard");
  await mkdir(app, { recursive: true });
  await mkdir(components, { recursive: true });

  await writeFile(
    path.join(app, "page.js"),
    'import Live from "@/components/dashboard/Live";\nexport default function Page() { return <Live />; }\n'
  );
  await writeFile(
    path.join(components, "Live.jsx"),
    '// Someday: import Orphan from "./Orphan";\n' +
      '/* import Orphan from "./Orphan"; */\n' +
      'const help = "see https://example.com/docs";\n' +
      "export default function Live() { return null; }\n"
  );
  await writeFile(path.join(components, "Orphan.jsx"), "export default function Orphan() { return null; }\n");

  const { seen, unresolved } = await reachableFromRoutes({ srcRoot: src, appRoot: path.join(src, "app") });
  assert.deepEqual(unresolved, [], "the fixture's own imports must all resolve, or this proves nothing");
  assert.ok(
    seen.has(path.join(components, "Live.jsx")),
    "the fixture's live component must be reachable, or the fixture is broken rather than the walker honest"
  );
  assert.equal(
    seen.has(path.join(components, "Orphan.jsx")),
    false,
    "a commented-out import counted as a real edge: this is the bypass that failed R2.7.10 the " +
      "first time — one `//` line in a route-reachable file silenced the orphan guard entirely"
  );
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

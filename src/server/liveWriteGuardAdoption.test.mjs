import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { BYPASS_CALL_SITES, CRLF_AND_NUL_PROBE, NEUTRAL_CALL_SITES } from "./liveWriteGuardAdoption.fixtures.mjs";

/**
 * R3.2.7 — the live write guard must be able to force its own ADOPTION.
 *
 * WHAT R3.2.4 LEFT OPEN
 * `src/server/liveWriteGuard.js` refuses undeclared writes, and its own suite
 * (`liveWriteGuard.test.mjs`) proves the refusals happen. What neither proves is
 * that a live-DB test goes through it at all. Its author named the gap in the
 * ledger: "a live test that never calls installLiveWriteGuard is unprotected,
 * and nothing makes a new file call it… the repo has no naming convention to
 * key on — probeTasksRace.test.mjs is a live file with no `Live` in its name."
 *
 * The one adoption rule that did exist — "META — every file that imports the
 * live gate arms the write guard" in liveWriteGuard.test.mjs — keys on
 * IMPORTING `src/server/liveDbGate.js`. A new file that reaches a database without
 * asking the gate — it reads the DATABASE_URL variable out of the environment
 * and builds a `pg.Client` by hand — imports nothing that rule looks at, so it
 * is invisible to it. That
 * is exactly the file this suite is for: adoption keyed on what a file DOES,
 * not on what it imports or what it is called.
 *
 * TWO PROPERTIES, ONE PER HALF OF THE LEDGER ITEM
 *   1. ADOPTION. Every test file that can reach a real database must open it
 *      through `armedLiveDbGate`. A file that can and does not fails here,
 *      naming the signal that flagged it.
 *   2. COVERS IS ENFORCED, NOT CONVENTIONAL. The three live files each assert
 *      `WRITE_GUARD.covers.pg === true` and `.covers.supabase === true`, because
 *      a guard whose dynamic import of the pg driver failed looks installed and
 *      refuses nothing. That assertion is itself a convention a new file can
 *      omit — so
 *      the cases at the bottom prove the enforcement does not depend on it:
 *      `armedLiveDbGate` refuses to report an OPEN gate behind a blind guard,
 *      and `liveDbGate` refuses the same way, in a child process where the
 *      transport really has been made unimportable.
 *
 * WHY ADOPTION MEANS `armedLiveDbGate` AND NOT `installLiveWriteGuard`
 * Both arm the guard. Only `armedLiveDbGate` also refuses to answer "the gate is
 * open" when the guard could not patch a transport — i.e. only it enforces
 * property 2 for the file that adopts it. A file that hand-rolls
 * `installLiveWriteGuard` is armed but may be armed and blind, and nothing tells
 * it. So the walker below requires the gate.
 *
 * WHY A TEXT SCAN, AND WHAT DEFEATS IT (say it rather than pretend)
 * The walker reads whole files with `fs.readFile` — not `grep`, not a line
 * regex — normalises CRLF (the tree is half CRLF despite .gitattributes,
 * R6.4.7), and refuses to scan a file it could not read. Two consequences worth
 * stating:
 *   - A NUL byte hides a file from a grep-based guard (R6.4.10). It does NOT
 *     hide anything here: `readFile(…, "utf8")` returns the NUL as one more
 *     character and the regexes still see the rest. There is a case below that
 *     plants a NUL and asserts detection survives it.
 *   - It is still text, so it is defeated by a signal built at runtime:
 *     `await import("p" + "g")`, a connection string assembled from
 *     `process.env[NAME]` with a computed NAME, or a database reached through a
 *     helper module this walker never opens (transitive imports are NOT
 *     followed). Those are covered by the OTHER two mechanisms, not by this one:
 *     the `--import ./src/server/liveWriteGuardAuto.mjs` preload arms every process
 *     the npm scripts start, and the runtime tripwire in `liveDbGate` throws
 *     when a real database is configured and no guard is armed. This file is the
 *     third leg — the one that fires at review time, before the run.
 *
 * The detector is deliberately conservative in ONE direction: a false positive
 * costs an exemption with a written reason in this file, which is visible in a
 * diff; a false negative costs a production write. So a signal fires unless the
 * file demonstrably neutralised it (see NEUTRALISERS on each signal).
 *
 * Hermetic: no database, no network. The child processes it spawns import
 * modules and are refused by the gate before anything connects.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Where test files live. `src` is what `npm test` / `npm run test:scoring`
 * glob. `worker/src` is scanned too and currently holds no test file at all:
 * the fleet's own `npm --prefix worker run test` script carries NO
 * `--import ./src/server/liveWriteGuardAuto.mjs`, so the first live worker test
 * would be unguarded by the preload, and this walker is where that shows up.
 */
const SCAN_ROOTS = ["src", "worker/src"];

/* ===========================================================================
 * THE CORPUS GUARD, because a walker over an empty file list passes vacuously.
 * Same shape as src/server/ssrfGuard.test.mjs:64 and the ten files swept by
 * R6.4.15: a floor at the true current count, uniqueness, and named members
 * that must never silently drop out of the scan.
 * ======================================================================== */
import { assertCorpusIntact } from "./testCorpus.mjs";

// ---------------------------------------------------------------------------
// The detector
// ---------------------------------------------------------------------------

/**
 * The credentials that name a REAL database. A test that reads one of these out
 * of the ambient environment is pointing itself at whatever `.env.local` holds
 * — which, following the gate's own instructions, is production.
 *
 * `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` are the two
 * `src/server/db.js:11-12` reads to build the shared client; the rest are what
 * `src/server/liveDbGate.js` opens the gate on plus the service-role key.
 */
const DB_CREDENTIALS = Object.freeze([
  "DATABASE_URL",
  "SUPABASE_DB_PASSWORD",
  "SUPABASE_DB_HOST",
  "SUPABASE_DB_USER",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
]);

/** The endpoint `src/server/db.js` builds its shared client from. */
const SHARED_CLIENT_ENDPOINT = "NEXT_PUBLIC_SUPABASE_URL";

/** The file sets or deletes the variable itself, so what it reads is its own. */
function ownsEnvVar(src, name) {
  return new RegExp(String.raw`delete\s+process\.env\.${name}\b|process\.env\.${name}\s*=(?!=)`).test(src);
}

function readsEnvVar(src, name) {
  return new RegExp(String.raw`process\.env\.${name}\b`).test(src);
}

/** The text of the first argument of a call, given everything after its `(`. */
function firstArgumentOf(text) {
  let depth = 0;
  let quote = null;
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      out += ch;
      if (ch === "\\") {
        out += text[i + 1] ?? "";
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") {
      depth += 1;
      out += ch;
      continue;
    }
    if (ch === ")" || ch === "]" || ch === "}") {
      if (depth === 0) break;
      depth -= 1;
      out += ch;
      continue;
    }
    if (ch === "," && depth === 0) break;
    out += ch;
  }
  return out.trim();
}

/**
 * A `createClient()` call whose first argument is not a literal written into the
 * source. NEUTRALISER: a quoted URL, because a URL spelled out in a test file is
 * not the ambient environment — `liveWriteGuard.test.mjs` builds a client
 * against `https://guard-self-test.invalid` exactly so it can provoke refusals
 * without a server. `createClient()` with NO argument is also neutral: it builds
 * nothing, and that is how the prose mention at insertScanCascade3.test.mjs:54
 * reads.
 */
function callsCreateClientOnAmbientUrl(src) {
  for (const m of src.matchAll(/\bcreateClient\s*\(/g)) {
    const arg = firstArgumentOf(src.slice(m.index + m[0].length));
    if (arg === "") continue;
    if (/^["'`]/.test(arg)) continue;
    return true;
  }
  return false;
}

/** A real import of the shared `supabase` client object out of src/server/db.js. */
function importsSharedClient(src) {
  return (
    /import\s*\{[^}]*\bsupabase\b[^}]*\}\s*from\s*["'][^"']*\bdb\.js["']/.test(src) ||
    /\{[^}]*\bsupabase\b[^}]*\}\s*=\s*await\s+import\s*\(\s*["'][^"']*\bdb\.js["']/.test(src) ||
    /import\s*\(\s*["'][^"']*\bdb\.js["']\s*\)\s*\)?\s*\.\s*supabase\b/.test(src)
  );
}

/**
 * The signals that say "this file can reach a real database". Each row is
 * [id, detect, why] — `why` is what the failure message tells the next author,
 * and is also what stops a row being deleted without a decision.
 */
const SIGNALS = Object.freeze([
  [
    "pg-driver",
    (src) => /\b(?:from|import|require)\s*\(?\s*["']pg["']/.test(src),
    "imports the raw `pg` driver. There is no fake pg: a Client/Pool connects to whatever connection " +
      "string it is handed, and in a test that string comes from the environment.",
  ],
  [
    "supabase-create-client",
    callsCreateClientOnAmbientUrl,
    "calls createClient() with a URL it did not write into the source, i.e. one that came from the " +
      "environment. That is a PostgREST client against a real project.",
  ],
  [
    "shared-supabase-client",
    (src) => importsSharedClient(src) && !ownsEnvVar(src, SHARED_CLIENT_ENDPOINT),
    "imports the shared client from src/server/db.js without first setting or deleting " +
      `process.env.${SHARED_CLIENT_ENDPOINT}, so the client it gets is built from the ambient credentials. ` +
      "The hermetic files that import it all clear that variable before the import and assert the client is null.",
  ],
  ...DB_CREDENTIALS.map((name) => [
    `env:${name}`,
    (src) => readsEnvVar(src, name) && !ownsEnvVar(src, name),
    `reads process.env.${name} without setting or deleting it first, so it is reading the real credential ` +
      `out of .env.local rather than a value of its own.`,
  ]),
]);

/** The signals a file trips, by id. */
function signalsFor(src) {
  return SIGNALS.filter(([, detect]) => detect(src)).map(([id]) => id);
}

/** What adoption looks like at a call site. See the header for why only this. */
function adoptsTheGuard(src) {
  return /\barmedLiveDbGate\s*\(/.test(src);
}

/** The `label:` a file passes to armedLiveDbGate, or null. */
function gateLabel(src) {
  const m = src.match(/armedLiveDbGate\s*\(\s*\{[\s\S]{0,200}?label\s*:\s*["']([^"']+)["']/);
  return m ? m[1] : null;
}

/**
 * EXEMPTIONS — keyed by `file#signal`, never by file alone, so exempting a
 * fixture string does not also exempt the real `pg` import somebody adds to the
 * same file next month. Each row carries the reason it is safe. A row that stops
 * firing is a FAILURE below, not a quiet leftover: a stale exemption is how the
 * eighth one gets added without anybody noticing the first seven.
 */
const EXEMPTIONS = Object.freeze([
  [
    "src/server/liveWriteGuard.test.mjs#pg-driver",
    "the guard's own suite. Its single import of the pg driver sits inside the RESTORE_PROBE template " +
      "string it runs in a child process to check the prototypes are restored; that child patches and " +
      "unpatches pg.Client.prototype.query and never constructs a client, let alone connects one.",
  ],
  [
    "src/server/liveWriteGuard.test.mjs#env:DATABASE_URL",
    "the same file's planted-offender corpus: the DATABASE_URL read appears inside quoted source text at " +
      "lines 941/944/1117/1122, where it is the INPUT to the R3.2.10 static rule rather than a read this " +
      "file performs. Its child processes are handed a literal 127.0.0.1:1 connection string.",
  ],
  [
    "src/server/credentialAssertionGuard.test.mjs#env:SUPABASE_DB_PASSWORD",
    "the SUPABASE_DB_PASSWORD read at line 518 is inside a template literal holding the SOURCE of an " +
      "example assertion that guard classifies. The file imports no database client of any kind.",
  ],
]);

/**
 * The files that really do run against a live database. Named, so that an empty
 * or shrunken result cannot read as a clean run (standing rule 1) — and so that
 * a FOURTH live file is a deliberate edit here rather than a silent arrival.
 */
const LIVE_DB_TEST_FILES = Object.freeze([
  "src/server/probeTasksRace.test.mjs",
  "src/server/scanRunsLive.test.mjs",
  // R3.3.5 — declares only scan_runs.
  "src/server/workers/reaperCloseLive.test.mjs",
  "src/server/workers/scanChunkLedgerLive.test.mjs",
]);

async function collectTestFiles() {
  const out = [];
  for (const rel of SCAN_ROOTS) {
    const base = path.join(ROOT, rel);
    let entries;
    try {
      entries = await readdir(base, { withFileTypes: true });
    } catch {
      continue; // worker/src may not exist in a checkout; src missing fails the floor below
    }
    const stack = entries.map((e) => ({ dir: base, entry: e }));
    while (stack.length > 0) {
      const { dir, entry } = stack.pop();
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") continue;
        for (const child of await readdir(full, { withFileTypes: true })) stack.push({ dir: full, entry: child });
      } else if (/\.test\.(mjs|js|jsx)$/.test(entry.name)) {
        out.push(full);
      }
    }
  }
  return out.sort();
}

async function readTestFiles() {
  const files = await collectTestFiles();
  const rows = [];
  for (const full of files) {
    const rel = path.relative(ROOT, full).split(path.sep).join("/");
    // Whole-file read, then CRLF normalised: half this tree is CRLF (R6.4.7),
    // and a line-anchored regex would behave differently on the two halves.
    const raw = await readFile(full, "utf8");
    rows.push({ rel, src: raw.replace(/\r\n/g, "\n"), raw });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// 1. ADOPTION
// ---------------------------------------------------------------------------

test("GUARD — the signal and exemption corpora are intact, so the walker below is not vacuous", () => {
  assertCorpusIntact(SIGNALS, "SIGNALS", {
    floor: 11, // 3 structural + one per DB_CREDENTIALS entry (8)
    rowLength: 3,
    isTuple: true,
    required: ["pg-driver", "supabase-create-client", "shared-supabase-client", "env:DATABASE_URL"],
  });
  for (const [id, detect] of SIGNALS) {
    assert.equal(typeof detect, "function", `SIGNALS row ${id} has no detector, so it can never fire`);
  }
  assertCorpusIntact(EXEMPTIONS, "EXEMPTIONS", { floor: 3, rowLength: 2, isTuple: true });
  for (const [key] of EXEMPTIONS) {
    assert.match(key, /^[\w./-]+#[\w:-]+$/, `exemption key ${key} must be file#signal, never a bare file`);
    const signal = key.split("#")[1];
    assert.ok(
      SIGNALS.some(([id]) => id === signal),
      `exemption ${key} names signal "${signal}", which no longer exists — it now exempts nothing, and ` +
        `a reader would believe it still does`
    );
  }
});

test("THE DETECTOR RECOGNISES A BYPASS — planted call sites, not just the ones already in the tree", () => {
  // The fixtures are a sibling module, not literals here, because this file is
  // itself inside the scanned corpus: holding the planted call sites inline
  // made this suite trip its own detector, and the only exit would have been to
  // exempt the guard from itself. See the header of the fixtures file.
  assertCorpusIntact(
    BYPASS_CALL_SITES.map((r) => r[0]),
    "BYPASS_CALL_SITES",
    {
      floor: 7,
      isTuple: false,
      required: ["hand-rolled pg client", "createClient on ambient credentials", "shared client with the credentials left ambient"],
    }
  );
  assertCorpusIntact(
    NEUTRAL_CALL_SITES.map((r) => r[0]),
    "NEUTRAL_CALL_SITES",
    { floor: 5, isTuple: false }
  );
  for (const row of [...BYPASS_CALL_SITES, ...NEUTRAL_CALL_SITES]) {
    assert.ok(
      typeof row[1] === "string" && row[1].trim().length > 0,
      `fixture ${JSON.stringify(row[0])} carries no source text, so the case below asserts nothing about it`
    );
  }
  for (const row of BYPASS_CALL_SITES) {
    assert.ok(
      Array.isArray(row[2]) && row[2].length > 0,
      `bypass fixture ${JSON.stringify(row[0])} names no expected signal, so it would pass however little ` +
        `the detector saw`
    );
  }

  for (const [name, src, expected] of BYPASS_CALL_SITES) {
    const got = signalsFor(src);
    for (const id of expected) {
      assert.ok(
        got.includes(id),
        `the detector missed signal "${id}" in the ${name} bypass. A file like this would reach a real ` +
          `database with no guard installed and this suite would stay green.`
      );
    }
    assert.equal(adoptsTheGuard(src), false, `${name} must not read as an adopter`);
  }

  // …and the neutralised forms, which is what stops the walker demanding an
  // exemption for half the suite. Each of these genuinely cannot reach a server.
  for (const [name, src] of NEUTRAL_CALL_SITES) {
    assert.deepEqual(
      signalsFor(src),
      [],
      `${name} cannot reach a real database, so flagging it would push a hermetic file onto the ` +
        `exemption list and teach the next author that the list is where files go to be quiet`
    );
  }
});

test("THE DETECTOR SURVIVES THE TWO THINGS THAT DEFEAT GREP IN THIS REPO", () => {
  const { src: BYPASS, signals: EXPECTED } = CRLF_AND_NUL_PROBE;
  assert.deepEqual(signalsFor(BYPASS).sort(), [...EXPECTED], "the probe must be a bypass before it is decorated");

  // R6.4.10: a NUL byte makes a file invisible to a grep-based guard, which is
  // an open finding against the grep-based guards in this repo. It does NOT
  // hide anything from this one: the walker reads whole files with fs and
  // matches against the string, so the NUL is one more character. Built with
  // fromCharCode so the byte is unmistakably a byte and not an escape sequence
  // somebody normalised on the way in.
  const NUL = String.fromCharCode(0);
  const withNul = "//" + NUL + " planted by R3.2.7\n" + BYPASS;
  assert.deepEqual(
    signalsFor(withNul).sort(),
    [...EXPECTED],
    "a NUL byte in the source must not hide a bypass from this walker. R6.4.10 is about grep going " +
      "blind; this is not grep, and if that ever stops being true the bypass becomes invisible again."
  );

  // R6.4.7: the tree is half CRLF despite .gitattributes. The walker normalises
  // before matching, and the verdict must not depend on which half a file is in.
  const crlf = BYPASS.split("\n").join("\r\n");
  assert.ok(crlf.includes("\r\n"), "the CRLF probe must actually contain CRLF, or it proves nothing");
  assert.deepEqual(
    signalsFor(crlf.split("\r\n").join("\n")).sort(),
    [...EXPECTED],
    "a CRLF file must reach the detector with the same verdict as an LF one"
  );
});


test("META — every test file that can reach a real database opens it through armedLiveDbGate", async () => {
  const rows = await readTestFiles();

  assertCorpusIntact(
    rows.map((r) => r.rel),
    "TEST_FILE_CORPUS",
    {
      // 163 test files under src/ at the time of writing (this one included);
      // worker/src holds none. A floor of 155 leaves room for churn and still
      // fails if the walk breaks and scans a handful of files or none.
      floor: 155,
      isTuple: false,
      required: [
        ...LIVE_DB_TEST_FILES,
        "src/server/liveWriteGuard.test.mjs",
        "src/server/liveWriteGuardAdoption.test.mjs",
        // A nested directory, so a walk that stops at the top level fails here.
        "src/server/workers/scanChunkLedger.test.mjs",
      ],
    }
  );

  const exempt = new Map(EXEMPTIONS.map(([key, why]) => [key, why]));
  const usedExemptions = new Set();
  const live = [];
  const offenders = [];

  for (const { rel, src } of rows) {
    const signals = signalsFor(src);
    const unexcused = [];
    for (const id of signals) {
      const key = `${rel}#${id}`;
      if (exempt.has(key)) {
        usedExemptions.add(key);
        continue;
      }
      unexcused.push(id);
    }
    if (unexcused.length === 0) continue;

    if (adoptsTheGuard(src)) {
      live.push(rel);
      // A refusal has to name the file that caused it, and every live file
      // labels itself with its own path. A copy-pasted gate block that kept the
      // original's label sends the next author to the wrong file.
      assert.equal(
        gateLabel(src),
        rel,
        `${rel} arms the guard under the label ${JSON.stringify(gateLabel(src))}. Every refusal it ` +
          `provokes would name that file instead of this one.`
      );
      continue;
    }
    offenders.push(
      `${rel} — ${unexcused
        .map((id) => `[${id}] ${SIGNALS.find(([s]) => s === id)[2]}`)
        .join(" ")}`
    );
  }

  assert.deepEqual(
    offenders,
    [],
    "These test files can reach a real database and do NOT open it through armedLiveDbGate, so nothing " +
      "installs the default-deny write guard for them: run one with --env-file=.env.local and a forgotten " +
      "stub writes to production, which is the R3.2.4 incident (two rows in `scans`, two in " +
      "`brand_metrics_daily`). Fix by replacing the hand-rolled access with " +
      '`await armedLiveDbGate({ label: "<this file>", allow: [...] })` from src/server/liveDbGate.js — it ' +
      "arms the guard BEFORE it tells you whether the gate is open. If the file genuinely cannot reach a " +
      "database, add a file#signal row to EXEMPTIONS in src/server/liveWriteGuardAdoption.test.mjs with the " +
      "reason.\n  " +
      offenders.join("\n  ")
  );

  assert.deepEqual(
    live.sort(),
    [...LIVE_DB_TEST_FILES],
    "the live-DB test files, and only those, reach a database through the armed gate. A new name here is " +
      "a new live file — check it declares only disposable tables; a missing name means a live file " +
      "stopped going through the gate, or the detector stopped seeing it."
  );

  const stale = [...exempt.keys()].filter((k) => !usedExemptions.has(k)).sort();
  assert.deepEqual(
    stale,
    [],
    "These EXEMPTIONS no longer match anything: either the file was renamed or deleted, or it stopped " +
      "tripping the signal. Remove them. A list of exemptions that do not apply is how the next author " +
      "concludes the list is decorative and adds one more."
  );
});

// ---------------------------------------------------------------------------
// 2. COVERS IS ENFORCED, NOT CONVENTIONAL
// ---------------------------------------------------------------------------

/**
 * Run a script in a child where the named bare specifiers CANNOT be imported.
 *
 * WHY A CHILD, AND WHY A LOADER HOOK. The property is "a guard whose dynamic
 * import failed must not read as armed". In THIS process both drivers import
 * fine and the preload already armed the guard, so the state has to be
 * constructed rather than waited for. A resolve hook that throws for `pg` (or
 * `@supabase/supabase-js`) reproduces exactly the failure `ensurePatched`
 * catches — a driver it could not load — without deleting anything from
 * node_modules.
 *
 * NODE_OPTIONS is cleared so the child does not inherit the preload: the
 * preload would arm the guard with both drivers still importable, before the
 * hook is registered.
 */
function runBlindChild(script, { blind = [] } = {}) {
  const hooks =
    `const BLIND = new Set(${JSON.stringify(blind)});` +
    "export async function resolve(spec, ctx, next) {" +
    ' if (BLIND.has(spec)) throw new Error("module " + spec + " is unavailable in this child (planted by liveWriteGuardAdoption.test.mjs)");' +
    " return next(spec, ctx); }";
  const prelude =
    'const { register } = await import("node:module");' +
    `register("data:text/javascript," + encodeURIComponent(${JSON.stringify(hooks)}));`;
  return execFileSync(process.execPath, ["--input-type=module", "-e", prelude + script], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    env: {
      ...process.env,
      // An address nothing listens on: if any of this ever did connect, it
      // fails rather than reaching a database.
      DATABASE_URL: "postgresql://nobody:nobody@127.0.0.1:1/postgres",
      NODE_OPTIONS: "",
    },
  });
}

/** A gate call that never mentions `covers` — the file that forgot the convention. */
const SCRIPT_ARMED_GATE =
  'const { armedLiveDbGate } = await import("./src/server/liveDbGate.js");' +
  'try { const g = await armedLiveDbGate({ label: "child/never-checks-covers",' +
  ' env: { DATABASE_URL: "postgresql://nobody:nobody@127.0.0.1:1/postgres" } });' +
  ' console.log("OPENED covers=" + JSON.stringify(g.guard.covers)); }' +
  'catch (e) { console.log("THREW: " + e.message); }';

test("COVERS IS ENFORCED, NOT CONVENTIONAL — an open gate behind a blind guard is refused, checked or not", () => {
  // The three live files each assert covers.pg and covers.supabase by hand. A
  // file that omits both — this child does — must still be stopped, or the
  // assertion is the only thing standing between armed and theatre.
  const CASES = [
    [["pg"], /the gate is OPEN and the guard is BLIND \(supabase=true, pg=false\)/, "raw SQL would be unguarded"],
    [
      ["@supabase/supabase-js"],
      /the gate is OPEN and the guard is BLIND \(supabase=false, pg=true\)/,
      "every PostgREST write would be unguarded",
    ],
    [
      ["pg", "@supabase/supabase-js"],
      /the gate is OPEN and the guard is BLIND \(supabase=false, pg=false\)/,
      "the guard would be installed and cover nothing at all",
    ],
  ];
  for (const [blind, expected, consequence] of CASES) {
    const out = runBlindChild(SCRIPT_ARMED_GATE, { blind });
    assert.match(
      out,
      expected,
      `with ${blind.join(" and ")} unimportable, ${consequence}, and armedLiveDbGate must refuse to report ` +
        `an open gate. It did not; got: ${out.trim()}`
    );
    assert.doesNotMatch(
      out,
      /OPENED/,
      `armedLiveDbGate opened the gate for a test that never checks covers while ${blind.join(" and ")} ` +
        `was unimportable — armed and blind read the same as armed`
    );
  }

  // The control, or the three cases above would also pass against a child that
  // is simply broken: with nothing blinded, the same script opens the gate and
  // reports both transports patched.
  const ok = runBlindChild(SCRIPT_ARMED_GATE, { blind: [] });
  assert.match(
    ok,
    /OPENED covers=\{"supabase":true,"pg":true\}/,
    `the control child must open the gate with both transports covered, or the blind cases above prove ` +
      `nothing about blindness; got: ${ok.trim()}`
  );
});

test("COVERS IS ENFORCED AT THE OTHER ENTRY POINT TOO — liveDbGate refuses an armed-but-blind process", () => {
  // The file that hand-rolls installLiveWriteGuard instead of using the gate IS
  // armed, and may be armed blind — which is why adoption above is defined as
  // armedLiveDbGate. Even so, the moment it asks liveDbGate about the real
  // environment it is refused, so the two halves agree.
  const script =
    'const { installLiveWriteGuard } = await import("./src/server/liveWriteGuard.js");' +
    'await installLiveWriteGuard({ label: "child/hand-armed", allow: [] });' +
    'const { liveDbGate } = await import("./src/server/liveDbGate.js");' +
    'try { liveDbGate(); console.log("OPENED-BLIND"); } catch (e) { console.log("THREW: " + e.message); }';

  const blind = runBlindChild(script, { blind: ["pg"] });
  assert.match(
    blind,
    /THREW: liveDbGate: a live database is configured and the write guard is armed but BLIND \(supabase=true, pg=false\)/,
    `a hand-armed process whose pg patch failed must not be told the gate is open; got: ${blind.trim()}`
  );
  assert.doesNotMatch(blind, /OPENED-BLIND/);

  // Control: the same script with nothing blinded is allowed through, so the
  // refusal above is about blindness and not about the shape of the child.
  const ok = runBlindChild(script, { blind: [] });
  assert.match(
    ok,
    /OPENED-BLIND/,
    `an armed and SIGHTED process must still be able to open the gate, or this rule would just be ` +
      `breaking live tests; got: ${ok.trim()}`
  );
});

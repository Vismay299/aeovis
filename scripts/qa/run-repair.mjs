#!/usr/bin/env node
/**
 * R21.1a — the repair runner. One entry point for every level the backlog names.
 *
 * WHY THIS EXISTS, AND WHAT IT REFUSES TO DO.
 *
 * The backlog declares 404 acceptance scenarios (`src/server/repairs/caseInventory.mjs`)
 * and none of them was implemented. The failure this runner is built against is
 * not a red test but a green run that proved nothing: a glob that collected no
 * files, a case id with no test behind it, a suite that was skipped and then
 * counted as satisfied. Each of those is a decision this file makes explicitly:
 *
 *   - A run that collects zero tests is a FAILURE. A case id with no discovered
 *     test is reported `unimplemented` — never `passed`.
 *   - `offline` runs U and I only. It refuses to start when a live database
 *     identity or a provider credential is configured in the environment: an
 *     offline suite that can reach production is not offline. Every child it
 *     does dispatch carries the repository's own default-deny write guard
 *     (`--import ./src/server/liveWriteGuardAuto.mjs`) and has the credential
 *     variables deleted, because a test process that inherits them is one
 *     forgotten stub away from a production write.
 *   - A suite the environment is not allowlisted for is refused, and
 *     `--environment qa` is not an exemption from the identity check: the flag
 *     says which suites to run, the check says which database the values name.
 *     `qa` plus a production `NEXT_PUBLIC_SUPABASE_URL` is refused before
 *     anything is dispatched.
 *   - `live` and `soak` need explicit `--max-requests` and `--max-spend-usd`
 *     ceilings; a run with no ceiling is the shape of "fund it and see".
 *   - `release` aggregates required evidence and fails unverified when a
 *     required suite is missing or skipped. Skips are printed and contribute no
 *     passes, so absence of evidence can never read as evidence.
 *
 * WHAT IT DISPATCHES, AND WHAT IT DOES NOT.
 * `offline` is dispatched: the runner runs the collected `src/server/repairs/*.test.mjs`
 * files filtered to the selected case ids by test name, parses the TAP the child
 * emits, and maps each result back to its case id. D/B/L/S are not dispatched
 * here — they need a real database, a browser, a funded provider, or elapsed
 * days, and a dedicated job/manifest each (backlog section B: do not let a
 * naming convention hide them). Those suites are reported `skipped` or `missing`
 * with the reason, which is what makes a release unverified rather than quietly
 * complete. Release may import dedicated-job/reviewer attestations with
 * --evidence: commit, clean source, fixture hash and artifact hashes must match.
 * This validates the packet's integrity, not the truth of an attestation.
 *
 * RE-ENTRANCY. A dispatched file may itself spawn this runner (the R21 harness
 * does). Dispatch therefore carries a case-id name filter — a test that spawns
 * the runner is only run inside a runner-dispatched child when its own name
 * carries a selected case id — and `PERCEEV_REPAIR_RUNNER_DEPTH` turns a genuine
 * cycle into a loud refusal instead of a fork bomb. Nested spawns pass the depth
 * through; this file increments it for its children.
 *
 * Dependency-free on purpose (node: builtins only): a harness that needs a
 * package nobody installed is a harness that stops running.
 */

import { readFile, readdir, stat, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DECLARED_TOTAL,
  EXECUTED_SUITES,
  MANUAL_SUITE,
  REPAIRS,
  SUITES,
  SUITE_LEVELS,
  allCaseIds,
  caseIdsForRepair,
  inventoryFromIds,
  levelForCase,
  repairOf,
  suitesForRepair,
  validateInventory,
} from "../../src/server/repairs/caseInventory.mjs";

import { loadReleaseEvidence, sha256 } from "../../src/server/repairs/releaseEvidence.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");

/** The files the offline suite may dispatch. Anything else needs a manifest. */
const COLLECTED_DIR = "src/server/repairs";
const COLLECTED_GLOB = "src/server/repairs/*.test.mjs";
/** The repository's default-deny write guard, preloaded into every child. */
const GUARD_PRELOAD = "./src/server/liveWriteGuardAuto.mjs";
const DEFAULT_MANIFEST = "tests/fixtures/repairs/manifest.json";
const REPORT_ROOT = "test_reports/repairs";
const CASE_ID = /\bR\d{2}-\d{2}\b/g;
const CASE_ID_IN_NAME = /\bR\d{2}-\d{2}\b/;

/**
 * Which suites each environment may run. `local` is a laptop shell: not a QA
 * database identity, so offline only. An environment absent from this table may
 * run nothing — that is how anything production-shaped fails safe.
 */
const ENVIRONMENT_SUITES = {
  qa: [...SUITES],
  local: ["offline"],
};

/** Suites whose evidence is a real database or a real provider, not a substitute. */
const DB_TOUCHING_SUITES = ["database", "browser", "live", "soak", "release"];
/** Suites that spend money, and so need ceilings before anything is dispatched. */
const CEILING_SUITES = ["live", "soak"];

/** Variables that name a database. Values are never printed; hosts are. */
const DB_IDENTITY_VARS = [
  "DATABASE_URL",
  "NEXT_PUBLIC_SUPABASE_URL",
  "SUPABASE_URL",
  "PRODUCTION_SUPABASE_URL",
  "PRODUCTION_DATABASE_URL",
  "SUPABASE_DB_HOST",
];
/**
 * The variables THIS repository's configuration reads for live access, listed
 * from `.env.example`. Deliberately a list and not a `*_API_KEY` pattern: an
 * unrelated key in a developer shell (a tool's own token, a CI runner's) is not
 * this application's live configuration, and refusing an offline run over it
 * would train everyone to disable the check.
 */
const LIVE_CONFIG_VARS = [
  "DATABASE_URL",
  "SUPABASE_URL",
  "SUPABASE_DB_PASSWORD",
  "SUPABASE_DB_HOST",
  "SUPABASE_SERVICE_ROLE_KEY",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "BRIGHTDATA_API_KEY",
  "FIRECRAWL_API_KEY",
  "GEMINI_API_KEY",
  "LLM_API_KEY",
  "OPENROUTER_API_KEY",
  "OPENAI_API_KEY",
  "PERPLEXITY_API_KEY",
  "GSC_SERVICE_ACCOUNT_KEY",
  "GSC_GOOGLE_CLIENT_SECRET",
  "GSC_TOKEN_ENCRYPTION_KEY",
  "CRON_SECRET",
  "OPERATOR_TOKEN",
  "PROBE_INGEST_TOKEN",
];

/**
 * Credential-shaped names, used only to CLEAR a child environment. Widening the
 * scrub is safe — a variable a child does not need is a variable it cannot
 * spend — which is the opposite of widening the refusal above.
 */
const CREDENTIAL_VAR = /(API_KEY|_KEY|TOKEN|SECRET|PASSWORD|SERVICE_ROLE)/i;
const NOT_A_CREDENTIAL = new Set(["PATH", "PATHEXT", "HOME", "NODE_OPTIONS", "NODE_PATH", "COMMANDCODE_SCRATCHPAD"]);

const USAGE = [
  "usage: node scripts/qa/run-repair.mjs --repair RNN --suite offline|database|browser|live|soak|release",
  "       --environment qa [--case RNN-NN] [--max-requests N] [--max-spend-usd X] [--days N]",
  "       [--output [dir]] [--manifest path] [--inventory path] [--evidence packet.json]",
].join("\n");

/** A refusal the operator is meant to read: it names the exact problem. */
class Refusal extends Error {
  constructor(message) {
    super(message);
    this.name = "Refusal";
  }
}

function refuse(message) {
  throw new Refusal(message);
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

const VALUE_FLAGS = new Map([
  ["--repair", "repair"],
  ["--suite", "suite"],
  ["--environment", "environment"],
  ["--case", "case"],
  ["--max-requests", "maxRequests"],
  ["--max-spend-usd", "maxSpendUsd"],
  ["--days", "days"],
  ["--manifest", "manifest"],
  ["--inventory", "inventory"],
  ["--evidence", "evidence"],
]);

function parseArgs(argv) {
  const opts = { output: null, outputGiven: false, manifest: DEFAULT_MANIFEST, inventory: null };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--output") {
      const next = argv[i + 1];
      const takesValue = next !== undefined && !next.startsWith("--");
      opts.output = takesValue ? next : REPORT_ROOT;
      opts.outputGiven = true;
      if (takesValue) i += 1;
      continue;
    }
    if (token === "--help" || token === "-h") {
      opts.help = true;
      continue;
    }
    const key = VALUE_FLAGS.get(token);
    if (key) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) refuse(`${token} needs a value.\n${USAGE}`);
      opts[key] = value;
      i += 1;
      continue;
    }
    if (token.startsWith("--")) refuse(`unknown option ${token}.\n${USAGE}`);
    refuse(`unexpected argument "${token}"; every input is a flag.\n${USAGE}`);
  }
  return opts;
}

function positiveInt(name, raw) {
  if (raw === null || raw === undefined) return null;
  if (!/^\d+$/.test(String(raw)) || Number(raw) < 1) {
    refuse(`${name} must be a positive whole number, got ${JSON.stringify(String(raw))}`);
  }
  return Number(raw);
}

function positiveMoney(name, raw) {
  if (raw === null || raw === undefined) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    refuse(`${name} must be a positive number of dollars, got ${JSON.stringify(String(raw))}`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Environment identity — the difference between "qa" and "actually QA"
// ---------------------------------------------------------------------------

function hostOf(value) {
  if (!value) return null;
  try {
    return new URL(String(value)).host.toLowerCase();
  } catch {
    return null;
  }
}

function qaHostAllowlist(env) {
  return String(env.PERCEEV_QA_DB_HOSTS || "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

/** A host is a QA identity when it is allowlisted explicitly, local, or says so. */
function isQaIdentity(host, env) {
  if (qaHostAllowlist(env).includes(host)) return true;
  if (host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".local")) return true;
  return /(^|[-.])qa([-.]|$)|(^|[-.])test([-.]|$)/.test(host);
}

/**
 * Every reason the configured database identity cannot be called QA. An empty
 * list means the run may talk to a database. Never returns a credential value.
 */
function inspectDatabaseIdentity(env) {
  const reasons = [];
  if (env.NODE_ENV === "production") {
    reasons.push("NODE_ENV=production: this process declares itself a production process");
  }
  const declaredProduction = DB_IDENTITY_VARS.filter((name) => name.startsWith("PRODUCTION_")).filter((name) => env[name]);
  for (const name of declaredProduction) {
    reasons.push(`${name} is set: a production identity is declared in this environment`);
  }
  const productionHosts = declaredProduction.map((name) => hostOf(env[name])).filter(Boolean);
  for (const name of DB_IDENTITY_VARS) {
    const host = hostOf(env[name]);
    if (!host) continue;
    if (productionHosts.includes(host)) {
      reasons.push(`${name} names the same host as the declared production identity (${host})`);
    } else if (/(^|[-.])prod(uction)?([-.]|$)/.test(host)) {
      reasons.push(`${name} points at a production-looking host (${host})`);
    } else if (!isQaIdentity(host, env)) {
      reasons.push(
        `${name} names ${host}, which is not an allowlisted QA identity (allowlist: PERCEEV_QA_DB_HOSTS, a ` +
          `qa-/test-labelled host, or localhost)`
      );
    }
  }
  return reasons;
}

/** Configuration meaning "this run could reach a provider or a live database". */
function liveConfigurationPresent(env) {
  const names = [];
  for (const name of [...LIVE_CONFIG_VARS, ...DB_IDENTITY_VARS]) {
    if (env[name]) names.push(name);
  }
  for (const name of Object.keys(env)) {
    if (name.startsWith("PRODUCTION_") && env[name]) names.push(name);
  }
  return [...new Set(names)].sort();
}

/**
 * Node's own test-runner protocol variables, cleared for every child.
 *
 * Not hygiene: a measured bug. A child that inherits `NODE_TEST_CONTEXT`
 * believes it IS a test-runner child, reports over the V8-serialization channel
 * instead of stdout, and prints no TAP at all. A dispatched `node --test` then
 * collects zero tests while exiting 0 — the exact "green run that proved
 * nothing" this runner exists to refuse, arriving as a false failure instead.
 * Measured on Node 26: as inherited, a dispatched run produced 0 parsable test
 * lines; with these two cleared, the same command produced its TAP.
 */
const TEST_RUNNER_PROTOCOL_VARS = ["NODE_TEST_CONTEXT", "NODE_TEST_WORKER_ID"];

function scrubChildEnv(env, { depth, cases, offline }) {
  const child = { ...env };
  const cleared = [];
  for (const name of Object.keys(child)) {
    if (NOT_A_CREDENTIAL.has(name)) continue;
    if (
      TEST_RUNNER_PROTOCOL_VARS.includes(name) ||
      DB_IDENTITY_VARS.includes(name) ||
      name.startsWith("PRODUCTION_") ||
      CREDENTIAL_VAR.test(name)
    ) {
      delete child[name];
      cleared.push(name);
    }
  }
  child.NODE_ENV = "test";
  child.PERCEEV_REPAIR_RUNNER_DEPTH = String(depth + 1);
  child.PERCEEV_REPAIR_CASES = cases.join(",");
  if (offline) child.PERCEEV_OFFLINE_ONLY = "1";
  return { child, cleared: cleared.sort() };
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/** The test files the offline glob collects, relative to the repository. */
async function collectedTestFiles() {
  let entries;
  try {
    entries = await readdir(path.join(REPO, COLLECTED_DIR), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".test.mjs"))
    .map((entry) => `${COLLECTED_DIR}/${entry.name}`)
    .sort();
}

/** `test("R05-01 — ...")` — the name forms that count as a real registration. */
const TEST_NAME_LITERAL = /(?:^|[^\w.])(?:test|it|describe)\(\s*["'`]([^"'`]*)["'`]/gm;

/**
 * Case id -> collected files that mention it (`byId`), file -> ids it mentions
 * (`byFile`), and case id -> collected files whose TEST NAMES carry it
 * (`byName`).
 *
 * The two are different questions. Section B says discovery reads names and
 * bodies, so an id mentioned anywhere counts when the runner decides whether a
 * case was implemented. But a mention in a comment or a message string is not a
 * test: `byName` is what the orphan check trusts, because an id that only ever
 * appears in prose is precisely how a required test disappears — the file looks
 * collected, and no test with that id runs.
 */
async function discoverCases(files) {
  const byId = new Map();
  const byName = new Map();
  const byFile = new Map();
  for (const rel of files) {
    const text = await readFile(path.join(REPO, rel), "utf8");
    const ids = new Set([...text.matchAll(CASE_ID)].map((match) => match[0]));
    const named = new Set(
      [...text.matchAll(TEST_NAME_LITERAL)].flatMap((match) => [...match[1].matchAll(CASE_ID)].map((m) => m[0]))
    );
    byFile.set(rel, { mentioned: [...ids].sort(), named: [...named].sort() });
    for (const id of ids) {
      if (!byId.has(id)) byId.set(id, []);
      byId.get(id).push(rel);
    }
    for (const id of named) {
      if (!byName.has(id)) byName.set(id, []);
      byName.get(id).push(rel);
    }
  }
  return { byId, byName, byFile };
}

const SCAN_TEST_NAME = /\.(test|spec)\.(mjs|js|cjs)$/;
const SCAN_MAX_BYTES = 512 * 1024;
const SCAN_MAX_FILES = 500;

/**
 * Case ids declared by test-shaped files outside the collected glob. A required
 * test whose file no glob reaches disappears silently from a green suite, so the
 * runner looks for it: the manifest can turn that into a hard error, and either
 * way the file is named in the summary rather than vanishing.
 *
 * Only test-shaped files are scanned. The fixture manifest also lists case ids
 * in its `used_by` metadata, and an orphan report full of registration metadata
 * is a report nobody reads.
 */
async function scanForOrphans(roots, collected) {
  const found = [];
  let scanned = 0;
  async function walk(abs, rel) {
    if (scanned >= SCAN_MAX_FILES) return;
    let entries;
    try {
      entries = await readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (scanned >= SCAN_MAX_FILES) return;
      const childAbs = path.join(abs, entry.name);
      const childRel = `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        await walk(childAbs, childRel);
        continue;
      }
      if (!SCAN_TEST_NAME.test(entry.name)) continue;
      if (childRel.startsWith(`${COLLECTED_DIR}/`)) continue;
      scanned += 1;
      let info;
      try {
        info = await stat(childAbs);
      } catch {
        continue;
      }
      if (info.size > SCAN_MAX_BYTES) continue;
      let text;
      try {
        text = await readFile(childAbs, "utf8");
      } catch {
        continue;
      }
      for (const id of new Set([...text.matchAll(CASE_ID)].map((match) => match[0]))) {
        if (!collected.byName.has(id)) {
          const note = collected.byId.has(id)
            ? "mentioned in a collected file, but no test there is named for that id"
            : null;
          found.push({ file: childRel, case: id, note });
        }
      }
    }
  }
  for (const root of roots) await walk(path.join(REPO, root), root.replace(/\/+$/, ""));
  return found.sort((a, b) => (a.file === b.file ? a.case.localeCompare(b.case) : a.file.localeCompare(b.file)));
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

const FIXTURE_FIELDS = ["name", "path", "origin", "consent", "usage_status", "surface", "redaction", "state"];

async function readManifest(relPath, collected) {
  let raw;
  try {
    raw = await readFile(path.resolve(REPO, relPath), "utf8");
  } catch (err) {
    refuse(`cannot read the fixture manifest ${relPath}: ${err.code ?? err.message}`);
  }
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (err) {
    refuse(`the fixture manifest ${relPath} is not valid JSON: ${err.message}`);
  }

  const errors = [];
  const fixtures = Array.isArray(manifest.fixtures) ? manifest.fixtures : [];
  if (!fixtures.length) errors.push(`${relPath} registers no fixtures at all`);

  for (const [index, entry] of fixtures.entries()) {
    const where = entry?.path ? entry.path : `fixtures[${index}]`;
    for (const field of FIXTURE_FIELDS) {
      if (!entry || entry[field] === undefined || entry[field] === null || entry[field] === "") {
        errors.push(`${where} is missing the "${field}" the registry requires`);
      }
    }
    if (entry?.state === "absent") {
      if (entry.sha256 !== null && entry.sha256 !== undefined) {
        errors.push(`${where} is marked absent but carries a sha256; an absent fixture has no hash to invent`);
      }
      if (!entry.absence_reason) errors.push(`${where} is marked absent without an absence_reason`);
      continue;
    }
    if (typeof entry?.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256)) {
      errors.push(`${where} is not marked absent, so it needs a 64-character sha256`);
      continue;
    }
    let bytes;
    try {
      bytes = await readFile(path.resolve(REPO, entry.path));
    } catch {
      errors.push(`${where} is registered as present but no such file exists`);
      continue;
    }
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== entry.sha256) {
      errors.push(`${where} has changed since it was registered: sha256 is ${actual}, the registry says ${entry.sha256}`);
    }
  }

  const required = Array.isArray(manifest.required_test_files) ? manifest.required_test_files : [];
  for (const entry of required) {
    const rel = String(entry?.path ?? "");
    if (!rel) {
      errors.push(`${relPath} has a required_test_files entry with no path`);
      continue;
    }
    let exists = true;
    try {
      await stat(path.resolve(REPO, rel));
    } catch {
      exists = false;
    }
    if (!exists) {
      errors.push(`required test file ${rel} is listed in ${relPath} but does not exist on disk`);
      continue;
    }
    if (!rel.startsWith(`${COLLECTED_DIR}/`) || !rel.endsWith(".test.mjs")) {
      errors.push(
        `orphaned required test: ${rel} is outside the collected glob ${COLLECTED_GLOB}, so the runner cannot ` +
          `dispatch it and its cases would vanish from a green suite. Move it into ${COLLECTED_DIR}/ or run it as ` +
          `its own explicit job and stop listing it as required here.`
      );
    }
  }

  const orphans = await scanForOrphans(manifest.orphan_scan_paths ?? [], collected);
  return { errors, orphans, path: relPath, requiredTestFiles: required.map((entry) => entry.path) };
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

async function resolveInventory(relPath) {
  if (!relPath) return { report: validateInventory(), source: "src/server/repairs/caseInventory.mjs" };
  let raw;
  try {
    raw = await readFile(path.resolve(REPO, relPath), "utf8");
  } catch (err) {
    refuse(`cannot read the inventory ${relPath}: ${err.code ?? err.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    refuse(`the inventory ${relPath} is not valid JSON: ${err.message}`);
  }
  const ids = Array.isArray(parsed) ? parsed : parsed?.cases;
  if (!Array.isArray(ids)) refuse(`the inventory ${relPath} must be an array of ids or { "cases": [ ... ] }`);
  return { report: validateInventory(inventoryFromIds(ids)), source: relPath };
}

/** The ids of a repair whose declared level is in `levels`. */
function casesForLevels(repair, levels) {
  return caseIdsForRepair(repair).filter((id) => levels.includes(levelForCase(id)));
}

function resolveSelection(opts, inventoryIds) {
  const suite = opts.suite;
  if (!SUITES.includes(suite)) refuse(`unknown suite "${suite}". Suites: ${SUITES.join(", ")}`);
  if (opts.repair && !REPAIRS.includes(opts.repair)) {
    refuse(`unknown repair id "${opts.repair}". Declared repairs: ${REPAIRS.join(", ")}`);
  }
  if (!opts.repair && !opts.case && suite !== "release") {
    refuse(
      `no selection: pass --repair RNN (or --case RNN-NN) for --suite ${suite}, or --suite release to aggregate. ` +
        `A run that selects nothing can only collect nothing.\n${USAGE}`
    );
  }

  let cases;
  let scope = opts.repair ?? "ALL";
  if (opts.case) {
    const caseRepair = repairOf(opts.case);
    if (!caseRepair || !inventoryIds.includes(opts.case)) refuse(`unknown case id "${opts.case}"`);
    if (!opts.repair) {
      refuse(
        `--case ${opts.case} was given without --repair ${caseRepair}: a single case narrows a repair, it is not a ` +
          `selection on its own`
      );
    }
    if (caseRepair !== opts.repair) {
      refuse(
        `--case ${opts.case} belongs to ${caseRepair}, but the selected repair is ${opts.repair}; a case can only be ` +
          `selected from the repair it was declared in`
      );
    }
    cases = [opts.case];
    scope = caseRepair;
  } else if (opts.repair) {
    cases = caseIdsForRepair(opts.repair);
  } else {
    cases = [...inventoryIds];
  }

  if (suite === "release") return { scope, selected: cases, blockedByLevel: [], suite };

  const allowed = SUITE_LEVELS[suite];
  if (opts.case && !allowed.includes(levelForCase(opts.case))) {
    const level = levelForCase(opts.case);
    const why =
      level === "L"
        ? "that case performs a paid provider call, and a paid call must not be dispatched from an offline run"
        : `its level is ${level}`;
    refuse(
      `${opts.case} is a ${level}-level case and the ${suite} suite executes only ${allowed.join("/")}: ${why}. ` +
        `Refused before dispatch.`
    );
  }
  return {
    scope,
    selected: cases.filter((id) => allowed.includes(levelForCase(id))),
    blockedByLevel: cases.filter((id) => !allowed.includes(levelForCase(id))),
    suite,
  };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The TAP the child emitted, as `{ok, name, skipped, reason, entry}` rows.
 *
 * `entry` marks a file-level row — node names the test FILE when a dispatched
 * file finished, and that row is not a test. Counting it would let a file whose
 * every test was filtered out read as "one test collected", which is exactly the
 * empty run this runner has to catch.
 */
function parseTap(tap) {
  const results = [];
  for (const line of tap.split("\n")) {
    const match = /^(not ok|ok)\s+\d+\s+-\s+(.*)$/.exec(line.trimEnd());
    if (!match) continue;
    let name = match[2];
    let skipped = false;
    let reason = null;
    const skip = /#\s*SKIP\s*(.*)$/.exec(name);
    if (skip) {
      skipped = true;
      reason = skip[1].trim() || "skipped without a reason";
      name = name.slice(0, skip.index);
    }
    const clean = name.trim();
    results.push({
      ok: match[1] === "ok",
      name: clean,
      skipped,
      reason,
      entry: /\.(mjs|js|cjs)$/.test(clean),
    });
  }
  return results;
}

/**
 * Run the collected files filtered to the selected case ids. The name filter is
 * not an optimisation: a test file that itself spawns this runner is only
 * re-entered when its own name carries a selected case id, which is what keeps
 * dispatch from recursing.
 */
function dispatch({ files, caseIds, environment, depth }) {
  const namePattern = caseIds.map(escapeRegExp).join("|");
  const argv = [
    "--import",
    GUARD_PRELOAD,
    "--test",
    "--test-reporter=tap",
    `--test-name-pattern=${namePattern}`,
    ...files,
  ];
  const { child, cleared } = scrubChildEnv(process.env, { depth, cases: caseIds, offline: environment !== "browser" });
  const started = Date.now();
  const run = spawnSync(process.execPath, argv, {
    cwd: REPO,
    env: child,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: Math.max(1, Number(process.env.PERCEEV_REPAIR_CHILD_TIMEOUT_MS) || 120_000),
  });
  return {
    argv,
    command: `node ${argv.join(" ")}`,
    preload: GUARD_PRELOAD,
    files,
    caseIds,
    namePattern,
    clearedEnv: cleared,
    childExitCode: run.status,
    childSignal: run.signal ?? null,
    childError: run.error?.message ?? null,
    durationMs: Date.now() - started,
    tap: run.stdout ?? "",
    stderrLines: (run.stderr ?? "").split("\n").filter(Boolean).slice(0, 40),
    results: parseTap(run.stdout ?? ""),
  };
}

/**
 * The offline suite: which of the selected cases ran, passed, failed, were
 * skipped, or have no test at all. Returns a result; the caller decides what it
 * means for the run's verdict.
 */
function executeOfflineSuite({ cases, files, discovered, environment, depth }) {
  const result = {
    dispatched: false,
    fatal: null,
    messages: [],
    passed: [],
    failed: [],
    skipped: [],
    unimplemented: [],
    unmapped: [],
    testsCollected: 0,
    dispatch: {
      dispatched: false,
      reason: null,
      argv: [],
      command: null,
      preload: GUARD_PRELOAD,
      files: [],
      namePattern: null,
      clearedEnv: [],
      results: [],
      tap: "",
    },
  };
  if (!cases.length) {
    result.fatal = "the selection is empty: nothing to dispatch";
    return result;
  }
  const dispatchFiles = files.filter((rel) => cases.some((id) => discovered.byId.get(id)?.includes(rel)));
  if (!dispatchFiles.length) {
    result.fatal =
      `the run collected 0 tests: ${cases.length} case(s) were selected and none has a collected test, so there is ` +
      `nothing to report as passing. Unimplemented, not passed.`;
    return result;
  }
  if (depth >= 2) {
    result.fatal =
      `nested dispatch refused: this runner was started from inside a runner-dispatched test process ` +
      `(PERCEEV_REPAIR_RUNNER_DEPTH=${depth}). Dispatching again would recurse.`;
    return result;
  }

  const dispatched = dispatch({ files: dispatchFiles, caseIds: cases, environment, depth });
  result.dispatch = { dispatched: true, reason: null, ...dispatched };
  result.dispatched = true;
  const testRows = dispatched.results.filter((row) => !row.entry);
  result.testsCollected = testRows.length;
  result.entryRows = dispatched.results.length - testRows.length;

  const byCase = new Map();
  for (const test of testRows) {
    const id = CASE_ID_IN_NAME.exec(test.name)?.[0] ?? null;
    if (!id) {
      result.unmapped.push(test.name);
      continue;
    }
    if (!byCase.has(id)) byCase.set(id, []);
    byCase.get(id).push(test);
  }

  for (const id of cases) {
    const tests = byCase.get(id) ?? [];
    if (!tests.length) {
      // Discovery is per file and per body, so a file can mention an id without
      // any test being named for it. The TAP is the authority on what ran: an id
      // with no result is unimplemented, never a silent pass.
      result.unimplemented.push(id);
      continue;
    }
    const failing = tests.filter((test) => !test.ok);
    const skips = tests.filter((test) => test.ok && test.skipped);
    if (failing.length) {
      result.failed.push({ case: id, tests: failing.map((test) => test.name) });
      continue;
    }
    if (skips.length) {
      result.skipped.push({ case: id, reason: skips[0].reason, tests: skips.map((test) => test.name) });
      continue;
    }
    result.passed.push(id);
  }
  if (result.unimplemented.length) {
    result.messages.push(
      `unimplemented: ${result.unimplemented.join(", ")} — no test with that case id ran, so these are not passes`
    );
  }
  if (result.unmapped.length) {
    result.messages.push(`tests whose name carries no case id were reported but not attributed: ${result.unmapped.join(", ")}`);
  }
  const entryFailures = dispatched.results.filter((row) => row.entry && !row.ok).map((row) => row.name);
  if (entryFailures.length) {
    result.messages.push(
      `dispatched file(s) failed at the file level, before their tests could be attributed: ${entryFailures.join(", ")}`
    );
  }
  if (dispatched.childExitCode !== 0 || dispatched.childSignal || dispatched.childError || entryFailures.length) {
    result.fatal = dispatched.childError || (dispatched.childSignal
      ? `test subprocess terminated by ${dispatched.childSignal}`
      : `test subprocess failed (exit ${dispatched.childExitCode}); failed files: ${entryFailures.join(", ") || "see TAP"}`);
    result.passed = [];
  }
  return result;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

async function shortSha() {
  const git = spawnSync("git", ["rev-parse", "--short=12", "HEAD"], { cwd: REPO, encoding: "utf8" });
  return git.status === 0 ? git.stdout.trim() : "local";
}

function printableSummary(summary) {
  const lines = [];
  lines.push(
    `${summary.runner} — repair ${summary.repair} suite ${summary.suite} environment ${summary.environment} -> ${summary.verdict}`
  );
  for (const error of summary.errors) lines.push(`  ERROR ${error}`);
  for (const message of summary.messages) lines.push(`  ${message}`);
  lines.push(
    `  cases: ${summary.counts.selected} selected / ${summary.counts.passed} passed / ${summary.counts.failed} failed / ` +
      `${summary.counts.unimplemented} unimplemented / ${summary.counts.blocked} blocked / ${summary.counts.skipped} skipped; ` +
      `${summary.counts.testsCollected} tests collected`
  );
  if (summary.dispatch.command) lines.push(`  dispatched: ${summary.dispatch.command}`);
  else lines.push(`  dispatched: no (${summary.dispatch.reason ?? "nothing to dispatch"})`);
  for (const skip of summary.skips) lines.push(`  SKIP ${skip.repair ? `${skip.repair}/` : ""}${skip.suite}: ${skip.reason}`);
  for (const orphan of summary.orphans) lines.push(`  ORPHAN ${orphan.file} declares ${orphan.case}, which no collected test registers`);
  return lines.join("\n");
}

async function writeReport(summary, outputBase) {
  const sha = await shortSha();
  const dir = path.resolve(REPO, outputBase, sha, summary.repair);
  await mkdir(dir, { recursive: true });
  const stem = `${summary.suite}-${summary.environment}`;
  const jsonPath = path.join(dir, `${stem}.json`);
  await writeFile(jsonPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  await writeFile(path.join(dir, `${stem}.txt`), `${printableSummary(summary)}\n`, "utf8");
  if (summary.dispatch.tap) await writeFile(path.join(dir, `${stem}.tap`), summary.dispatch.tap, "utf8");
  return path.relative(REPO, jsonPath).split(path.sep).join("/");
}

function emitted(summary) {
  const clone = { ...summary, dispatch: { ...summary.dispatch } };
  delete clone.dispatch.tap;
  delete clone.dispatch.results;
  return clone;
}

function emit(summary) {
  process.stdout.write(`${JSON.stringify(emitted(summary), null, 2)}\n`);
  process.stderr.write(`${printableSummary(summary)}\n`);
  process.exitCode = summary.exitCode;
  return summary;
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

function emptyCounts() {
  return { selected: 0, discovered: 0, passed: 0, failed: 0, unimplemented: 0, blocked: 0, skipped: 0, testsCollected: 0 };
}

function baseSummary({ opts, argv, startedAt }) {
  return {
    runner: "scripts/qa/run-repair.mjs",
    command: `node scripts/qa/run-repair.mjs ${argv.join(" ")}`.trim(),
    repair: opts.repair ?? "ALL",
    suite: opts.suite ?? null,
    environment: opts.environment ?? "local",
    startedAt,
    endedAt: null,
    verdict: "invalid",
    exitCode: 2,
    errors: [],
    messages: [],
    counts: emptyCounts(),
    cases: { selected: [], discovered: [], passed: [], failed: [], unimplemented: [], blocked: [], skipped: [] },
    inventory: null,
    manifest: null,
    orphans: [],
    skips: [],
    suites: [],
    ceilings: { maxRequests: null, maxSpendUsd: null, days: null, enforced: false },
    dispatch: {
      dispatched: false,
      reason: "refused before dispatch",
      argv: [],
      command: null,
      preload: GUARD_PRELOAD,
      files: [],
      namePattern: null,
      clearedEnv: [],
    },
  };
}

function tally(summary) {
  summary.cases.passed = [...new Set(summary.cases.passed)];
  summary.cases.unimplemented = [...new Set(summary.cases.unimplemented)];
  summary.counts.passed = summary.cases.passed.length;
  summary.counts.failed = summary.cases.failed.length;
  summary.counts.unimplemented = summary.cases.unimplemented.length;
  summary.counts.blocked = summary.cases.blocked.length;
  summary.counts.skipped = summary.cases.skipped.length;
  summary.counts.discovered = summary.cases.discovered.length;
  summary.counts.selected = summary.cases.selected.length;
}

async function run(argv) {
  const opts = parseArgs(argv);
  const summary = baseSummary({ opts, argv, startedAt: new Date().toISOString() });
  if (opts.help) {
    process.stdout.write(`${USAGE}\n`);
    process.exitCode = 0;
    return null;
  }

  try {
    // 1. The declared inventory, and every registration problem in it.
    const inventory = await resolveInventory(opts.inventory);
    summary.inventory = {
      source: inventory.source,
      total: inventory.report.total,
      unique: inventory.report.unique,
      declaredTotal: DECLARED_TOTAL,
      ok: inventory.report.ok,
      perRepair: inventory.report.perRepair,
      errors: inventory.report.errors,
    };
    if (!inventory.report.ok) {
      summary.errors.push(...inventory.report.errors);
      return summary;
    }
    const inventoryIds = allCaseIds();

    // 2. Selection and environment allowlisting, before anything is spawned.
    const selection = resolveSelection(opts, inventoryIds);
    const environment = opts.environment ?? "local";
    summary.environment = environment;
    const allowedHere = ENVIRONMENT_SUITES[environment];
    if (!allowedHere) {
      refuse(
        `unknown environment "${environment}": no allowlist covers it, so this runner refuses to run anything. ` +
          `Known environments: ${Object.keys(ENVIRONMENT_SUITES).join(", ")}`
      );
    }
    if (!allowedHere.includes(selection.suite)) {
      refuse(
        `environment "${environment}" is not allowlisted for suite "${selection.suite}" (allowlisted here: ` +
          `${allowedHere.join(", ")}). Suite allowlisting is per environment and --suite does not widen it.`
      );
    }
    summary.cases.selected = selection.selected;

    // 3. Ceilings: a spend-capable suite without hard limits is not a plan.
    const maxRequests = positiveInt("--max-requests", opts.maxRequests);
    const maxSpendUsd = positiveMoney("--max-spend-usd", opts.maxSpendUsd);
    const days = positiveInt("--days", opts.days);
    if (CEILING_SUITES.includes(selection.suite)) {
      const missing = [];
      if (maxRequests === null) missing.push("--max-requests N");
      if (maxSpendUsd === null) missing.push("--max-spend-usd X");
      if (selection.suite === "soak" && days === null) missing.push("--days N");
      if (missing.length) {
        refuse(
          `--suite ${selection.suite} requires explicit ceilings before anything is dispatched: ${missing.join(", ")}. ` +
            `A budget is a hard ceiling, not a target; stop when it is exhausted.`
        );
      }
    }
    summary.ceilings = { maxRequests, maxSpendUsd, days, enforced: CEILING_SUITES.includes(selection.suite) };

    // 4. Identity. --environment qa says which suites to run; this says which
    //    database the configured values actually name.
    if (DB_TOUCHING_SUITES.includes(selection.suite)) {
      const identityProblems = inspectDatabaseIdentity(process.env);
      if (identityProblems.length) {
        refuse(
          `refusing to run the ${selection.suite} suite against a database that is not verifiably QA, before any ` +
            `write: ${identityProblems.join("; ")}. --environment qa does not override the identity check; unset the ` +
            `production values or point them at an allowlisted QA instance.`
        );
      }
    }
    if (selection.suite === "offline") {
      const live = liveConfigurationPresent(process.env);
      if (live.length) {
        refuse(
          `the offline suite refuses to start: a live database identity or provider credential is configured in this ` +
            `environment (${live.join(", ")}; names only, never values). An offline run that can reach production is ` +
            `not offline. Unset them for this run.`
        );
      }
    }
    summary.messages.push(
      `identity: ${
        selection.suite === "offline" ? "hermetic (no live database identity or provider credential configured)" : "qa-allowlisted"
      }`
    );

    // 5. Discovery, manifest, and orphan detection.
    const files = await collectedTestFiles();
    const discovered = await discoverCases(files);
    summary.manifest = { path: opts.manifest, requiredTestFiles: [], errors: [] };
    const manifest = await readManifest(opts.manifest, discovered);
    summary.manifest.requiredTestFiles = manifest.requiredTestFiles;
    summary.manifest.errors = manifest.errors;
    summary.orphans = manifest.orphans;
    if (manifest.errors.length) {
      summary.errors.push(...manifest.errors);
      return summary;
    }
    const unknownRegistrations = [...discovered.byId.keys()].filter((id) => !inventoryIds.includes(id));
    if (unknownRegistrations.length) {
      summary.errors.push(`collected tests register case ids the declaration does not contain: ${unknownRegistrations.join(", ")}`);
      return summary;
    }

    summary.cases.discovered = selection.selected.filter((id) => discovered.byId.has(id));
    summary.cases.unimplemented = selection.selected.filter((id) => !discovered.byId.has(id));
    if (summary.cases.unimplemented.length) {
      summary.messages.push(
        `unimplemented: ${summary.cases.unimplemented.join(", ")} — no collected test declares these ids, so they are ` +
          `not reported as passes`
      );
    }
    for (const id of selection.blockedByLevel) {
      summary.cases.blocked.push({
        case: id,
        reason: `level ${levelForCase(id)} is not executed by the ${selection.suite} suite`,
      });
    }
    tally(summary);

    // 6. Release aggregates required evidence; the other suites are either
    //    dispatched or explicitly reported as not run.
    if (opts.evidence && selection.suite !== "release") refuse("--evidence is only accepted by the release suite");
    if (selection.suite === "release") {
      let external = new Map();
      if (opts.evidence) {
        const git = spawnSync("git", ["rev-parse", "HEAD"], { cwd: REPO, encoding: "utf8" });
        const dirty = spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: REPO, encoding: "utf8" });
        if (git.status !== 0 || dirty.status !== 0 || dirty.stdout.trim()) refuse("external evidence requires a clean committed checkout");
        try {
          external = await loadReleaseEvidence(path.resolve(REPO, opts.evidence), {
            commit: git.stdout.trim(), manifestHash: sha256(await readFile(path.resolve(REPO, opts.manifest))),
          });
        } catch (err) { refuse(err.message); }
        summary.evidence = { path: opts.evidence, cases: [...external.keys()] };
      }
      return await runRelease({ summary, selection, discovered, files, environment, external });
    }
    if (selection.suite !== "offline") {
      const levels = SUITE_LEVELS[selection.suite].join("/");
      const reason =
        `the ${selection.suite} suite needs a dedicated job for ${levels} cases; this runner dispatches only the ` +
        `offline U/I glob ${COLLECTED_GLOB}`;
      for (const id of selection.selected) summary.cases.blocked.push({ case: id, reason });
      summary.skips.push({ suite: selection.suite, reason });
      tally(summary);
      summary.verdict = "unverified";
      summary.exitCode = 1;
      summary.messages.push(
        `unverified: the ${selection.suite} suite was not executed. Missing access or a missing job is blocked, never a pass.`
      );
      return summary;
    }

    const depth = Number(process.env.PERCEEV_REPAIR_RUNNER_DEPTH || 0);
    const outcome = executeOfflineSuite({
      cases: selection.selected,
      files,
      discovered,
      environment,
      depth,
    });
    applyOutcome(summary, outcome, selection.suite);
    if (outcome.fatal) {
      summary.errors.push(outcome.fatal);
      summary.verdict = "failed";
      summary.exitCode = 1;
      summary.messages.push(`FAILURE: ${outcome.fatal}`);
      return summary;
    }
    if (summary.counts.testsCollected === 0) {
      const msg = `the dispatch collected 0 tests even though ${outcome.dispatch.files.length} file(s) were named. A run that collects nothing cannot pass.`;
      summary.errors.push(msg);
      summary.verdict = "failed";
      summary.exitCode = 1;
      summary.messages.push(`FAILURE: ${msg}`);
      return summary;
    }
    const problems = summary.counts.failed + summary.counts.unimplemented + summary.counts.skipped;
    if (problems > 0) {
      summary.verdict = "failed";
      summary.exitCode = 1;
      summary.messages.push(
        `failed: ${summary.counts.failed} failed, ${summary.counts.unimplemented} unimplemented, ` +
          `${summary.counts.skipped} skipped — none of those is a pass.`
      );
      return summary;
    }
    summary.verdict = "passed";
    summary.exitCode = 0;
    summary.messages.push(`passed: ${summary.counts.passed} case(s) ran and passed at the ${selection.suite} level`);
    return summary;
  } catch (err) {
    if (err instanceof Refusal) {
      summary.errors.push(err.message);
      summary.verdict = "invalid";
      summary.exitCode = 2;
      summary.dispatch.reason = "refused before dispatch";
      return summary;
    }
    throw err;
  }
}

/** Fold an offline outcome into the run summary. */
function applyOutcome(summary, outcome, suite) {
  summary.dispatch = {
    dispatched: outcome.dispatched,
    reason: outcome.fatal,
    argv: outcome.dispatch.argv,
    command: outcome.dispatch.command,
    preload: GUARD_PRELOAD,
    files: outcome.dispatch.files,
    namePattern: outcome.dispatch.namePattern,
    clearedEnv: outcome.dispatch.clearedEnv,
    childExitCode: outcome.dispatch.childExitCode ?? null,
    durationMs: outcome.dispatch.durationMs ?? 0,
    stderrLines: outcome.dispatch.stderrLines ?? [],
    tap: outcome.dispatch.tap ?? "",
    results: outcome.dispatch.results ?? [],
  };
  summary.counts.testsCollected = outcome.testsCollected;
  summary.messages.push(...outcome.messages);
  summary.cases.unimplemented.push(...outcome.unimplemented);
  for (const entry of outcome.failed) summary.cases.failed.push(entry);
  for (const entry of outcome.skipped) {
    summary.cases.skipped.push(entry);
    summary.skips.push({ suite, case: entry.case, reason: entry.reason });
  }
  summary.cases.passed.push(...outcome.passed);
  tally(summary);
}

async function runRelease({ summary, selection, discovered, files, environment, external = new Map() }) {
  const repairs = selection.scope === "ALL" ? REPAIRS : [selection.scope];
  const depth = Number(process.env.PERCEEV_REPAIR_RUNNER_DEPTH || 0);
  const suites = [];
  const skips = [];
  summary.cases.selected = [];
  summary.cases.discovered = [];
  summary.cases.unimplemented = [];
  summary.cases.passed = [];
  summary.cases.failed = [];
  summary.cases.skipped = [];
  summary.cases.blocked = [];

  for (const repair of repairs) {
    for (const suite of suitesForRepair(repair)) {
      const entry = { repair, suite, status: null, reason: null, cases: 0, casesPassed: 0 };
      if (suite !== "offline" && external.size) {
        const ids = casesForLevels(repair, suite === MANUAL_SUITE ? ["M"] : SUITE_LEVELS[suite]);
        entry.cases = ids.length;
        summary.cases.selected.push(...ids);
        for (const id of ids) {
          const row = external.get(id);
          if (row?.outcome === "pass") { summary.cases.passed.push(id); entry.casesPassed++; }
          else if (row?.outcome === "fail") summary.cases.failed.push({ case: id, reason: row.actual });
          else if (row?.outcome === "skipped") summary.cases.skipped.push({ case: id, reason: row.actual });
          else summary.cases.blocked.push({ case: id, reason: row?.actual || "no current external evidence" });
        }
        entry.status = entry.casesPassed === ids.length ? "passed" : "incomplete";
        entry.reason = entry.status === "passed" ? null : `${ids.length - entry.casesPassed} required cases lack passing evidence`;
        if (entry.reason) skips.push({ repair, suite, reason: entry.reason });
        suites.push(entry);
        continue;
      }
      if (suite === MANUAL_SUITE) {
        summary.cases.selected.push(...casesForLevels(repair, ["M"]));
        entry.cases = casesForLevels(repair, ["M"]).length;
        entry.status = "missing";
        entry.reason =
          "M cases need a documented human review with a rubric, reviewer, evidence, and a signed outcome; no " +
          "dispatcher can produce one";
        suites.push(entry);
        skips.push({ repair, suite, reason: entry.reason });
        for (const id of casesForLevels(repair, ["M"])) summary.cases.blocked.push({ case: id, reason: entry.reason });
        continue;
      }

      const cases = casesForLevels(repair, SUITE_LEVELS[suite]);
      entry.cases = cases.length;
      summary.cases.selected.push(...cases);

      if (suite === "offline") {
        const outcome = executeOfflineSuite({ cases, files, discovered, environment, depth });
        const missingIds = [
          ...new Set([...cases.filter((id) => !discovered.byId.has(id)), ...outcome.unimplemented]),
        ];
        entry.casesUnimplemented = missingIds.length;
        entry.status = outcome.fatal
          ? "missing"
          : outcome.failed.length || outcome.skipped.length || entry.casesUnimplemented > 0
            ? "incomplete"
            : "passed";
        entry.casesPassed = entry.status === "passed" ? outcome.passed.length : 0;
        entry.reason = outcome.fatal
          ? outcome.fatal
          : entry.status === "passed"
            ? null
            : `${entry.casesUnimplemented} of ${cases.length} ${repair} U/I case(s) have no test with that case id; ` +
              `${outcome.failed.length} failed, ${outcome.skipped.length} skipped`;
        if (entry.status === "passed") {
          summary.cases.passed.push(...outcome.passed);
        }
        for (const failedEntry of outcome.failed) summary.cases.failed.push(failedEntry);
        for (const skippedEntry of outcome.skipped) summary.cases.skipped.push(skippedEntry);
        summary.cases.unimplemented.push(...cases.filter((id) => !discovered.byId.has(id)));
        summary.cases.unimplemented.push(...outcome.unimplemented);
        summary.counts.testsCollected += outcome.testsCollected;
        if (outcome.dispatched) {
          summary.dispatch = {
            dispatched: true,
            reason: null,
            argv: outcome.dispatch.argv,
            command: outcome.dispatch.command,
            preload: GUARD_PRELOAD,
            files: outcome.dispatch.files,
            namePattern: outcome.dispatch.namePattern,
            clearedEnv: outcome.dispatch.clearedEnv,
            childExitCode: outcome.dispatch.childExitCode ?? null,
            durationMs: outcome.dispatch.durationMs ?? 0,
            stderrLines: outcome.dispatch.stderrLines ?? [],
            tap: outcome.dispatch.tap ?? "",
            results: outcome.dispatch.results ?? [],
          };
        }
        if (entry.status !== "passed") skips.push({ repair, suite, reason: entry.reason });
        suites.push(entry);
        continue;
      }

      const declared = cases.filter((id) => discovered.byName.has(id));
      entry.status = declared.length ? "skipped" : "missing";
      entry.reason = declared.length
        ? `the ${suite} suite needs a dedicated job for ${SUITE_LEVELS[suite].join("/")} cases, which this runner does ` +
          `not dispatch; ${declared.length} case(s) are declared but no evidence was produced`
        : `no collected test in ${COLLECTED_GLOB} declares a ${SUITE_LEVELS[suite].join("/")} case for ${repair}`;
      skips.push({ repair, suite, reason: entry.reason });
      suites.push(entry);
      for (const id of cases) summary.cases.blocked.push({ case: id, reason: entry.reason });
    }
  }

  for (const entry of summary.cases.skipped) {
    skips.push({ repair: repairOf(entry.case), suite: "offline", case: entry.case, reason: entry.reason });
  }
  summary.suites = suites;
  summary.skips = skips;
  tally(summary);

  const unverified = suites.filter((entry) => entry.status !== "passed");
  if (unverified.length) {
    summary.verdict = "unverified";
    summary.exitCode = 1;
    summary.messages.push(
      `release unverified: ${unverified.length} of ${suites.length} required suite(s) produced no verified evidence ` +
        `(${unverified.map((entry) => `${entry.repair}/${entry.suite}=${entry.status}`).join(", ")}). A skipped or ` +
        `missing suite is not a pass.`
    );
    return summary;
  }
  summary.verdict = "passed";
  summary.exitCode = 0;
  summary.messages.push(`release verified: all ${suites.length} required suite(s) produced evidence`);
  return summary;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

let optsForReport = null;
let failure = null;
let summary = null;
try {
  const argv = process.argv.slice(2);
  optsForReport = parseArgs(argv);
  if (!optsForReport.help) summary = await run(argv);
} catch (err) {
  failure = err;
}

if (failure) {
  const refused = failure instanceof Refusal;
  summary = {
    ...baseSummary({ opts: optsForReport ?? {}, argv: process.argv.slice(2), startedAt: new Date().toISOString() }),
    verdict: refused ? "invalid" : "error",
    exitCode: refused ? 2 : 3,
    errors: [refused ? failure.message : `${failure.name}: ${failure.message}`],
  };
  summary.endedAt = new Date().toISOString();
  emit(summary);
  if (!refused) throw failure;
} else if (summary) {
  summary.endedAt = new Date().toISOString();
  if (optsForReport?.outputGiven) {
    try {
      summary.reportPath = await writeReport(summary, optsForReport.output);
    } catch (err) {
      summary.errors.push(`could not write the report: ${err.message}`);
      if (summary.exitCode === 0) {
        summary.verdict = "failed";
        summary.exitCode = 1;
      }
    }
  }
  emit(summary);
}

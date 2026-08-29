import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildHealthPayload, vendorFlags, VENDORS } from "./health.js";

const execFileAsync = promisify(execFile);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = path.join(REPO, "scripts/check-secrets.mjs");

/**
 * check:secrets contract tests (R0.1.6).
 *
 * Every case below runs with a SCRUBBED environment, so no vendor credential
 * is ever present and the script makes NO network call. That keeps the suite
 * hermetic and free, and it means these tests exercise the two things that do
 * not need credentials: the three-verdict vocabulary, and the exit code.
 *
 * What they cannot cover — whether a REAL key produces PASS, and whether each
 * vendor endpoint is the right one — is why R0.1.6 is blocked rather than
 * closed. See its ledger note.
 */
function run(extraEnv = {}) {
  // A deliberately minimal env: PATH for node, nothing else that could be
  // mistaken for a credential.
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, ...extraEnv };
  return execFileAsync(process.execPath, [SCRIPT], { env, cwd: REPO, timeout: 60000 }).then(
    (r) => ({ code: 0, ...r }),
    (e) => ({ code: e.code ?? 1, stdout: e.stdout || "", stderr: e.stderr || "" })
  );
}

test("check:secrets - prints one verdict line per vendor", async () => {
  const { stdout } = await run();
  const verdictLines = stdout.split("\n").filter((l) => /^\[.{6}\]/.test(l));
  assert.ok(verdictLines.length >= 8, `expected a line per vendor, got:\n${stdout}`);
  for (const line of verdictLines) {
    assert.match(
      line,
      /\b(PASS|FAIL|UNCONFIGURED)\b/,
      `every line must carry exactly one of the three verdicts: ${line}`
    );
  }
  for (const vendor of ["supabase", "brightdata", "llm", "firecrawl", "perplexity", "gsc"]) {
    assert.match(stdout, new RegExp(`\\b${vendor}\\b`), `${vendor} must be reported`);
  }
});

test("check:secrets - UNCONFIGURED is not a failure: exit 0 with no credentials at all", async () => {
  // A deploy gate must not go red because an optional vendor is unset. It
  // must also not go GREEN silently — hence the "required" note below.
  const { code, stdout } = await run();
  assert.equal(code, 0, stdout);
  assert.match(stdout, /UNCONFIGURED/);
  assert.doesNotMatch(stdout, /\bPASS\b/, "nothing can pass with no credentials");
});

test("check:secrets - names which unconfigured vendors are REQUIRED for a scan", async () => {
  const { stdout } = await run();
  assert.match(stdout, /required for a scan to run/);
  assert.match(stdout, /supabase.*brightdata.*llm.*cron|cron/s);
});

test("check:secrets - a CONFIGURED vendor that fails exits non-zero", async () => {
  // CRON_SECRET is checked entirely offline (it guards our own routes), so
  // this proves the exit-code contract without touching the network.
  const { code, stdout } = await run({ CRON_SECRET: "tooshort" });
  assert.equal(code, 1, stdout);
  assert.match(stdout, /\[ FAIL \] cron/);
  assert.match(stdout, /use a long random string/);
});

test("check:secrets - a well-formed offline credential passes", async () => {
  const { code, stdout } = await run({ CRON_SECRET: "a".repeat(40) });
  assert.equal(code, 0, stdout);
  assert.match(stdout, /\[   ok   \] cron|\[  ok  \] cron/);
});

test("check:secrets - a malformed GSC service account is FAIL, not a skip", async () => {
  const { code, stdout } = await run({ GSC_SERVICE_ACCOUNT_KEY: "definitely not json" });
  assert.equal(code, 1, stdout);
  assert.match(stdout, /\[ FAIL \] gsc/);
});

// ---------------------------------------------------------------------------
// R0.1.9 — the stale-SERPAPI_KEY deployment, and the "check-secrets and
// /api/health AGREE" half of the accept criterion.
//
// These are BEHAVIOURAL, not textual: they run the real scripts/check-secrets.mjs
// and compare its parsed output against the real health payload. Both sides see
// the same environment. No stub stands in for either.
//
// It stays hermetic because SERPAPI_KEY satisfies no vendor's `keys`, so every
// vendor short-circuits to UNCONFIGURED and no `check()` — hence no fetch —
// runs. That is precisely the property under test: if check-secrets ever
// accepted SERPAPI_KEY for brightdata, the vendor would go CONFIGURED, attempt
// a live call with no Bright Data credential, and these tests would fail on
// both the verdict and the exit code.
//
// Note the child is spawned as `node scripts/check-secrets.mjs`, not via
// `npm run check:secrets`, so the `--env-file-if-exists=.env.local` flag is not
// applied and a developer's local .env.local cannot leak a real credential in.
// ---------------------------------------------------------------------------

const STALE = { SERPAPI_KEY: "stale-serpapi-key" };

/** Parse the verdict table into structured rows, so we assert on data not prose. */
function parseVerdicts(stdout) {
  const rows = {};
  for (const line of stdout.split("\n")) {
    const m = line.match(/^\[.{6}\]\s+(\S+)\s+(PASS|FAIL|UNCONFIGURED)\s+(required|optional)\s*(.*)$/);
    if (m) rows[m[1]] = { verdict: m[2], required: m[3] === "required", detail: m[4].trim() };
  }
  return rows;
}

test("check:secrets - only SERPAPI_KEY set: the SERP vendor is UNCONFIGURED, naming BRIGHTDATA_API_KEY", async () => {
  const { code, stdout } = await run(STALE);
  const rows = parseVerdicts(stdout);
  assert.ok(rows.brightdata, `no brightdata row in:\n${stdout}`);
  assert.equal(rows.brightdata.verdict, "UNCONFIGURED", "a superseded key is not a SERP credential");
  assert.match(rows.brightdata.detail, /missing BRIGHTDATA_API_KEY/);
  assert.equal(rows.brightdata.required, true, "SERP is required for a scan to run");
  // Exit 0 because UNCONFIGURED is not a failure — but the stale key must not
  // have provoked a live call either, which a FAIL row would betray.
  assert.equal(code, 0, stdout);
  assert.doesNotMatch(stdout, /\bPASS\b|\bFAIL\b/, "a stale key must not produce a pass or a live-call failure");
  assert.doesNotMatch(stdout, /SERPAPI/i, "check:secrets must not report on a superseded provider at all");
});

test("check:secrets - SERPAPI_KEY changes nothing: byte-identical report with and without it", async () => {
  // The no-op form of "it is not a credential here", across every vendor.
  const [stale, bare] = await Promise.all([run(STALE), run()]);
  assert.equal(stale.code, bare.code);
  assert.equal(stale.stdout, bare.stdout);
});

test("check:secrets and /api/health AGREE on a deployment holding only SERPAPI_KEY", async () => {
  // The accept criterion's "agree" half, asserted rather than assumed: same
  // env into both surfaces, then compare vendor-for-vendor.
  const { stdout } = await run(STALE);
  const rows = parseVerdicts(stdout);
  const flags = vendorFlags(STALE);

  assert.deepEqual(
    Object.keys(rows).sort(),
    Object.keys(flags).sort(),
    "the two vendor tables have drifted apart — one surface knows about a vendor the other does not"
  );

  for (const [name, row] of Object.entries(rows)) {
    assert.equal(
      row.verdict === "UNCONFIGURED",
      flags[name].configured === false,
      `${name}: check:secrets says ${row.verdict} but /api/health says configured=${flags[name].configured}`
    );
    assert.equal(row.required, flags[name].required, `${name}: the two disagree on required-ness`);
  }

  // And the specific claim R0.1.9 is about, from both sides at once.
  assert.equal(rows.brightdata.verdict, "UNCONFIGURED");
  const payload = buildHealthPayload({ db: { ok: true }, env: STALE, ticks: [], now: "2026-08-29T12:00:00.000Z" });
  assert.equal(payload.vendors.brightdata.configured, false);
  assert.ok(payload.missing_required.includes("brightdata"));
  assert.notEqual(payload.status, "ok");
});

test("check:secrets and /api/health agree on every REQUIRED vendor name", async () => {
  // Cheap drift guard with a fixed expectation, so that deleting a vendor from
  // BOTH tables at once still has to be a deliberate edit to this line.
  const { stdout } = await run(STALE);
  const rows = parseVerdicts(stdout);
  const requiredFromScript = Object.entries(rows).filter(([, r]) => r.required).map(([n]) => n).sort();
  const requiredFromHealth = VENDORS.filter((v) => v.required).map((v) => v.key).sort();
  assert.deepEqual(requiredFromScript, requiredFromHealth);
  assert.deepEqual(requiredFromScript, ["brightdata", "cron", "llm", "supabase"]);
});

test("check:secrets - the GSC pass line SAYS it was an offline shape check only", async () => {
  // The script must never imply it verified something it did not.
  const account = JSON.stringify({
    type: "service_account",
    client_email: "svc@example.iam.gserviceaccount.com",
    private_key: "-----BEGIN PRIVATE KEY-----",
  });
  const { stdout } = await run({ GSC_SERVICE_ACCOUNT_KEY: Buffer.from(account).toString("base64") });
  assert.match(stdout, /NOT verified against the API \(offline check only\)/);
});

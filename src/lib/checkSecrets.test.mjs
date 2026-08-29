import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

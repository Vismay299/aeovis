import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * R6.1.4 (finding S17) — the secrets rule must live in the agent definitions,
 * not in whatever the controller remembers to type into a prompt.
 *
 * Two agents working R0.1.6 pasted live credentials into their transcripts by
 * running an unscoped recursive search that matched `.env.local`. Both
 * disclosed it themselves; the second one happened after the first was already
 * reported. A rule that depends on a human retyping it is a rule that will be
 * skipped, so it now ships inside every `.claude/agents/rebuild-*.md` and this
 * guard fails when a definition stops carrying it — including a brand new
 * definition added later, because the set of files is read off disk rather than
 * hardcoded.
 *
 * Honest about its limits: this asserts the rule is IN the brief. It cannot
 * assert an agent obeyed it, and it cannot see a transcript. The behavioural
 * half of the acceptance criterion is not covered by any test here.
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const AGENTS_DIR = path.join(REPO, ".claude/agents");

import { assertCorpusIntact } from "./testCorpus.mjs";

/**
 * Every phrase the rule must contain, matched against the file with all runs of
 * whitespace collapsed, so re-wrapping a paragraph does not break the guard but
 * deleting the substance does.
 */
const REQUIRED_PHRASES = [
  // The section itself.
  "## Secrets hygiene",
  // Never print a credential value.
  "**Never print a credential value.**",
  "A prefix is still a leak.",
  // The concrete exclusion idiom, in each tool's own spelling.
  "--exclude='.env*'",
  "--glob '!.env*'",
  'glob: "!.env*"',
  // The asymmetry: the example file is safe, and saying so is what keeps the
  // rest of the rule credible.
  "`.env.example` is safe",
  // What to do when it happens anyway — the norm both real leaks followed.
  "stop, do not repeat it, disclose it",
];

test("GUARD TEETH — assertCorpusIntact enforces length floor, uniqueness, and required targets", () => {
  assert.throws(
    () => assertCorpusIntact([], "TEST_CORPUS", { floor: 1, isTuple: false }),
    /under its floor of 1/
  );
  assert.throws(
    () => assertCorpusIntact(["a", "a"], "TEST_CORPUS", { floor: 1, isTuple: false }),
    /repeats/
  );
  assert.throws(
    () => assertCorpusIntact(["a"], "TEST_CORPUS", { floor: 1, required: ["b"], isTuple: false }),
    /no longer contains/
  );
  assert.throws(
    () => assertCorpusIntact([123], "TEST_CORPUS", { floor: 1, isTuple: false }),
    /is not a string/
  );
});

test("GUARD — REQUIRED_PHRASES corpus is intact", () => {
  assertCorpusIntact(REQUIRED_PHRASES, "REQUIRED_PHRASES", {
    floor: 8,
    required: [
      "## Secrets hygiene",
      "**Never print a credential value.**",
      "A prefix is still a leak.",
      "`.env.example` is safe",
      "stop, do not repeat it, disclose it",
    ],
    isTuple: false,
  });
});

/** `.claude/agents/rebuild-*.md`, discovered on disk, never hardcoded. */
async function rebuildAgentDefinitions() {
  const entries = await readdir(AGENTS_DIR, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.startsWith("rebuild-") && e.name.endsWith(".md"))
    .map((e) => e.name)
    .sort();
}

const collapse = (s) => s.replace(/\s+/g, " ");

test("GUARD — every rebuild-* agent definition carries the secrets-hygiene rule", async () => {
  const files = await rebuildAgentDefinitions();

  // A guard that finds nothing must fail, not pass quietly: an empty sweep is
  // not a clean one.
  assert.ok(
    files.length >= 6,
    `expected the six known rebuild-* definitions in ${AGENTS_DIR}, found ${files.length}: ${files.join(", ")}`,
  );

  const missing = [];
  for (const file of files) {
    const text = collapse(await readFile(path.join(AGENTS_DIR, file), "utf8"));
    for (const phrase of REQUIRED_PHRASES) {
      if (!text.includes(collapse(phrase))) missing.push(`${file} is missing: ${phrase}`);
    }
  }

  assert.deepEqual(
    missing,
    [],
    `every rebuild-* agent must carry the secrets rule by construction, not by prompt:\n  ${missing.join("\n  ")}`,
  );
});

test("GUARD — .env.local and .env are git-ignored, .env.example is tracked", () => {
  const ignored = (file) => {
    // `git check-ignore` exits 1 when the path is NOT ignored, which execFileSync
    // throws on; anything else (git absent, repo absent) must surface, not pass.
    try {
      execFileSync("git", ["check-ignore", "-q", "--no-index", file], { cwd: REPO });
      return true;
    } catch (err) {
      if (err.status === 1) return false;
      throw err;
    }
  };

  assert.equal(ignored(".env.local"), true, ".env.local must be git-ignored");
  assert.equal(ignored(".env"), true, ".env must be git-ignored");
  assert.equal(
    ignored(".env.example"),
    false,
    ".env.example holds placeholder names only and must stay tracked — tasks edit it",
  );
});

/**
 * A partial guard, and it says so: it cannot see a transcript, which is where
 * both real leaks happened. It catches the other half — a key that reached a
 * tracked file. It searches tracked paths only, so an untracked `.env.local` is
 * never read by this suite either.
 */
test("GUARD — no tracked file contains private-key material", async () => {
  // Assembled at runtime so this guard's own source is not itself a match.
  const HEADER = "-----BEGIN";
  const needles = [
    `${HEADER} PRIVATE KEY-----`,
    `${HEADER} RSA PRIVATE KEY-----`,
    `${HEADER} EC PRIVATE KEY-----`,
    `${HEADER} OPENSSH PRIVATE KEY-----`,
  ];

  const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: REPO, maxBuffer: 32 * 1024 * 1024 })
    .toString("utf8")
    .split("\0")
    .filter(Boolean);

  assert.ok(tracked.length > 100, `expected a populated tree, git ls-files returned ${tracked.length}`);

  // `git grep` restricted to tracked files. `-l` prints paths and never the
  // matched line — printing the match is the leak this whole task is about.
  const args = ["grep", "-l", "-F", "-I"];
  for (const n of needles) args.push("-e", n);
  let candidates = [];
  try {
    candidates = execFileSync("git", args, { cwd: REPO, maxBuffer: 8 * 1024 * 1024 })
      .toString("utf8")
      .split("\n")
      .filter(Boolean);
  } catch (err) {
    // exit 1 means "no match", which is the passing case. Anything else is a
    // broken guard and must not read as clean.
    if (err.status !== 1) throw err;
  }

  // A bare header with nothing after it is not a credential — `checkSecrets`
  // uses exactly that as a deliberately-unusable fixture. What makes a file an
  // offender is key MATERIAL: a long base64 run following the header. That
  // distinction is the guard, not an allowlist, so pasting a real key into the
  // fixture file would still fail here.
  const material = new RegExp(`${HEADER} [A-Z ]*PRIVATE KEY-----[\\s\\\\n"']{0,8}[A-Za-z0-9+/]{40}`);

  const offenders = [];
  for (const file of candidates) {
    const text = await readFile(path.join(REPO, file), "utf8");
    if (material.test(text)) offenders.push(file);
  }

  assert.deepEqual(
    offenders,
    [],
    `private key material is committed to this repo; rotate it first, then remove it: ${offenders.join(", ")}`,
  );
});

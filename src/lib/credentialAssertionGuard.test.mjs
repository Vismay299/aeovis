import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * R6.5.9 — the assertion that exists to prove a credential was cleared is the
 * thing that would disclose it.
 *
 * `src/lib/engines/serp.test.mjs` asserted a scrubbed key with
 * `assert.equal(process.env.BRIGHTDATA_API_KEY, undefined, "<custom message>")`.
 * node:test dumps `actual` into the reporter on failure EVEN WHEN a custom
 * message is supplied — twice, once in the `+ actual - expected` diff and once
 * in the AssertionError's own `actual:` field. Measured here with a sentinel,
 * never a real value:
 *
 *     AssertionError: an ambient Bright Data key must be scrubbed
 *     + actual - expected
 *     + '<the whole value>'
 *     - undefined
 *       ...
 *       actual: '<the whole value>',
 *
 * So on any machine where the var is genuinely set — the normal state on a
 * developer box and in CI — a regression in the scrub prints the live key into
 * the CI log at the exact moment the safety net tore. Same run, with
 * `assert.ok(process.env.X === undefined, msg)`, printed `actual: false`: the
 * comparison collapses the value to a boolean before the assertion can see it,
 * so there is nothing left to dump. That is the fix pattern, and it matches the
 * shape-only `describeEnv` convention R6.5.5 established in the serp suite.
 *
 * This guard walks the test tree rather than calling a function, because the
 * defect is a source form, not a runtime state: an `assert.equal` on a
 * credential var is a latent disclosure that only fires on the day something
 * else breaks, which is precisely the day nobody is reading carefully.
 *
 * Honest about its limits. It reasons about the *first* argument only, which is
 * where node:test sources `actual`; a credential passed as the second argument
 * is printed as `expected` and is not caught here (in practice the expected side
 * is a literal like `undefined` or `'mock-key'`). It does not follow a value
 * through a local variable — `const k = process.env.X; assert.equal(k, ...)`
 * leaks identically and reads clean to this guard. And it cannot see an
 * assertion inside a helper in a non-test file.
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TEST_ROOT = path.join(REPO, "src");

/**
 * The assertion methods that print `actual` on failure. The `not*` half is
 * included even though the finding was about `equal`: `assert.notEqual` renders
 * "Expected "actual" to be strictly unequal to:" followed by the value, which
 * leaks the same way. The tree is currently clean of those on credential vars,
 * so including them costs nothing and closes the obvious workaround.
 */
const LEAKY_ASSERTIONS = [
  "equal",
  "strictEqual",
  "deepEqual",
  "deepStrictEqual",
  "notEqual",
  "notStrictEqual",
  "notDeepEqual",
  "notDeepStrictEqual",
];

const CALL_RE = new RegExp(
  String.raw`\bassert(?:\.strict)?\s*\.\s*(${LEAKY_ASSERTIONS.join("|")})\s*\(`,
  "g",
);

/** `process.env.FOO` and `process.env["FOO"]`, capturing the var name. */
const ENV_READ_RE =
  /process\s*\.\s*env\s*(?:\.\s*([A-Za-z_][A-Za-z0-9_]*)|\[\s*["'`]([A-Za-z_][A-Za-z0-9_]*)["'`]\s*\])/g;

/**
 * A name is credential-like when one of its underscore-delimited segments is a
 * secrecy word. Segment matching, not substring: it must catch
 * SUPABASE_SERVICE_ROLE_KEY and CRON_SECRET while leaving NEXTAUTH_URL,
 * MONKEY_PATCH and SCAN_RATE_LIMIT alone.
 */
const SECRET_SEGMENT = /(?:^|_)(KEY|KEYS|SECRET|SECRETS|TOKEN|TOKENS|PASSWORD|PASSWD|PWD|CREDENTIAL|CREDENTIALS|APIKEY|AUTH|DSN|SALT|SIGNATURE)(?:_|$)/;

/**
 * Names with no secrecy word in them that are still credentials, because they
 * embed one. Drawn from `.env.example` (placeholder names, no values) and the
 * deploy config. Add to this list rather than loosening SECRET_SEGMENT — a
 * looser regex sweeps in innocent names and gets allowlisted back out one by
 * one, which is how a guard dies.
 */
const EXTRA_CREDENTIAL_VARS = new Set([
  "DATABASE_URL", // postgres://user:password@host — the password is in the value
  "REDIS_URL",
  "SUPABASE_DB_HOST", // paired with SUPABASE_DB_PASSWORD in connection strings
  "LLM_BASE_URL", // gateway URLs in this repo have carried inline auth
]);

function isCredentialVar(name) {
  return SECRET_SEGMENT.test(name) || EXTRA_CREDENTIAL_VARS.has(name);
}

/**
 * ALLOWLIST — assertions that read a credential var into `actual` and are
 * nonetheless permitted, as `"<relative path>:<line>"`.
 *
 * Empty, deliberately. The fix pattern costs one word (`assert.ok`, `===`), so
 * there is no assertion this rule is expensive enough to be worth excusing. If
 * you add an entry, write the reason on its own line beside it and say why the
 * value cannot reach the reporter — "the test is skipped in CI" is not a
 * reason, because a guard that trusts where it runs is not a guard.
 */
const ALLOWLIST = new Set([]);

/**
 * Replace the interior of every comment, string and template literal with
 * spaces, preserving length and newlines so offsets and line numbers still
 * point at the original file.
 *
 * This is what stops the guard matching its own documentation and its own
 * fixture table below — the same self-match problem `agentSecretsGuard.test.mjs`
 * solves by assembling its needles at runtime. Blanking is the better answer
 * here because it is also correct: an `assert.equal` inside a commented-out
 * block or inside a string is not an assertion and must not be reported as a
 * live disclosure.
 *
 * Deliberate simplification: a template literal is blanked whole, including
 * `${...}` interpolations. An assertion written inside an interpolation would
 * therefore be missed. That is a false negative in code nobody writes, and the
 * alternative is a nested-state parser that the next maintainer cannot check by
 * eye.
 */
function blankNonCode(src) {
  const out = src.split("");
  const blank = (from, to) => {
    for (let i = from; i < to && i < out.length; i++) {
      if (out[i] !== "\n") out[i] = " ";
    }
  };

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    // An escape in code position (inside a regex literal, typically). Skipping
    // the next character keeps `/https:\/\//` from reading as a line comment.
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      const end = src.indexOf("\n", i);
      blank(i, end === -1 ? src.length : end);
      i = end === -1 ? src.length : end;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? src.length : end + 2;
      blank(i, stop);
      i = stop - 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) {
        if (src[j] === "\\") j++;
        j++;
      }
      // Blank the body but leave the quotes, so `assert.ok("" === x)` still
      // parses as balanced code.
      blank(i + 1, j);
      i = j;
      continue;
    }
  }
  return out.join("");
}

/**
 * Extract the source text of the first argument of a call whose opening paren
 * sits at `openIdx`, in already-blanked source. Tracks bracket depth only —
 * every comma that could confuse it now lives inside a blanked string. Returns
 * null on an unbalanced call, which the caller reports as unparseable rather
 * than treating as clean.
 */
function firstArgument(src, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (c === "(" || c === "[" || c === "{") {
      depth++;
      continue;
    }
    if (c === ")" || c === "]" || c === "}") {
      depth--;
      // depth 0 here is the call's own closing paren: a single-argument call.
      if (depth === 0) return src.slice(openIdx + 1, i);
      continue;
    }
    if (c === "," && depth === 1) return src.slice(openIdx + 1, i);
  }
  return null;
}

/**
 * Every credential-var offence in one file's source.
 *
 * Two views of the same bytes, and the split matters. Call sites and argument
 * boundaries are found in the BLANKED source, so an assertion inside a comment
 * or a string is not reported. The env read is then matched against the RAW
 * slice at those same offsets, because `process.env["FOO"]` puts the var name
 * inside a string literal — scanning the blanked argument would let bracket
 * access walk straight past the guard, which is exactly what the fixture table
 * caught when this was written the other way.
 *
 * The cost of matching the raw slice is a deliberate over-catch: a first
 * argument that merely *mentions* `process.env.SOME_KEY` inside a string
 * literal is reported. That is pinned as a fixture case below rather than left
 * as a surprise, and the allowlist is the escape hatch if it ever bites.
 */
function findOffences(rawSrc, rel) {
  const src = blankNonCode(rawSrc);
  const offences = [];
  CALL_RE.lastIndex = 0;
  let m;
  while ((m = CALL_RE.exec(src)) !== null) {
    const openIdx = CALL_RE.lastIndex - 1;
    const blankedArg = firstArgument(src, openIdx);
    if (blankedArg === null) {
      offences.push(`${rel}: unparseable assert.${m[1]}(...) at offset ${openIdx}`);
      continue;
    }
    const arg = rawSrc.slice(openIdx + 1, openIdx + 1 + blankedArg.length);
    ENV_READ_RE.lastIndex = 0;
    let e;
    while ((e = ENV_READ_RE.exec(arg)) !== null) {
      const name = e[1] ?? e[2];
      if (!isCredentialVar(name)) continue;
      const line = src.slice(0, openIdx).split("\n").length;
      const at = `${rel}:${line}`;
      if (ALLOWLIST.has(at)) continue;
      offences.push(
        `${at}: assert.${m[1]}(process.env.${name}, ...) prints the value of ` +
          `${name} into the reporter on failure — use ` +
          `assert.ok(process.env.${name} === <expected>, msg)`,
      );
    }
  }
  return offences;
}

async function testFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      out.push(...(await testFiles(full)));
    } else if (entry.name.endsWith(".test.mjs")) {
      out.push(full);
    }
  }
  return out;
}

test("GUARD — no assertion sources `actual` from a credential env var", async () => {
  const files = await testFiles(TEST_ROOT);

  // A sweep that finds nothing is not a clean sweep. `npm run test:scoring`
  // globs src/**/*.test.mjs; if this walk stops matching the runner's own set,
  // the guard has quietly stopped guarding and must say so.
  assert.ok(
    files.length >= 100,
    `expected the full src test tree (131 files at the time of writing), walked ${files.length} ` +
      `from ${TEST_ROOT} — a guard that reads an empty tree passes for the wrong reason`,
  );

  const offences = [];
  for (const full of files) {
    const rel = path.relative(REPO, full).split(path.sep).join("/");
    offences.push(...findOffences(await readFile(full, "utf8"), rel));
  }

  assert.deepEqual(
    offences,
    [],
    "node:test prints `actual` on failure even with a custom message, so these assertions " +
      "would disclose a live credential in CI on the day the code under test regressed:\n  " +
      offences.join("\n  "),
  );
});

/**
 * The detector's own teeth, on inline fixtures rather than the live tree.
 *
 * Without this, the sweep above passes on a tree that is genuinely clean AND on
 * a detector whose regex silently stopped matching anything — the two are
 * indistinguishable from a green run. These cases pin both halves: what must be
 * caught, and what must not be, so the guard cannot be quieted by broadening it
 * into uselessness or narrowing it into noise.
 */
const DETECTOR_CASES = [
  // --- must be caught ---
  { catches: true, why: "the exact form R6.5.9 was filed against, custom message and all",
    src: `assert.equal(process.env.BRIGHTDATA_API_KEY, undefined, 'must be scrubbed');` },
  { catches: true, why: "strictEqual leaks identically",
    src: `assert.strictEqual(process.env.OPENAI_API_KEY, undefined);` },
  { catches: true, why: "deepEqual on an object literal containing the read",
    src: `assert.deepEqual({ k: process.env.CRON_SECRET }, { k: undefined });` },
  { catches: true, why: "assert.strict.equal is the same method by another path",
    src: `assert.strict.equal(process.env.GSC_SERVICE_ACCOUNT_KEY, undefined);` },
  { catches: true, why: "bracket access is not a way around the rule",
    src: `assert.equal(process.env["SUPABASE_SERVICE_ROLE_KEY"], undefined);` },
  { catches: true, why: "notEqual prints the value too",
    src: `assert.notEqual(process.env.OPERATOR_TOKEN, 'x');` },
  { catches: true, why: "a comma inside a string must not end the first argument early",
    src: `assert.equal(fmt("a,b", process.env.PERPLEXITY_API_KEY), undefined);` },
  { catches: true, why: "DELIBERATE OVER-CATCH — a mention inside the first argument's own string literal is reported, the price of seeing through bracket access; allowlist it if it ever bites",
    src: `assert.equal("process.env.LLM_API_KEY", label);` },
  { catches: true, why: "multi-line calls are the common formatting in this repo",
    src: `assert.equal(\n  process.env.SUPABASE_DB_PASSWORD,\n  undefined,\n  'msg',\n);` },

  // --- must NOT be caught ---
  { catches: false, why: "THE FIX — assert.ok collapses actual to false before the reporter sees it",
    src: `assert.ok(process.env.BRIGHTDATA_API_KEY === undefined, 'must be scrubbed');` },
  { catches: false, why: "a non-credential var is not this guard's business",
    src: `assert.equal(process.env.SERP_PROVIDER, undefined, 'override must be scrubbed');` },
  { catches: false, why: "NODE_ENV, SCAN_RATE_LIMIT and friends must not be swept in",
    src: `assert.equal(process.env.NODE_ENV, 'test');\nassert.equal(process.env.SCAN_RATE_LIMIT, '3');` },
  { catches: false, why: "MONKEY contains KEY as a substring but not as a segment",
    src: `assert.equal(process.env.MONKEY_PATCH, undefined);` },
  { catches: false, why: "passing the whole env object to a function reads no credential",
    src: `assert.equal(resolveVercelRuntime(process.env).onVercel, false, "VERCEL leaked");` },
  { catches: false, why: "second argument is `expected`, which this guard documents as out of scope",
    src: `assert.ok(scrubbed, process.env.FIRECRAWL_API_KEY === undefined);` },
  { catches: false, why: "a credential read outside any assertion is not an assertion leak",
    src: `const key = process.env.GEMINI_API_KEY;\nassert.ok(key === undefined);` },
  { catches: false, why: "a commented-out assertion is not live code — this is also how the guard avoids matching its own docs",
    src: `// assert.equal(process.env.BRIGHTDATA_API_KEY, undefined);\nassert.ok(true);` },
  { catches: false, why: "a block comment likewise",
    src: `/* assert.equal(process.env.CRON_SECRET, undefined); */\nassert.ok(true);` },
  { catches: false, why: "an assertion quoted inside a string is prose — this is how the fixture table below avoids matching itself",
    src: "assert.ok(msg === 'assert.equal(process.env.OPENAI_API_KEY, undefined)');" },
];

/**
 * Cases for the blanker specifically, where the failure mode is a false
 * NEGATIVE: something in the source derails the scanner so that a real offence
 * later in the file is never seen. A guard that quietly stops looking is the
 * exact defect R6.5.5 was filed for, one level up.
 */
const BLANKER_CASES = [
  { catches: true, why: "an escaped slash in a regex must not read as a line comment and swallow the rest",
    src: `const re = /https:\\/\\//;\nassert.equal(process.env.OPENAI_API_KEY, undefined);` },
  { catches: true, why: "an apostrophe inside a comment must not open a string and eat the file",
    src: `// don't let this comment's apostrophe run on\nassert.equal(process.env.CRON_SECRET, undefined);` },
  { catches: true, why: "a template literal must be closed, not left open across the offence",
    src: "const t = `a ${b} c`;\nassert.equal(process.env.OPERATOR_TOKEN, undefined);" },
];

test("GUARD — the credential-assertion detector catches what it claims to", () => {
  const wrong = [];
  for (const c of [...DETECTOR_CASES, ...BLANKER_CASES]) {
    const hits = findOffences(c.src, "fixture.test.mjs");
    const caught = hits.length > 0;
    if (caught !== c.catches) {
      wrong.push(
        `expected ${c.catches ? "CAUGHT" : "CLEAN"} but got ${caught ? "CAUGHT" : "CLEAN"} — ${c.why}\n` +
          `      source: ${c.src.replace(/\n/g, "\\n")}`,
      );
    }
  }
  assert.deepEqual(
    wrong,
    [],
    "the detector no longer agrees with its own specification, so the sweep above proves nothing:\n  " +
      wrong.join("\n  "),
  );

  // Belt and braces against a detector rewritten to return [] unconditionally:
  // the case table must contain both kinds, and both kinds must be exercised.
  assert.ok(
    DETECTOR_CASES.some((c) => c.catches) &&
      DETECTOR_CASES.some((c) => !c.catches) &&
      BLANKER_CASES.length > 0,
    "the case tables must hold both must-catch and must-not-catch cases, and the blanker cases " +
      "must not have been emptied — a detector rewritten to return [] unconditionally passes " +
      "every must-not-catch case on its own",
  );

  // The blanker must preserve offsets, or every `file:line` this guard reports
  // points somewhere else and the report is worse than useless.
  const sample = "const a = 1; // x\n`tpl`\n'str'\n/* b\nc */\nassert.ok(1);\n";
  const blanked = blankNonCode(sample);
  assert.equal(blanked.length, sample.length, "blankNonCode must preserve source length");
  assert.equal(
    blanked.split("\n").length,
    sample.split("\n").length,
    "blankNonCode must preserve line count, or reported line numbers drift",
  );
});

/**
 * GUARD — the suite this task was filed against still uses the fix pattern.
 *
 * The sweep above would catch a revert to `assert.equal`. It would NOT catch a
 * revert to `assert.equal(key, undefined)` written as
 * `assert.ok(process.env.BRIGHTDATA_API_KEY == undefined)`-adjacent sloppiness,
 * nor the deletion of the three assertions altogether — a file with no
 * assertion about the scrub passes every sweep in this file. So the presence of
 * the checks is pinned here, by name.
 */
test("GUARD — serp.test.mjs still asserts the scrub, in the non-disclosing form", async () => {
  const rel = "src/lib/engines/serp.test.mjs";
  const src = await readFile(path.join(REPO, rel), "utf8");

  for (const name of ["BRIGHTDATA_API_KEY", "SERP_PROVIDER", "SERPAPI_KEY"]) {
    const re = new RegExp(String.raw`assert\.ok\(\s*process\.env\.${name}\s*===`);
    assert.ok(
      re.test(src),
      `${rel} no longer asserts the ${name} scrub as ` +
        `assert.ok(process.env.${name} === ...) — either the assertion was removed, ` +
        `which leaves the env-scrub regression unguarded, or it went back to a form ` +
        `that prints the value into the CI log on failure (R6.5.9)`,
    );
  }
});

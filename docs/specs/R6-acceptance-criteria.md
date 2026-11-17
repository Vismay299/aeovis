# R6 Acceptance Criteria — Scoring & Analytics Review

> <!-- doc-status -->
> **Status: HISTORICAL.** A dated review artefact from the 2026-09-14 session:
> the acceptance verdicts it records were acted on and the tasks it names have
> since closed in the ledger. `.claude/orchestration/tasks.json` is the record
> of what each task's verifier actually accepted; read this for the reasoning
> at the time, not for current status.

**Reviewer:** PM2 (Scoring & Analytics)
**Date:** 2026-09-14
**Scope:** R6.4.17, R6.4.16, R6.4.10, R6.4.11, R6.4.3, R6.4.8, R6.5.8

---

## R6.4.17 — `assertCorpusIntact` shared helper (IN PROGRESS)

**File reviewed:** `src/server/testCorpus.mjs` (123 lines), `src/server/testCorpus.test.mjs` (166 lines)

### Current state

The shared helper exists at `src/server/testCorpus.mjs:33` and covers:
- Floor check (array length vs minimum)
- Shape check (isTuple mode with rowLength, non-tuple string/RegExp mode)
- Uniqueness check (duplicate detection via Set)
- Required members check (exact equality or substringMatch)

The test file at `src/server/testCorpus.test.mjs` covers:
1. Nine "GUARD TEETH" tests proving the helper rejects: under-floor, duplicates, missing required, non-string entries, blank entries, tuples with no reason, RegExp accepted/rejected correctly, substring matching, valid tuples, valid string arrays.
2. One repo-wide guard that walks all `*.test.mjs` files under `src/` and fails if any defines its own local `function assertCorpusIntact(` without importing from `testCorpus.mjs`.

### Acceptance criteria

| # | Criterion | Pass/Fail | Evidence |
|---|-----------|-----------|----------|
| 1 | `assertCorpusIntact` exists in `src/server/testCorpus.mjs` as a named export, not duplicated elsewhere | PASS | Single definition at line 33; test at line 136 walks all test files for local copies |
| 2 | Floor rejection: `assertCorpusIntact([], "X", { floor: 1 })` throws with "under its floor" | PASS | Test at line 23 |
| 3 | Duplicate rejection: `["a","a"]` throws with "repeats" | PASS | Test at line 30 |
| 4 | Missing required rejection: `["a"]` with `required: ["b"]` throws with "no longer contains" | PASS | Test at line 37 |
| 5 | Non-string rejection (when `!allowRegExp`): `[123]` throws with "is not a string" | PASS | Test at line 44 |
| 6 | Blank-string rejection: `[""]` and `["   "]` both throw with "empty string" | PASS | Test at line 51 |
| 7 | Tuple-no-reason rejection: `[["a",""]]` with `isTuple: true` throws with "carries no reason" | PASS | Test at line 62 |
| 8 | `allowRegExp=true` accepts RegExp instances; `allowRegExp=false` rejects them | PASS | Test at line 69 |
| 9 | `substringMatch=true` uses `target.includes(member)` for required check | PASS | Test at line 80 |
| 10 | Valid tuples (`["value","reason"]`) and valid string arrays (`["a","b","c"]`) are accepted | PASS | Tests at lines 102, 113 |
| 11 | Repo-wide drift guard: no `*.test.mjs` file defines a local `assertCorpusIntact` function without importing from `testCorpus.mjs` | PASS | Test at line 136 walks `src/` recursively |

### OPEN DEFECTS — not yet fixed as of 2026-09-14

These three items from the task description remain in their original broken state. The implementer MUST address them before R6.4.17 can be verified:

| # | File:Line | Defect | Required fix |
|---|-----------|--------|--------------|
| 1 | `serpQueryPrice.test.mjs:269` | `required` list is `COST_LITERAL_PATTERNS[0].source, COST_LITERAL_PATTERNS[1].source` — derived from the corpus it is checking, so it can never detect a removal. Truncation fails via TypeError reading `.source` of undefined rather than the floor message. | Inline the literal regex source strings (e.g. `"=\\s*[1-9]\\d*\\.\\d{2,}"`) so the required list is independent of the corpus. |
| 2 | `docStatus.test.mjs:42` | `governedDocs()` floor is 35 against a real count of ~43. Eight governed docs could be deleted with the guard still green. | Raise floor to at or near the real count (43). |
| 3 | `publicRouteExposure.test.mjs:32` | Defines its own local `function assertCorpusIntact(...)` (60 lines) instead of importing from `testCorpus.mjs`. This is the exact drift the repo-wide guard is meant to prevent. | Delete the local copy, import from `./testCorpus.mjs`, and pass `substringMatch: true` in the options. |

---

## R6.4.16 — Source-reading guard determinism (TODO, READY)

**Anchors:** `src/server/migrationsLedger.test.mjs`, `src/server/docStatus.test.mjs`

### Problem

Source-reading guards (`readFile` / `readFileSync` during test execution) can observe a half-written file when another agent is concurrently writing. The migration-runner guard at `migrationsLedger.test.mjs:99` failed spuriously on one run and passed on the next two with no source change.

### Acceptance criteria

| # | Criterion | How to verify |
|---|-----------|---------------|
| 1 | A shared read helper exists (e.g. `src/lib/safeReadSource.mjs`) that any test can import | Glob for `safeReadSource` exports |
| 2 | The helper re-reads once on a parse or emptiness anomaly before asserting | Unit test: write a file, truncate it mid-read simulation, verify the helper retries |
| 3 | The helper does NOT swallow genuine failures — a file that is truly broken (e.g. invalid JSON where JSON is expected) still fails on the second read | Unit test: verify a genuinely malformed file throws after retry |
| 4 | The helper distinguishes a torn read from a genuine defect — test asserts both paths | Dedicated test case |
| 5 | At least `migrationsLedger.test.mjs` and `docStatus.test.mjs` use the shared helper instead of raw `readFile` | Grep for direct `readFile` calls in those files |
| 6 | No guard skips when the tree is dirty (explicitly banned in the task) | Verify no `git status` or dirty-tree check in the helper |
| 7 | The suite is deterministic across 3 consecutive `npm run test:scoring` runs with no source change | Manual verification |

---

## R6.4.10 — NUL-byte detection guard (TODO, READY)

**Anchors:** `src/server/rateLimit.test.mjs`, `.gitattributes`

### Problem

A NUL byte in a source file makes it invisible to ripgrep (which silently skips binary files). Every grep-based guard in the repo would pass over such a file without opening it.

### Acceptance criteria

| # | Criterion | How to verify |
|---|-----------|---------------|
| 1 | A test exists that scans all tracked text source files under `src/` for NUL bytes | Read the test file |
| 2 | The guard itself is NOT grep-based (it must use `fs.readFile` or `Buffer.indexOf`) | Read the implementation — it must not shell out to `rg` or use `grep` |
| 3 | The guard names the offending file when a NUL is found | Plant a NUL in a temp file, run guard, verify error message includes the filename |
| 4 | A planted NUL in a source file causes the guard to fail | Integration test: write `\0` into a `.js` file, run guard, assert failure |
| 5 | Removing the NUL makes the guard pass again | Cleanup and re-run |
| 6 | The guard covers at minimum: `.js`, `.mjs`, `.jsx`, `.ts`, `.tsx`, `.json`, `.md`, `.sql`, `.css` files | Verify the file extension filter |
| 7 | Binary files (images, fonts) are excluded from the scan | Verify exclusion logic for known binary extensions |

---

## R6.4.11 — Shared component-render harness (TODO, READY)

**Anchors:** `src/components/dashboard/crawlabilityRivalOutcome.test.mjs`, `src/components/dashboard/engineSetChangeSurface.test.mjs`, `package.json`

### Problem

A component-render harness exists inline in `engineSetChangeSurface.test.mjs` (sucrase + react-dom/server), but it is copy-pasted per test file. The default `@/components` catch-all stub silently renders nothing, allowing UI guards to pass while components are broken. The inverted-ternary mutation in `CrawlabilityView.jsx` passes all 8 text-scan tests.

### Acceptance criteria

| # | Criterion | How to verify |
|---|-----------|---------------|
| 1 | A shared render harness module exists (e.g. `src/lib/testRenderHarness.mjs`) importable by any test | Glob for the file, verify it exports a render function |
| 2 | The harness uses only dependencies already in `package.json` (sucrase, react-dom/server) — no new runtime dependency | Check `package.json` before and after; diff should show no new deps |
| 3 | The harness renders a component to static HTML string via `renderToStaticMarkup` | Read the implementation |
| 4 | The harness's default stub behavior is to FAIL (throw) rather than silently render null | Unit test: render a component that imports a missing child, verify it throws |
| 5 | Stubbing is explicit — callers must opt in to stub specific modules | Read the API surface |
| 6 | At least one existing text-scan guard (preferably `crawlabilityRivalOutcome.test.mjs`) is converted to use the shared harness | Grep for import of the shared harness in that file |
| 7 | The converted guard catches the inverted-ternary mutation in `CrawlabilityView.jsx` that the text scan misses | Mutation test: invert the ternary, run the converted guard, assert it fails |
| 8 | `engineSetChangeSurface.test.mjs` imports from the shared harness instead of defining its own inline version | Grep for the import |

---

## R6.4.3 — Infra-vendor / engine-name rendered-copy guard (TODO, READY)

**Anchors:** `src/components/`

### Problem

Infrastructure vendor names (Bright Data, MiMo, Firecrawl) must never appear in user-visible rendered copy. Engine names must remain visible. Both directions need a guard.

### Acceptance criteria

| # | Criterion | How to verify |
|---|-----------|---------------|
| 1 | A test exists that asserts infra vendor names ("Bright Data", "BrightData", "MiMo", "Firecrawl") do not appear in rendered component output | Read the test file |
| 2 | A test exists that asserts engine names DO appear in rendered component output | Read the test file |
| 3 | The guard fails forward: injecting a vendor name into a component's rendered output causes the guard to fail | Mutation test: add "Bright Data" to a component template, run guard |
| 4 | The guard fails backward: removing an engine name from rendered output causes the guard to fail | Mutation test: remove an engine name reference, run guard |
| 5 | The guard operates on rendered HTML (not source text), following the white-label test's trick | Read the implementation — must use `renderToStaticMarkup` or equivalent |
| 6 | The vendor-name list and engine-name list are both defined as explicit corpora with floor checks (using `assertCorpusIntact`) | Verify corpus definitions |

---

## R6.4.8 — Doc-to-source staleness tripwire (TODO, READY)

**Anchors:** `docs/vendors/README.md:97`, `src/server/docStatus.test.mjs`

### Problem

When a cited source file changes in a commit that does not touch the doc citing it, the doc goes stale. The gemini.md falsification (ee5504e) is the worked example. An existence check catches zero of the thirteen broken citations. A citation guard with 202 hand-written expectations would rot silently.

### Acceptance criteria

| # | Criterion | How to verify |
|---|-----------|---------------|
| 1 | Either a tripwire test exists that fails when a cited source file changes without its citing doc, OR a documented decision not to build it exists with noise measurement | Read the test or the decision doc |
| 2 | If built: the tripwire covers at minimum the 34 doc-to-source edges identified in the task | Verify the edge list |
| 3 | If built: the tripwire is proven by replaying it over git history (at least the last 40 commits) and it fires on ee5504e | Run the test against historical commits |
| 4 | If built: the tripwire is proven by a live case — a deliberate source change without doc update triggers failure | Manual verification |
| 5 | A guard that passes on the gemini.md defect (the old existence check) is NOT the implementation | Verify the implementation is not a simple "file exists" check |
| 6 | If not built: the decision doc includes a noise measurement from comment-only edits to cited files | Read the decision doc |

---

## R6.5.8 — Scan worker sweep branch testability (TODO, READY)

**Anchors:** `src/app/api/scan/worker/route.js:390`, `src/app/api/scans/_lib/scanRow.js`, `src/server/scanWorkerRoute.route.test.mjs`

### Problem

The sweep branch of `GET /api/scan/worker` is behind `if (!supabase)` and the route imports `supabase` as a module binding with no seam to inject a fake. The test suite has no Supabase by design, so the branch is never entered. This is the cron entry point — the branch that decides which brands get scanned.

### Acceptance criteria

| # | Criterion | How to verify |
|---|-----------|---------------|
| 1 | The sweep branch is reachable by a test that observes a real `Response` object | Read the test — it must call `GET()` or the extracted function and assert on response shape |
| 2 | The seam follows the existing `scanRow.js` precedent — either an injectable client seam or a `_lib` module pattern | Read the implementation — verify dependency injection or module extraction |
| 3 | No test can reach a real database — the seam prevents it | Verify that Supabase env vars are cleared or the client is stubbed to null |
| 4 | A test drives the sweep branch end-to-end and fails on a response-shape regression | Read the test assertions — they must check JSON structure of the sweep response |
| 5 | The `runSweepMaintenance` function (already exported at `route.js:401`) is driven by the test with injected `runSchedulerTick` and `reapStaleRuns` deps | Read the test — verify it passes mock functions via `deps` |
| 6 | The branch that was previously unreachable (`if (!supabase)` guard) is now exercised through the extracted function, not by bypassing the guard with a fake Supabase client | Verify the test strategy does not mock Supabase |

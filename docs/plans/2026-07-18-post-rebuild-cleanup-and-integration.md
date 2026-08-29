# aeovis — Post-Rebuild Cleanup & Integration Plan

> <!-- doc-status -->
> **Status: HISTORICAL.** A record of work done at the time, not an authority for current decisions. It predates the 2026-08-29 honesty audit, so any claim it makes about what is finished must be checked against [docs/BUILD_JOURNAL.md](../BUILD_JOURNAL.md) and [2026-08-29-rebuild-roadmap.md](./2026-08-29-rebuild-roadmap.md).

**Date:** 2026-07-18
**Follows:** `docs/plans/2026-07-15-aio-unbranded-30-prompt-rebuild.md` (the v8 rebuild)
**Status of that rebuild:** implemented, uncommitted, 69/69 tests pass, `npm run build` succeeds.

---

## 0. Read this first (executor briefing)

### 0.1 What state the repo is in right now

Do not go looking for a messy branch situation — there isn't one.

- Current branch `fix/brightdata-truncation-and-rate-limit` is at commit `fb853e2`.
- `main` is at `fb853e2`. `origin/main` is at `fb853e2`. They are identical.
- `updated-logic-july10` is at `8cb4654`, which is the **parent** of `fb853e2` — it is
  already merged into main. There is nothing to reconcile.
- **The new branch has zero commits on it.** Every change from the v8 rebuild is sitting
  uncommitted in the working tree: 14 modified files + 7 new source files + a large pile
  of scratch files.

So the task is not "merge branches." The task is: **clean the working tree, close the
integration gaps the rebuild left behind, then split the result into reviewable commits.**

### 0.2 Hard rules for the executor

1. **DO NOT run `git commit`. DO NOT run `git push`.** Phase 7 tells you exactly what
   commits to prepare and in what order, but the repo owner runs them. Stage nothing
   unless a step explicitly says to.
2. **DO NOT run `npm run build` until Phase 3 Step 3.1 is complete.** Right now the build
   executes `/api/scan/worker` during static generation and starts *real* Bright Data
   scans. This is a live bug that costs money. Step 3.1 fixes it. Until then, verify with
   `npm run test:scoring` and `npm run lint` only.
3. **Work phase by phase, in order.** Each phase ends with a verification block. If
   verification fails, stop and fix before moving on. Do not batch phases together.
4. **Use exact string matching for edits.** Every edit below gives the exact current text
   and the exact replacement. If the current text does not match byte-for-byte, stop and
   report — do not guess at a fuzzy match.
5. **Do not "improve" things not listed here.** The rebuild is good code. Scope creep is
   how this working tree got hard to review in the first place.

### 0.3 Context: what the v8 rebuild changed

The scan pipeline moved from v7 to v8:

| Concern | v7 (before) | v8 (now) |
|---|---|---|
| Prompt sourcing | Mixed branded + unbranded, via PAA/autocomplete + Gemini | Exactly 30 unbranded, via OpenRouter free model |
| Competitor detection | Regex NER + hardcoded stopwords (`coMentions.js`) | One batched LLM call (`competitorExtract.js`) |
| Geo | `us` default | `in` (India) default |
| Bright Data | 30s timeout, retry on 5xx only | 60s timeout, truncation + rate-limit + HTML-page detection |
| Metrics | `visibility_pct` only | `share_of_ai_pct` / `aio_coverage_pct` / `presence_rate_pct`, three fixed denominators |

The rebuild plan explicitly said: *"Branded prompts are out of scope this pass (all 30 are
unbranded); leave the branded helpers in place for later re-enable."* That decision was
honored in the **pipeline** but not in the **UI** — that is the main integration gap this
plan closes (Phase 4).

---

## Phase 1 — Remove scratch files and fix `.gitignore`

**Goal:** get the untracked file list down to only things that belong in the repo.

### Step 1.1 — Inventory before deleting

Run this and read the output. You are about to delete ~3.3 MB of files; confirm they match
what is described here before proceeding.

```powershell
Get-ChildItem scripts -Filter '_*' | Select-Object Name, Length | Format-Table -AutoSize
```

Expected: 19 files, all prefixed `_`, including two ~1.6 MB files named `_api_check.txt`
and `_api_check2.txt`. These are raw Bright Data API response dumps captured during
debugging. They are byte-identical to each other and contain live API response payloads.

**If any file in `scripts/` does NOT start with `_`, do not delete it.** The legitimate
scripts (`setup-supabase.mjs`, `test-dynamic-prompts.mjs`) have no underscore prefix and
are referenced by `package.json`.

### Step 1.2 — Delete the debugging scratch files

```powershell
Remove-Item scripts/_* -Force
```

Verify `scripts/` still contains the real scripts:

```powershell
Get-ChildItem scripts | Select-Object Name
```

Expected to still exist: `setup-supabase.mjs`, `test-dynamic-prompts.mjs`, and any other
non-underscore files. If `package.json`'s `test:prompts` or `setup:db` targets are gone,
you deleted too much — restore and retry.

### Step 1.3 — Delete tooling/session scratch directories

These are agent-session and local-tooling artifacts, not project code:

```powershell
Remove-Item .commandcode -Recurse -Force
Remove-Item terminals -Recurse -Force
Remove-Item mcps -Recurse -Force
```

**Note:** if the repo owner uses `mcps/` for MCP server configs they want to keep, ask
before deleting — but it should then be committed deliberately with a README explaining
it, not left as loose untracked files.

### Step 1.4 — Decide on the docs binaries

`docs/` contains generated PNG diagrams alongside their `.mmd` Mermaid sources:

- `docs/aeovis-mvp-flow.mmd` + `docs/aeovis-mvp-flow.png`
- `docs/profound-flow.mmd` + `docs/profound-flow.png`

**Recommendation:** keep the `.mmd` sources (text, diffable, small), drop the `.png`
binaries (regenerable, ~200 KB, produce noisy diffs on every regeneration).

```powershell
Remove-Item docs/aeovis-mvp-flow.png, docs/profound-flow.png -Force
```

Also delete the throwaway config used to render them, and the stray notes file:

```powershell
Remove-Item docs/puppeteer-config.json -Force
Remove-Item "docs/plans/short context.md" -Force
```

**Keep** `docs/plans/2026-07-15-aio-unbranded-30-prompt-rebuild.md` — that is the design
record for the rebuild and belongs in the repo.

### Step 1.5 — Fix the over-broad `.gitignore` rule

**File:** `.gitignore`

The rebuild appended `.env*` at the end of the file. This pattern also matches
`.env.example`, which is a file you *want* tracked. It currently appears to work only
because `.env.example` was already tracked before the rule was added — git does not apply
ignore rules to already-tracked files. A fresh clone plus `git add` would behave
differently, which is exactly the kind of trap that bites six months later.

Find this at the end of the file:

```
# typescript
*.tsbuildinfo
next-env.d.ts
.env*
```

Replace with:

```
# typescript
*.tsbuildinfo
next-env.d.ts

# local env files (the .example template stays tracked)
.env
.env.*
!.env.example
```

Note line 29 already contains `.env*.local`, which is now redundant with `.env.*` but
harmless — leave it, it documents intent.

### ✅ Phase 1 verification

```powershell
git status --short
```

The untracked (`??`) list should now contain **only** these entries:

```
?? docs/aeovis-mvp-flow.mmd
?? docs/plans/2026-07-15-aio-unbranded-30-prompt-rebuild.md
?? docs/plans/2026-07-18-post-rebuild-cleanup-and-integration.md
?? docs/profound-flow.mmd
?? src/lib/llm.js
?? src/lib/openrouter.js
?? src/lib/openrouter.test.mjs
?? src/lib/scoring/competitorExtract.js
?? src/lib/scoring/competitorExtract.test.mjs
?? src/lib/scoring/promptGen.js
?? src/lib/scoring/promptGen.test.mjs
?? src/lib/scoring/summarize.test.mjs
```

Then confirm the ignore rule does the right thing in both directions:

```powershell
git check-ignore -v .env.local    # should print a matching rule
git check-ignore -v .env.example  # should print NOTHING and exit 1
```

---

## Phase 2 — Remove code the rebuild orphaned

**Goal:** delete modules and imports that nothing references anymore. This is not cosmetic
— one of these deletions structurally enforces the free-model-only policy.

### Step 2.1 — Delete `src/lib/scoring/aioPrompts.js`

**Why this one matters most.** `aioPrompts.js` exported `buildAioQueries`, and
`scanWorker.js` was its only consumer. The rebuild removed that import, so the module is
now unreachable. But it also does this at line 3:

```js
import { generateContent } from "../gemini.js";
```

`promptGen.js` carries an explicit comment (lines 10–14) saying it deliberately does *not*
import from `aioPrompts.js` precisely because that would pull the paid Gemini provider into
the free-model-only prompt path. Deleting the file converts that documented convention into
a structural guarantee: the paid provider can no longer be reached from prompt generation
at all.

Confirm nothing imports it, then delete:

```powershell
Select-String -Path "src/**/*.js","src/**/*.jsx","src/**/*.mjs" -Pattern "aioPrompts" -ErrorAction SilentlyContinue
```

Expected output: only the self-reference inside `promptGen.js`'s comment (line 12) and
nothing else. If any real `import ... from ".../aioPrompts.js"` shows up, **stop** and
report it.

```powershell
Remove-Item src/lib/scoring/aioPrompts.js -Force
```

Then remove the now-stale comment reference. **File:** `src/lib/scoring/promptGen.js`,
lines 10–14.

Find:

```js
/**
 * Small local industry-key resolver — deliberately NOT imported from
 * aioPrompts.js (that module imports gemini.js at load time, which would
 * pull the paid-fallback provider into this free-model-only path).
 */
```

Replace with:

```js
/**
 * Small local industry-key resolver. Kept local so this module's only LLM
 * dependency stays `llmJson` (OpenRouter free model) — nothing here may reach
 * a paid provider.
 */
```

### Step 2.2 — Delete `src/lib/scoring/hybridPrompts.js` and its test

`mergePromptPools` is exported from `hybridPrompts.js` and imported by exactly one file:
`hybridPrompts.test.mjs`. Nothing in production references it. A module whose only consumer
is its own test is dead weight — it will keep passing CI forever while testing nothing that
ships.

Confirm, then delete both:

```powershell
Select-String -Path "src/**/*.js","src/**/*.jsx","src/**/*.mjs" -Pattern "hybridPrompts|mergePromptPools" -ErrorAction SilentlyContinue
```

Expected: matches only inside `hybridPrompts.js` and `hybridPrompts.test.mjs`.

```powershell
Remove-Item src/lib/scoring/hybridPrompts.js, src/lib/scoring/hybridPrompts.test.mjs -Force
```

**Expected test count change:** the suite drops from 69 to 67 tests (the two
`mergePromptPools` tests). This is correct and expected — note it so the Phase 6 count
does not look like a regression.

### Step 2.3 — Remove the unused `getScanJob` import

**File:** `src/app/api/scan/route.js`, line 2.

`getScanJob` is imported but never called anywhere in this file.

Find:

```js
import { createScanJob, getScanJob, globalMemoryJobs } from "@/lib/db";
```

Replace with:

```js
import { createScanJob, globalMemoryJobs } from "@/lib/db";
```

**Do not remove `globalMemoryJobs` yet** — it is still used by `hasActiveScanForBrand` on
line 10. Phase 3 Step 3.2 rewrites that function and removes this import properly. Order
matters here; doing 3.2 first then 2.3 would leave a broken intermediate state.

### Step 2.4 — Drop the dead parameter on `citationMatchesCompetitor`

**File:** `src/lib/scoring/coMentions.js`, line 351.

The fourth parameter `brandDomainForComp` is declared but never read anywhere in the
function body. `competitorExtract.js` (line 129) already calls this function with only
three arguments, which works fine but looks like an accidental omission to a reviewer.
Removing the parameter makes the three-argument call obviously correct.

Find:

```js
export function citationMatchesCompetitor(citations, references, compAliases, brandDomainForComp) {
```

Replace with:

```js
export function citationMatchesCompetitor(citations, references, compAliases) {
```

Then check for any remaining four-argument callers:

```powershell
Select-String -Path "src/**/*.js","src/**/*.mjs" -Pattern "citationMatchesCompetitor" -ErrorAction SilentlyContinue
```

Every call site should pass at most three arguments. If one passes four, remove its fourth
argument too.

### ✅ Phase 2 verification

```powershell
npm run test:scoring
```

Expected: **67 tests, 0 failures.** (Down from 69 — the two deleted `mergePromptPools`
tests.)

```powershell
npm run lint
```

Expected: no errors about unresolved imports or unused variables in the files touched.

---

## Phase 3 — Fix correctness bugs

**Goal:** two real bugs, one of which is actively costing money on every deploy.

### Step 3.1 — Stop the build from launching real scans (**do this first, it costs money**)

**File:** `src/app/api/scan/worker/route.js`

**The bug.** This route has no route-segment config, so Next.js treats it as statically
analyzable and **prerenders it at build time** — which means it *executes the GET handler*
during `npm run build`. The handler queries Supabase for pending `scan_jobs` and calls
`startScanJob` on up to three of them.

This is confirmed, not theoretical. A `npm run build` run on 2026-07-18 printed:

```
Generating static pages (3/12)
[aio-worker] Starting scan job e5ad720a-... for brand: italica
[aio-worker] Starting scan job 1713d4ef-... for brand: italica tiles
[aio-worker] Starting scan job 315d07cb-... for brand: italica
```

Three real scans, each hitting Bright Data 30 times, launched by a build. The build output
also confirms the route was classified `○ (Static)` rather than `ƒ (Dynamic)`.

**Consequences:** every local build and every Vercel deploy silently burns Bright Data
quota, and it creates duplicate/stuck job rows — which is very likely the root cause of the
symptom that the new 409 guard in Phase 3.2 is trying to treat.

**The fix.** Add a route-segment config so Next never prerenders it.

Find lines 1–3:

```js
import { NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { startScanJob } from "@/lib/workers/scanWorker";
```

Replace with:

```js
import { NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { startScanJob } from "@/lib/workers/scanWorker";

// This route has side effects (it launches real Bright Data scans). Without
// force-dynamic, Next prerenders it during `next build` and actually executes
// the handler, starting live scans and burning SERP quota on every deploy.
export const dynamic = "force-dynamic";
```

**Audit the sibling routes while you are here.** Any API route that mutates state or calls
a paid API must not be prerendered. Check each of these for a `dynamic` export and add the
same line where the handler has side effects:

```powershell
Get-ChildItem -Recurse -Path src/app/api -Filter route.js | ForEach-Object {
  $hasDynamic = Select-String -Path $_.FullName -Pattern 'export const dynamic' -Quiet
  "$($_.FullName.Replace($PWD.Path,'')) -> dynamic: $hasDynamic"
}
```

Routes with only a `POST`/`PUT`/`DELETE` handler are dynamic automatically and need no
change. Routes exporting `GET` that touch Supabase or an external API **do** need it.

### Step 3.2 — Make the duplicate-scan guard actually work in production

**Files:** `src/lib/db.js` (add function), `src/app/api/scan/route.js` (use it)

**The bug.** The current guard in `src/app/api/scan/route.js` lines 8–19 iterates
`globalMemoryJobs`, which is `global.memoryJobs` — an in-process `Map`. On Vercel's
serverless runtime each concurrent request may be served by a different instance with its
own empty `Map`. Two rapid scan requests for the same brand land on two instances, both see
an empty map, both return 201, and both start scanning. That is precisely the Bright Data
overload the guard exists to prevent, so today the guard provides false confidence rather
than protection.

The check must consult the shared source of truth: the `scan_jobs` table.

**3.2a — Add the function to `src/lib/db.js`.**

Insert immediately **after** the `createScanJob` function (which ends at line 223 with its
closing `}`) and **before** `export async function getScanJob(jobId) {` on line 225:

```js
/**
 * True if a scan for this brand is already running. Checks the shared
 * `scan_jobs` table, not just the in-process memory map — on serverless each
 * instance has its own map, so a memory-only check does not prevent two
 * concurrent scans from starting and overloading the Bright Data zone.
 *
 * Jobs older than STALE_JOB_MS are ignored so a crashed job stuck in
 * "probing" cannot block a brand forever.
 */
const STALE_JOB_MS = 15 * 60 * 1000;

export async function hasActiveScanForBrand(brand) {
  const RUNNING = ["pending", "generating_prompts", "probing", "scoring"];
  const key = String(brand || "").trim().toLowerCase();
  if (!key) return false;

  const cutoffMs = Date.now() - STALE_JOB_MS;

  // In-memory first: covers local dev and Supabase-less runs.
  for (const job of global.memoryJobs.values()) {
    if (String(job.brand || "").trim().toLowerCase() !== key) continue;
    if (!RUNNING.includes(job.status)) continue;
    const created = new Date(job.created_at || 0).getTime();
    if (Number.isFinite(created) && created < cutoffMs) continue; // stale
    return true;
  }

  if (!supabase) return false;

  try {
    const { data, error } = await supabase
      .from("scan_jobs")
      .select("id")
      .ilike("brand", key)
      .in("status", RUNNING)
      .gt("created_at", new Date(cutoffMs).toISOString())
      .limit(1);
    if (error) throw error;
    return (data || []).length > 0;
  } catch (err) {
    // Fail open: a broken duplicate-check must not block all scanning.
    console.warn("[db] hasActiveScanForBrand check failed, allowing scan:", err.message);
    return false;
  }
}
```

Notes for the executor:

- `.ilike("brand", key)` with no `%` wildcards is an exact case-insensitive match, which is
  the intent. Do not add wildcards — `"acme"` must not match `"acme corp"`.
- **Fail open on error is deliberate.** If Supabase is unreachable, blocking every scan is
  worse than permitting a possible duplicate.
- `STALE_JOB_MS` is 15 minutes while the cron worker in `api/scan/worker/route.js` line 22
  re-picks jobs after 5 minutes. That ordering is intentional: the cron gets three chances
  to resume a stalled job before the guard stops treating it as active.

**3.2b — Now remove `globalMemoryJobs` from `src/lib/db.js`.**

It only existed to support the broken in-route check. Find line 186:

```js
export const globalMemoryJobs = global.memoryJobs;
```

Delete that line entirely. Keep line 185 (`global.memoryJobs = global.memoryJobs || new Map();`) — that is load-bearing.

**3.2c — Rewrite the route to use it.**

**File:** `src/app/api/scan/route.js`

Find lines 1–19 (the imports plus the whole local `hasActiveScanForBrand` function, which
after Step 2.3 reads):

```js
import { NextResponse } from "next/server";
import { createScanJob, globalMemoryJobs } from "@/lib/db";
import { startScanJob } from "@/lib/workers/scanWorker";

// Returns true if a scan job for this brand is already active (pending or
// probing/scoring). Used to avoid stacking parallel scans that overload the
// Bright Data SERP zone and trigger timeouts.
function hasActiveScanForBrand(brand) {
  const running = ["pending", "generating_prompts", "probing", "scoring"];
  for (const job of globalMemoryJobs.values()) {
    if (
      job.brand?.toLowerCase() === brand.toLowerCase() &&
      running.includes(job.status)
    ) {
      return true;
    }
  }
  return false;
}
```

Replace with:

```js
import { NextResponse } from "next/server";
import { createScanJob, hasActiveScanForBrand } from "@/lib/db";
import { startScanJob } from "@/lib/workers/scanWorker";
```

Then find line 32 (the call site, currently synchronous):

```js
    if (hasActiveScanForBrand(brand)) {
```

Replace with:

```js
    if (await hasActiveScanForBrand(brand)) {
```

**This `await` is mandatory** — the function is now `async`, and without `await` the
expression is a always-truthy Promise, which would reject *every* scan with a 409. If you
see "A scan for this brand is already in progress" on a clean database, this `await` is
missing.

### ✅ Phase 3 verification

Now that Step 3.1 is done, the build is safe to run.

```powershell
npm run test:scoring
npm run lint
npm run build
```

Expected in the build output:

1. **No `[aio-worker] Starting scan job ...` lines.** If any appear, Step 3.1 did not take
   effect — recheck the `export const dynamic` line placement.
2. In the route table, `/api/scan/worker` is now marked **`ƒ (Dynamic)`**, not `○ (Static)`.

Manual smoke test of the 409 guard (requires a dev server):

```powershell
npm run dev
```

In a second terminal, fire two scans for the same brand back to back:

```powershell
$body = '{"brand":"testbrand","url":"https://example.com","industry":"saas","competitors":""}'
Invoke-WebRequest -Uri http://localhost:3000/api/scan -Method POST -Body $body -ContentType 'application/json' -UseBasicParsing | Select-Object StatusCode
Invoke-WebRequest -Uri http://localhost:3000/api/scan -Method POST -Body $body -ContentType 'application/json' -UseBasicParsing | Select-Object StatusCode
```

Expected: first returns **201**, second returns **409**. If the *first* returns 409, the
`await` from 3.2c is missing.

---

## Phase 4 — Make the dashboard match the pipeline

**Goal:** the UI currently advertises a metric the v8 pipeline can no longer produce.

### 4.1 — Understand the gap before editing

`scanWorker.js` now sources exactly 30 **unbranded** queries and passes `competitors: []`
to `runAioScan`. No branded query is ever probed. Therefore, for every v8 scan:

- every result row has `is_branded_query === false`
- `summary.branded_with_aio === 0`
- `summary.branded_visibility_pct === 0`
- downstream, `result.brandPresencePromptsCount === 0`

But `src/app/dashboard/page.js` still renders four branded surfaces:

| Location | Surface | What a user sees on a v8 scan |
|---|---|---|
| lines 382–397 | "Brand Presence" KPI card | Value `—`, subtitle "0 of 0 own-name queries had an AIO" |
| lines 406–416 | "Tracked Queries" subtitle | "30 non-branded · 0 own-name" |
| line 511 | "Brand Presence" tab button | A tab that opens an empty panel |
| lines 558–582 | Brand Presence tab panel | Empty-state message under a heading promising data |
| lines 348–352 | Hero `brandedVisibility` prop | Already guarded, renders nothing — no change needed |

### 4.2 — Chosen approach: conditional, not deleted

**Do not delete the branded code paths.** The v8 rebuild plan explicitly said to *"leave
the branded helpers in place for later re-enable."* `aioPipeline.js` still computes branded
metrics correctly; they are simply always zero because no branded queries are fed in.

So: **hide these surfaces when there is no branded data, rather than removing them.** When
branded prompts are re-enabled later, the UI comes back automatically with no further work.
Every edit below is gated on the same single condition.

### Step 4.3 — Add the gate variable

**File:** `src/app/dashboard/page.js`

Find the KPI row opening (line 326–327):

```jsx
        {/* KPI row */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-7 gap-5 mb-8">
```

Replace with:

```jsx
        {/* KPI row.
            hasBrandedData is false for every v8 (unbranded-only) scan — the
            pipeline still computes branded metrics, but nothing feeds it
            branded queries. Branded surfaces stay in the tree and light up
            automatically if branded prompts are re-enabled. */}
        <div
          className={`grid grid-cols-1 md:grid-cols-2 gap-5 mb-8 ${
            hasBrandedData ? "lg:grid-cols-7" : "lg:grid-cols-6"
          }`}
        >
```

Then declare `hasBrandedData` near the other derived values. Find line 161 area — the
existing derived-result block that references `is_branded_query`. Insert this immediately
**before** the `return (` of the component's main JSX (i.e. alongside the other `const`
derivations such as `mentionedNonBranded` / `citedNonBranded`; search for
`const mentionedNonBranded` and place it directly after that block):

```jsx
  // True only when the scan actually probed branded/own-name queries. v8 scans
  // are unbranded-only, so this is false and all branded UI is hidden.
  const hasBrandedData = (result?.brandPresencePromptsCount ?? 0) > 0;
```

**Guard against a crash:** if `result` can be null before a scan loads, the `?.` and `??`
above already handle it. Confirm `result` is in scope at that point — if the derivation
sits inside a block where `result` is guaranteed non-null, drop the `?.`.

### Step 4.4 — Gate the "Brand Presence" KPI card

**File:** `src/app/dashboard/page.js`, lines 382–397.

Find:

```jsx
          <KpiCard
            testId="kpi-brand-presence"
            label="Brand Presence"
            value={
              dataSourceIssue || result.brandPresencePromptsCount === 0
                ? "—"
                : result.brandedVisibilityPct
            }
            suffix={
              dataSourceIssue || result.brandPresencePromptsCount === 0 ? "" : "%"
            }
            sub={`${result.brandPresenceWithAio ?? result.brandedWithAio ?? 0} of ${
              result.brandPresencePromptsCount || 0
            } own-name queries had an AIO`}
            index={3}
          />
```

Replace with:

```jsx
          {hasBrandedData && (
            <KpiCard
              testId="kpi-brand-presence"
              label="Brand Presence"
              value={dataSourceIssue ? "—" : result.brandedVisibilityPct}
              suffix={dataSourceIssue ? "" : "%"}
              sub={`${result.brandPresenceWithAio ?? result.brandedWithAio ?? 0} of ${
                result.brandPresencePromptsCount || 0
              } own-name queries had an AIO`}
              index={3}
            />
          )}
```

The inner `brandPresencePromptsCount === 0` checks are now redundant — `hasBrandedData`
already guarantees it is non-zero — so they are removed for clarity.

### Step 4.5 — Fix the "Tracked Queries" subtitle

**File:** `src/app/dashboard/page.js`, lines 406–416.

On a v8 scan this renders "30 non-branded · 0 own-name", where the second half is
permanently meaningless.

Find:

```jsx
            sub={(() => {
              const nonB = result.promptsAnalyzed || 0;
              const own = result.brandPresencePromptsCount || 0;
              const other =
                result.aliasBrandedOnlyCount ??
                Math.max(0, (result.brandedPromptsCount || 0) - own);
              if (other > 0) {
                return `${nonB} non-branded · ${own} own-name · ${other} other branded`;
              }
              return `${nonB} non-branded · ${own} own-name`;
            })()}
```

Replace with:

```jsx
            sub={(() => {
              const nonB = result.promptsAnalyzed || 0;
              const own = result.brandPresencePromptsCount || 0;
              const other =
                result.aliasBrandedOnlyCount ??
                Math.max(0, (result.brandedPromptsCount || 0) - own);
              // Unbranded-only scan: don't pad the label with permanent zeros.
              if (own === 0 && other === 0) {
                return `${nonB} unbranded queries`;
              }
              if (other > 0) {
                return `${nonB} non-branded · ${own} own-name · ${other} other branded`;
              }
              return `${nonB} non-branded · ${own} own-name`;
            })()}
```

### Step 4.6 — Gate the "Brand Presence" tab

**File:** `src/app/dashboard/page.js`, line 511.

Find:

```jsx
              {["overview", "brand-presence", "queries", "citations"].map((tab) => (
```

Replace with:

```jsx
              {[
                "overview",
                ...(hasBrandedData ? ["brand-presence"] : []),
                "queries",
                "citations",
              ].map((tab) => (
```

**Leave the tab panel at lines 558–582 exactly as it is.** It is already gated behind
`activeTab === "brand-presence"`, and with the button gone that state is unreachable. It
costs nothing and returns automatically when branded data exists.

**Edge case to handle:** `activeTab` defaults to `"overview"` (line 34), so there is no
risk of landing on a hidden tab on first render. But if any code path sets
`activeTab = "brand-presence"` programmatically, the user would see a blank content area.
Verify with:

```powershell
Select-String -Path "src/app/dashboard/page.js" -Pattern "setActiveTab"
```

If the only `setActiveTab` call is the `onClick` on line 514, no further work is needed.

### ✅ Phase 4 verification

Manual, in the browser — this is UI work and tests will not catch it.

```powershell
npm run dev
```

Open the dashboard for an existing v8 scan and confirm:

1. The KPI row shows **six** columns, evenly spaced, with no gap where the Brand Presence
   card used to be.
2. No "Brand Presence" tab appears in the tab bar.
3. "Tracked Queries" reads "30 unbranded queries", not "30 non-branded · 0 own-name".
4. The hero card and the "AI Overview coverage" / "Presence" cards are unchanged.
5. Load an **older, pre-v8 scan** from the Previous Scans row if one exists. Because it has
   branded data, the Brand Presence card and tab should **reappear** and the grid should go
   back to seven columns. This is the real test that the gate is conditional and not a
   disguised deletion.

---

## Phase 5 — Document the dual competitor-scoring path

**Goal:** no code change. Make a deliberate, recorded decision about a real inconsistency.

### 5.1 — The situation

There are now two different implementations that produce a number called "competitor
visibility":

- **Server (v8, authoritative):** `src/lib/scoring/competitorExtract.js` →
  `extractCompetitors()`, one batched LLM call. Called by `scanWorker.js` line 137.
- **Client (v7 legacy fallback):** `src/services/api.js` line 182 →
  `buildCompetitorLeaderboard()` from `coMentions.js`, the regex/stopword heuristic the
  rebuild plan said to *"retire."*

The client path only fires inside `resolveCompetitors()` when a scan record has no stored
competitors with signal (`api.js` lines 169–195). For a v8 scan that never happens, because
the worker always persists `competitorObjects`. So it is genuinely a legacy-scan fallback —
it exists so historical scans still render a competitor table.

### 5.2 — Recommendation: keep it, but label it

Deleting it would blank the competitor table for every pre-v8 scan in the database. The
cost of keeping it is that two definitions of one metric coexist, which will confuse the
next reader.

**Add this comment** in `src/services/api.js`. Find lines 165–168:

```js
/**
 * Prefer stored competitor metrics; if empty, rediscover from AIO evidence
 * so older scans / form-empty runs still show Blank-style co-mentions.
 */
```

Replace with:

```js
/**
 * Prefer stored competitor metrics; if empty, rediscover from AIO evidence
 * so older scans / form-empty runs still show co-mentions.
 *
 * NOTE — two competitor scorers coexist by design:
 *   - v8 (authoritative): competitorExtract.extractCompetitors(), one batched
 *     LLM call, run server-side in scanWorker and persisted on the scan record.
 *   - v7 (this fallback): coMentions.buildCompetitorLeaderboard(), the regex +
 *     stopword heuristic. Retained ONLY so pre-v8 scans still render a
 *     competitor table.
 *
 * A v8 scan always persists competitors, so this branch should never run for
 * new scans. If you see it firing on a fresh scan, the worker failed to persist
 * competitors — fix that rather than tuning the heuristic. Delete this fallback
 * (and coMentions' scoring exports) once pre-v8 scans age out of the database.
 */
```

### 5.3 — Also confirm the loosened reliability gates were intentional

No code change unless the owner disagrees. **Flag this in your report.**

`src/lib/scoring/aioConstants.js` changed two thresholds:

- `AIO_MIN_NON_BRANDED_COVERAGE`: `0.30` → `0.15`
- `AIO_COVERAGE_WARNING_PCT`: `50` → `30`

The inline comments justify this as India-specific tuning, which is reasonable — Indian AIO
coverage genuinely is lower and more volatile than US. But the combined effect is that
`data_source_issue` is now materially harder to trigger, so a scan with genuinely poor data
is more likely to produce a confident-looking score instead of flagging itself. That is a
product judgment call, not a bug. Report it; change nothing.

---

## Phase 6 — Full verification

Run everything, in this order. All must pass before Phase 7.

```powershell
npm run test:scoring
```
Expected: **67 tests, 0 failures.** (69 minus the 2 deleted `mergePromptPools` tests.)

```powershell
npm run lint
```
Expected: clean, or only pre-existing warnings unrelated to the files touched.

```powershell
npm run build
```
Expected:
- Build succeeds.
- **Zero `[aio-worker] Starting scan job` lines.**
- `/api/scan/worker` listed as `ƒ (Dynamic)`.

```powershell
git status --short
```
Expected untracked list — exactly these, nothing else:

```
?? docs/aeovis-mvp-flow.mmd
?? docs/plans/2026-07-15-aio-unbranded-30-prompt-rebuild.md
?? docs/plans/2026-07-18-post-rebuild-cleanup-and-integration.md
?? docs/profound-flow.mmd
?? src/lib/llm.js
?? src/lib/openrouter.js
?? src/lib/openrouter.test.mjs
?? src/lib/scoring/competitorExtract.js
?? src/lib/scoring/competitorExtract.test.mjs
?? src/lib/scoring/promptGen.js
?? src/lib/scoring/promptGen.test.mjs
?? src/lib/scoring/summarize.test.mjs
```

Expected deletions (` D`) in the tracked list:

```
 D src/lib/scoring/aioPrompts.js
 D src/lib/scoring/hybridPrompts.js
 D src/lib/scoring/hybridPrompts.test.mjs
```

Finally, the end-to-end check — one real scan through the running app:

```powershell
npm run dev
```

Trigger a scan from `/scan` and confirm from the console that it sources 30 unbranded
prompts, probes them, extracts competitors, and completes. Then confirm the dashboard
renders six KPI columns with no Brand Presence tab.

---

## Phase 7 — Commit plan (**prepare only — DO NOT run**)

The repo owner runs these. Present the plan and stop.

The working tree currently mixes three unrelated concerns. Splitting them means the risky
architectural change can be reverted on its own without losing the cleanup or the bug fixes.

### Commit 1 — housekeeping

Files: `.gitignore`, deletion of `scripts/_*`, `.commandcode/`, `terminals/`, `mcps/`,
`docs/*.png`, `docs/puppeteer-config.json`, `docs/plans/short context.md`.

```
chore: remove debug scratch files and tighten .env gitignore

Drops ~3.3MB of Bright Data response dumps and session scratch from the
working tree. Narrows the `.env*` ignore rule so `.env.example` stays
tracked on a fresh clone.
```

### Commit 2 — bug fixes (independently revertable, safe to ship alone)

Files: `src/app/api/scan/worker/route.js`, `src/lib/db.js`, `src/app/api/scan/route.js`.

```
fix(scan): stop builds launching scans; make duplicate guard cluster-safe

The worker route had no route-segment config, so `next build` prerendered
it and executed the handler — starting real Bright Data scans on every
build and deploy. Adds `export const dynamic = "force-dynamic"`.

The duplicate-scan guard read an in-process Map, which is per-instance on
serverless and so never fired across concurrent requests. Moves the check
to the shared scan_jobs table with a 15-minute staleness window, failing
open if the check itself errors.
```

### Commit 3 — the v8 rebuild

Everything else: the new modules, the worker rewrite, engine hardening, scoring changes,
UI changes, and the two plan docs.

```
feat(aio): v8 unbranded 30-prompt pipeline on OpenRouter free model

Sources exactly 30 unbranded prompts per scan via OpenRouter (free model
only, no paid fallback), probes Google AI Overview via Bright Data with
India geo, and extracts competitors with one batched LLM call.

Scoring now exposes three metrics on fixed, never-mixed denominators:
share_of_ai_pct (visible / queries-with-AIO), aio_coverage_pct
(queries-with-AIO / 30), presence_rate_pct (visible / 30).

Bright Data client hardened: 60s timeout, truncation detection, rate-limit
and HTML-proxy-page handling.

Removes aioPrompts.js and hybridPrompts.js, both orphaned by the rewrite.
Deleting aioPrompts.js also removes the last path by which prompt
generation could reach the paid Gemini provider.

Branded UI surfaces are hidden rather than deleted — they return
automatically if branded prompts are re-enabled.
```

### Branch and push

The work is currently on `fix/brightdata-truncation-and-rate-limit`, whose name no longer
describes the change. Suggest to the owner:

```powershell
git branch -m fix/brightdata-truncation-and-rate-limit feat/aio-v8-unbranded-pipeline
```

**Then stop. The owner decides whether to push and open a PR.**

---

## Appendix A — Complete file change manifest

| # | File | Action | Phase |
|---|---|---|---|
| 1 | `scripts/_*` (19 files) | delete | 1.2 |
| 2 | `.commandcode/`, `terminals/`, `mcps/` | delete | 1.3 |
| 3 | `docs/*.png`, `docs/puppeteer-config.json`, `docs/plans/short context.md` | delete | 1.4 |
| 4 | `.gitignore` | edit | 1.5 |
| 5 | `src/lib/scoring/aioPrompts.js` | delete | 2.1 |
| 6 | `src/lib/scoring/promptGen.js` | edit (comment only) | 2.1 |
| 7 | `src/lib/scoring/hybridPrompts.js` + `.test.mjs` | delete | 2.2 |
| 8 | `src/app/api/scan/route.js` | edit (import) | 2.3 |
| 9 | `src/lib/scoring/coMentions.js` | edit (signature) | 2.4 |
| 10 | `src/app/api/scan/worker/route.js` | edit (force-dynamic) | 3.1 |
| 11 | `src/lib/db.js` | edit (add fn, drop export) | 3.2a/b |
| 12 | `src/app/api/scan/route.js` | edit (use new guard) | 3.2c |
| 13 | `src/app/dashboard/page.js` | edit (4 gated surfaces) | 4.3–4.6 |
| 14 | `src/services/api.js` | edit (comment only) | 5.2 |

## Appendix B — Do NOT touch

These are correct as-is. Changing them is out of scope:

- `src/lib/openrouter.js`, `src/lib/llm.js` — clean provider layer.
  `google/gemma-4-31b-it:free` was verified against the live OpenRouter model list on
  2026-07-18 and exists. Do not "fix" the model slug.
- `src/lib/scoring/promptGen.js` (beyond the 2.1 comment) — tested, dependency-injected.
- `src/lib/scoring/competitorExtract.js` — tested.
- `src/lib/scoring/aioPipeline.js` — the three-denominator contract is correct and tested.
- `src/lib/engines/brightdata.js` — the retry/truncation logic is the point of this branch.
- `src/lib/scoring/aioQueryClassify.js`, `aliases.js`, `citations.js` — still used.
- `src/lib/scoring/coMentions.js` beyond 2.4 — still used by the `api.js` legacy fallback.

## Appendix C — If something goes wrong

Nothing here is committed, so `git` cannot restore deleted **untracked** files (the
`scripts/_*` debris, `terminals/`, etc.). Those are gone permanently once deleted — which
is intended, but take a copy first if you are unsure:

```powershell
Copy-Item -Recurse scripts/_* "$env:TEMP/aeovis-scratch-backup/" -ErrorAction SilentlyContinue
```

Tracked files **can** be restored:

```powershell
git checkout -- src/lib/scoring/aioPrompts.js       # restore one deleted tracked file
git checkout -- src/app/dashboard/page.js           # discard edits to one file
git diff src/app/dashboard/page.js                  # review before discarding
```

To see the full uncommitted state at any point:

```powershell
git status --short
git diff --stat
```

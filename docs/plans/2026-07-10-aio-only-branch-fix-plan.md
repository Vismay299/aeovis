# AIO-Only Branch Fix Plan (`updated-logic-july10`)

> <!-- doc-status -->
> **Status: HISTORICAL.** A record of work done at the time, not an authority for current decisions. It predates the 2026-08-29 honesty audit, so any claim it makes about what is finished must be checked against [docs/BUILD_JOURNAL.md](../BUILD_JOURNAL.md) and [2026-08-29-rebuild-roadmap.md](./2026-08-29-rebuild-roadmap.md).

**Created**: 2026-07-10  
**Status**: Ready to implement (do not start until this plan is approved)  
**Branch**: `updated-logic-july10` (base commit at plan writing: `a04dbfb`)  
**Goal**: Fix AIO-only scoring, quality gates, result normalization, and dashboard display so the **logic is consistent end-to-end** for every brand — one formula, one set of thresholds, one set of counts, no contradictory KPIs.

This plan is **not** about a specific company or demo brand. All examples use synthetic numbers and generic labels.

---

## Context

The branch pivots scoring to Google AI Overview only (Bright Data). Direction matches PRD intent. The implementation still has **logic and presentation bugs** that affect any scan:

| Symptom (generic) | What goes wrong |
|-------------------|-----------------|
| Visibility score vs hero label | Score uses “non-branded **with AIO**” as denominator; UI says “across N non-branded queries” (all tracked) — users divide by the wrong N |
| Coverage KPI vs coverage gate | Different denominators (all queries vs non-branded only) |
| Coverage % vs visibility % | Same `run_record` can show non-zero visibility and 0% coverage after normalize/display |
| Error gate vs UI copy | Code trips above **50%** errors; UI copy says **40%** |
| Small-sample banner | Shows total non-branded count, not AIO-present count |
| Citation-only rows | Empty AIO text + citations → treated as no AIO → under-count |
| Re-run / DB prompts | Branded seeds dropped; Brand Presence empties for any brand |
| Competitor / branded counts | Classification and plumbing bugs, not brand-specific |

**Why score can be 20% when “1 of 7” feels like ~14%**: score is  

```text
visible non-branded AIOs ÷ non-branded queries that had an AIO
```

Example: **1 visible ÷ 5 with AIO = 20%**, while **7** is only how many non-branded queries were tracked. The hero label hides that distinction.

This document lists **every fix**, in order, with files, exact approach, and done-when criteria.

---

## How to use this plan

1. Stay on **`updated-logic-july10`**.
2. Implement **P0 first** (correctness blockers), then P1 → P2 → P3.
3. Each step is atomic: one logical change, one verification.
4. After each P0 step, verify with **synthetic unit fixtures** and/or **any** real scan — not a named customer.
5. Do **not** change the intentional formula  
   `visible non-branded with AIO ÷ non-branded with AIO`  
   unless product explicitly decides to switch denominator to “all non-branded.”

**Step ID format**: `P{priority}-S{nn}`  
**Priorities**: P0 = correctness blockers · P1 = robustness · P2 = hardening · P3 = cleanup

---

## Source-of-truth files (touch map)

| Area | Path |
|------|------|
| Probe + summarize | `src/lib/scoring/aioPipeline.js` |
| Query generation | `src/lib/scoring/aioPrompts.js` |
| Worker / DB prompts | `src/lib/workers/scanWorker.js` |
| Normalize for UI | `src/services/api.js` |
| Dashboard | `src/app/dashboard/page.js` |
| Hero / methodology | `src/components/dashboard/KpiCard.jsx` |
| Evidence UI | `src/components/dashboard/AioEvidence.jsx` |
| Competitors | `src/components/dashboard/CompetitorTable.jsx` |
| Status polling | `src/app/api/scan/[job_id]/status/route.js` |
| Industry seeds | `src/data/industries.js` |
| Existing constants (legacy) | `src/lib/scoring/constants.js` |
| Live smoke tests | `tests/test_aio_scan.py` |
| PRD / credentials smell | `memory/PRD.md`, `memory/test_credentials.md` |
| Sample report | `test_reports/iteration_1.json` |

---

## Shared design decisions (agree once, use everywhere)

### D1 — Visibility formula (keep)

```
visibility_pct =
  count(non-branded AND aio_present AND visible)
  / count(non-branded AND aio_present)
  × 100
```

- `visible` = `brand_mentioned_in_text OR brand_cited`
- Branded queries never enter the headline denominator.

### D2 — Gate thresholds (single constants module)

Introduce AIO-specific constants (new file preferred so legacy v6 weights stay untouched):

**Recommended file**: `src/lib/scoring/aioConstants.js`

| Constant | Recommended value | Rationale |
|----------|-------------------|-----------|
| `AIO_ERROR_RATE_LIMIT_PCT` | `50` | Matches current pipeline + PRD |
| `AIO_MIN_NON_BRANDED_COVERAGE` | `0.30` | Fail if &lt; 30% of non-branded get AIO |
| `AIO_MIN_NON_BRANDED_WITH_AIO` | `5` | Insufficient sample below this |
| `AIO_CONCURRENCY` | `3` | Existing probe concurrency |

UI must import and **display** these numbers — never hardcode “40%” or “30%” as string literals alone.

### D3 — Coverage definition (unify)

```
aio_coverage_pct =
  count(non-branded AND aio_present)
  / count(non-branded)
  × 100
```

- Gate and KPI use **this same** definition.
- Optional secondary field later: `aio_coverage_all_queries_pct` if product wants total including branded — do not mix into the gate.

### D4 — Counts always stored, never reverse-engineered

Every scan `summary` must include integer counts the UI can show:

- `non_branded_queries`
- `branded_queries`
- `non_branded_with_aio`
- `branded_with_aio`
- `visible_non_branded`
- `cited_non_branded`
- `mentioned_non_branded`
- `errored_queries`
- `total_queries`

Dashboard must prefer these integers over `Math.round(pct/100 * total)`.

---

# P0 — Correctness blockers

Fix these first. They make scores, gates, and KPIs disagree for **any** brand.

---

### P0-S01 — Create `aioConstants.js` and wire pipeline gates

**Problem**: Error threshold and coverage rules live as magic numbers; UI disagrees with code.

**Steps**:

1. Create `src/lib/scoring/aioConstants.js` with exports from **D2**.
2. In `src/lib/scoring/aioPipeline.js` → `summarizeAioResults`:
   - Replace `errorRatePct > 50` with `errorRatePct > AIO_ERROR_RATE_LIMIT_PCT`.
   - Replace `... < 0.30` with `... < AIO_MIN_NON_BRANDED_COVERAGE`.
   - Replace `nonBrandedWithAio.length < 5` with `... < AIO_MIN_NON_BRANDED_WITH_AIO`.
3. Export thresholds on `summary` for UI (optional but useful):

   ```js
   thresholds: {
     error_rate_limit_pct: AIO_ERROR_RATE_LIMIT_PCT,
     min_non_branded_coverage: AIO_MIN_NON_BRANDED_COVERAGE,
     min_non_branded_with_aio: AIO_MIN_NON_BRANDED_WITH_AIO,
   }
   ```

**Done when**:

- [ ] No bare `50`, `0.30`, or `5` gate literals remain in `aioPipeline.js`.
- [ ] Unit test (can land with P2-S01) or manual assert: 45% errors does **not** trip gate if limit is 50.

**Files**: `src/lib/scoring/aioConstants.js` (new), `src/lib/scoring/aioPipeline.js`

---

### P0-S02 — Unify AIO coverage math (KPI = gate)

**Problem**: KPI uses all queries; gate uses non-branded only. Coverage can look healthy (or broken) for reasons that do not match the reliability gate.

**Steps**:

1. In `summarizeAioResults`, set:

   ```js
   const aioCoveragePct =
     nonBranded.length > 0
       ? round1((nonBrandedWithAio.length / nonBranded.length) * 100)
       : 0;
   ```

2. Keep `queries_with_aio` (all) and `non_branded_with_aio` as separate counts.
3. Document in a one-line comment: coverage is **non-branded only**.
4. Ensure `scanWorker` persists `aio_coverage_pct: summary.aio_coverage_pct` (already does — verify after change).

**Done when**:

- [ ] For a synthetic set: 10 non-branded, 5 with AIO, 5 branded all with AIO → coverage **50%** (not 75%).
- [ ] Gate `nonBrandedWithAio/nonBranded < 0.30` uses the same ratio as coverage/100.

**Files**: `src/lib/scoring/aioPipeline.js`

---

### P0-S03 — Citation-only AIOs count as present

**Problem**: If Bright Data returns references but empty text, row is “no AIO”; brand domain citations are ignored → under-count for every brand.

**Steps**:

1. In `probeQueryOnce` (`aioPipeline.js`), after `extractBrightDataAiOverview`:

   ```js
   const hasText = Boolean(text && text.trim());
   const hasCitations = (citations?.length || 0) > 0 || (references?.length || 0) > 0;
   if (hasText || hasCitations) {
     result.aio_present = true;
     result.aio_text = text || "";
     // always attach citations/references when present
     // run brand_cited even when !hasText
     // brand_mentioned_in_text only when hasText
     result.visible = result.brand_mentioned_in_text || result.brand_cited;
   }
   ```

2. Competitor text detection only when `hasText`; competitor cited detection can run on citations always.
3. Add a fixture unit case: empty text + citation matching brand domain → `aio_present`, `brand_cited`, `visible`.

**Done when**:

- [ ] Empty text + brand domain in citations → `visible === true`.
- [ ] Truly empty SERP (no text, no refs) → `aio_present === false`.

**Files**: `src/lib/scoring/aioPipeline.js`, later tests

---

### P0-S04 — Fix `normalizeResult` counts and coverage plumbing

**Problem**: Dashboard can show non-zero visibility and 0% AIO coverage for the same scan. Coverage subtext rebuilds “X of Y” from percent × total.

**Steps**:

1. In `src/services/api.js` → `normalizeResult`:

   - Read summary counts with fallbacks:

     ```js
     const nonBrandedWithAio =
       summary?.non_branded_with_aio
       ?? results.filter((r) => !isBranded(r) && r.aio_present).length;
     const brandedWithAio =
       summary?.branded_with_aio
       ?? results.filter((r) => isBranded(r) && r.aio_present).length;
     ```

   - Expose on the normalized object:

     | Field | Source |
     |-------|--------|
     | `promptsAnalyzed` | non-branded **total** (keep meaning: tracked non-branded) |
     | `nonBrandedWithAio` | **new** — AIO denominator for score |
     | `brandedWithAio` | **new** |
     | `visibleNonBranded` | **new** (optional, for copy) |
     | `aioCoveragePct` | summary coverage (after P0-S02) |
     | `aioErrorRatePct` | summary error rate |

   - Helper `isBranded(r)`:

     ```js
     const isBranded = (r) => !!(r.is_branded_query ?? r.isBrandedQuery);
     ```

     Use for **all** branded filters (this also starts P1-S02).

2. If `summary` is missing but `results` exist, **recompute** coverage/visibility from results rather than defaulting coverage to `0`/`null` silently when visibility is present.

3. Prefer recomputation when stored fields disagree badly (optional safety):  
   if `visibility_pct > 0` and `aio_coverage_pct === 0` and any `aio_present`, recompute from results.

**Done when**:

- [ ] Loading any `run_record` never shows coverage 0% when any non-branded `aio_present` is true.
- [ ] Normalized object always has integer `nonBrandedWithAio`.

**Files**: `src/services/api.js`

---

### P0-S05 — Hero and KPI copy: show real denominator

**Problem**: “Across N non-branded queries” + score S% makes users compute wins÷N instead of wins÷(non-branded with AIO).

**Steps**:

1. `HeroScoreCard` (`KpiCard.jsx`): change props to accept:

   - `nonBrandedCount` (tracked total)
   - `nonBrandedWithAio` (score denominator)
   - `visibleNonBranded` (optional numerator)

2. Replace subtitle with something like:

   ```text
   Visible in {visibleNonBranded} of {nonBrandedWithAio} non-branded AI Overviews
   ({nonBrandedCount} non-branded queries tracked)
   ```

3. Keep mention / domain cited lines, but ensure they are rates over **`nonBrandedWithAio`**, and optionally show counts: `Domain cited: 20% (1/5)`.

4. Tooltip formula text must match D1 exactly (already close — verify wording “with AIO”).

5. `dashboard/page.js`: pass the new fields from normalized result; stop passing only `promptsAnalyzed` as if it were the score base.

6. **AIO Coverage `KpiCard` subtext**: stop reverse engineering:

   ```text
   {nonBrandedWithAio} of {promptsAnalyzed} non-branded queries returned an AI Overview
   ```

7. Data-source banner: show limit from constant:

   ```text
   (limit {AIO_ERROR_RATE_LIMIT_PCT}%)
   ```

   not hardcoded 40%.

8. Methodology modal in `KpiCard.jsx`: replace “more than 40%” with the shared constant (import or inject as prop).

**Done when**:

- [ ] Synthetic case 1 visible / 5 AIO / 7 tracked reads as **20%** with copy that cannot be read as 1÷7.
- [ ] No “limit 40%” string remains anywhere in dashboard components.
- [ ] Coverage card never says “0 of N” when `nonBrandedWithAio > 0`.

**Files**: `src/components/dashboard/KpiCard.jsx`, `src/app/dashboard/page.js`

---

### P0-S06 — Small-sample warning uses AIO count

**Problem**: Warning says “Only {promptsAnalyzed} non-branded queries had a live AI Overview” but `promptsAnalyzed` is total non-branded.

**Steps**:

1. Banner text:

   ```text
   Only {result.nonBrandedWithAio} non-branded queries had a live AI Overview
   (of {result.promptsAnalyzed} non-branded tracked). Treat this score with caution.
   ```

2. Show banner when `insufficientSample` and not `dataSourceIssue` (keep current gating).
3. Ensure `insufficient_sample` remains `nonBrandedWithAio < AIO_MIN_NON_BRANDED_WITH_AIO`.

**Done when**:

- [ ] If 3 AIOs out of 18 tracked non-branded, banner says **3**, not 18.

**Files**: `src/app/dashboard/page.js`, `src/services/api.js` (field)

---

### P0-S07 — DB prompt reuse preserves branded seeds

**Problem**: Re-run loads DB prompts only → `brandedCount: 0` → Brand Presence dies for any brand. First save marks all rows `intent_tier: "exploratory"`.

**Steps**:

1. Export or reuse branded detection in worker:

   - Import `getBrandAliases` (already) + `detectMention` / local helper.
   - Or export `buildBrandedQueries` from `aioPrompts.js` (currently private — **export it**).

2. When `getPromptsForBrand` returns rows:

   ```js
   const brandAliases = getBrandAliases(brand, url);
   const mapped = dbPrompts.map(...);
   const nonBranded = mapped.filter((q) => !isBrandedQuery(q.text, brandAliases));
   let branded = mapped.filter((q) => isBrandedQuery(q.text, brandAliases));
   if (branded.length === 0) {
     branded = buildBrandedQueries(brand, url);
   }
   queryPlan = {
     seeds: [],
     queries: [...nonBranded, ...branded],
     nonBrandedCount: nonBranded.length,
     brandedCount: branded.length,
   };
   ```

3. On **first** persist (`upsertPrompts`), set:

   ```js
   intent_tier: isBrandedQuery(q.text, brandAliases) ? "branded" : "exploratory"
   ```

4. Optional: if DB returns prompts but **all disabled**, fail with a clear error (do not run empty) — match old worker behavior if that existed.

5. Log line must show non-zero `brandedCount` when branded seeds exist.

**Done when**:

- [ ] Second scan for the same brand still has branded queries (Brand Presence panel not empty solely due to reuse).
- [ ] DB rows for branded seeds have `intent_tier: "branded"`.

**Files**: `src/lib/workers/scanWorker.js`, `src/lib/scoring/aioPrompts.js`

---

### P0-S08 — End-to-end verification checklist (logic)

**Not a code change** — manual / automated gate after P0-S01…S07.

Use **unit fixtures** plus **any** real scan (brand-agnostic).

**Check**:

| Check | Pass criteria |
|-------|----------------|
| Score vs evidence | Count of visible non-branded AIO rows = numerator implied by score |
| Denominator copy | Hero shows “of N AIOs”; N matches evidence rows with AIO |
| Coverage | Coverage % = nonBrandedWithAio / nonBranded; not 0 if AIOs exist |
| Error limit text | Banner/methodology match `AIO_ERROR_RATE_LIMIT_PCT` |
| Brand Presence | Own-name seeds ≥ 1 after re-run (when branded generation is enabled) |
| Denominator clarity | Score S% only when numerator/denominator produce S; label never implies ÷ all tracked non-branded |

**Done when**: checklist signed off for fixtures + one real scan + one re-run (any brand).

---

# P1 — Robustness

---

### P1-S01 — Wire constants into all UI strings

**Problem**: Even after P0-S05, other strings may still hardcode thresholds.

**Steps**:

1. Grep for `40%`, `50%`, `30%`, `limit 40` under `src/`.
2. Replace with imports from `aioConstants.js` or props from server summary thresholds.
3. Methodology modal, InsightPanel, any empty states.

**Done when**: `rg "40%|limit 40" src` returns nothing relevant to error gates.

**Files**: dashboard components, any copy modules

---

### P1-S02 — Full casing-safe normalization

**Problem**: Only `is_branded_query` is read; camelCase re-entry misclassifies all rows as non-branded.

**Steps**:

1. In `normalizeResult` and `mapPromptForUi`, use dual-key helpers for:

   - `is_branded_query` / `isBrandedQuery`
   - `aio_present` / `aioPresent`
   - `brand_mentioned_in_text` / `brandMentionedInText`
   - `brand_cited` / `brandCited`
   - `aio_citations` / `aioCitations`

2. Never call `normalizeResult` on an already-normalized object without detecting shape (optional guard: if `visibilityScore` exists and `rawResults` missing structure, return as-is).

**Done when**: Feeding a camelCase-normalized object back into `normalizeResult` does not empty Brand Presence or inflate score.

**Files**: `src/services/api.js`

---

### P1-S03 — History / previous-scan KPI consistency

**Problem**: Switching history entries can show mismatched KPIs if payload is incomplete or fields use different meanings (e.g. “7 queries” vs “20 queries” without labeling which count).

**Steps**:

1. Confirm `insertScan` / history API returns `summary_stats` or full `run_record` fields used by `normalizeResult`.
2. In history click handler (`dashboard/page.js`), always `normalizeResult(scan, ...)`.
3. If old rows lack `summary_stats`, recompute from `results` inside `normalizeResult` (P0-S04).
4. Previous-scan chips: show `non_branded_queries` or total consistently; label which.

**Done when**: Switching between history chips never shows coverage 0 with non-zero visibility from the same `results` array.

**Files**: `src/services/api.js`, `src/app/dashboard/page.js`, scan history API if needed

---

### P1-S04 — Hero tier when data source fails

**Problem**: Score “—” but tier “Weak” from 0%.

**Steps**:

1. When `dataSourceIssue`:

   ```js
   tierText={dataSourceIssue ? "Unavailable" : tierLabel(tier)}
   score="—"
   ```

2. Skip `scoreTier(0)` styling for fail state (neutral badge).

**Done when**: Forced data-source failure shows no “Weak”/“Strong” tier.

**Files**: `src/app/dashboard/page.js`, maybe `src/utils/format.js`

---

### P1-S05 — Industry key normalization

**Problem**: `INDUSTRY_PROMPTS["SaaS"]` misses `"saas"`.

**Steps**:

1. In `aioPrompts.js`, add:

   ```js
   function resolveIndustry(industry) {
     if (!industry) return null;
     const key = String(industry).trim().toLowerCase();
     return INDUSTRY_PROMPTS[key] || null;
   }
   ```

2. Use in `deriveCategorySeeds` and `buildAioQueries` fallback.
3. Map common aliases if UI sends labels (`"E-commerce"` → `ecommerce`).

**Done when**: industry `"SaaS"`, `"saas"`, `"SAAS"` all hit the same seed list.

**Files**: `src/lib/scoring/aioPrompts.js`, optionally industries API

---

### P1-S06 — Competitor detection empty / misleading zero

**Problem**: Competitors Found can show `0` when competitors were never configured, or when detection failed despite names appearing in AIO text/citations.

**Steps**:

1. Verify scan request stores `competitors` / `competitors_raw` on job and worker.
2. Confirm `computeCompetitorAioMetrics` receives the list.
3. If user left competitors blank, UI should say “No competitors configured” not “0 found”.
4. If configured: check alias matching for multi-word names; ensure citation-only AIO still runs competitor cite detection after P0-S03.
5. Dashboard `competitorsFound` should count competitors with `visibilityScore > 0` or any mention/citation — define explicitly and document.

**Done when**: Scan with a configured competitor list on a synthetic/fixture query that names them → Competitors Found ≥ 1 or evidence shows them in competitor columns; blank config does not look like “found zero.”

**Files**: `scanWorker.js`, `aioPipeline.js`, `dashboard/page.js`, `CompetitorTable.jsx`

---

### P1-S07 — Branded query classification sanity

**Problem**: Tracked split can show far more “branded” than the ~4 auto branded seeds (or far too few non-branded). Causes: over-broad aliases, DB pollution, or intent_tier never set.

**Steps**:

1. Log per query: text, `is_branded_query`, source.
2. Audit `getBrandAliases(brand, website)` for overly broad aliases that mark category queries as branded (or fail to mark own-name queries).
3. Ensure P0-S07 doesn’t double-append branded seeds every run without dedupe.
4. Tracked Queries UI: show intent tier; allow user to fix misclassified prompts.
5. Cap auto branded seeds at `MAX_BRANDED` (already 4 in `aioPrompts.js`); DB may still hold many brand-containing PAA lines — decide product rule:
   - **Option A**: branded = alias in query (current), many branded OK  
   - **Option B**: branded = only `source === branded_seed` for Brand Presence panel  
   Document choice when implementing.

**Recommended default**: Brand Presence panel uses `source === "branded_seed"` OR `intent_tier === "branded"`; headline exclusion still uses `is_branded_query` (any alias hit).

**Done when**: Brand Presence count matches intentional own-name set; headline non-branded set is not tiny solely because of alias over-match.

**Files**: `aliases.js`, `aioPipeline.js`, `aioPrompts.js`, `QueryManager.jsx`, worker

---

### P1-S08 — Brand Presence card denominator

**Problem**: Card shows “Own-name queries: N” and a % without saying how many had AIO.

**Steps**:

1. Mirror hero pattern: `brandedVisibility = visibleBranded / brandedWithAio`.
2. Subtext: `{brandedWithAio} of {brandedPromptsCount} own-name queries had an AIO`.

**Done when**: 0% with 0 AIO is explained (“no AIO on own-name queries”) vs 0% with K AIOs (“not visible in any”).

**Files**: `dashboard/page.js`, `KpiCard` usage

---

# P2 — Hardening

---

### P2-S01 — Unit tests for `summarizeAioResults` and pure probe scoring

**Problem**: Only live Bright Data pytest; scoring regressions slip through.

**Steps**:

1. Add `src/lib/scoring/aioPipeline.test.mjs` (match existing `*.test.mjs` style).
2. Cases (all synthetic brands/domains — no real customers):

   | Case | Expect |
   |------|--------|
   | 1 visible / 5 AIO non-branded | visibility 20 |
   | Branded visible only | headline unchanged |
   | errorRate 45%, limit 50 | no data_source_issue from errors |
   | errorRate 51% | data_source_issue |
   | non-branded AIO ratio 20% | data_source_issue |
   | nonBrandedWithAio = 4 | insufficient_sample |
   | citation-only visible | counts in visibility |
   | empty results | zeros, no throw |

3. Run via existing npm test script if present; else document `node --test`.

**Done when**: CI or local `npm test` covers above without network.

**Files**: `src/lib/scoring/aioPipeline.test.mjs`

---

### P2-S02 — Soften live integration tests

**Problem**: Live suite hard-codes a single brand and fails the whole suite if Bright Data is down.

**Steps**:

1. Parameterize brand/url via env (`TEST_BRAND`, `TEST_BRAND_URL`) with neutral defaults only for optional smoke.
2. `@pytest.mark.integration` + skip if no `BRIGHTDATA_API_KEY` or on API outage / provider-driven `data_source_issue`.
3. Assert structure (`visibility_pct` number, `results` list, required keys) — not a specific brand’s expected %.
4. Move parser-only tests to mocked JSON fixtures from Bright Data samples.

**Done when**: `pytest` without API keys skips integration tests cleanly (exit 0).

**Files**: `tests/test_aio_scan.py`, optional fixtures under `tests/fixtures/`

---

### P2-S03 — Throttle progress DB updates

**Problem**: Every query completion fires `updateScanJob`; concurrent writes reorder progress.

**Steps**:

1. In `runAioScan` or worker `onProgress`:

   - Keep `lastPct` / `lastWriteAt`.
   - Only write if `pct` increased by ≥ 2 or ≥ 500ms since last write.
   - Always write on final completion.

2. Optionally await a single in-flight promise chain (serialize updates).

**Done when**: One scan produces ≪ 1 DB write per query (e.g. ≤ ~15 writes for 20 queries).

**Files**: `src/lib/workers/scanWorker.js`, optionally `aioPipeline.js`

---

### P2-S04 — Status route cache headers (optional)

**Steps**:

1. Confirm `force-dynamic`, `revalidate = 0`, `Cache-Control: no-store`.
2. Add `Pragma: no-cache`, `Expires: 0` if desired.

**Done when**: Polling never serves stale `complete` without `run_record`.

**Files**: `src/app/api/scan/[job_id]/status/route.js`

---

# P3 — Cleanup

---

### P3-S01 — Remove `memory/test_credentials.md` from git

**Steps**:

1. Delete file or move sanitized content to `docs/testing.md` (env var **names** only, point to `.env.example`).
2. Ensure `.env.local` gitignored.
3. Commit deletion on this branch.

**Done when**: No credentials-named file in repo; secrets still only in env.

**Files**: `memory/test_credentials.md`, optional `docs/testing.md`

---

### P3-S02 — Remove unused imports in `aioPipeline.js`

**Steps**:

1. Remove unused `extractCitations` / `normalizeUrl` if still unused after P0-S03.
2. Run lint.

**Done when**: No unused-import lint on that file.

**Files**: `src/lib/scoring/aioPipeline.js`

---

### P3-S03 — Remove dead `brandMentions` prop

**Steps**:

1. In `dashboard/page.js`, stop passing `brandMentions` to `CompetitorTable`.
2. Confirm `CompetitorTable` props API.

**Done when**: No React unknown-prop noise; call site clean.

**Files**: `src/app/dashboard/page.js`

---

### P3-S04 — Align PRD / test report numbers

**Steps**:

1. Read `memory/PRD.md` smoke claims vs `test_reports/iteration_1.json` actuals.
2. Either update PRD to actuals or mark figures as “illustrative / not last run.”
3. Date-stamp the report reference. Avoid hard-coding customer brand narrative as product truth.

**Done when**: Docs do not contradict committed reports.

**Files**: `memory/PRD.md`, `test_reports/iteration_1.json`

---

### P3-S05 — Industry catalog vs real-world categories (optional product work)

**Problem**: Preset industries are limited (e.g. SaaS, ecommerce, finance, agency). Brands outside those categories rely on website scrape + Gemini; a wrong industry pick can inject irrelevant fallback seeds.

**Steps** (product decision):

1. Short term: UI helper — industry is optional; website-derived seeds are primary.
2. Medium term: expand `INDUSTRY_PROMPTS` for more categories as needed.
3. Do not special-case a single customer in code or plans.

**Done when**: Scan form does not force misleading industry seeds when industry is blank or mismatched.

**Files**: `src/data/industries.js`, scan page copy

---

# Implementation order (summary)

```text
P0-S01  aioConstants + pipeline gates
P0-S02  unify coverage math
P0-S03  citation-only AIO
P0-S04  normalizeResult counts / fix 0% coverage
P0-S05  hero + KPI + banner copy (shared thresholds, real denominators)
P0-S06  small-sample warning
P0-S07  DB prompt reuse + branded intent
P0-S08  logic verification (fixtures + any real scan)
───
P1-S01 … P1-S08  (constants everywhere, casing, history, tier, industry, competitors, branded sanity, brand presence card)
───
P2-S01 … P2-S04  (unit tests, soft integration tests, progress throttle, cache headers)
───
P3-S01 … P3-S05  (credentials file, nits, PRD, industry product)
```

**Do not start P1 until P0-S08 passes** (fixtures + one real scan + re-run).

---

# Mapping: issues → steps

| Issue | Step(s) |
|-------|---------|
| Error 50% vs UI 40% | P0-S01, P0-S05, P1-S01 |
| Coverage KPI ≠ gate | P0-S02 |
| Coverage 0% with non-zero visibility | P0-S04, P0-S05, P1-S03 |
| Hero “across N” vs score using AIO denominator | P0-S05, D1 |
| Small-sample wrong count | P0-S06 |
| Citation-only ignored | P0-S03 |
| DB reuse drops branded | P0-S07 |
| Shared constants | P0-S01, D2 |
| normalizeResult casing | P0-S04, P1-S02 |
| History inconsistency | P1-S03 |
| Tier “Weak” on fail | P1-S04 |
| Industry case | P1-S05 |
| Competitors Found misleading | P1-S06 |
| Branded / non-branded split sanity | P1-S07 |
| Brand Presence denominator | P1-S08 |
| No unit tests | P2-S01 |
| Live tests brittle | P2-S02 |
| Progress thrash | P2-S03 |
| Status cache | P2-S04 |
| test_credentials.md | P3-S01 |
| Unused imports | P3-S02 |
| brandMentions prop | P3-S03 |
| PRD vs report numbers | P3-S04 |
| Industry catalog limits | P3-S05 |
| useMemo false positive | **No work** |

---

# Out of scope (explicit)

- Changing headline formula to `visible ÷ all non-branded` (product decision; requires PRD update).
- Multi-engine scoring (Perplexity/ChatGPT) — not part of AIO-only pivot.
- Customer-specific tuning, query packs, or special cases.
- Fixing unrelated legacy `computeVisibilityScore` / Bayesian paths unless they still run in this branch’s worker (they should not).

---

# Definition of done (branch-level)

- [ ] All P0 steps complete and P0-S08 checklist green (fixtures + any real scan + re-run).
- [ ] No contradictory KPI pairs on dashboard for the same `run_record`.
- [ ] Re-run preserves Brand Presence seeds.
- [ ] Unit tests for summarize gates exist and pass offline.
- [ ] P3 credentials file removed.
- [ ] This plan’s P0/P1 checkboxes can be ticked in a follow-up PR description.

---

# Suggested PR breakdown

| PR | Steps | Title idea |
|----|-------|------------|
| PR1 | P0-S01…S06 | fix(aio): align gates, coverage, and dashboard denominators |
| PR2 | P0-S07, P1-S07, P1-S08 | fix(aio): branded seed reuse and Brand Presence |
| PR3 | P1-S02…S06, P1-S01 | fix(aio): normalize, history, competitors, copy constants |
| PR4 | P2-* | test+chore(aio): unit tests, soft integration, progress throttle |
| PR5 | P3-* | chore: docs/credentials cleanup |

---

*End of plan. Implement only after approval; start at P0-S01.*

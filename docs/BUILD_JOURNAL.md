# Build journal

> <!-- doc-status -->
> **Status: LIVE.** Append-only. A new entry goes in the SAME COMMIT as the fix
> it describes, not afterwards.

This file exists because of one recurring failure: **a number that was wrong
looked exactly like a number that was right.** Not a crash, not a 500 — a clean
green dashboard reporting a measurement that had never been taken. Every entry
below is one instance of that, with the mechanism that made it invisible.

## How to use this file

- **Entry #1** is the retroactive template: the 2026-07-29 visibility-score
  postmortem, the first time this class of bug was diagnosed properly.
- **The findings register** is the audit of 2026-08-29, which found 37 of them
  at once. Each carries a `file:line` and a one-line mechanism.
- When you close a finding, edit its row: add the task id and the commit. Do not
  delete it. The register is the memory.

## The rule this file enforces

A code path that can silently do nothing must say so. A skip is not a success,
an empty state is not a clean one, and a measured zero must look different from
never-ran. If you find yourself writing `?? 0` on a metric, or a `catch {}` that
returns a plausible-looking default, you are writing the next entry in this file.

---

# Entry #1 — 2026-07-29 — the visibility score measured the wrong questions

**Mechanism:** the prompt set, not the scoring maths.

Three hypotheses were tested against live data; two were wrong. The weights in
`src/lib/scoring/computeVisibilityScore.js` looked harsh enough to explain it,
but that module is dead code — only `probe.js` imports it, and the live headline
comes from `enginePipeline.summarizeEngineSlice`. Bright Data was fine: answer
yield on the Italica scan was 93.3%.

The real cause, measured on scan `36a91fbb` against the 17-vendor roster the
scan itself extracted:

| | |
|---|---|
| answered unbranded prompts | 56 |
| ...that named **any** vendor | **16 (28.6%)** |
| ...that named nobody at all | **40 (71.4%)** |

Forty prompts were questions like *how to calculate tiles needed for room* —
arithmetic and how-tos that return no brand at all. **A brand cannot be
mentioned in an answer that names nobody.** Each was a guaranteed zero in the
denominator, capping the achievable score at 16/56 before the brand's real
visibility was ever measured.

**Why it was invisible:** the score was a real number computed from real data by
correct arithmetic. Nothing failed. The denominator was simply measuring
something other than brand visibility, and no surface distinguished "this prompt
could not have named anyone" from "this prompt named someone else".

**Full postmortem:** `docs/plans/2026-07-29-visibility-score-fix.md`.

---

# Entry #2 — 2026-08-29 — the findings register

An audit of the whole surface at commit `5111219` found 37 defects of this
class, grouped as **A** (the dashboard shows something untrue), **B** (the
pipeline produces something untrue), and **C** (operational and data-integrity).
They are the source of the R0–R6 rebuild in
`docs/plans/2026-08-29-rebuild-roadmap.md`.

> ## The Anchor column below expired. Read this before following one.
>
> **Declared commit: the anchors in this register describe the tree at
> `b6e3610` (2026-08-29), and for `B8`/`B9`/`B12` at `5d51aa3` (2026-08-30).**
> They were correct there. They are a dated snapshot and they have not been
> maintained since.
>
> Re-derived at `1a5ed81` on 2026-09-05 under R6.3.3, counting this file *as it
> stood at that commit* — the corrections added by that pass are not in the
> tally, and are anchored on symbols rather than numbers so they will not join
> it. Across the whole file: **111 line citations. 106 resolve to a real line; 5 name a file that no longer
> exists**, which is the only kind that fails loudly and all 5 are already
> labelled as deleted or moved. Of the 106 that resolve, **26 still describe
> what the sentence around them claims and 70 land on unrelated code**; the
> other 10 are the "audit said" cells in the tables below, which are *supposed*
> to be stale and say so. Nothing was renumbered. Renumbering 37 rows against a tree three
> other agents are editing right now would buy a week of accuracy and then be a
> lie again, more convincingly. The per-file measurement and the tripwire this
> argues for are in **Entry #5** at the bottom of this file.
>
> **How to use a row now:** treat the Anchor cell as a hint about *which file*,
> take the mechanism sentence as the thing to search for, and re-derive the line
> yourself with `git grep`. Three rows — `B8`, `B9`, `B12` — have dated
> corrections attached because their *mechanism*, not just their line, has
> changed; those corrections are inline below.

## What this register can and cannot claim

Read this before trusting a row.

- **All 37 findings are recorded below.** 34 were recoverable from the tree;
  `B8`, `B9` and `B12` were pasted in from the companion artifact on
  2026-08-30 and their anchors re-verified against source at HEAD — see *Gaps*
  at the end for exactly how, and for the trap that still sits next to them.
  Until that paste the register held 34 and said so, because quietly
  renumbering 34 findings as "all of them" would be the same lie it exists to
  catalogue.
- The **Anchor** column was re-checked against the tree at the time of writing.
  Anchors that had already moved are marked **`moved`** with the corrected path.
  This matters: the audit's own closing note says to re-verify every line number
  before acting on it, and eight of them had in fact moved.
- The **Verified** column is honest about depth. `read` means the code at that
  location was read and the mechanism confirmed. `anchor only` means the file
  and line range were confirmed to exist, but the mechanism has **not** been
  re-confirmed by reading at this commit. Do not treat an `anchor only` row as
  proven present.

Status values: `open` · `closed <task>` · `does not reproduce`.

## A — the dashboard shows something untrue

| # | Mechanism | Anchor | Verified | Status |
|---|---|---|---|---|
| A1 | Per-engine summaries carry no `state`/`state_reason`, so an engine that returned nothing is indistinguishable from one that measured zero. | `src/lib/scoring/enginePipeline.js:298-308` | anchor only | open — R2.1.1 |
| A2 | A fully-errored engine contributes to the blend instead of rendering `failed`, so a dead engine drags the headline as if it had measured 0%. | `src/components/dashboard/DashboardShell.jsx:299-301` | anchor only | open — R2.1.4 |
| A3 | No UI vocabulary for did-not-report / not-assessed / small-sample; `engines_counted` is never rendered, so the reader cannot tell how many engines are behind a number. | `src/components/dashboard/DashboardShell.jsx:616-621` | anchor only | open — R2.1.3 |
| A4 | An engine gauge with zero rows renders a gauge rather than "no data". | `src/components/dashboard/interlocking.js:98-113` **moved** (audit said `src/lib/scoring/interlocking.js`) | anchor only | open — R2.8.2 |
| A5 | Studio and Opportunities render recommendations without gating on whether the underlying scan had usable data. | `src/components/studio/OpportunitiesPanel.jsx:20-28` | anchor only | open — R2.8.1 |
| A6 | Hero, history, sidebar and homepage each select the headline score differently, so the same scan reads as four different numbers. | `src/lib/db.js:242-286`; `src/components/perceev/Sidebar.jsx:138-143` **moved** (audit said `src/components/dashboard/Sidebar.jsx`) | anchor only | open — R2.4.2 |
| A7 | Those selectors do not honour the data-quality gate, so a gated scan still publishes a headline. | `src/lib/db.js:242-286`; `src/components/dashboard/DashboardShell.jsx:570-597` | anchor only | open — R2.4.2 |
| A8 | `generateContent` returned `{ text: "" }` on a missing key or exhausted retries, so a total LLM outage was indistinguishable from an empty answer — the origin of the false 100% Share of Voice. | `src/lib/openrouter.js:22-25`, `:124-125` | **read** | **closed R0.3.1** |
| A9 | With no rivals extracted the roster is `[self]`, so share of voice computes self ÷ self = 100% and the Rivals view asserts "no rival brands were co-mentioned" — a positive claim about answers nobody looked at. | `src/components/perceev/charts/Donut.jsx:29-44` **moved** (audit said `src/components/charts/Donut.jsx`); `src/components/dashboard/RivalsView.jsx:44-46`; `src/components/dashboard/VisibilityVerdictPanel.jsx:51-58`; `src/lib/workers/scanWorker.js:692-698` | **read** | **closed R0.3.2, R0.3.3** |
| A10 | SourcesView reads pre-v9 field names, so multi-engine scans render empty sources rather than an error. | `src/components/dashboard/SourcesView.jsx:12-15` | anchor only | open — R2.7.2 |
| A11 | An unknown job status rewinds the progress bar to 0% instead of reading "reconnecting". | `src/app/api/scan/[job_id]/status/route.js:28-33` | anchor only | open — R2.8.3 |
| A12 | A database outage renders as "no scans yet" — an empty state indistinguishable from a healthy new account. | `src/app/dashboard/[brand]/page.js:52-57` | anchor only | open — R2.8.4 |

## B — the pipeline produces something untrue

| # | Mechanism | Anchor | Verified | Status |
|---|---|---|---|---|
| B1 | The Perplexity extractor is not a pure, fixture-tested function, so extraction regressions surface as plausible data rather than as test failures. | `src/lib/scoring/enginePipeline.js:154-157` | anchor only | open — R2.2.1 |
| B2 | A failed Perplexity citation leg leaves citations looking complete instead of marking them unverified. | `src/lib/engines/perplexity.js:147-160` | anchor only | open — R2.2.2 |
| B3 | Finalize had no roster continuity: an unavailable extractor produced an empty roster that read as "no rivals exist", and `scans.competitors` was never written despite the column existing since migration 001. | `src/lib/workers/scanWorker.js:653`, `:868-914` | **read** | **closed R0.3.3** |
| B4 | Top-level scan fields are single-engine values on a multi-engine scan, so the headline silently describes one engine. | `src/lib/scoring/enginePipeline.js:583-613` | anchor only | open — R2.4.1 |
| B5 | `upsertPrompts` returns `{ error }` instead of throwing; callers treat the envelope as a value. A fail-soft create is how a write that never happened reads as one that did. | `src/lib/db/prompts.js:96-100` | anchor only | open — R2.2.3 |
| B6 | Same defect as A8, from the pipeline side: missing key and exhausted retries both returned empty text. | `src/lib/openrouter.js:22-25`, `:124-125` | **read** | **closed R0.3.1** |
| B7 | A new brand with no LLM silently fell back to the hardcoded per-industry prompt pack, and the resulting scan published as if the questions had been generated for that brand. | `src/lib/scoring/promptGen.js` (industry-pack top-up); `src/lib/workers/scanWorker.js` sourcing | **read** | **closed R0.3.4** |
| B8 | "No engines enabled!" runs one anyway: when every requested engine is skipped as unconfigured, the resolver warns and returns `aio` regardless — an engine the operator did not ask for, whose configuredness is the hardcoded constant `isConfigured: () => true`, so an aio run with no Bright Data key resolves as "enabled" and every query lands in `probeAio`'s catch as a complete zero-valued row. | `src/lib/scoring/enginePipeline.js:510-514` (audit said `:510-515`; `:515` is the blank line closing the block); the constant at `:450`; the swallowing catch at `:98-101` — **all three stale at `1a5ed81`; anchor on `resolveEnabledEngines`, the `aio` entry in `ENGINE_REGISTRY`, and `probeAio`** | **read** at `5d51aa3`; **re-derived 2026-09-05** | open — no task; **partly recorded since** — see *Correction to B8* and *Since, on B8* below |
| B9 | The frozen engine set can be silently replaced mid-run. Sourcing freezes the resolved engine names onto the checkpoint precisely so a resume cannot re-resolve them, then probing discards that freeze: if no frozen name matches the live registry, `engineDefs` falls back to whatever is enabled today, with no warning and nothing recorded on the scan. | `src/lib/workers/scanWorker.js:472-479` **moved** (audit said `:432-439`, which was exact at `5111219`); the freeze contract it voids is stated at `:364-370` — **both stale at `1a5ed81`; anchor on `runProbingPhase` and the `frozenNames`/`filtered` pair** | **read** at `5d51aa3`; **re-derived 2026-09-05** | **does not reproduce as written** — see *B9 no longer runs silently* below |
| B10 | `insertScan` has a three-tier column-drop cascade: an insert that fails silently retries with fewer columns, so a scan can persist with fields quietly missing. | `src/lib/db.js:122-167` | **read** | open — R2.2.4 |
| B11 | `hasActiveScanForBrand` fails open on any DB error and leaves a TOCTOU window, so two concurrent requests could each start a full-budget duplicate scan. | `src/lib/db.js:403-408` | **read** | **closed R0.1.5** |
| B12 | No Supabase env gives a memory mode that "works": the client is null, so scan jobs live only in a per-instance `global.memoryJobs` map, `insertScan` logs "Skipping database insert" and returns, and every read returns empty. The scan completes and reports success, nothing persists, the dashboard is permanently empty rather than erroring, and two serverless instances disagree about the same job. | `src/lib/db.js:11-15` **moved** (audit said `:5-8`) and `:298` **moved** (audit said `:289`); the silent skip at `:62-65`; empty reads at `:180-182` and `:252` — **of these five, only `:11-15` still resolves to what it claims at `1a5ed81`; anchor on `insertScan`, `resolveClient` and `global.memoryJobs`** | **read** at `5d51aa3`; **re-derived 2026-09-05** | **partly fixed** — the silent-skip half is gone; the memory-mode half reproduces. See *B12: the silent skip is gone, the memory store is not* below |
| B13 | A fabricated `studio.perceev.app` URL is presented to the user as a real published location. | `src/app/api/content-items/[id]/decision/route.js:19-27` | anchor only | open — R5.2.1 |

**Liveness of B8 and B9 (standing rule 10).** *Line numbers in the next two
paragraphs are a snapshot of `5d51aa3` (2026-08-30). Re-derived at `1a5ed81` on
2026-09-05: of the seventeen, only three still land on what they name —
`src/app/api/scan/route.js:13` and `:62`, and `src/lib/engines/types.js:47`.
The chain still holds with one correction: `runScanChunk` now has **three**
entry points, not two. `GET /api/scan/[job_id]/status` dispatches it as a
poll-driven rescue (`src/app/api/scan/[job_id]/status/route.js:57` at
`1a5ed81`), alongside `POST /api/scan` (`src/app/api/scan/route.js:62`) and
`GET /api/scan/worker` (`src/app/api/scan/worker/route.js:291` and `:368`). So B8
and B9 are, if anything, more live than this section says — an added route
widened the surface and nothing re-checked the paragraph asserting the surface.
Follow it by symbol, not by number: `resolveEnabledEngines` (four call sites:
`runSourcingPhase`, `runProbingPhase`, `runFinalizePhase`, and the still-dead
`runMultiEngineScan`) → `runScanChunk` → those three routes. In six days
`enginePipeline.js` went from 625 lines to
1,132 and `scanWorker.js` from 1,181 to 2,545, which is why every number in them
moved by hundreds rather than by a handful — the drift is not drift, it is a
rewrite, and no small correction would have kept up with it.*

Both are on the live scan path,
but not by the route the file's own shape suggests. `resolveEnabledEngines`
(`enginePipeline.js:488`) has four call sites. Three are live —
`scanWorker.js:375` (sourcing, which writes the resolved names onto the
checkpoint at `:436`/`:449`), `:464` (probing) and `:579` (finalize) — and all
three are reached through `runScanChunk` (`scanWorker.js:1028`, calling
sourcing at `:1082` and probing at `:1088`), which is dispatched from **two**
entry points: `POST /api/scan` (`src/app/api/scan/route.js:13`, firing at
`:62`) and `GET /api/scan/worker` (`src/app/api/scan/worker/route.js:39`,
firing at `:60` and `:94`), the latter being a cron entry in `vercel.json`
(`/api/scan/worker`, `0 0 * * *`).

The fourth call site is **dead**: `runMultiEngineScan`
(`enginePipeline.js:533`, resolving at `:534`) has no importer anywhere in
`src/` — `docs/plans/production-plan.md` E1.4 already lists it as a dead export
to delete. It sits nineteen lines below B8's anchor and reads like the obvious
consumer, and it is not. This is the same trap as the `adapter.js`/`probe.js`
pair (`src/lib/engines/types.js:47` computes engine availability from
`BRIGHTDATA_API_KEY`, but its only consumer is `src/lib/scoring/probe.js`,
which nothing live imports). Do not cite the dead consumer as proof either
finding runs; cite the worker chain above.

**Correction to B8 as written.** The companion artifact says the resolver
"returns the aio definition it just proved unconfigured". It never proves that,
and did not at the audit commit either: `aio`'s registry entry hardcodes
`isConfigured: () => true` (`enginePipeline.js:450`, byte-identical at
`5111219`), so the skip loop at `:502-506` can never reject it. Two things do
reproduce, and they are the same class of defect the artifact was pointing at.
First, with `ENGINES=chatgpt,perplexity` and neither key set, both are skipped
and `:510-514` returns `[aio]` — an engine the operator did not request, and
the scan then publishes as an aio scan with no record that the requested
engines never ran. Second, and worse, because aio's configuredness is a
constant rather than a credential check, a deployment with no
`BRIGHTDATA_API_KEY` still resolves aio as "enabled"; `brightDataSearch` throws
"Bright Data SERP is not configured" (`src/lib/engines/brightdata.js:139-140`),
`probeAio` catches it per query (`enginePipeline.js:98-101`), and each query
returns a fully-populated row with `answer_present: false`, `visible: false`
and `cost: 0`. A completely unconfigured engine therefore produces a full set
of measured-looking zeroes rather than a failure.

**Note on B12.** The finding reproduces in full at HEAD, for the trigger the
artifact names — *no Supabase env*. A neighbouring trigger for the same map was
already gone before the audit: `480fd9a` made the job store DB-authoritative,
so a transient DB error on a **configured** deployment now throws instead of
tipping the job into `global.memoryJobs` (the mechanism is written up in the
doc comment at `src/lib/db.js:300-318`). That fix does not touch the
unconfigured case, which is what B12 is about: `hasDb` is simply `false`
(`:347`, `:426`, `:457`, `:473`, `:530`) and memory is the only store. Added
since the audit, `/api/health` reports supabase as `required` with the missing
env vars named (`src/lib/health.js:20`, `src/app/api/health/route.js:4`) — but
it is a report, not a gate: nothing on the scan path consults it, so an
unconfigured deployment still accepts scans and still completes them.

### B9 no longer runs silently — 2026-09-05, at `1a5ed81`

B9's mechanism, as the row above states it, **does not reproduce**. The row is
kept because the register is the memory, and because how it stopped reproducing
is the point: nobody closed B9, so nothing updated its row. Two tasks aimed at
neighbouring symptoms landed on top of it.

The fallback itself is unchanged — `runProbingPhase` still does
`const engineDefs = filtered.length > 0 ? filtered : allEngineDefs`, so a
checkpoint whose frozen engines no longer resolve is still probed with today's
set. What is gone is the "**with no warning and nothing recorded on the scan**"
clause, which was the whole reason it belonged in this file:

- `25e7727` (**R3.2.2**) added two skip reasons on the run ledger —
  `ENGINE_NOT_REGISTERED` per dropped engine, and `ENGINE_SET_FALLBACK` when the
  whole frozen set is substituted — each with a `console.warn` naming the job,
  the engine and the consequence.
- `3e37c92` (**R3.2.5**) carried the same two events onto the checkpoint via
  `describeEngineSetChange`, so the finalized scan record says so rather than
  only a table no dashboard reads. It rides the checkpoint deliberately, so an
  engine that vanished during chunk 2 and returned by chunk 5 is still recorded.

Anchor by symbol: `runProbingPhase`, then `frozenNames` / `filtered` /
`recordSkip` / `describeEngineSetChange`. Anyone re-opening B9 should file the
*residual* — the substitution still happens, it is now merely loud — and not
re-file the original, which is fixed.

### B12: the silent skip is gone, the memory store is not — 2026-09-05, at `1a5ed81`

B12 as written is two findings wearing one row, and they have diverged.

**Fixed.** "`insertScan` logs 'Skipping database insert' and returns" is no
longer true. `6fc5b61` (**R2.8.6**) replaced it with
`throw new ScanWriteError(..., { code: "db_not_configured" })`, and the string
survives only in the past tense inside `insertScan`'s own contract comment —
which is why `git grep "Skipping database insert"` still finds a hit in
`src/lib/db.js` and why that hit proves the opposite of what it looks like. The
`:62-65` anchor in the row now resolves to `ScanWriteError`'s JSDoc: the fix,
sitting where the defect used to be, reading as though nothing changed.
`R2.8.7` closed the mirror of it inside the old cascade.

**Still reproduces.** The memory mode does. `export const supabase = supabaseUrl
&& supabaseKey ? createClient(...) : null` is unchanged, `hasDb` is still
`!!client`, and `global.memoryJobs` is still the only store when it is false —
five of those `hasDb` guards remain, none of them at the line numbers this row
cites. `/api/health` still reports rather than gates.

So the row's status moved from `open — no task` to **partly fixed**, by two
tasks that were never told they touched it. Anchor by symbol: `insertScan`,
`ScanWriteError`, `resolveClient`, `hasDb`, `global.memoryJobs`.

### Since, on B8 — 2026-09-05, at `1a5ed81`

Half of B8 is recorded now too. `resolveEnabledEngines` still returns `[aio]`
when every requested engine is skipped — an engine the operator did not ask for
— but `R3.2.2` gave that branch an `onSkip(ENGINE_RESOLUTION_SKIPS.SET_DEFAULTED)`
alongside the pre-existing `console.warn`, so the substitution reaches the run
ledger. The rest stands: `aio`'s `isConfigured: () => true` is still a hardcoded
constant, `brightDataSearch` still throws "Bright Data SERP is not configured",
`probeAio` still catches per query, and a wholly unconfigured engine still
yields a full set of measured-looking zeroes. Anchor by symbol:
`resolveEnabledEngines`, `ENGINE_REGISTRY`'s `aio` entry, `probeAio`.

## C — operational and data integrity

| # | Mechanism | Anchor | Verified | Status |
|---|---|---|---|---|
| C1 | A `new Date()` fallback for a missing timestamp makes "we do not know when this was collected" render as "collected just now". | `src/services/api.js:550` | anchor only | open — R2.7.3 |
| C2 | The collection window is neither persisted nor rendered, so a reader cannot tell what period a number covers. | `src/lib/workers/scanWorker.js:411` | anchor only | open — R2.7.4 |
| C3 | The weekly report is not metered per brand per day. | `src/lib/content/weeklyReport.js:22-40` | anchor only | open — R3.6.3 |
| C4 | An unpriced model id costs $0 rather than failing loud, so spend under-reports silently. | `src/lib/openrouter.js:28-29`, `:101` | anchor only | open — R3.6.1 |
| C5 | A skipped scheduled scan does not bump `next_run_at` and writes no skip row, so a schedule that never fires looks the same as one with nothing due. | `src/lib/workers/scanWorker.js:1059-1062` | anchor only | open — R3.4.2 |
| C6 | The worker ignores per-brand `prompt_target`, `engines` and `geo`, so the configuration a user set is not the configuration that ran. | `src/lib/workers/scanWorker.js:91-95` | anchor only | open — R3.4.4 |
| C7 | `display_name` is not written, so a scheduled scan and a manual scan of the same brand become two identities. | `src/lib/workers/scanWorker.js:1061` | anchor only | open — R3.4.3 |
| C8 | The `?batch=1` cron entry is missing, so the daily content batch never runs and nothing reports that it did not. | `vercel.json` | anchor only | open — R3.1.2 |
| C9 | Both worker gates failed open when `CRON_SECRET` was unset: a warning was logged once and the request allowed, leaving two budget-spending endpoints unauthenticated in production. | `src/app/api/scan/worker/route.js:29-47`; `src/app/api/content/worker/route.js:25-52` | **read** | **fixed, task blocked R0.1.1** — code landed, fail-closed in production; the task stays open until `CRON_SECRET` is set in Vercel and a live 401 is observed. **Residual half closed by R0.1.8**: the forgeable `x-vercel-cron` branch (`src/lib/cronAuth.js:49-56`, plus the `OK_VERCEL_CRON` reason) is deleted, so with the secret configured a caller presenting only that client-settable header is now refused (`DENY_BAD_SECRET`). The production cron entries in `vercel.json` therefore authenticate **only** via `CRON_SECRET` — Vercel attaches `Authorization: Bearer <CRON_SECRET>` when the variable is set on the project. Operator precondition: if `CRON_SECRET` is not set in the deployment, scheduled scans 401 rather than run. |
| C10 | `setup-supabase.mjs` has no migrations ledger and no transaction per file, so a partially-applied migration leaves an unknown schema. | `scripts/setup-supabase.mjs:52-96` | anchor only | open — R6.1.1 |
| C11 | The landing page presents fabricated figures as measurements. | `src/components/landing/AnswerSheet.jsx:63-65`; `src/app/page.js:126-129` | anchor only | open — R2.10.1 |
| C12 | `/chart-preview` self-described as "not a product route" and shipped a named third-party brand's real visibility trend on a public, un-noindexed page. | `src/app/chart-preview/page.js:17-30` — **file deleted**, see below | **read** | **closed R0.1.2** |

**Correction to C12 as written.** The audit says the route "renders a real
third-party brand's live trend from the production DB". It did not query the
database at request time — the values were hardcoded constants, copied out of
the DB by hand. The exposure is the same; the mechanism is not. The route was
deleted rather than gated, because gating leaves the customer's numbers in the
repository and in every build.

## Gaps — closed 2026-08-30, and the trap that is still open

**`B8`, `B9` and `B12` are now in the register.** From 2026-08-29 to
2026-08-30 they were not, and this section said so: the findings originate in a
companion document — *The Honesty Gap* (artifact `bbd113a7`) — which is **not
committed here**, and the only in-repo record of which findings exist is
`.claude/orchestration/tasks.json`, where each task lists the finding ids it
addresses. No task references B8, B9 or B12, so nothing in the tree carried
their description, mechanism or anchor.

**How the gap was closed.** The operator holding the artifact supplied the
three verbatim, with the anchors the audit recorded at commit `5111219`. They
were not pasted as given. Each anchor was re-read against source at HEAD before
its row was written, because the audit's own closing note says to re-verify
every line number and eight had already moved:

| Finding | Audit anchor (at `5111219`) | At `5d51aa3`, 2026-08-30 | Outcome, as judged on 2026-08-30 |
|---|---|---|---|
| B8 | `enginePipeline.js:510-515` | `enginePipeline.js:510-514` | resolves; `:515` is the blank line closing the block. Mechanism **corrected** — the artifact's "the aio definition it just proved unconfigured" is not what the code does; see *Correction to B8* above. |
| B9 | `scanWorker.js:432-439` | `scanWorker.js:472-479` | **moved** `+40`. Exact at `5111219` (confirmed with `git show`); the block was displaced by later work in the same file. Mechanism reproduces as written. **Superseded 2026-09-05: it no longer does — see *B9 no longer runs silently*.** |
| B12 | `db.js:5-8`, `:289` | `db.js:11-15`, `:298` | **moved** `+7` / `+9`, by `4f7b6b6` adding the `duplicateScan` imports at `:4-9`. Mechanism reproduces in full; see *Note on B12* above. **Superseded 2026-09-05: half of it does — see *B12: the silent skip is gone*.** |

B9's stale anchor is the reason this mattered. At HEAD **as of 2026-08-30
(`5d51aa3`)**, `scanWorker.js:432-439` still resolved — to the "Prepared N
queries" log and the head of the sourcing checkpoint. A reader who trusted the
number would have written up a real, different piece of code as B9 and never
known.

> **The word "HEAD" in that sentence has since moved, which is the joke.** At
> `1a5ed81` (2026-09-05) `scanWorker.js:432-439` resolves to neither the old
> code nor the new: it is a comment about heartbeat failure being tolerated. So
> this paragraph, written to warn about a stale anchor, went stale in the same
> way inside six days. **Never write "at HEAD" in a dated document — name the
> commit.** That is the whole recommendation this file has to offer R6.4.8.

Both B8 and B9 were also traced to an entry point before being described as
live, under standing rule 10 — see *Liveness of B8 and B9* above. This is not
ceremony: the nearest plausible consumer of B8's code, `runMultiEngineScan`,
is dead.

**The renumbering trap is still live.** `docs/plans/production-plan.md`
contains sections also labelled `B8` and `B9` ("Remaining input/output
hygiene", "Dependency patching"). They belong to that document's own scheme and
are **unrelated** to the audit's finding ids. They were not used here and must
not be: the rows above come from the artifact and from source, not from that
file.

**What is still missing.** Closing the documentation gap did not create the
work. No rebuild task references B8, B9 or B12, so all three rows read `open —
no task`. Until a task claims them they are recorded and unowned, which is a
better state than unrecorded, and not the same as fixed.

---

## Appendix — anchors that had already moved

The audit's own closing note says to re-verify its line numbers before acting on
them. Checked when this register was written (2026-08-29), eight anchors no
longer resolved. Re-checked when B8, B9 and B12 were pasted in from the
companion artifact (2026-08-30), three more had moved — **eleven in total**:

| Finding | Audit said | Actually at |
|---|---|---|
| A4 | `src/lib/scoring/interlocking.js:98-113` | `src/components/dashboard/interlocking.js` |
| A6, A7 | `src/components/dashboard/Sidebar.jsx:138-143` | `src/components/perceev/Sidebar.jsx` |
| A8, A9 | `src/components/charts/Donut.jsx:29-44` | `src/components/perceev/charts/Donut.jsx` |
| B1 | `worker/` | no such directory; the extractor lives in `src/lib/engines/perplexity.js` |
| B9 | `src/lib/workers/scanWorker.js:432-439` | `:472-479` — the old range still resolves, to unrelated code |
| B12 | `src/lib/db.js:5-8` | `:11-15` (shifted by `4f7b6b6`) |
| B12 | `src/lib/db.js:289` | `:298` |
| C4 | `docs/vendors/` | does not exist yet; created by R5.1.1 |
| C12 | `src/app/chart-preview/page.js` | deleted by R0.1.2 |

---

# Entry #3 — 2026-08-30 — the dead registry that stopped parsing

`src/lib/engines/adapter.js` and `src/lib/scoring/probe.js` are deleted.

They were a second, parallel engine registry, superseded by
`src/lib/scoring/enginePipeline.js`. `adapter.js:3` imported `probeOpenAI` from
`./openai.js`, which has never exported it — `openai.js` exports exactly
`isChatGptConfigured` and `probeChatGpt`. So both modules threw
`SyntaxError: The requested module './openai.js' does not provide an export
named 'probeOpenAI'` on import, and had done since `a1ed0e0`.

This was **not** an outage. Nothing imported `probe.js`, and the only importer of
`adapter.js` was `probe.js` itself. The live scan path runs through
`enginePipeline.js`, which imports `probeChatGpt` correctly and loads clean.

The point worth keeping is *why nobody noticed*. A module in the source tree
stopped parsing entirely and the suite stayed green, because no test imported
it. A green suite is evidence only about the code it actually loads — the same
lesson as S29, where 57 tests sat outside the glob, and the reason
`testCoverageGuard.test.mjs` exists.

**Test count before: 880 passing. After: 880 passing.** Unchanged, which is the
measurement that matters here: deleting these files removed no coverage,
because they had none. Neither file had a test. `npm run build` still exits 0.

| | Before | After |
|---|---|---|
| Tests | 880 pass / 0 fail | 880 pass / 0 fail |
| Files that throw on import | 2 | 0 |
| Engine registries | 2 (one unreachable) | 1 |

Evidence for R6.5.2's remaining deletions: this pair is the sharpest case, but
it is unlikely to be the only dead code the suite cannot see.

---

# Entry #4 — 2026-08-30 — the tracker rendered its own false success

`b46358d` changed the tracker renderer, and no ledger task covered it. This
entry is that record (R6.1.3).

**What changed.** `.claude/orchestration/orchestrate.mjs:436` now reads:

```js
const evLabel = t.status === "done" ? "closed at" : "submitted";
```

Before it, every task carrying evidence rendered as `— closed at <file:line>`,
regardless of status. A task sitting in verification — evidence submitted, not
yet checked by anyone — appeared in the generated tracker as closed, with a
citation next to it. The tracker is the artifact a reader consults to answer
"what is done", and it was answering wrongly in exactly the direction that
flatters progress.

That is the false-success class this rebuild exists to remove, appearing inside
the tool built to remove it. The same shape as `check-secrets.mjs` reporting a
vendor healthy without reading the zone it short-circuits on, and as
`setup:db`'s verify list passing on a database missing 006.

**Why it needed its own entry.** The change was correct and shipped inside a
docs commit about the Bright Data ADR, with the regenerated tracker swept along
with it. Nothing in the ledger pointed at it, so it could not be attributed
from the record — you could see the renderer was right, but not when it became
right or who decided. Caught by the R0.2.4 verifier.

**Standing rule 9**, already in force, is the general form: *a change to the
orchestration tooling is itself ledger work — the machine is not exempt from
the discipline it enforces.*

---

# Entry #5 — 2026-09-05 — this file's own citations became the bug it catalogues

**Mechanism:** a `file:line` that still resolves after the line moved.

Filed under R6.3.3. This entry is about `docs/BUILD_JOURNAL.md` and
`docs/HANDOFF-2026-08-30.md`, and it is here because the failure they developed
is the one this file exists to name: **a citation that was wrong looked exactly
like a citation that was right.** Not a broken link, not a 404 — a line number
that resolves cleanly, to plausible neighbouring code, with nothing to tell the
reader they are in the wrong place.

## The measurement

Every backticked `file:line` in both documents **as they stood at `1a5ed81`**,
resolved against that commit and then **read** — existence was never the test.
The corrections R6.3.3 added afterwards are excluded from the count.

| | Journal | Handoff | Both |
|---|---|---|---|
| Line citations | 111 | 8 | **119** |
| Resolve to a real line | 106 | 7 | **113** |
| Name a missing file (fail loudly) | 5 | 1 | **6** |
| ...of those, already labelled deleted/moved | 5 | 0 | 5 |
| Of those that resolve: still describe the claim | 26 | 0 | **26** |
| Of those that resolve: land on unrelated code | 70 | 7 | **77** |
| Of those that resolve: labelled "audit said", stale on purpose | 10 | 0 | 10 |

**113 of 119 resolve. 26 are right.** A checker that asks "does this line
exist" passes 95% of a document that is 22% accurate. That gap is the finding.

The cause is not neglect, it is velocity. Between `5d51aa3` (2026-08-30) and
`1a5ed81` (2026-09-05), `src/lib/scoring/enginePipeline.js` went 625 → 1,132
lines and `src/lib/workers/scanWorker.js` 1,181 → 2,545. Six days. Nothing
short of a symbol anchor survives a file doubling.

## What was wrong when written, and what merely expired

Two categories, treated differently, because renumbering a dated document is
itself a falsification — it re-points a historical record at code that did not
exist when the record was made.

**Wrong at the authoring commit** (corrected inline, correction labelled):

- `HANDOFF-2026-08-30.md`, `R0.1.10`: `check-secrets.mjs:79` never called
  `get_all_zones`. At `3c9d3f2` the call was `:76`; `:79` was
  `if (!res.ok) return fromResponse(res);`.
- `HANDOFF-2026-08-30.md`, `R1.7.4`: `:198` and `:250` were each one line high —
  the enclosing `Promise.race([` and `try {` rather than the `paaFn(` call that
  does the spending, which sat on `:199` and `:251`.

**Right when written, then outlived** (given a declared commit and a symbol
anchor, never renumbered): everything else, including the whole *Liveness of B8
and B9* chain, whose seventeen citations are down to three survivors while the
argument they support is still sound.

## Three things changed underneath the register without touching it

None of these came from a task that knew it was touching this file. That is the
part worth generalising.

1. **B9 stopped reproducing.** `25e7727` (R3.2.2) and `3e37c92` (R3.2.5) made
   the silent engine-set substitution loud. B9's row said `open — no task` for
   six days after it was fixed by two tasks aimed at something else.
2. **Half of B12 stopped reproducing.** `6fc5b61` (R2.8.6) turned
   `insertScan`'s "Skipping database insert" into a throw. The row still
   described the log line.
3. **A live entry point was added.** `runScanChunk` is now dispatched from
   `GET /api/scan/[job_id]/status` as well as `POST /api/scan` and
   `GET /api/scan/worker`. The liveness paragraph asserting "**two** entry
   points" was not wrong when written and is wrong now — the direction that
   *understates* exposure, which is why nobody noticed.

Ten register rows also read `open — <task>` for a task the ledger has since
marked `done`: A10, A11, A12, B1, B5, C1, C2, C4, C10, C11. Those cells were
**not** flipped here. This task verified citations, not fixes; asserting a
mechanism is gone because a ledger row says `done` would be exactly the
transcription-over-verification failure the handoff warns about. Trust
`orchestrate.mjs show <id>` for status and re-derive the mechanism before
writing `closed` into a row.

## What this hands to R6.4.8

The doc-to-source staleness tripwire is a separate task and is not built here.
What this sweep establishes about its requirements:

- **Existence is not the check.** 113 of 119 citations resolve. A tripwire that
  only asserts "file exists, line ≤ line count" would have passed this document
  in the state described above, and would have said so with a green tick.
- **The check has to be content-shaped.** The workable form is a quoted
  fragment or a symbol name next to the number — `enginePipeline.js:149
  ("[aio] Query failed")`, which is where that warn sits at `1a5ed81` — so the
  tripwire can assert the line still contains
  it, and fail with "moved to :NNN" rather than "ok".
- **Dated documents need an exemption with a declared commit.** A handoff is
  *supposed* to describe an old tree. The tripwire should resolve its citations
  against the declared commit and fail only when the commit is missing or
  undeclared — otherwise it will nag forever and be muted, which is worse than
  absent.
- **`at HEAD` must be a lint failure in prose.** Three sentences in this file
  said "at HEAD" meaning three different commits. Grep for it.
- **Source comments drift too, and nothing watches them.**
  `src/lib/engines/deployedEngines.js:21` cites `enginePipeline.js:527` for
  `resolveEnabledEngines`, which lives at `:979`. The tripwire's input should be
  `file:line` citations *in code comments*, not only in `docs/`.
- **The tree moves under the checker.** While this sweep ran,
  `src/lib/db.js`, `src/lib/workers/scanWorker.js` and `src/middleware.js` were
  all modified uncommitted by other agents; `insertScan` sat at `:126` in
  `1a5ed81` and `:149` in the working tree, a 23-line divergence inside one
  session. The tripwire must resolve against a commit, never the worktree, or it
  will report failures that belong to somebody else's unfinished edit.

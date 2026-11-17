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
`src/shared/scoring/computeVisibilityScore.js` looked harsh enough to explain it,
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

> ## The Anchor and Status columns below expired. Read this before following a row.
>
> **The Status column is stale on ten rows.** `A10`, `A11`, `A12`, `B1`, `B5`,
> `C1`, `C2`, `C4`, `C10` and `C11` read `open — <task>` for a task the ledger
> has since marked `done`. Those cells were deliberately **not** flipped: R6.3.3
> verified citations, not fixes, and asserting a mechanism is gone because a
> ledger row says `done` is exactly the transcription-over-verification failure
> this file exists to catalogue. Trust `node
> .claude/orchestration/orchestrate.mjs show <id>` for task status, and
> re-derive the mechanism from source before writing `closed` into a row.
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
> **Second pass at `8e6ecc6` on 2026-09-12 under R6.3.6, and what it did NOT
> cover.** R6.3.6 was scoped to the *unpinned present-tense assertions* in this
> file and in `docs/HANDOFF-2026-08-30.md` — the three sentences this file had
> enumerated as saying "at HEAD", plus the claims that carry no line number at
> all: counts, task statuses, and commands quoted with an expected answer.
> Claims found rotted now carry a correction dated 2026-09-12 naming `8e6ecc6`.
> **`grep -n R6.3.6` on either file lists every one**; that grep, not a number
> written here, is the index — a count in this sentence would be the next thing
> to rot. **Five in this file:** the *Note on B12* opener, Entry #3's count of
> `openai.js` exports, the R6.4.8 bullet's `resolveEnabledEngines` line number,
> *What is still missing*'s "all three rows read `open — no task`", and the
> appendix cell saying `docs/vendors/` does not exist. The handoff's are listed
> in its own header. **The 111
> line citations were NOT re-counted.** The tally above is still the `1a5ed81`
> measurement and should be read as a lower bound on the drift, since two more
> weeks of commits have landed on top of it. Do not quote it as current.
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
  2026-08-30 and their anchors re-verified against source at `5d51aa3`, the
  branch tip that day *(pinned 2026-09-12, R6.3.6; this sentence said "at HEAD"
  and was one of the three the file had enumerated as an open defect)* — see
  *Gaps* at the end for exactly how, and for the trap that still sits next to
  them.
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
| A1 | Per-engine summaries carry no `state`/`state_reason`, so an engine that returned nothing is indistinguishable from one that measured zero. | `src/shared/scoring/enginePipeline.js:298-308` | anchor only | open — R2.1.1 |
| A2 | A fully-errored engine contributes to the blend instead of rendering `failed`, so a dead engine drags the headline as if it had measured 0%. | `src/components/dashboard/DashboardShell.jsx:299-301` | anchor only | open — R2.1.4 |
| A3 | No UI vocabulary for did-not-report / not-assessed / small-sample; `engines_counted` is never rendered, so the reader cannot tell how many engines are behind a number. | `src/components/dashboard/DashboardShell.jsx:616-621` | anchor only | open — R2.1.3 |
| A4 | An engine gauge with zero rows renders a gauge rather than "no data". | `src/components/dashboard/interlocking.js:98-113` **moved** (audit said `src/lib/scoring/interlocking.js`) | anchor only | open — R2.8.2 |
| A5 | Studio and Opportunities render recommendations without gating on whether the underlying scan had usable data. | `src/components/studio/OpportunitiesPanel.jsx:20-28` | anchor only | open — R2.8.1 |
| A6 | Hero, history, sidebar and homepage each select the headline score differently, so the same scan reads as four different numbers. | `src/server/db.js:242-286`; `src/components/perceev/Sidebar.jsx:138-143` **moved** (audit said `src/components/dashboard/Sidebar.jsx`) | anchor only | open — R2.4.2 |
| A7 | Those selectors do not honour the data-quality gate, so a gated scan still publishes a headline. | `src/server/db.js:242-286`; `src/components/dashboard/DashboardShell.jsx:570-597` | anchor only | open — R2.4.2 |
| A8 | `generateContent` returned `{ text: "" }` on a missing key or exhausted retries, so a total LLM outage was indistinguishable from an empty answer — the origin of the false 100% Share of Voice. | `src/server/openrouter.js:22-25`, `:124-125` | **read** | **closed R0.3.1** |
| A9 | With no rivals extracted the roster is `[self]`, so share of voice computes self ÷ self = 100% and the Rivals view asserts "no rival brands were co-mentioned" — a positive claim about answers nobody looked at. | `src/components/perceev/charts/Donut.jsx:29-44` **moved** (audit said `src/components/charts/Donut.jsx`); `src/components/dashboard/RivalsView.jsx:44-46`; `src/components/dashboard/VisibilityVerdictPanel.jsx:51-58`; `src/server/workers/scanWorker.js:692-698` | **read** | **closed R0.3.2, R0.3.3** |
| A10 | SourcesView reads pre-v9 field names, so multi-engine scans render empty sources rather than an error. | `src/components/dashboard/SourcesView.jsx:12-15` | anchor only | open — R2.7.2 |
| A11 | An unknown job status rewinds the progress bar to 0% instead of reading "reconnecting". | `src/app/api/scan/[job_id]/status/route.js:28-33` | anchor only | open — R2.8.3 |
| A12 | A database outage renders as "no scans yet" — an empty state indistinguishable from a healthy new account. | `src/app/dashboard/[brand]/page.js:52-57` | anchor only | open — R2.8.4 |

## B — the pipeline produces something untrue

| # | Mechanism | Anchor | Verified | Status |
|---|---|---|---|---|
| B1 | The Perplexity extractor is not a pure, fixture-tested function, so extraction regressions surface as plausible data rather than as test failures. | `src/shared/scoring/enginePipeline.js:154-157` | anchor only | open — R2.2.1 |
| B2 | A failed Perplexity citation leg leaves citations looking complete instead of marking them unverified. | `src/shared/engines/perplexity.js:147-160` | anchor only | open — R2.2.2 |
| B3 | Finalize had no roster continuity: an unavailable extractor produced an empty roster that read as "no rivals exist", and `scans.competitors` was never written despite the column existing since migration 001. | `src/server/workers/scanWorker.js:653`, `:868-914` | **read** | **closed R0.3.3** |
| B4 | Top-level scan fields are single-engine values on a multi-engine scan, so the headline silently describes one engine. | `src/shared/scoring/enginePipeline.js:583-613` | anchor only | open — R2.4.1 |
| B5 | `upsertPrompts` returns `{ error }` instead of throwing; callers treat the envelope as a value. A fail-soft create is how a write that never happened reads as one that did. | `src/server/db/prompts.js:96-100` | anchor only | open — R2.2.3 |
| B6 | Same defect as A8, from the pipeline side: missing key and exhausted retries both returned empty text. | `src/server/openrouter.js:22-25`, `:124-125` | **read** | **closed R0.3.1** |
| B7 | A new brand with no LLM silently fell back to the hardcoded per-industry prompt pack, and the resulting scan published as if the questions had been generated for that brand. | `src/shared/scoring/promptGen.js` (industry-pack top-up); `src/server/workers/scanWorker.js` sourcing | **read** | **closed R0.3.4** |
| B8 | "No engines enabled!" runs one anyway: when every requested engine is skipped as unconfigured, the resolver warns and returns `aio` regardless — an engine the operator did not ask for, whose configuredness is the hardcoded constant `isConfigured: () => true`, so an aio run with no Bright Data key resolves as "enabled" and every query lands in `probeAio`'s catch as a complete zero-valued row. | `src/shared/scoring/enginePipeline.js:510-514` (audit said `:510-515`; `:515` is the blank line closing the block); the constant at `:450`; the swallowing catch at `:98-101` — **all three stale at `1a5ed81`; anchor on `resolveEnabledEngines`, the `aio` entry in `ENGINE_REGISTRY`, and `probeAio`** | **read** at `5d51aa3`; **re-derived 2026-09-05** | open — no task; **partly recorded since** — see *Correction to B8* and *Since, on B8* below |
| B9 | The frozen engine set can be silently replaced mid-run. Sourcing freezes the resolved engine names onto the checkpoint precisely so a resume cannot re-resolve them, then probing discards that freeze: if no frozen name matches the live registry, `engineDefs` falls back to whatever is enabled today, with no warning and nothing recorded on the scan. | `src/server/workers/scanWorker.js:472-479` **moved** (audit said `:432-439`, which was exact at `5111219`); the freeze contract it voids is stated at `:364-370` — **both stale at `1a5ed81`; anchor on `runProbingPhase` and the `frozenNames`/`filtered` pair** | **read** at `5d51aa3`; **re-derived 2026-09-05** | **does not reproduce as written** — see *B9 no longer runs silently* below |
| B10 | `insertScan` has a three-tier column-drop cascade: an insert that fails silently retries with fewer columns, so a scan can persist with fields quietly missing. | `src/server/db.js:122-167` | **read** | open — R2.2.4 |
| B11 | `hasActiveScanForBrand` fails open on any DB error and leaves a TOCTOU window, so two concurrent requests could each start a full-budget duplicate scan. | `src/server/db.js:403-408` | **read** | **closed R0.1.5** |
| B12 | No Supabase env gives a memory mode that "works": the client is null, so scan jobs live only in a per-instance `global.memoryJobs` map, `insertScan` logs "Skipping database insert" and returns, and every read returns empty. The scan completes and reports success, nothing persists, the dashboard is permanently empty rather than erroring, and two serverless instances disagree about the same job. | `src/server/db.js:11-15` **moved** (audit said `:5-8`) and `:298` **moved** (audit said `:289`); the silent skip at `:62-65`; empty reads at `:180-182` and `:252` — **of these five, only `:11-15` still resolves to what it claims at `1a5ed81`; anchor on `insertScan`, `resolveClient` and `global.memoryJobs`** | **read** at `5d51aa3`; **re-derived 2026-09-05** | **partly fixed** — the silent-skip half is gone (R2.8.6) and the accept-the-scan half is gone (R0.1.21); the memory-store code survives but no route can reach it at `8e6ecc6`. See *B12: the silent skip is gone, the memory store is not* below, including the 2026-09-12 update |
| B13 | A fabricated `studio.perceev.app` URL is presented to the user as a real published location. | `src/app/api/content-items/[id]/decision/route.js:19-27` | **read** — anchors still exact at `4323f78` | **partly fixed** — R5.2.1 deleted the synthesizer and the approval-time `content_events` write, and made the decision response say `published: false, url: null, reason: "approved_not_published"`; `GET /api/content-events` now nulls the lift on any surviving fabricated-host row (`fabricated_url: true`) instead of serving a number computed against a page that never existed. Rows written before the deletion are **not** migrated away. Open: R5.2.2 (real, verified publish URL) and R5.2.3 (lift copy) |

**Liveness of B8 and B9 (standing rule 10).** *Line numbers in the next two
paragraphs are a snapshot of `5d51aa3` (2026-08-30). Re-derived at `1a5ed81` on
2026-09-05: of the seventeen, only three still land on what they name —
`src/app/api/scan/route.js:13` and `:62`, and `src/shared/engines/types.js:47`.*

> **Correction — the liveness trace below was incomplete when it was made.**
> *(2026-09-05, R6.3.3, after a verifier rejected the first version of this
> correction.)*
>
> `runScanChunk` has **three** live entry points, not two — and it had three at
> `5d51aa3`, the commit the paragraph below declares as its own snapshot. The
> third is `GET /api/scan/[job_id]/status`, dispatching it as a poll-driven
> rescue. Re-derived against the declared commit, not the worktree:
> `git show 5d51aa3:'src/app/api/scan/[job_id]/status/route.js'` puts the
> import on `:3` and `runScanChunk(job.id)` on `:57`, inside the exported `GET`
> handler (`:8`), gated by `shouldRescueJob` — real logic at
> `scanWorker.js:317-321` at that commit, not a stub — on a route the client
> polls in a loop (`src/shared/api.js:778` at `5d51aa3`). It has dispatched
> `runScanChunk` since `9580782` (2026-07-24), which
> `git merge-base --is-ancestor 9580782 5d51aa3` confirms is an ancestor of the
> declared commit. Reproduce with
> `git log -S runScanChunk --oneline -- 'src/app/api/scan/[job_id]/status/route.js'`,
> which returns exactly that one commit.
>
> **The first version of this correction said the third entry point had been
> *added* since, and that the paragraph "was not wrong when written and is
> wrong now". That was false.** Nothing was added. The original
> standing-rule-10 trace found two of the three call sites and stopped, and
> this file then wrote the result up as a completed liveness check. So this is
> not drift and must not be filed as drift: it is a claim that was **wrong at
> its own declared commit**, and it is the third such claim in this document
> set, not one of two — see *What was wrong when written* in Entry #5, and the
> R6.4.8 bullet on why declared-commit-plus-symbol anchoring would not have
> caught it.
>
> The error understates exposure: B8 and B9 were more live than this section
> claimed, on 2026-08-30 as much as today. That direction is why it survived
> the original write, a full re-derivation, and a first attempt at this very
> correction.

*Follow it by symbol, not by number: `resolveEnabledEngines` (four call sites:
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
entry points — ***wrong at this paragraph's own commit; it was three. See the
correction above*** — `POST /api/scan` (`src/app/api/scan/route.js:13`, firing at
`:62`) and `GET /api/scan/worker` (`src/app/api/scan/worker/route.js:39`,
firing at `:60` and `:94`), the latter being a cron entry in `vercel.json`
(`/api/scan/worker`, `0 0 * * *`). The missing third is
`GET /api/scan/[job_id]/status`, `:57` at `5d51aa3`.

The fourth call site is **dead**: `runMultiEngineScan`
(`enginePipeline.js:533`, resolving at `:534`) has no importer anywhere in
`src/` — `docs/plans/production-plan.md` E1.4 already lists it as a dead export
to delete. It sits nineteen lines below B8's anchor and reads like the obvious
consumer, and it is not. This is the same trap as the `adapter.js`/`probe.js`
pair (`src/shared/engines/types.js:47` computes engine availability from
`BRIGHTDATA_API_KEY`, but its only consumer is `src/lib/scoring/probe.js`,
which nothing live imports). Do not cite the dead consumer as proof either
finding runs; cite the worker chain above.

**Correction to B8 as written.** *Every line number in this paragraph is a
snapshot of `5d51aa3` (2026-08-30) and **none of them resolves to what it names
at `8e6ecc6`** — `enginePipeline.js` has more than doubled again since. Pinned
2026-09-12 under R6.3.6; the paragraph is not renumbered, because renumbering a
dated correction re-points it at code that did not exist when it was made. Every
mechanism it describes was re-derived by symbol at `8e6ecc6` and all of them
still hold: `aio`'s `isConfigured: () => true` inside `ENGINE_REGISTRY`,
`brightDataSearch` throwing `"Bright Data SERP is not configured (set
BRIGHTDATA_API_KEY)."` in `src/shared/engines/brightdata.js`, and `probeAio`'s
`catch` logging ``[aio] Query failed`` in `src/shared/scoring/enginePipeline.js`.
Follow those names, not the numbers below.*

The companion artifact says the resolver
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
"Bright Data SERP is not configured" (`src/shared/engines/brightdata.js:139-140`),
`probeAio` catches it per query (`enginePipeline.js:98-101`), and each query
returns a fully-populated row with `answer_present: false`, `visible: false`
and `cost: 0`. A completely unconfigured engine therefore produces a full set
of measured-looking zeroes rather than a failure.

**Note on B12 — written 2026-08-30, and its headline was wrong by 2026-09-12.**

*This note opened "The finding reproduces in full at HEAD." It did, at
`5d51aa3`. It does not at `8e6ecc6`, and the word `HEAD` is why nobody noticed:
the sentence stayed literally true-looking while the tree moved under it. This
is the second of the three unpinned at-HEAD sentences the file enumerated, now
resolved rather than re-enumerated (R6.3.6).*

**What B12 asserted.** On the trigger the artifact names — *no Supabase env* —
the job store silently degrades to memory, `insertScan` skips, reads come back
empty, and the deployment reports success. **Every one of those four clauses has
since been closed or made unreachable**, by several separate tasks — `R2.8.6`,
`R2.8.7`, `R2.8.12`, `R0.1.21` — none of which was aimed at B12, and no task in
the ledger lists B12 among its `findings` at all. Re-derived at `8e6ecc6`, by
symbol:

- **The silent skip is gone.** `insertScan` throws `ScanWriteError` with
  `code: "db_not_configured"` when `resolveClient` yields no client — see
  *B12: the silent skip is gone, the memory store is not* below for the full
  derivation and for the past-tense-comment trap that makes a grep read the
  wrong way.
- **The deployment no longer accepts the scan.** `POST /api/scan` refuses with
  a 503 `scan_store_unavailable` on `!supabase`, *before* `createScanJob` and
  before any vendor spend — `scanStoreUnavailable` in
  `src/app/api/scan/route.js`, landed by **R0.1.21** (ledger: `done`). The cron
  entry point refuses too: `GET /api/scan/worker` returns
  `{ mode: "no-db", dispatched: 0 }` on `!supabase`, and that check sits ahead
  of the `runSweepMaintenance` call, so the scheduler tick — `createScanJob`'s
  only other non-test caller, via `runSchedulerTick` — never runs either.
  **Those are `createScanJob`'s only two non-test call sites at `8e6ecc6`**, so
  no HTTP path can now put a job into the memory store. Re-derive with
  `git grep -n createScanJob 8e6ecc6 -- src/ | grep -v test.mjs` and discard
  the comment mentions and the `export function` line itself; what remains is
  `src/app/api/scan/route.js` and `runSchedulerTick`'s `deps.createScanJob ||
  createScanJob` in `src/server/workers/scanWorker.js`.
- **The reads refuse instead of coming back empty.** `getScansForBrand` and
  `getScansByDomain` both throw `ScansUnavailableError` with
  `code: "db_not_configured"` when there is no client — the second one's message
  says so in as many words: *"This is a refusal to look, not a domain with no
  scans."* `R2.8.12` closed the last `if (!client) return []` here, and the
  contract comment above `getScansByDomain` records it. `listRecentScans` throws
  the same error on `!supabase` too. **But the refusal does not necessarily reach
  the screen, and that is not B12's clause — it is the layer above it.**
  `listRecentScans` still ends `catch { console.warn(...); return []; }`, which
  covers a *query* error rather than the unconfigured case, and its own contract
  comment in `src/server/db.js` records — as a measurement, not an assumption —
  that `GET /api/history`'s catch turns the refusal into a `200
  { scans: [], runs: [], activeJobs: [], counts: {} }`, so the log tells the
  truth and the workspace still renders empty. **`R2.8.16` is `in_verification`
  for exactly that pair as of 2026-09-12** and `src/app/api/history/route.js` is
  uncommitted in the working tree while another agent works it, so this bullet
  states the ledger position and deliberately asserts nothing about whether it
  is fixed. Check the task, not this sentence.
- **A neighbouring trigger was already gone before the audit.** `480fd9a` made
  the job store DB-authoritative, so a transient DB error on a **configured**
  deployment throws instead of tipping the job into `global.memoryJobs`. The
  mechanism is written up in the doc comment above `resolveClient` in
  `src/server/db.js` (headed *"Scan job store — DB-authoritative, fail-loud"*);
  it was cited here as `src/server/db.js:300-318`, which at `8e6ecc6` resolves to
  `isSchemaMismatch`'s JSDoc instead — the same rot this entry is about.

**What still exists, and why that is not the same as reproducing.** The memory
mode itself is unchanged.
`export const supabase = supabaseUrl && supabaseKey ? createClient(...) : null`
still yields `null`, `hasDb` is still `!!client`, and `global.memoryJobs` is
still the only store on that branch — five `hasDb = !!client` guards at
`8e6ecc6`, none at the line numbers this note originally cited (`:347`, `:426`,
`:457`, `:473`, `:530`; they are hundreds of lines further down now, which is
why the anchor is the symbol). What changed is *reachability*, not the code:
the branch survives and is exercised by the test suite and by injected
`deps.client`, and is no longer reachable from a route.

**`/api/health` is still a report, not a gate.** Supabase is declared
`required: true` — but in `src/server/vendorRegistry.js`, not in `src/server/health.js`
where this note cited it: **R0.1.16** moved the one vendor list there and
`health.js` now re-exports `VENDORS` from it. The report is consumed only by
`src/app/api/health/route.js` and by `health.test.mjs`/`envTruth.test.mjs`/
`checkSecrets.test.mjs` (`git grep -ln 'buildHealthPayload' 8e6ecc6 -- src/`),
so nothing on the scan path reads it. The refusal above is what actually gates;
health still only describes.

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
`src/server/db.js` and why that hit proves the opposite of what it looks like. The
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

**Update — 2026-09-12, at `8e6ecc6` (R6.3.6). The memory store is now
unreachable, which is not the same as gone.** The paragraph above is still
accurate about the *code*: `supabase` is still `null` without env, `hasDb` is
still `!!client`, `global.memoryJobs` is still the only store on that branch,
and five `hasDb = !!client` guards remain. What changed is that nothing can
reach them from a route. **R0.1.21** (ledger: `done`) put a 503
`scan_store_unavailable` refusal in front of `createScanJob` in
`src/app/api/scan/route.js` — see `scanStoreUnavailable` and the `!supabase`
check immediately above the `createScanJob` call — and `GET /api/scan/worker`
returns `{ mode: "no-db", dispatched: 0 }` on `!supabase` ahead of its
`runSweepMaintenance` call, which is the only route into `runSchedulerTick`,
`createScanJob`'s other non-test call site. So the surviving half of B12 is now
**latent, not live**: the branch exists, is covered by tests and by injected
`deps.client`, and cannot be entered by an HTTP request at `8e6ecc6`. Stated
this way on purpose — "does not reproduce" would be wrong (the code is there and
a new caller re-arms it) and "reproduces" would be wrong (no request reaches
it). Anchor by symbol: `scanStoreUnavailable`, `runSweepMaintenance`,
`runSchedulerTick`.

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
| C1 | A `new Date()` fallback for a missing timestamp makes "we do not know when this was collected" render as "collected just now". | `src/shared/api.js:550` | anchor only | open — R2.7.3 |
| C2 | The collection window is neither persisted nor rendered, so a reader cannot tell what period a number covers. | `src/server/workers/scanWorker.js:411` | anchor only | open — R2.7.4 |
| C3 | The weekly report is not metered per brand per day. | `src/shared/content/weeklyReport.js:22-40` | anchor only | open — R3.6.3 |
| C4 | An unpriced model id costs $0 rather than failing loud, so spend under-reports silently. | `src/server/openrouter.js:28-29`, `:101` | anchor only | open — R3.6.1 |
| C5 | A skipped scheduled scan does not bump `next_run_at` and writes no skip row, so a schedule that never fires looks the same as one with nothing due. | `src/server/workers/scanWorker.js:1059-1062` | anchor only | open — R3.4.2 |
| C6 | The worker ignores per-brand `prompt_target`, `engines` and `geo`, so the configuration a user set is not the configuration that ran. | `src/server/workers/scanWorker.js:91-95` | anchor only | open — R3.4.4 |
| C7 | `display_name` is not written, so a scheduled scan and a manual scan of the same brand become two identities. | `src/server/workers/scanWorker.js:1061` | anchor only | open — R3.4.3 |
| C8 | The `?batch=1` cron entry is missing, so the daily content batch never runs and nothing reports that it did not. | `vercel.json` | anchor only | open — R3.1.2 |
| C9 | Both worker gates failed open when `CRON_SECRET` was unset: a warning was logged once and the request allowed, leaving two budget-spending endpoints unauthenticated in production. | `src/app/api/scan/worker/route.js:29-47`; `src/app/api/content/worker/route.js:25-52` | **read** | **fixed, task blocked R0.1.1** — code landed, fail-closed in production; the task stays open until `CRON_SECRET` is set in Vercel and a live 401 is observed. **Residual half closed by R0.1.8**: the forgeable `x-vercel-cron` branch (`src/server/cronAuth.js:49-56`, plus the `OK_VERCEL_CRON` reason) is deleted, so with the secret configured a caller presenting only that client-settable header is now refused (`DENY_BAD_SECRET`). The production cron entries in `vercel.json` therefore authenticate **only** via `CRON_SECRET` — Vercel attaches `Authorization: Bearer <CRON_SECRET>` when the variable is set on the project. Operator precondition: if `CRON_SECRET` is not set in the deployment, scheduled scans 401 rather than run. |
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
were not pasted as given. Each anchor was re-read against source at `5d51aa3`,
the branch tip on 2026-08-30, before its row was written, because the audit's
own closing note says to re-verify every line number and eight had already
moved. *(That sentence read "at HEAD" until 2026-09-12; pinned under R6.3.6 —
the third of the three the file had enumerated.)*

| Finding | Audit anchor (at `5111219`) | At `5d51aa3`, 2026-08-30 | Outcome, as judged on 2026-08-30 |
|---|---|---|---|
| B8 | `enginePipeline.js:510-515` | `enginePipeline.js:510-514` | resolves; `:515` is the blank line closing the block. Mechanism **corrected** — the artifact's "the aio definition it just proved unconfigured" is not what the code does; see *Correction to B8* above. |
| B9 | `scanWorker.js:432-439` | `scanWorker.js:472-479` | **moved** `+40`. Exact at `5111219` (confirmed with `git show`); the block was displaced by later work in the same file. Mechanism reproduces as written. **Superseded 2026-09-05: it no longer does — see *B9 no longer runs silently*.** |
| B12 | `db.js:5-8`, `:289` | `db.js:11-15`, `:298` | **moved** `+7` / `+9`, by `4f7b6b6` adding the `duplicateScan` imports at `:4-9`. Mechanism reproduces in full; see *Note on B12* above. **Superseded 2026-09-05: half of it does — see *B12: the silent skip is gone*. Superseded again 2026-09-12 at `8e6ecc6`: the surviving half is latent, not live — R0.1.21 refuses the request before `createScanJob`.** |

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
> commit.** That was recorded on 2026-09-05 as the whole recommendation this
> file had to offer R6.4.8. **It is no longer the main one**: a later pass the
> same day found an error that a declared commit would not have caught, because
> it was wrong at the declared commit. See *What this hands to R6.4.8* in Entry
> #5.

Both B8 and B9 were also traced to an entry point before being described as
live, under standing rule 10 — see *Liveness of B8 and B9* above. This is not
ceremony: the nearest plausible consumer of B8's code, `runMultiEngineScan`,
is dead. **But that trace was incomplete**: it found two of `runScanChunk`'s
three live entry points and stopped, and the omission stood in this file from
`5d51aa3` until it was corrected under R6.3.3 on 2026-09-05. Following the rule
proved these findings are live; it did not measure how live, and the file said
nothing to flag the difference.

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

> **Half of that is still true and half is not — 2026-09-12 (R6.3.6).** The
> *ownership* claim holds: at `8e6ecc6` no task's `findings` array contains B8,
> B9 or B12 (`node -e 'const g=require("./.claude/orchestration/tasks.json");
> for (const id of ["B8","B9","B12"]) console.log(id,
> g.tasks.filter(t=>(t.findings||[]).includes(id)).map(t=>t.id));'` prints three
> empty lists). The *status* claim does not: **the three rows no longer read
> `open — no task`.** B9's reads `does not reproduce as written`, B12's reads
> `partly fixed`, and only B8's still opens `open — no task`. All three moved
> because tasks aimed at neighbouring symptoms landed on them — which is
> precisely the paragraph's own point, arriving faster than the paragraph did.
> Unowned and unfixed are different axes, and this sentence conflated them.

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
| B1 | `worker/` | no such directory; the extractor lives in `src/shared/engines/perplexity.js` |
| B9 | `src/server/workers/scanWorker.js:432-439` | `:472-479` — the old range still resolves, to unrelated code |
| B12 | `src/server/db.js:5-8` | `:11-15` (shifted by `4f7b6b6`) |
| B12 | `src/server/db.js:289` | `:298` |
| C4 | `docs/vendors/` | did not exist on 2026-08-30; created by R5.1.1 and populated since — nine files at `8e6ecc6`, `README.md` plus one per vendor. *(Corrected 2026-09-12, R6.3.6: this cell read "does not exist yet".)* |
| C12 | `src/app/chart-preview/page.js` | deleted by R0.1.2 |

---

# Entry #3 — 2026-08-30 — the dead registry that stopped parsing

`src/lib/engines/adapter.js` and `src/lib/scoring/probe.js` are deleted.

They were a second, parallel engine registry, superseded by
`src/shared/scoring/enginePipeline.js`. `adapter.js:3` imported `probeOpenAI` from
`./openai.js`, which has never exported it — `git grep probeOpenAI 8e6ecc6 -- src/`
returns nothing, and that is the durable form of the claim. *(This sentence read
"`openai.js` exports exactly `isChatGptConfigured` and `probeChatGpt`". That was
true through `1a5ed81` — two exports — and stopped being true at `50672e2`
(2026-09-08), which added `OPENAI_PROVIDER`, `OPENAI_TOOL`,
`DEFAULT_OPENAI_MODEL`, `getOpenAiModel` and `COST_STATE`: seven exports at
`8e6ecc6`. Corrected 2026-09-12 under R6.3.6. The count was never the point —
`probeOpenAI`'s absence was — but a count is exactly the kind of claim that
rots without anyone touching the sentence.)* So both modules threw
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
`1a5ed81` (2026-09-05), `src/shared/scoring/enginePipeline.js` went 625 → 1,132
lines and `src/server/workers/scanWorker.js` 1,181 → 2,545. Six days. Nothing
short of a symbol anchor survives a file doubling.

## What was wrong when written, and what merely expired

Two categories, treated differently, because renumbering a dated document is
itself a falsification — it re-points a historical record at code that did not
exist when the record was made.

**Wrong at the authoring commit** — **three**, corrected inline, each
correction labelled. *This list said two until 2026-09-05; the third was found
by the verifier who rejected the first version of this entry, and is by some
distance the most important of them.*

- `HANDOFF-2026-08-30.md`, `R0.1.10`: `check-secrets.mjs:79` never called
  `get_all_zones`. At `3c9d3f2` the call was `:76`; `:79` was
  `if (!res.ok) return fromResponse(res);`.
- `HANDOFF-2026-08-30.md`, `R1.7.4`: `:198` and `:250` were each one line high —
  the enclosing `Promise.race([` and `try {` rather than the `paaFn(` call that
  does the spending, which sat on `:199` and `:251`.
- `BUILD_JOURNAL.md`, *Liveness of B8 and B9*: "`runScanChunk` … is dispatched
  from **two** entry points". It was dispatched from three at `5d51aa3`, the
  commit that paragraph declares. `GET /api/scan/[job_id]/status` has
  dispatched it since `9580782` (2026-07-24). **This one is not a `file:line`
  citation at all** — every number in that paragraph was exact at `5d51aa3`.
  The defect is a *missing* citation: an entry point that was never looked for,
  written up as a completed standing-rule-10 liveness trace. It is also the
  only one of the three where the error understates risk rather than merely
  mislocating it.

**Right when written, then outlived** (given a declared commit and a symbol
anchor, never renumbered): everything else, including the seventeen line
citations of the *Liveness of B8 and B9* chain, now down to three survivors.
Note the split inside that one paragraph, because it is the cleanest example in
the file: its **numbers** were all right when written and merely expired, while
the **claim they were assembled into** — "two entry points" — was wrong on the
day it was written. Accurate citations, wrong conclusion. Checking the numbers
would have told you nothing.

## Three things the register did not know about itself

Two of these are changes underneath the register; the third is not a change at
all. None came from a task that knew it was touching this file, which is the
part worth generalising.

1. **B9 stopped reproducing.** `25e7727` (R3.2.2) and `3e37c92` (R3.2.5) made
   the silent engine-set substitution loud. B9's row said `open — no task` for
   six days after it was fixed by two tasks aimed at something else.
2. **Half of B12 stopped reproducing.** `6fc5b61` (R2.8.6) turned
   `insertScan`'s "Skipping database insert" into a throw. The row still
   described the log line. (Trap: `git grep` still finds "Skipping database
   insert" in a **past-tense contract comment**, so a grep-based check reads as
   if the behaviour survives.)
3. **A liveness trace was incomplete from the start — nothing was added.**
   `runScanChunk` is dispatched from `GET /api/scan/[job_id]/status` as well as
   `POST /api/scan` and `GET /api/scan/worker`, and has been since `9580782`
   (2026-07-24) — before `5d51aa3`, the commit the liveness paragraph declares.
   The paragraph asserting "**two** entry points" was **wrong when written**.
   The first version of this entry said the opposite — that a third entry point
   had been added and the paragraph "was not wrong when written and is wrong
   now" — and a verifier rejected it. Recording the mistake rather than just
   the fix, because the mistake is the more useful artifact: the first
   explanation reached for was the flattering one, in which the document was
   right and the world moved. It was not. Nobody had finished looking.

The **Status** column is stale on ten rows as well. That caveat has been moved
up into the banner above the tables, where a reader meets it before reading a
row rather than after — see *The Anchor column below expired*.

## What this hands to R6.4.8

The doc-to-source staleness tripwire is a separate task and is not built here.
**It has never run.** What this sweep establishes about its requirements:

> **Read this before the bullets: this sweep's own headline recommendation
> would not have caught this sweep's most important finding.**
>
> Everything below argues for declared-commit-plus-symbol anchoring, and
> R6.4.8's own spec proposes a *staleness* tripwire — fail when a cited source
> file changes in a commit that does not touch the citing doc. Apply either one
> to the "**two** entry points" claim and it passes, cleanly and with a green
> tick. Every `file:line` in that paragraph was **exact at `5d51aa3`**, the
> commit the paragraph declares; resolving them against that commit succeeds.
> Nothing had gone stale. **The citation was wrong from birth, and the specific
> shape of the error is an omission — a third live entry point that was never
> cited because it was never found.**
>
> No citation checker detects a citation that is not there. Staleness detection
> is defined over *change*, and there was no change; anchoring is defined over
> *the citations present*, and the missing one is by construction absent. This
> is a class of error the recommended fix does not address, and it happens to
> be the class that understates risk — the direction that produces a document
> claiming less exposure than exists.
>
> If R6.4.8 ships the tripwire and stops, this class stays invisible and now
> carries a green tick, which is worse than the current state. Whatever else
> R6.4.8 concludes, it must record that its guard is scoped to stale citations
> and **does not** cover incomplete liveness traces, so the next reader does
> not mistake a passing tripwire for a verified chain. Standing rule 10 is
> still the only control that touches this class, and it demonstrably failed
> here: it was followed, and it still produced two of three.

- **Existence is not the check.** 113 of 119 citations resolve. A tripwire that
  only asserts "file exists, line ≤ line count" would have passed this document
  in the state described above, and would have said so with a green tick.
- **The check has to be content-shaped.** The workable form is a quoted
  fragment or a symbol name next to the number — `enginePipeline.js:149
  ("[aio] Query failed")`, which is where that warn sits at `1a5ed81` — so the
  tripwire can assert the line still contains
  it, and fail with "moved to :NNN" rather than "ok".
  - *The example has since demonstrated itself. Checked 2026-09-12 (R6.3.6):
    that warn is on `:159` at `8e6ecc6`. The number moved by ten and the
    quoted fragment did not move at all, so the form above still resolves the
    reader to the right line while a bare `:149` would not — and a tripwire
    holding the fragment would have failed with "moved to :159" instead of
    silently passing. Of the citations R6.3.6 re-checked, this is the one that
    needed no correction, and the parenthesis is why. That is a sample, not a
    census — R6.3.6 re-checked the at-HEAD assertions and the `Since` bullets,
    not all 119.*
- **Dated documents need an exemption with a declared commit.** A handoff is
  *supposed* to describe an old tree. The tripwire should resolve its citations
  against the declared commit and fail only when the commit is missing or
  undeclared — otherwise it will nag forever and be muted, which is worse than
  absent.
- **`at HEAD` must be a lint failure in prose.** Three sentences in this file
  said "at HEAD" meaning three different commits. Grep for it.
  - **Resolved 2026-09-12 (R6.3.6).** All three are pinned or rewritten: the
    *"What this register can and cannot claim"* bullet and the *"How the gap was
    closed"* paragraph now name `5d51aa3`, and the *Note on B12* opener is
    rewritten with a dated correction because it had **stopped being true** —
    see that note. **`grep -n 'at HEAD' docs/HANDOFF-2026-08-30.md` now returns
    nothing.** It still returns hits in *this* file, and deliberately: every one
    is either the phrase in quotation marks or backticks, being discussed —
    including this
    bullet, its parent, and the corrections that record what each sentence used
    to say — or the one sentence that pins itself inline, *"At HEAD **as of
    2026-08-30 (`5d51aa3`)**"* in the *Gaps* section. No count is given for
    those hits, because the count changes every time somebody writes about the
    rule. A lint rule should therefore allow `at HEAD` when a sha appears in the
    same sentence, and when it is inside quotation marks or backticks; otherwise it fires on
    every paragraph arguing for itself and gets muted.
- **Source comments drift too, and nothing watches them, and this bullet proves
  it twice.** `src/shared/engines/deployedEngines.js` cites
  `enginePipeline.js:527` for `resolveEnabledEngines`, in the doc comment
  paragraph beginning *"WHAT THIS FILE CANNOT DO"*. The source comment's number
  was already stale when this bullet was written and is still stale; at
  `8e6ecc6` the symbol is declared in `src/shared/scoring/enginePipeline.js` at
  `:1393`. The tripwire's input should be `file:line` citations *in code
  comments*, not only in `docs/`.
  - **And this bullet's own correction rotted before it was verified.** It
    originally read "which lives at `:979`". That was true at `1a5ed81`. By
    `ea165ed` the symbol was at `:1236` and by `6bb211c` — **the commit that
    carried R6.3.3's corrected journal into the branch, i.e. the commit that
    added this very bullet** — it was already at `:1383`. Reproduce the whole
    slide with
    `for c in 1a5ed81 ea165ed 6bb211c 8e6ecc6; do git grep -n '^export function resolveEnabledEngines' $c -- src/shared/scoring/enginePipeline.js; done`.
    It did not fail verification, because the sentence carries the
    symbol next to the number and resolving the symbol still lands you in the
    right place. That is the whole argument for the rule in one bullet: at
    `8e6ecc6`, `enginePipeline.js:979` still **resolves**, cleanly, to an
    unrelated JSDoc block enumerating the `"none"` / `"partial"` / `"critical"`
    degradation states — plausible neighbouring code, nothing to tell the reader
    they are in the wrong place. A citation that goes stale between submission
    and verification is not a hypothetical the tripwire is guarding against; it
    is what happened here. Corrected 2026-09-12 under R6.3.6, and the number is
    not being replaced with a fresh one: `:1393` above is pinned to `8e6ecc6`
    and the durable anchor is the symbol.
- **The tree moves under the checker.** While this sweep ran,
  `src/server/db.js`, `src/server/workers/scanWorker.js` and `src/middleware.js` were
  all modified uncommitted by other agents; `insertScan` sat at `:126` in
  `1a5ed81` and `:149` in the working tree, a 23-line divergence inside one
  session. The tripwire must resolve against a commit, never the worktree, or it
  will report failures that belong to somebody else's unfinished edit.
- **It kept moving after the sweep, which is the argument for symbols, again.**
  Between `1a5ed81` and `ea165ed`, `insertScan` moved `:126` → `:152` in
  `src/server/db.js`; R2.8.12 replaced `getScansByDomain`'s `if (!client) return []`
  with a `ScansUnavailableError` throw (`git grep -c ScansUnavailableError
  ea165ed -- src/server/db.js` → 9); and R0.1.20 withdrew the `trusted: true`
  label from the rate limiter, renaming `TRUSTED_IP_HEADER` to
  `PLATFORM_IP_HEADER` (`git grep -l PLATFORM_IP_HEADER ea165ed -- src/` →
  `src/server/rateLimit.js`, `src/server/rateLimit.test.mjs`). Neither document cites
  those symbols, so nothing here broke — but note that a **rename** defeats
  symbol anchoring exactly as a line move defeats numbers. The anchor is more
  durable, not durable. Cite a symbol *and* the commit where it had that name.
- **The bullet above was itself briefly wrong at the commit it names, and the
  window was minutes.** Its first draft read `→ 11`, taken from a `git grep`
  against the literal ref `HEAD`. Between reading `git rev-parse HEAD` and
  running that grep, another agent committed `e2e46f4`, so `HEAD` had stopped
  meaning `ea165ed`: the count is **9** at `ea165ed` and 11 at `e2e46f4`. The
  number was measured correctly and attributed to the wrong commit — a
  wrong-at-authoring citation, in a bullet arguing against wrong-at-authoring
  citations, caught only because the command was re-run with the sha spelled
  out. **A tripwire must resolve `HEAD` to a sha once and pin it**, and prose
  must never carry the word `HEAD`, for the same reason: on a branch a dozen
  agents are committing to, `HEAD` is not a citation, it is a race.

---

# Entry #6 — 2026-09-14 — the approve→publish→lift pipeline is unproven

**Filed under R5.2.3.** The lift copy in `src/components/studio/ContentItemView.jsx`
said "since publish" — implying the operator had verified a live URL and that a
post-publish re-scan confirmed the lift was real. Neither was true: the
approve→publish→lift chain has never run end-to-end on a real brand with a
verified live URL.

**What was wrong.** The word "publish" in the lift panel created the impression
that a publish step had occurred and that the lift measurement was causal. The
publish step (R5.2.2) exists but has not been exercised against a real deployment.
The lift measurement is a correlation between the approval timestamp and the
post-approval re-scan — it is not proof that the published content caused the
lift.

**What was fixed.** Changed "since publish" to "since approval" in both the
post-scan and pre-scan copy at `ContentItemView.jsx:251,262`. This is the honest
description of what the measurement actually represents: the difference between
the scan before approval and the scan after approval. The word "publish" will
return when the pipeline runs once with a verified live URL and a post-publish
re-scan confirms the lift.

**Status.** The copy now reads "since approval" with a code comment recording
the known-open pipeline. The build journal entry (this one) is the ledger row
the accept criterion required.

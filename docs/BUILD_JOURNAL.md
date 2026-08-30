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
| B8 | "No engines enabled!" runs one anyway: when every requested engine is skipped as unconfigured, the resolver warns and returns `aio` regardless — an engine the operator did not ask for, whose configuredness is the hardcoded constant `isConfigured: () => true`, so an aio run with no Bright Data key resolves as "enabled" and every query lands in `probeAio`'s catch as a complete zero-valued row. | `src/lib/scoring/enginePipeline.js:510-514` (audit said `:510-515`; `:515` is the blank line closing the block); the constant at `:450`; the swallowing catch at `:98-101` | **read** | open — no task; see *Correction to B8* below |
| B9 | The frozen engine set can be silently replaced mid-run. Sourcing freezes the resolved engine names onto the checkpoint precisely so a resume cannot re-resolve them, then probing discards that freeze: if no frozen name matches the live registry, `engineDefs` falls back to whatever is enabled today, with no warning and nothing recorded on the scan. | `src/lib/workers/scanWorker.js:472-479` **moved** (audit said `:432-439`, which was exact at `5111219`); the freeze contract it voids is stated at `:364-370` | **read** | open — no task |
| B10 | `insertScan` has a three-tier column-drop cascade: an insert that fails silently retries with fewer columns, so a scan can persist with fields quietly missing. | `src/lib/db.js:122-167` | **read** | open — R2.2.4 |
| B11 | `hasActiveScanForBrand` fails open on any DB error and leaves a TOCTOU window, so two concurrent requests could each start a full-budget duplicate scan. | `src/lib/db.js:403-408` | **read** | **closed R0.1.5** |
| B12 | No Supabase env gives a memory mode that "works": the client is null, so scan jobs live only in a per-instance `global.memoryJobs` map, `insertScan` logs "Skipping database insert" and returns, and every read returns empty. The scan completes and reports success, nothing persists, the dashboard is permanently empty rather than erroring, and two serverless instances disagree about the same job. | `src/lib/db.js:11-15` **moved** (audit said `:5-8`) and `:298` **moved** (audit said `:289`); the silent skip at `:62-65`; empty reads at `:180-182` and `:252` | **read** | open — no task; reproduces in full, see *Note on B12* below |
| B13 | A fabricated `studio.perceev.app` URL is presented to the user as a real published location. | `src/app/api/content-items/[id]/decision/route.js:19-27` | anchor only | open — R5.2.1 |

**Liveness of B8 and B9 (standing rule 10).** Both are on the live scan path,
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

| Finding | Audit anchor | At HEAD | Outcome |
|---|---|---|---|
| B8 | `enginePipeline.js:510-515` | `enginePipeline.js:510-514` | resolves; `:515` is the blank line closing the block. Mechanism **corrected** — the artifact's "the aio definition it just proved unconfigured" is not what the code does; see *Correction to B8* above. |
| B9 | `scanWorker.js:432-439` | `scanWorker.js:472-479` | **moved** `+40`. Exact at `5111219` (confirmed with `git show`); the block was displaced by later work in the same file. Mechanism reproduces as written. |
| B12 | `db.js:5-8`, `:289` | `db.js:11-15`, `:298` | **moved** `+7` / `+9`, by `4f7b6b6` adding the `duplicateScan` imports at `:4-9`. Mechanism reproduces in full; see *Note on B12* above. |

B9's stale anchor is the reason this mattered. At HEAD, `scanWorker.js:432-439`
still resolves — to the "Prepared N queries" log and the head of the sourcing
checkpoint. A reader who trusted the number would have written up a real,
different piece of code as B9 and never known.

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

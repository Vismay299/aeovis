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

- **34 of the 37 findings are recorded below.** `B8`, `B9` and `B12` are **not
  recoverable from this repository** — see *Gaps* at the end. A register that
  quietly renumbered 34 findings as "all of them" would be the same lie it
  exists to catalogue.
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
| B10 | `insertScan` has a three-tier column-drop cascade: an insert that fails silently retries with fewer columns, so a scan can persist with fields quietly missing. | `src/lib/db.js:122-167` | **read** | open — R2.2.4 |
| B11 | `hasActiveScanForBrand` fails open on any DB error and leaves a TOCTOU window, so two concurrent requests could each start a full-budget duplicate scan. | `src/lib/db.js:403-408` | **read** | **closed R0.1.5** |
| B13 | A fabricated `studio.perceev.app` URL is presented to the user as a real published location. | `src/app/api/content-items/[id]/decision/route.js:19-27` | anchor only | open — R5.2.1 |

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
| C9 | Both worker gates failed open when `CRON_SECRET` was unset: a warning was logged once and the request allowed, leaving two budget-spending endpoints unauthenticated in production. | `src/app/api/scan/worker/route.js:29-47`; `src/app/api/content/worker/route.js:25-52` | **read** | **fixed, task blocked R0.1.1** — code landed, fail-closed in production; the task stays open until `CRON_SECRET` is set in Vercel and a live 401 is observed |
| C10 | `setup-supabase.mjs` has no migrations ledger and no transaction per file, so a partially-applied migration leaves an unknown schema. | `scripts/setup-supabase.mjs:52-96` | anchor only | open — R6.1.1 |
| C11 | The landing page presents fabricated figures as measurements. | `src/components/landing/AnswerSheet.jsx:63-65`; `src/app/page.js:126-129` | anchor only | open — R2.10.1 |
| C12 | `/chart-preview` self-described as "not a product route" and shipped a named third-party brand's real visibility trend on a public, un-noindexed page. | `src/app/chart-preview/page.js:17-30` — **file deleted**, see below | **read** | **closed R0.1.2** |

**Correction to C12 as written.** The audit says the route "renders a real
third-party brand's live trend from the production DB". It did not query the
database at request time — the values were hardcoded constants, copied out of
the DB by hand. The exposure is the same; the mechanism is not. The route was
deleted rather than gated, because gating leaves the customer's numbers in the
repository and in every build.

## Gaps — what is NOT in this register

**`B8`, `B9` and `B12` are missing. They are not recoverable from this
repository.**

The findings originate in a companion document — *The Honesty Gap* (artifact
`bbd113a7`) — which is **not committed here**. The only surviving record inside
the repo is `.claude/orchestration/tasks.json`, where each task lists the
finding ids it addresses. Every finding that no task references therefore has no
description, no mechanism and no anchor anywhere in the tree. Three fall in that
hole.

Do not resolve this by renumbering. `docs/plans/production-plan.md` happens to
contain sections also labelled `B8` and `B9` ("Remaining input/output hygiene",
"Dependency patching") — those belong to that document's own scheme and are
**unrelated** to the audit's finding ids. Treating them as the missing findings
would put three wrong rows in a register whose entire purpose is that its rows
are true.

**To close this gap:** paste the three findings from the companion artifact into
this file, or record a decision that they are dropped and why.

---

## Appendix — anchors that had already moved

The audit's own closing note says to re-verify its line numbers before acting on
them. Checked at the time of writing, eight anchors no longer resolved:

| Finding | Audit said | Actually at |
|---|---|---|
| A4 | `src/lib/scoring/interlocking.js:98-113` | `src/components/dashboard/interlocking.js` |
| A6, A7 | `src/components/dashboard/Sidebar.jsx:138-143` | `src/components/perceev/Sidebar.jsx` |
| A8, A9 | `src/components/charts/Donut.jsx:29-44` | `src/components/perceev/charts/Donut.jsx` |
| B1 | `worker/` | no such directory; the extractor lives in `src/lib/engines/perplexity.js` |
| C4 | `docs/vendors/` | does not exist yet; created by R5.1.1 |
| C12 | `src/app/chart-preview/page.js` | deleted by R0.1.2 |

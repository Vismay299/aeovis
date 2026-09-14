# Contract — Probe Result v2

> <!-- doc-status -->
> **Status: LIVE** as the normative target for the R1 probe fleet
> (`worker/`) and the R1.2.4 ingest route.
> It is **not** a description of what `src/lib/scoring/enginePipeline.js`
> returns today. Section 2 records that shape as it actually is; section 7 lists
> every place today's code violates section 3.

**Date:** 2026-09-05 · **Task:** R1.1.1 · **Consumed by:** R1.1.4, R1.2.4,
R1.3.3, R1.4.4, R1.5.2, R2.1.1

## Baseline

**Every line number in this document is true at commit `49fe39e`, and at no
other commit.** There is one baseline and this is it.

Each citation below was resolved by reading `git show 49fe39e:<path>` — the
committed blob, never the working tree — and checking that the line carries the
symbol the prose names. Nothing here was copied from the roadmap, from the
ledger, or from an earlier revision of this file.

The tree this was written in has concurrent writers, so read the baseline
literally: a citation is a claim about `49fe39e`, not about `HEAD` and not about
your checkout. To re-verify one, use `git show 49fe39e:<path>`. If a number does
not resolve for you, find the symbol by name and assume the file moved after
`49fe39e` — the prose names the symbol at every citation for exactly that
reason.

Two earlier revisions declared different baselines (`8502166`, then `25e7727`);
both are superseded by this one and neither should be used to check a number
here. What moved between them is recorded in the revision note below.

### Revision note — three baselines, and what each one got wrong

This document has been written three times. The failures are recorded rather
than quietly absorbed, because all three are the same failure wearing different
clothes: a citation that *resolved* to a plausible line without being *checked*
against the symbol it claimed.

**Revision 1, baselined `8502166`.** Failed verification on four counts, all
corrected in revision 2:

1. **§3.2's `no_answer` justification was factually wrong** — it claimed an
   effect on the coverage denominator that runs the opposite way. Rewritten
   against a reproduction; see §3.2.
2. **§6.1 labelled our own inference `vendor_reported`.** `basis` now has a
   fourth value; see §3.9.
3. **§3.9 did not reconcile with `src/lib/llmPricing.js`**, which landed the
   same day and emits a `free_tier` cost source that no `basis` could represent.
   §3.9 now carries the mapping table.
4. **One citation was read from the dirty tree.** The V11 note cited
   `src/lib/scoring/promptGen.js:9` under a declared `8502166` baseline, where
   that import sat at `:3`; the concurrency disclosure did not name
   `promptGen.js` as a file under edit. (At `25e7727` and at `49fe39e` it is
   `:9`.)

**Revision 2, baselined `25e7727`.** Corrected all four, and introduced two of
its own:

5. **The header named two different commits in one sentence** — it declared
   `49fe39e` as the baseline while stating the citations had been re-read with
   `git show 25e7727:`. A document with two baselines has none.
6. **It disclosed a working-tree drift table that had become false.** Five
   files — `llmPricing.js`, `openrouter.js`, `openrouter.test.mjs`,
   `scanWorker.js`, `promptGen.js` — were listed as uncommitted with hunk
   offsets and a warning that the citations to them were "commit-true only".
   Those edits landed in commits at or before `49fe39e`; when this revision was
   written, `git status --short` reported none of the five as modified. The
   table has been deleted rather than updated. A stale drift disclosure is worse
   than no disclosure — a reader trusts it and discounts numbers that are
   correct.

**Revision 3 — this one, baselined `49fe39e`.** Every citation in the document
was re-resolved against `git show 49fe39e:<path>` and checked against the symbol
the prose names. Three things were wrong.

Two were line numbers left over from the `25e7727` baseline, both in §3.9:

- `UnpricedModelError` was cited at `llmPricing.js:73`; at `49fe39e` the class
  is declared at `:79`.
- `throwUnpriced` was cited at `llmPricing.js:218-220`; at `49fe39e` the
  function is at `:229` and raises at `:231`. (`:218` at `49fe39e` is the tail
  of `alertUnpriced`'s parameter list — it resolved, to plausible neighbouring
  code, which is precisely the failure mode.)

The third was worse, because no line number was wrong. §7's V3 note drew the
ungated render path as `enginePipeline.js:939` → `db.js:119` →
`weeklyReport.js:35`. All three lines exist, all three carry
`aio_coverage_pct`, and **the chain between them cannot execute**: `db.js:119`
is a promoted *column* that the weekly report never reads. The real path runs
through `summary_stats` and `raw_results`. Corrected in §7; the violation itself
is unchanged, because both surfaces carry the same fabricated denominator. This
is the same failure `docs/decisions/2026-08-29-serp-provider-bright-data.md` was
rewritten over — see its "re-check *liveness*" warning — and it is the one worth
naming twice: every citation resolving is not the same as the chain drawn
between them being able to run.

§7's six unowned violations (V1, V2, V3, V6, V8, V10) and the
`deployedEngines.js:21` stale citation were each re-verified at `49fe39e` and
all seven still reproduce. V12's *mechanism* needed correcting — "nothing writes
`probe_tasks.outcome`" was true of the outcome, not of the writer. The writer
exists and is wired; see V12 and §2.3.

**The dirty-tree trap, recorded once so it need not be relearned.** An early
draft of §3.9 was written by reading `src/lib/llmPricing.js` out of the working
tree, because a `git diff` run minutes earlier had come back clean. An
implementer landed in that file in between. Every §3.9 line number in that draft
was wrong by the same silent amount, and every one of them *resolved*, to
plausible neighbouring code. For the record, across the three baselines this
document has carried, `resolveCost`'s `free_tier` branch sits in three different
places: `src/lib/llmPricing.js` does not exist at all at `8502166`, the branch is
at `:283` at `25e7727`, and at `:335` at `49fe39e`. The rule that follows: on a
repo with concurrent writers, `git diff` being clean is a fact about the past,
and only `git show <commit>:<path>` produces a citation that means anything.

This document is **normative**: "must", "must not" and "never" here are
requirements on code, not advice. Other documents in `docs/contracts/`
may exist; each carries its own `<!-- doc-status -->` header.

---

## 1. Why this exists

One failure recurs and this contract exists to make it unrepresentable:

> **A probe result that cannot distinguish "the engine answered and did not name
> the brand" from "we never got an answer" will be scored as the first one.**

Both look like `visible: false`. The scoring layer divides by a count of rows,
and a row that was never measured is indistinguishable from a row that was
measured and came back empty, so a blocked engine, an expired credential and a
brand nobody talks about all produce the same number on the dashboard.

Standing rule 1 of the rebuild states it as policy: *a skip is not a success; an
empty state is not a clean one; measured zero must look different from never
ran.* This document states it as a data shape.

## 2. What a probe result actually is today (v1)

### 2.1 Where it is produced, and that it is live

Two functions in one file build every probe row the product scores:

- `probeAio` — `src/lib/scoring/enginePipeline.js:77`, result literal at
  `:78-98`
- `probeTextEngine` — `src/lib/scoring/enginePipeline.js:172`, result literal at
  `:176-196`

They are reached through `ENGINE_REGISTRY`
(`src/lib/scoring/enginePipeline.js:735-775`) — `probe: probeAio` at `:740`, and
two thin wrappers around `probeTextEngine` at `:747-756` and `:763-772`.

The chain from there to an HTTP request, hop by hop, each hop read at `49fe39e`:

1. `engine.probe(...)` is invoked at `src/lib/workers/scanWorker.js:1307`.
2. That line is inside `runProbingPhase` (`scanWorker.js:1227`) — **not**
   directly inside `runScanChunk`, which is 700 lines further down.
3. `runScanChunk` (`scanWorker.js:2006`) dispatches to it at `scanWorker.js:2181`.
4. `runScanChunk` is imported and called by `src/app/api/scan/route.js:62`
   (`POST /api/scan`, import at `:6`) and by
   `src/app/api/scan/worker/route.js:138` and `:215` (import at `:5`).
5. `/api/scan/worker` is on the daily cron: `vercel.json:4-5`,
   `"path": "/api/scan/worker"`, `"schedule": "0 0 * * *"`.

**This chain executes in production.** It is not a legacy path. Hop 2 is spelled
out because an earlier revision compressed it to "that runs inside
`runScanChunk`", which is true only transitively — and a compressed hop is where
a dead chain hides.

### 2.2 The v1 row, field by field

Every field below is initialised in both literals, so the shape is the same for
`aio`, `chatgpt` and `perplexity`. Types are what the code actually assigns.

| Field | Type | Set by | Notes |
|---|---|---|---|
| `engine` | `"aio" \| "chatgpt" \| "perplexity"` | both | registry name |
| `prompt` | string | both | the query text |
| `is_branded_query` | boolean | both | `isBrandedQuery(query.text, brandAliases)` |
| `topic` | string | both | defaults to `"General"` |
| `source` | string | both | defaults to `"unknown"` |
| `intent_tier` | string | both | `resolveQueryIntentTier`, `src/lib/scoring/aioQueryClassify.js:38-44`; `"branded"` or `"exploratory"` by default |
| `answer_present` | boolean | both | **initialised `false`**, set true only after a text-or-citations check (`:117`, `:243`) |
| `aio_present` | boolean | both | backward-compat duplicate of `answer_present`; text engines leave it `false` |
| `text` | string | both | `""` when nothing came back |
| `citations` | string[] | both | normalized URLs |
| `references` | `{href,title,source,domain}[]` | both | `domain` added by `extractBrandDomain` |
| `brand_mentioned_in_text` | boolean | both | **initialised `false`** (`:90`, `:188`) |
| `brand_cited` | boolean | both | **initialised `false`** |
| `visible` | boolean | both | `brand_mentioned_in_text \|\| brand_cited` (`:144`, `:257`); **stays `false` when the probe failed** |
| `competitors_found_in_text` | string[] | both | |
| `competitors_cited` | string[] | both | |
| `brands` | `{name,is_self,mentioned,position,sentiment}[]` | both | `judgeBrandsSymmetric`, `src/lib/scoring/judge.js:317-323`; `position`/`sentiment` are `null` when not mentioned |
| `error` | string \| null | both | free-text message, or the `EMPTY_ANSWER` sentinel |
| `cost` | number | both | USD, always a number, never null |
| `organic` | `{position,href,domain,title}[]` | **aio only** | `:104` |
| `brand_organic_position` | number \| null | **aio only** | `:109` |

Fields that do **not** exist in v1 at all: `state`, `state_reason`,
`citations_state`, `engine_surface`, `geo`, `evidence`, `timings`, `attempt`,
`probed_at`.

### 2.3 The one typed vocabulary that already exists

`worker/src/lib/probe.js:15-24` freezes the eight outcomes, and
`supabase/migrations/010_probe_tasks.sql:57-61` enforces the same eight in a
CHECK constraint.

Stated precisely, because "not wired" is easy to get wrong in both directions:
the *consumer* side is wired and the *producer* side is not. `reportBatch`
(`worker/src/lib/queue.js:207-231`) writes outcomes through the
`complete_probe_tasks` RPC, and the worker loop calls it at
`worker/src/index.js:211`. What never arrives is a real outcome:
`probeBatch` (`worker/src/lib/probe.js:26-31`) throws rather than returning
zero-valued rows, so the loop's `probe` step (`worker/src/index.js:174`) always
raises before `report` is reached. The only code that has ever produced an
outcome value is the self-test's stub (`worker/src/index.js:308`, hardcoded
`outcome: "skipped"`), whose `reportBatch` is also stubbed and touches no
database.

Nor is the worker deployed from this repo: `worker/package.json` starts it with
`node src/index.js` on "a container host", and at `49fe39e` the tree contains no
Dockerfile, Procfile, fly/render config or workflow that launches it.

The vocabulary is decided and the write path is built; the producer is not, and
nothing runs it. This contract is what the adapters of R1.3 and R1.4 must
satisfy.

### 2.4 How v1 is persisted

`src/lib/workers/scanWorker.js:1345-1369` (`const rows = batchResults.map`, in
`runProbingPhase`, twenty lines after the `engine.probe` call of §2.1) maps the
probe row onto `prompt_results`
(`supabase/migrations/005_analytics_platform.sql:8-27`): `answered` ←
`answer_present` (`:1359`), `answer_text` ← `text` (`:1366`), and the entire
probe result verbatim into `raw` jsonb (`:1367`). `upsertResults(rows)` at
`:1370` is the write. The row is unique on `(job_id, engine, query)`
(`005_analytics_platform.sql:26`).

Because the whole result goes into `raw`, **v2 fields can be added without a
migration for reads that come out of `raw`**; the promoted columns (R1.5.2) are
a separate decision.

### 2.5 What v1 cannot say

Four things, each already a filed finding:

1. **A failed probe and an unanswered one are the same row.** Both carry
   `answer_present: false`, `visible: false`, `text: ""`. They differ only by
   `error` being non-null, and `error` is a free-text string with no closed
   vocabulary — so "Bright Data HTTP 502", "empty_answer" and
   "OPENAI_API_KEY not set" are the same type of thing to every consumer.
2. **`false` is used for "not measured".** `visible`,
   `brand_mentioned_in_text` and `brand_cited` are initialised `false`
   (`enginePipeline.js:90-92`, `:188-190`) and are never set on the failure
   path. A consumer that counts `!r.visible` counts unmeasured rows as measured
   absences. Today's consumers happen to guard on `answer_present` first
   (`src/components/dashboard/interlocking.js:30-32`,
   `src/lib/content/weeklyReport.js:95-98`,
   `src/components/studio/OpportunitiesPanel.jsx:25-28`) — but that is
   convention, not structure, and one unguarded reader reintroduces the bug.
3. **Zero citations does not mean zero citations.** `probePerplexity` runs two
   independent legs; if `/search` exhausts its retries while the answer leg
   succeeds, the function returns `citations: []`, `references: []` and a
   hardcoded `error: null` (`src/lib/engines/perplexity.js:174-180`). "Cited
   nothing" and "citations unverifiable" are the same value. Filed as R2.2.2;
   documented at `docs/vendors/perplexity.md:123-140`.
4. **`cost` is never null, so an unpriced probe reports a price.** The
   Perplexity answer leg falls back to a hardcoded `0.005`
   (`src/lib/engines/perplexity.js:67`) and the search leg returns a flat
   `0.005` that no vendor reported (`:121`). `probeAio` assigns a constant
   `0.0015` (`enginePipeline.js:111`). Aggregating these and calling the total
   measured spend is a fabrication.

---

## 3. The v2 contract (normative)

A **probe result** is one JSON object describing one attempt to ask one query of
one engine on one surface.

### 3.1 Required fields

Every probe result **must** carry all of these. A result missing any of them is
**rejected**, never repaired (§5).

| Field | Type | Null? | Meaning |
|---|---|---|---|
| `contract_version` | `2` | no | Literal integer `2`. |
| `engine` | string | no | Registry name: `aio`, `chatgpt`, `perplexity`. |
| `engine_surface` | `"ui" \| "api"` | no | Which surface was driven. §3.5. |
| `query` | string | no | The exact text sent. Non-empty. |
| `geo` | string | no | ISO-3166-1 alpha-2, lowercase, as actually used. §3.6. |
| `state` | enum, §3.2 | no | The typed outcome. |
| `state_reason` | string | **yes, only when `state` is `answered`** | Machine-readable snake_case discriminator. §3.3. |
| `probed_at` | ISO-8601 UTC | no | When the attempt completed. |
| `attempt` | integer ≥ 1 | no | Which attempt this row is. |
| `timings` | object, §3.8 | no | |
| `evidence` | object, §3.7 | no | The object is required; its ids may be null only where §3.7 permits. |
| `cost` | object, §3.9 | no | |

### 3.2 `state` — the eight values, and exactly what each means

> **NORMATIVE.** Every probe result **must** carry a `state`, and its value
> **must** be exactly one of the eight below. A producer **must not** emit any
> other value; the R1.2.4 ingest route **must** reject a row that does (§5). A
> ninth value **must not** be invented in code: adding one is a migration, an
> edit to `worker/src/lib/probe.js`, and an edit to this contract, in one
> commit (§8).

The eight are not this document's invention — they are already frozen at
`worker/src/lib/probe.js:15-24` and constrained at
`supabase/migrations/010_probe_tasks.sql:57-61`. This contract adopts that list
verbatim and adds what each one means for scoring.

| `state` | Means | Scoring |
|---|---|---|
| `answered` | The surface produced an answer for this query and it was extracted. | **Coverage denominator + visibility denominator.** |
| `no_answer` | The surface was reached and rendered, and it produced **no answer of the kind being measured**, and that absence is itself an observation. | **Coverage denominator only.** Never a visibility denominator. |
| `blocked` | The surface refused us: bot wall, rate-limit page, 403, geo-block. | Neither. |
| `captcha` | A human-verification challenge was served. | Neither. |
| `login_wall` | The surface demanded authentication we do not hold. | Neither. |
| `timeout` | The attempt exceeded its budget with no usable response. | Neither. |
| `parse_error` | A response arrived but nothing extractable could be got out of it. | Neither. |
| `skipped` | We decided not to attempt it. `state_reason` says why. | Neither. |

**`no_answer` is the dangerous one and its use is restricted.** It is legitimate
**only** where the surface has a genuine, observable "no answer" state. Today
exactly one does: a Google SERP that renders without an AI Overview block. A
chat surface (`chatgpt`, `perplexity`, `ui` or `api`) always answers something,
so an empty or whitespace-only body from a chat engine **must** be recorded as
`parse_error`, never `no_answer`.

**What this rule actually costs, stated correctly.** An earlier revision of this
paragraph claimed that `no_answer` "would put the row back into the coverage
denominator and undo R2.2.1". Both halves of that are false and the record is
corrected here rather than deleted.

Reproduction — ten non-branded `chatgpt` rows built to today's v1 shape (§2.2)
and passed through the real `summarizeEngineSlice`
(`src/lib/scoring/enginePipeline.js:329`). Five carry `answer_present: true`;
five carry `answer_present: false` with the `EMPTY_ANSWER` sentinel R2.2.1
introduced. This was run, not reasoned about, and re-run at `49fe39e` for this
revision:

| Field | Value |
|---|---|
| `non_branded_queries` (coverage denominator) | `10` |
| `non_branded_with_answer` (coverage numerator) | `5` |
| `coverage_pct` | `50` |
| `eliciting_queries` (visibility denominator) | `5` |
| `data_source_issue` | `true` |

(On the last row: on a *chat* slice today's health gate does trip, because
`TEXT_ENGINE_MIN_NON_BRANDED_COVERAGE` is `0.9`
(`src/lib/scoring/enginePipeline.js:36`) and `0.5` is under it. That is the
opposite of the aio case in §7's V3, where the equivalent floor is `0.15`
(`src/lib/scoring/aioConstants.js:4`) and nothing trips. The gate is not what
this section is about, but it is the difference between the two reproductions
and must not be read across.)

So post-R2.2.1 the empty row is **already** in the coverage denominator and
**already** out of the numerator — which is exactly `no_answer` semantics under
§3.11. `no_answer` could not recreate R2.2.1's bug in any case: §3.2 above puts
it in no visibility denominator, and R2.2.1's bug was an empty row sitting in the
*visibility* denominator as a non-mention. The state that recreates that bug is
`answered`, and only `answered`.

The real consequence of this rule runs the other way, and it is a cost, not a
saving. Excluding those five rows entirely — which is what `parse_error` in no
denominator (§3.11) does — takes the same slice from `coverage_pct: 50` to
`coverage_pct: 100`. Re-run with only the five answered rows:
`non_branded_queries: 5`, `non_branded_with_answer: 5`, `coverage_pct: 100`,
`data_source_issue: false`. **A chat engine returning empty bodies for half its
prompts reports 100% coverage under this contract, and loses the degraded flag
it has today.**

That is defensible, but only on these terms, and a consumer that drops the
second half of them is misreporting:

1. Coverage under this contract answers "of the prompts the surface actually
   rendered an answer state for, how many produced an answer" — not "how many of
   our prompts worked". The second question is a real one and it is answered by
   the `not_measured` tally, not by `coverage_pct`.
2. §3.11 therefore makes that tally **mandatory on every slice**, broken down by
   `state` and `state_reason`. A `coverage_pct: 100` next to
   `not_measured: { parse_error: { empty_body: 5 } }` is honest. The same `100`
   with the tally dropped is the failure in §1 with a different sign.
3. The alternative — calling an empty chat body `no_answer` — would be a
   *stronger* claim than we can support: it asserts that the surface was reached,
   rendered, and observably declined to answer. An empty 200 from an API does not
   establish that. Recording a weak observation as a strong one is the fabrication
   this contract forbids, and it is the reason the rule stands.

R2.2.1 is the reason the empty row is typed at all
(`src/lib/scoring/enginePipeline.js:217-241`, `EMPTY_ANSWER` at `:162`,
`result.error = EMPTY_ANSWER` with `answer_present = false` at `:234-235`;
regression test `src/lib/scoring/emptyAnswer.test.mjs:86`). This contract keeps
that typing and moves the row out of the denominator entirely — a deliberate
change in coverage semantics, not a defence of the existing one. **R2.1.1 and
R1.2.4 encode this paragraph, and neither of them may ship the exclusion without
the `not_measured` tally in the same surface: a slice that excludes rows from
the coverage denominator and does not say how many it excluded, and why, must
not be rendered.**

`skipped` is never a success. It is the state for "an engine frozen into a
checkpoint no longer resolves", "no credential", "budget exhausted" — the same
class of discarded decision `CHUNK_SKIP_REASONS`
(`src/lib/workers/scanWorker.js:193-207`) was created to stop losing.

### 3.3 `state_reason`

`state_reason` **must** be present and non-empty for every `state` except
`answered`. It **must** be snake_case and drawn from a per-state closed list
owned by the adapter, not a free-text message. The free-text detail belongs in
`error_detail` (§3.10), never in `state_reason`.

This mirrors what the schema already enforces one level up: `scan_runs.reason`
is required for every outcome except `succeeded` — the column is declared at
`supabase/migrations/011_scan_runs.sql:113` and the constraint that makes it
mandatory is `scan_runs_reason_chk` at `:144-145`
(`CHECK (outcome IS NULL OR outcome = 'succeeded' OR btrim(COALESCE(reason, ''))
<> '')`), raised as a sentence rather than a constraint name by
`close_scan_run` at `:327-329`. In application code `recordSkip` throws on a
reason-less skip (`src/lib/workers/scanWorker.js:254-259`). A skip with no
reason is the discarded fact this whole phase exists to keep.

`no_answer` requires a reason too, and this is deliberate: `no_ai_overview`
(Google rendered a SERP with no AI Overview block) is a different observation
from any other absence, and a reader must be able to tell which absence was
observed.

### 3.4 Measurement fields — the not-measured rule

These fields carry the measurement. They are **required when `state` is
`answered`** and **must be `null` for every other state**.

| Field | Type when `answered` | Value when not `answered` |
|---|---|---|
| `text` | string (may be `""` only if `citations` is non-empty) | `null` |
| `citations` | string[] | `null` |
| `references` | `{href,title,source,domain}[]` | `null` |
| `brand_mentioned_in_text` | boolean | `null` |
| `brand_cited` | boolean | `null` |
| `visible` | boolean | `null` |
| `competitors_found_in_text` | string[] | `null` |
| `competitors_cited` | string[] | `null` |
| `brands` | `{name,is_self,mentioned,position,sentiment}[]` | `null` |

> **THE RULE.** `false` means measured-and-absent. `null` means not measured.
> `[]` means measured and empty. A producer **must never** emit `false` or `[]`
> for a fact it did not establish, and a consumer **must never** coerce `null`
> to `false` or `0`.

This is what makes "measured zero" and "not measured" different values rather
than different stories about the same value. It is also why R2.1.2 exists
("delete every `?? 0` null-coalescing metric in the normalize layer"): a `?? 0`
anywhere downstream re-erases exactly the distinction this table creates.

`visible` remains derived, not independent: when `state` is `answered`,
`visible === (brand_mentioned_in_text || brand_cited)`. A producer must not
report a `visible` that disagrees with its own two components.

### 3.5 `engine_surface`

`"ui"` — a browser drove the surface a buyer actually uses (perplexity.ai,
chatgpt.com). `"api"` — a vendor API answered (api.perplexity.ai,
api.openai.com, Bright Data SERP).

Rules:

- `engine_surface` is **required on every row**, including API rows. There is no
  default and no inference from `engine`.
- UI rows and API rows of the same engine **must never** be blended into one
  number or one trend series (R1.4.4). They are two different measurements of
  two different things; decision D1 of the rebuild is that the API is not the
  product surface.
- A UI probe that comes back `blocked`, `captcha` or `login_wall` **must** be
  recorded with that state. Falling back to the API and writing the API's answer
  as if the UI had answered is forbidden: it converts a coverage failure into a
  measurement, which is the failure class in §1 with an extra step.

### 3.6 `geo`

The geo **actually used for the request**, not the configured default. Today the
default resolves through `resolveSerpGeo` (`src/lib/engines/serpGeo.js:25-27`,
default `"in"` at `:15`), and the ChatGPT and Perplexity API adapters hardcode
`country: "IN"` in the request body (`src/lib/engines/openai.js:28`,
`src/lib/engines/perplexity.js:47`) while recording it nowhere on the result.

A result whose geo is unknown to the producer **must** be `skipped` with
`state_reason: "geo_unresolved"`. It must not default.

### 3.7 `evidence`

```
evidence: {
  screenshot_id: string | null,
  dom_id:        string | null,
  har_id:        string | null,
  raw_id:        string | null
}
```

- The `evidence` object is **required on every row, in every state**, including
  failures. Failure evidence is how a block gets debugged; R1.3.3's acceptance
  criterion is that *every* one of the eight outcomes writes an evidence id.
- For `engine_surface: "ui"`, **at least one** of `screenshot_id` or `dom_id`
  **must** be non-null in every state. A UI row with no evidence at all is
  **rejected**.
- For `engine_surface: "api"`, `raw_id` **must** be non-null; the other three
  may be null.
- Ids are opaque object keys in the `probe-evidence` bucket (R1.5.1); this
  contract does not specify their format, only that they resolve.

### 3.8 `timings`

```
timings: { total_ms: integer, navigation_ms: integer|null, extract_ms: integer|null }
```

`total_ms` is required in every state, including `timeout` — the elapsed time is
the evidence for a timeout. `navigation_ms` is required for `ui` and `null` for
`api`. `extract_ms` is required when `state` is `answered` and may be `null`
otherwise.

### 3.9 `cost`

```
cost: { amount_usd: number|null, basis: "vendor_reported"|"estimated"|"no_charge"|"unpriced", reason: string|null }
```

`amount_usd` is **vendor spend only**. Our own browser, proxy and compute cost is
not modelled by this contract at all, and no `basis` value should be read as a
claim about it.

| `basis` | Who established the number | `amount_usd` | `reason` |
|---|---|---|---|
| `vendor_reported` | The vendor returned a price and `amount_usd` **is** that returned number, unmodified. | non-null | `null` |
| `estimated` | We computed it from a rate card we hold. | non-null | `null` |
| `no_charge` | **We** determined the vendor's meter did not run, from a rule we can name. | **must** be `0` | **required** |
| `unpriced` | Nobody priced this call and we do not know what it cost. | **must** be `null`, never `0` | optional |

**Why `no_charge` exists, and why the fourth value rather than one of the other
three.** An earlier revision of this document wrote
`{ "amount_usd": 0, "basis": "vendor_reported" }` for a logged-out UI probe and
defended it as "the vendor charged nothing because we did not call the API".
That is wrong on this contract's own terms: no vendor returned anything, so the
zero is *our inference*, and labelling our inference as a vendor measurement is
the fabrication class §1 exists to forbid. It is not `estimated` either — no rate
card was consulted. And it cannot be `unpriced`, because `unpriced` requires
`amount_usd: null` and this zero is a real, defensible zero that a spend total
should include.

So a fourth value, with a constraint the other three do not carry: `no_charge`
**must** name its rule in `reason`, because "this cost nothing" is a claim about
the world that an operator has to be able to audit. Two reasons are defined
today:

- `ui_surface_no_metered_call` — a browser drove a public surface; no metered API
  request was issued. Says nothing about proxy or compute cost (see above).
- `free_model_id_suffix` — the model id ends in `:free`
  (`src/lib/llmPricing.js:105-107`), which is a gateway naming convention we are
  trusting, not a price the gateway quoted.

A consumer summing `amount_usd` **must** report the `unpriced` **and**
`no_charge` counts alongside the total, or report the total as unavailable. A
`$0.00` total over three hundred `no_charge` rows is an assertion, not a
measurement, and it must be legible as one. Standing rule 5 of the rebuild — an
unpriced model id fails loud, never `$0` — is what `unpriced` enforces;
`no_charge` is the narrow, reasoned exception to it and is not a way around it.

#### Mapping to `src/lib/llmPricing.js`

`llmPricing.js` landed the same day as this contract and is the tree's only
existing cost-provenance vocabulary. It returns `cost_source` of
`gateway | free_tier | price_table` (`llmPricing.js:308`). The mapping is
normative — an adapter that calls it **must** translate, never pass
`cost_source` through as `basis`:

| `cost_source` | Returned at | → `cost.basis` | `amount_usd` | `reason` |
|---|---|---|---|---|
| `gateway` | `llmPricing.js:331` — `{ cost: reported, cost_source: "gateway" }`, the echoed `usage.cost` | `vendor_reported` | the echoed number | `null` |
| `free_tier` | `llmPricing.js:335` — `{ cost: 0, cost_source: "free_tier" }` | `no_charge` | `0` | `free_model_id_suffix` |
| `price_table` | `llmPricing.js:359` — `{ cost, cost_source: "price_table" }`, tokens × rate | `estimated` | tokens × rate | `null` |

`free_tier` is why the fourth `basis` value is not optional. It is a **priced
zero**: `isFreeModelId` (`llmPricing.js:105-107`) infers it from the `:free`
suffix, no vendor quoted it and no rate card produced it, and
`src/lib/openrouter.test.mjs:537` pins the distinction verbatim — *"free is a
priced 0, not an unpriced one"*. Under the three-value vocabulary it had no
representable `basis` at all. With the free-model decision locked for this
project, that gap was live, not theoretical.

`unpriced` has **no** `cost_source` that maps onto it, and that is correct:
`resolveCost` (`llmPricing.js:310`) never *returns* an unpriced value. It throws
on two paths instead:

- its final branch calls `throwUnpriced` (`llmPricing.js:364-371` → the function
  at `:229`, raising `UnpricedModelError` at `:231` with
  `reason: "unpriced_model"`); and
- a priced model whose gateway reported no token counts at all calls
  `throwUnmeasured` (`llmPricing.js:357`, `reason: "unmeasured_tokens"`) —
  "this priced model consumed nothing" and "this gateway never said what it
  consumed" are different facts, and only the first may be priced.

`UnpricedModelError` is declared at `llmPricing.js:79`, and
`assertModelPriceable` (`llmPricing.js:292-301`) throws on the same class before
the request is even sent. So on any adapter routed through `llmPricing.js`,
`unpriced` is unreachable — a probe row may only carry it when some *other* call
path priced nothing at all. That is standing rule 5 holding at the layer below
this contract, and `no_charge` must not be used to route around it.

**Liveness, so this table is not read as more than it is.** `cost_source` runs
today only on the LLM-call path — `resolveCost` at `src/lib/openrouter.js:124`,
returned to callers at `:139`, reaching `src/lib/llm.js` and from there
`src/lib/scoring/promptGen.js:13`, `src/lib/scoring/competitorExtract.js:4` and
`src/lib/analytics/citationEnrich.js:1`. **No probe row carries it.** Probe rows
still carry a bare `cost` number that is never null (§2.2), which is V6 in §7.
This mapping is what the R1.3 and R1.4 adapters must implement, not a
description of what any row contains today.

### 3.10 Citation honesty — `citations_state`

```
citations_state: "measured" | "unverified" | "not_applicable"
```

`citations_state` **must** be present on every row, in every state.

- `measured` — the citation list is a complete read of what the surface showed.
  `citations: []` under this state is a **real zero**: the answer cited nothing.
- `unverified` — an answer was obtained but the citation channel failed or was
  not read. The list may be empty or partial and **means nothing**.
- `not_applicable` — `state` is not `answered`, so `citations` is `null`.

> **Consumers must exclude `unverified` rows from every citation denominator**
> (citation share, cited-non-branded, source mix). They stay in the coverage and
> visibility denominators, because the answer itself was measured.

This is R2.2.2 stated as a contract rather than a bug: the Perplexity two-leg
split at `src/lib/engines/perplexity.js:145-148` produces exactly the
answer-ok/search-failed row that must be `unverified`.

### 3.11 The denominator rule

> **THE DENOMINATOR RULE (normative).** A probe result **must not** enter any
> scoring denominator unless its `state` is `answered` or `no_answer`. Those two
> states, and only those two, may enter one. A row in any of the other six —
> `blocked`, `captcha`, `login_wall`, `timeout`, `parse_error`, `skipped` —
> **must not** enter any denominator and **must not** enter any numerator, in
> any metric, at any layer, ever. A consumer that cannot tell which state a row
> is in **must not** compute a rate from it.

Concretely, for a slice of rows from one engine:

- **Coverage denominator** = rows with `state ∈ {answered, no_answer}`.
  Coverage numerator = rows with `state = answered`.
- **Visibility denominator** = rows with `state = answered`, further narrowed to
  the eliciting pool (`src/lib/scoring/enginePipeline.js:367-373`).
  Numerator = those with `visible === true`.
- **Citation denominator** = rows with `state = answered` **and**
  `citations_state = "measured"`.
- Rows in the other six states are counted **only** in a `not_measured` tally,
  broken down by `state` and `state_reason`, which every slice **must** report
  and every surface that shows a rate **must** be able to show.

A slice whose coverage denominator is zero has **not** measured zero coverage.
It has measured nothing, and its rate is `null`, not `0`.

### 3.12 Slice-level state (the R2.1.1 boundary)

Row `state` and slice state are different vocabularies and must not be confused.
R2.1.1 owns the slice-level four: `measured | measured_zero | not_assessed |
failed`. The mapping this contract fixes:

| Slice state | Condition on the rows |
|---|---|
| `measured` | visibility denominator ≥ the minimum sample and at least one `visible` row |
| `measured_zero` | visibility denominator ≥ the minimum sample and zero `visible` rows — **a real 0%** |
| `not_assessed` | visibility denominator below the minimum sample, or zero |
| `failed` | the health gate tripped (`src/lib/scoring/enginePipeline.js:466-469`) |

`share_of_ai_pct` **must** be `null` for `not_assessed` and `failed`, and `0`
**only** for `measured_zero`. Today it is `0` for all three
(`src/lib/scoring/enginePipeline.js:393-396`) — see §7.

The precedent this follows already exists in the same file: `share_of_voice_pct`
is `null`, not `0` and not `100`, when there is no rival roster to compute it
over (`src/lib/scoring/enginePipeline.js:427-431`), for exactly this reason.

### 3.13 Who consumes this contract, and how that is checkable

R1.1.1's acceptance criterion requires that **R2.1 consumes this contract**.
That link is not a claim in prose; it is a declared dependency in the
orchestration ledger, and it is checkable:

```
node .claude/orchestration/orchestrate.mjs show R2.1.1
node .claude/orchestration/orchestrate.mjs show R1.2.4
```

At `49fe39e`:

| Task | Declares | What it takes from here |
|---|---|---|
| **R2.1.1** — *Per-engine summaries emit state + state_reason* | `"deps": ["R1.1.1"]` | The slice-state four and the `null`-not-`0` rule of §3.12; the `not_measured` tally §3.11 makes mandatory. Its own accept criterion — "an engine with an empty pool emits null plus `state='not_assessed'` and a reason" — is §3.12 restated as a test. |
| **R2.1.2** — *Delete every `?? 0` null-coalescing metric* | `"deps": ["R2.1.1"]`, transitively on this contract | §3.4's THE RULE: a `?? 0` downstream re-erases the `null`/`false`/`[]` distinction the row shape creates. |
| **R1.2.4** — *Authenticated ingest `POST /api/internal/probe-results`* | `"deps": ["R1.2.3", "R1.1.1"]`, and its detail names *"contract-validated against Probe Result Contract v2"* by name | §3 in full, and §5's `422`-never-repair rule. |

**Do not cite a line number in `.claude/orchestration/tasks.json`.** That file is
written continuously by the controller and by every worker; a line citation into
it is false within the hour. Query it by task id instead. (For the record, at
`49fe39e` R2.1.1's `deps` block is at `tasks.json:2735-2737` and R1.2.4's at
`:1997-2000` — offered as reproduction detail for this commit only, not as a
citation to maintain.)

**R2.1.1 has not consumed it yet.** Its ledger status at `49fe39e` is `todo`,
its `readiness.why` is `"waiting on R1.1.1"`, and `summarizeEngineSlice`'s
return object (`src/lib/scoring/enginePipeline.js:480-510`) carries no `state`
and no `state_reason` — twenty-seven fields, none of them either. The dependency is
declared and the contract is written; the consumption is scheduled, not done.
§9 says the same thing and it is repeated here so this section cannot be read as
a completion claim.

---

## 4. Required vs engine-optional

**Required from every engine on every surface:** everything in §3.1, plus §3.4
under `answered`, plus `citations_state`.

**Engine-optional** — a consumer must treat absence as absence, not as zero:

| Field | Populated by | Absent from |
|---|---|---|
| `organic` | `aio` (`enginePipeline.js:104`) | `chatgpt`, `perplexity` |
| `brand_organic_position` | `aio` (`enginePipeline.js:109`) | others; `null` also means "not in the top 10", which `organic` disambiguates |
| `references[].title` / `.source` | `aio`, `chatgpt`, `perplexity` — but frequently `""` | — |
| `timings.navigation_ms` | `ui` only | `api` |

An engine-optional field that is absent **must be omitted or `null`**, never
`0`, `""` or `[]`.

## 5. Rejection

The R1.2.4 ingest route **must** validate against §3 and **must** answer `422`
on a body that fails it. It **must not** repair, default, or coerce. A rejected
probe result is not written and the task is left for retry.

Rejection is mandatory (not merely permitted) for:

- a missing or unknown `state`;
- `state_reason` absent for any state other than `answered`;
- any §3.4 field non-null when `state` is not `answered` (the row claims a
  measurement it did not make);
- any §3.4 field null when `state` is `answered`;
- `visible !== (brand_mentioned_in_text || brand_cited)` when `answered`;
- `engine_surface: "ui"` with no `screenshot_id` and no `dom_id`;
- `cost.basis: "unpriced"` with a non-null `amount_usd`;
- `cost.basis: "no_charge"` with `amount_usd` anything other than `0`;
- `cost.basis: "no_charge"` with an absent or empty `cost.reason` — an
  unexplained zero is the shape §3.9 exists to stop;
- `cost.basis: "vendor_reported"` or `"estimated"` on a row whose adapter made
  no metered call (§3.9: that zero is ours, not the vendor's);
- `citations_state: "measured"` with `citations: null`.

The refusal precedent is already in the tree: `probeBatch`
(`worker/src/lib/probe.js:26-31`) throws rather than returning zero-valued rows;
`requireClient` (`worker/src/lib/queue.js:84-92`) throws rather than returning
an empty batch, "because an unreachable queue and an empty one would otherwise
look identical"; `claimBatch` throws on a missing `workerId`
(`worker/src/lib/queue.js:184`); and `reportBatch` refuses to report a count it
cannot verify (`worker/src/lib/queue.js:220-225`). Failing loud at the boundary
is cheaper than a plausible row in the denominator.

## 6. Examples

### 6.1 A good result — measured, and the brand was named

```json
{
  "contract_version": 2,
  "engine": "perplexity",
  "engine_surface": "ui",
  "query": "best vitrified tile brands in india",
  "geo": "in",
  "state": "answered",
  "state_reason": null,
  "probed_at": "2026-09-05T06:31:12.004Z",
  "attempt": 1,
  "text": "For large-format vitrified tiles, Kajaria, Somany and Italica are ...",
  "citations": ["https://kajariaceramics.com/vitrified", "https://italicatiles.com/products"],
  "references": [
    { "href": "https://italicatiles.com/products", "title": "Products", "source": "Italica", "domain": "italicatiles.com" }
  ],
  "citations_state": "measured",
  "brand_mentioned_in_text": true,
  "brand_cited": true,
  "visible": true,
  "competitors_found_in_text": ["Kajaria", "Somany"],
  "competitors_cited": ["Kajaria"],
  "brands": [
    { "name": "Italica", "is_self": true, "mentioned": true, "position": 3, "sentiment": 72 },
    { "name": "Kajaria", "is_self": false, "mentioned": true, "position": 1, "sentiment": 80 }
  ],
  "timings": { "total_ms": 18422, "navigation_ms": 4110, "extract_ms": 96 },
  "evidence": { "screenshot_id": "ev/2026-09-05/pplx/0a1b.png", "dom_id": "ev/2026-09-05/pplx/0a1b.html", "har_id": null, "raw_id": null },
  "cost": { "amount_usd": 0, "basis": "no_charge", "reason": "ui_surface_no_metered_call" }
}
```

The cost line is the honest shape for a logged-out UI probe, and it took two
attempts to get right. `basis: "vendor_reported"` — what an earlier revision of
this example carried — would have been false: no vendor returned a price, so the
zero is our own inference and `vendor_reported` would have laundered it as a
measurement while also exempting the row from the disclosure §3.9 requires of a
summing consumer. `basis: "unpriced"` would be false in the other direction,
because `unpriced` means "we do not know" and here we do. `no_charge` says
exactly what happened — we did not issue a metered request — and `reason` names
the rule so an operator can check it. It is still not a claim that the probe was
free to run; the browser and proxy cost is outside this contract (§3.9).

### 6.2 A measured zero — the answer named vendors, and not us

Identical shape to §6.1 with `brand_mentioned_in_text: false`,
`brand_cited: false`, `visible: false`, and a `brands` array in which the self
entry has `mentioned: false, position: null, sentiment: null`. This row **is** in
the visibility denominator and **is** a real zero. It is the only row shape that
may lower the score.

### 6.3 A degraded result — answered, citations unverifiable

```json
{
  "contract_version": 2,
  "engine": "perplexity",
  "engine_surface": "api",
  "query": "best vitrified tile brands in india",
  "geo": "in",
  "state": "answered",
  "state_reason": null,
  "probed_at": "2026-09-05T06:33:40.881Z",
  "attempt": 3,
  "text": "For large-format vitrified tiles, Kajaria, Somany and Italica are ...",
  "citations": [],
  "references": [],
  "citations_state": "unverified",
  "brand_mentioned_in_text": true,
  "brand_cited": null,
  "visible": true,
  "competitors_found_in_text": ["Kajaria", "Somany"],
  "competitors_cited": null,
  "brands": [ { "name": "Italica", "is_self": true, "mentioned": true, "position": 3, "sentiment": 72 } ],
  "timings": { "total_ms": 9004, "navigation_ms": null, "extract_ms": 41 },
  "evidence": { "screenshot_id": null, "dom_id": null, "har_id": null, "raw_id": "ev/2026-09-05/pplx-api/7c2d.json" },
  "cost": { "amount_usd": null, "basis": "unpriced", "reason": "vendor_returned_no_price" },
  "error_detail": "search leg: HTTP 403 after 3 attempts"
}
```

Read it field by field: the answer was measured, so the row scores for coverage
and visibility. The citation channel was not, so `brand_cited` and
`competitors_cited` are `null` — not `false` — and `citations_state` keeps this
row out of every citation denominator. `visible` is `true` on the strength of the
mention alone, which is legitimate because a mention was observed. Nobody priced
the call, so the cost is `null` and says why.

This is the exact row `src/lib/engines/perplexity.js:174-180` produces today with
`error: null`, `citations: []` and `brand_cited: false` — which is why it is the
worked example.

### 6.4 A blocked result — nothing was measured

```json
{
  "contract_version": 2,
  "engine": "chatgpt",
  "engine_surface": "ui",
  "query": "best vitrified tile brands in india",
  "geo": "in",
  "state": "login_wall",
  "state_reason": "auth_required_before_answer",
  "probed_at": "2026-09-05T06:35:02.113Z",
  "attempt": 2,
  "text": null,
  "citations": null,
  "references": null,
  "citations_state": "not_applicable",
  "brand_mentioned_in_text": null,
  "brand_cited": null,
  "visible": null,
  "competitors_found_in_text": null,
  "competitors_cited": null,
  "brands": null,
  "timings": { "total_ms": 7311, "navigation_ms": 6980, "extract_ms": null },
  "evidence": { "screenshot_id": "ev/2026-09-05/cgpt/3f9a.png", "dom_id": "ev/2026-09-05/cgpt/3f9a.html", "har_id": null, "raw_id": null },
  "cost": { "amount_usd": 0, "basis": "no_charge", "reason": "ui_surface_no_metered_call" },
  "error_detail": "redirected to /auth/login before any assistant turn rendered"
}
```

Every measurement field is `null`. This row is in **no** denominator. It appears
in the slice's `not_measured` tally as `login_wall / auth_required_before_answer`,
and the screenshot is what lets a human confirm that classification.

The cost is `no_charge`, not `unpriced`, for the same reason as §6.1: this is a
UI surface and no metered request was issued. A failed probe is not automatically
an unpriced one — `unpriced` is reserved for calls whose price we genuinely do
not know, which is §6.3, not this.

### 6.5 A rejected result — refused at ingest, never stored

```json
{
  "contract_version": 2,
  "engine": "chatgpt",
  "engine_surface": "ui",
  "query": "best vitrified tile brands in india",
  "geo": "in",
  "state": "blocked",
  "state_reason": "cloudflare_challenge",
  "probed_at": "2026-09-05T06:36:44.002Z",
  "attempt": 1,
  "text": "",
  "citations": [],
  "visible": false,
  "citations_state": "measured",
  "timings": { "total_ms": 5002, "navigation_ms": 4900, "extract_ms": null },
  "evidence": { "screenshot_id": null, "dom_id": null, "har_id": null, "raw_id": null },
  "cost": { "amount_usd": 0, "basis": "unpriced" }
}
```

Four independent rejections, any one of which is sufficient — `422`:

1. `state: "blocked"` with `visible: false` and `citations: []` — measurement
   fields non-null on a non-`answered` row. **This is the original bug**: stored,
   it is a measured non-mention.
2. `citations_state: "measured"` on a row that measured nothing.
3. `engine_surface: "ui"` with neither `screenshot_id` nor `dom_id`.
4. `cost.basis: "unpriced"` with `amount_usd: 0`.

The route must not fix any of these. It answers `422`, writes nothing, and the
task is retried or reported.

## 7. Where the code violates this contract today

Each of these is a gap between §3 and the code at `49fe39e`. None is fixed by
this document; each needs a task.

**Re-verification status at `49fe39e`.** The six violations with no owning task
— V1, V2, V3, V6, V8, V10 — were each re-checked against
`git show 49fe39e:<path>` for this revision. **All six still reproduce**, and V3
was re-run rather than re-read (see the note below). The stale citation in
`src/lib/engines/deployedEngines.js:21` also still reproduces. Nothing in this
section has been fixed since the previous revision; if you are reading this
after a fix has landed, the honest move is to strike the row and name the
commit, not to leave it standing.

Two claims did **not** survive re-verification unchanged, and both are corrected
below rather than quietly restated: V12's mechanism (the writer exists; the
producer does not) and V3's second render path (the previous revision's chain
through `db.js:119` could not execute). Neither correction weakens the
violation; in both cases every cited line resolved and it was the *chain drawn
between* the lines that could not run.

| # | Violation | Where | Existing task |
|---|---|---|---|
| V1 | No `state` field exists. Outcome is inferred from `answer_present` plus a free-text `error`. | `src/lib/scoring/enginePipeline.js:78-98`, `:176-196` | none — needs one |
| V2 | Measurement fields are initialised `false` and left `false` on the failure path, so not-measured is stored as measured-absent. | `enginePipeline.js:90-92`, `:188-190`; failure return at `:200-205` | none — needs one |
| V3 | `coverage_pct`'s denominator is every non-branded row **including errored ones**, so a provider outage reads identically to Google genuinely serving no AI Overview. **Reproduced — see below.** | `enginePipeline.js:334`, `:331`, `:386-389`; renders via `:503` → `:728` → `DashboardShell.jsx:661`, `:735` (gated) and via `:939` → `scanWorker.js:1769` → `db.js:123`/`:147` → `weeklyReport.js:24`, `:35` (ungated) | none — needs one |
| V4 | `share_of_ai_pct` is `0` for an empty eliciting pool, where §3.12 requires `null`. | `enginePipeline.js:393-396` | R2.1.1 |
| V5 | Perplexity search-leg failure returns `error: null` and `citations: []`; no `citations_state`. | `src/lib/engines/perplexity.js:174-180` | R2.2.2 |
| V6 | `cost` is a bare number and is never null; two hardcoded `0.005` constants and one `0.0015` are reported as spend, with no provenance. The vocabulary to fix it already exists one layer over (`cost_source`, §3.9) and no probe adapter uses it. | `perplexity.js:67`, `perplexity.js:121`, `enginePipeline.js:111`; contrast `src/lib/llmPricing.js:308` | none — needs one |
| V7 | No `engine_surface` anywhere. Every row today is `api`, and nothing says so. | `enginePipeline.js:78-98`, `:176-196` | R1.4.4 (partially) |
| V8 | No `geo` on the result. `resolveSerpGeo()` is called per request but discarded; the two chat adapters hardcode `country: "IN"` in the body. | `enginePipeline.js:101` via `brightdata.js:361`; `openai.js:28`; `perplexity.js:47` | none — needs one |
| V9 | No `evidence`, no `timings`, no `attempt`, no `probed_at`. | both result literals | R1.5.1/R1.5.2 (evidence); none for timings |
| V10 | `error` is free text with no closed vocabulary; `EMPTY_ANSWER` is the only sentinel. | `enginePipeline.js:162`, `:234`; `:148` | none — needs one |
| V11 | Three adapters return a "skipped" sentinel with `cost: 0.0` and no error at all — a missing credential is indistinguishable from a successful empty answer. | `src/lib/engines/gemini.js:15`, `:29`; `src/lib/engines/serp.js:162`, `:275` | see note below |
| V12 | `probe_tasks.outcome` has the right eight-value CHECK and a *working writer*, but no producer. `reportBatch` writes outcomes through `complete_probe_tasks`, and the worker loop calls it — but `probeBatch` throws first, so no outcome is ever produced to write. The vocabulary is enforced on a column that receives no rows, and the reason is upstream of the write, not at it. **Corrected in this revision**; see §2.3. | `supabase/migrations/010_probe_tasks.sql:57-61`; `worker/src/lib/probe.js:26-31`; writer at `worker/src/lib/queue.js:207-231`, called at `worker/src/index.js:211`, unreachable because of `worker/src/index.js:174` | R1.3.3, R1.4.3 |

### Note on V3 — reproduced, and it renders

V3 is not inferred from reading the code. It was run, and re-run against
`49fe39e` for this revision; the table below is that second run's output.

Two ten-row `aio` slices were passed through `summarizeEngineSlice`
(`src/lib/scoring/enginePipeline.js:329`). Both have five identical answered
non-branded rows. They differ **only** in the other five:

- **Slice A (provider outage):** five rows with `answer_present: false` and
  `error: "Bright Data HTTP 502"` — the shape `probeAio`'s catch block writes
  (`enginePipeline.js:147-150`).
- **Slice B (genuine no-AI-Overview):** five rows with `answer_present: false`
  and `error: null` — a SERP that rendered with no AI Overview block.

| Field | A — outage | B — no AI Overview |
|---|---|---|
| `non_branded_queries` | 10 | 10 |
| `non_branded_with_answer` | 5 | 5 |
| **`coverage_pct`** | **50** | **50** |
| `errored_queries` | 5 | 0 |
| `error_rate_pct` | 50 | 0 |
| `data_source_issue` | `false` | `false` |

`coverage_pct` is identical. Under §3.11 these are not the same measurement at
all: B has a coverage denominator of 10 and a real 50%; A has a coverage
denominator of 5 and has measured nothing about the other five.

**Mechanism, line by line:**

1. `enginePipeline.js:334` — `const nonBranded = results.filter((r) => !r.is_branded_query);`
   filters on `is_branded_query` and **nothing else**. There is no error filter.
2. `enginePipeline.js:386-389` — `coveragePct` divides
   `nonBrandedWithAnswer.length` by `nonBranded.length`. Every errored row is
   still in that denominator.
3. `enginePipeline.js:331` — `const errored = results.filter((r) => r.error).length;`
   is the only place the error is counted, and it feeds exactly two outputs:
   `error_rate_pct` (`:390`, surfaced at `:504`) and the `errored_queries` field
   (`:488`). **Neither ever removes a row from the coverage denominator.**

**It renders, by two paths, and only one of them is gated.** `coverage_pct` is
set on the slice at `enginePipeline.js:503` and the slice map is returned as
`engines` (`:909`, `:964`).

*Path 1 — gated, the dashboard health panel.* `src/services/api.js:597` reads
`engines` into `perEngineSummaries` and
`src/components/dashboard/DashboardShell.jsx:369` calls
`describeScanDataSourceIssue` on it. Slices flagged `data_source_issue` go
through `describeDegradedSlice` (`enginePipeline.js:639` → `:698`), which copies
`slice.coverage_pct` onto the rendered record at `enginePipeline.js:728`, and
`DashboardShell.jsx:661` and `:735` print it as *"answer coverage"*. The shell is
mounted by `src/app/dashboard/[brand]/page.js:88` and
`src/app/dashboard/[brand]/[scanId]/page.js:50`.

*Path 2 — ungated, the weekly-report KPI.* `enginePipeline.js:939` —
`aio_coverage_pct: aioSummary.coverage_pct || 0` — copies the same number onto
the scan `summary` with **no gate at all**. From there, hop by hop:
`src/lib/workers/scanWorker.js:1769` (`summary_stats: summary`) →
`src/lib/db.js:123` and the `raw_results` payload assembled at `src/lib/db.js:147`
→ read back by `getScansForBrand` (`src/lib/db.js:237-251`, `select("*")`),
called at `src/lib/content/weeklyReport.js:114` → `scanMetrics` reads
`raw.summary_stats` at `weeklyReport.js:24` and lifts the number at `:35` →
rendered as the *"AI answer coverage"* KPI at `:65-71` → reached over HTTP by
`POST /api/content/report` (`src/app/api/content/report/route.js:14`, importing
`generateWeeklyReport` at `:2`).

*The promoted column is a third surface, and a separate hop.* An earlier
revision drew path 2 as `:939` → `db.js:119` → `weeklyReport.js:35`. Every one
of those three lines is real and every one of them resolves, but **that chain
cannot execute**: `db.js:119` is the promoted `aio_coverage_pct` *column* in
`insertScan`'s allowlist, fed by `src/lib/workers/scanWorker.js:1729`, and the
weekly report never reads it — it reads `raw_results.summary_stats`. The column
is read by `src/services/api.js:396-399` and
`src/app/api/scans/_lib/scanRow.js:81-82` instead. Both surfaces carry the same
fabricated denominator, so the violation is unchanged; the trace was wrong and
is corrected here because a chain drawn between correct lines is still a
fabrication if it cannot run.

**Path 1 does not fire for slice A, and that makes it worse, not better.**
Neither health gate trips. The gate reads its two numbers from
`engineHealthThresholds` (`enginePipeline.js:56-66`, called at `:465`), which for
`aio` returns `AIO_MIN_NON_BRANDED_COVERAGE` = `0.15` and
`AIO_ERROR_RATE_LIMIT_PCT` = `50` (`src/lib/scoring/aioConstants.js:4`, `:1`).
Coverage reads `0.5`, which clears `0.15`; and the comparison at
`enginePipeline.js:466-469` is a strict `>`, so a 50% error rate is not over its
own limit of 50. `data_source_issue` is `false`, as the run above confirms.
(For a *text* engine the same gate uses `TEXT_ENGINE_MIN_NON_BRANDED_COVERAGE` =
`0.9` (`enginePipeline.js:36`), which is why the equivalent chat slice in §3.2
*is* flagged. The aio floor is the loose one, and aio is the engine this
violation is about.) So a 50% Bright Data outage raises **no** degraded banner — the
fabricated denominator is what keeps coverage above the gate that exists to catch
exactly this — while path 2 still ships `aio_coverage_pct: 50` to the weekly
report as a measurement of Google.

This is a scoring bug, not merely a contract gap. It has no owning task.

**Note on V11 — dead code, deliberately not counted as live.** Following
standing rule 10, these were traced before being listed, and re-traced at
`49fe39e` with `git grep` over `src/`, `worker/` and `scripts/`:

- `probeGemini` (`src/lib/engines/gemini.js:11`) has **no importer anywhere**.
  Nothing imports `src/lib/engines/gemini.js` at all. (Beware the near-miss:
  `src/lib/gemini.js` is a *different* file and its `generateContent` is
  imported by `prompts.js:1` and `judge.js:1`. Grepping for `gemini.js` finds
  those and proves nothing about the adapter.)
- `probeGoogleAiOverview` (`src/lib/engines/serp.js:158`) is imported only by
  `src/lib/engines/serp.test.mjs:3` and `src/lib/engines/serpGeo.test.mjs:4` —
  tests, both of them.
- The only non-test import from `serp.js` is `fetchPeopleAlsoAsk` /
  `fetchAutocomplete` into `src/lib/scoring/promptGen.js:9`, which *is* live:
  imported by `src/lib/workers/scanWorker.js:28` and called at
  `promptGen.js:185-186`. It does not reach either sentinel above.

(That `:9` is the citation revision 1 got from the dirty tree: it was `:3` at
the `8502166` baseline and has been `:9` since `25e7727`. The trace it supports
was correct in both directions; only the number was read from the wrong commit.)

So V11 cannot corrupt a score today. It is listed because the shape is the
anti-pattern this contract forbids and because these files are still reachable
by one added import; the correct fix is deletion (R1.7.3), not conformance.

### A stale citation found while verifying

**Still reproduces at `49fe39e`.** `src/lib/engines/deployedEngines.js:21` cites
`resolveEnabledEngines (src/lib/scoring/enginePipeline.js:527)`. At `49fe39e`
that function is at `src/lib/scoring/enginePipeline.js:818`. It was `:777` at
`8502166` and `:818` at `25e7727`, so the comment has been wrong by two
different amounts across the three baselines this contract has used — which is
the whole argument for naming the function rather than the line. The prose in
that comment is correct; the number is not. Not fixed here: this contract does
not edit source. It needs a one-line follow-up, and the fix should delete the
line number rather than update it.

## 8. What would change this contract

- **A ninth outcome.** If a real surface produces a state none of the eight
  describe (e.g. an answer that streams and then retracts), add it here, to
  `worker/src/lib/probe.js` and to the CHECK in a new migration, in one commit —
  and say which denominator it joins.
- **A surface with a genuine no-answer state.** §3.2 restricts `no_answer` to
  Google AIO because that is the only surface known to have one. Evidence that
  another does reopens that restriction.
- **Promoted columns.** If R1.5.2 promotes `state` / `citations_state` /
  `engine_surface` out of `raw` into real `prompt_results` columns, §2.4 changes
  and this section should name the migration.
- **A fifth `cost.basis`.** Unlike `state`, `basis` is this contract's own
  vocabulary and is not frozen in a migration, so it can be extended here alone.
  `no_charge` was the fourth, added because `src/lib/llmPricing.js`'s `free_tier`
  had no representable value. A fifth needs the same test: a real cost source
  whose provenance none of the four describes. Adding a `no_charge` **reason** is
  cheaper and is the right move for anything that is still "we know the meter did
  not run".
- **Our own infrastructure cost.** §3.9 models vendor spend only. If browser,
  proxy or compute cost is ever attributed per probe, `no_charge` stops being
  true as written and this section is where that reckoning starts.

## 9. What is unproven

- **No adapter has ever emitted a v2 result.** `probeBatch` throws
  (`worker/src/lib/probe.js:26-31`). Every example in §6 is constructed from the
  contract, not captured from a run. The first captured v2 result belongs in this
  document, replacing §6.1.
- **The probe worker is not deployed by anything in this repo.** Even if an
  adapter existed, nothing at `49fe39e` launches `worker/src/index.js`: no
  Dockerfile, Procfile, fly/render config or GitHub workflow starts it. The
  container host named in `worker/package.json`'s description is a plan, not a
  deployment this tree can prove.
- **The ingest route does not exist.** R1.2.4 is `todo`; §5's `422` behaviour is
  specified and unimplemented.
- **No consumer reads a row `state` or a slice `state`, because neither is
  emitted.** R2.1.1 is `todo` and blocked on this contract;
  `summarizeEngineSlice`'s return object
  (`src/lib/scoring/enginePipeline.js:480-510`) has no such field. §3.13 states
  the consumption link as a declared dependency, which is what it is — not as
  work that has happened.
- **`basis: "no_charge"` has never been emitted or validated.** It is defined in
  §3.9 and used in two constructed examples. Nothing in the tree writes it,
  nothing rejects a malformed one, and no adapter performs the §3.9 mapping from
  `cost_source`. The `free_tier` gap it closes is real and verified
  (`src/lib/llmPricing.js:335`, `src/lib/openrouter.test.mjs:537`); the closure
  is on paper.
- **§3.11's `not_measured` tally does not exist in code.** §3.2's argument for
  excluding empty chat bodies from the coverage denominator depends on it
  entirely, and every consumer in the tree today reports `coverage_pct` with no
  tally beside it. Until R2.1.1 ships one, the honest reading of §3.2 is that it
  specifies a trade the product cannot yet honour.
- **V3 is reproduced but not fixed.** The numbers in §7's V3 note came from
  running `summarizeEngineSlice` at `49fe39e`, not from reading it. No task owns
  the fix, and every scan scored since has the defect.
- **The approve-to-publish-to-lift loop has never run end to end.** Not once, not
  in staging, not with a stub at either end. Nothing in this contract has been
  exercised against a real published change, so every claim here about what a
  v2 result *will* look like in production is a specification and not an
  observation. Read §6 accordingly.

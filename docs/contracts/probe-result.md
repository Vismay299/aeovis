# Contract — Probe Result v2

> <!-- doc-status -->
> **Status: LIVE** as the normative target for the R1 probe fleet
> (`worker/`) and the R1.2.4 ingest route.
> It is **not** a description of what `src/lib/scoring/enginePipeline.js`
> returns today. Section 2 records that shape as it actually is; section 7 lists
> every place today's code violates section 3.

**Date:** 2026-09-05 · **Task:** R1.1.1 · **Consumed by:** R1.1.4, R1.2.4,
R1.3.3, R1.4.4, R1.5.2, R2.1.1
**Baseline commit for every line number below:** `8502166`. Every citation in
this document was read at that commit (`git show 8502166:<path>`), not copied
from the roadmap.

Two of the cited files — `src/lib/scoring/enginePipeline.js` and
`src/lib/workers/scanWorker.js` — had uncommitted edits by other implementers in
the tree while this was written. For `enginePipeline.js` those edits are confined
to lines 777+, so every line cited from it is byte-identical at `8502166` and in
the working tree; that was checked both ways. For `scanWorker.js` the working
tree has already diverged above the cited lines, so **those line numbers are true
at `8502166` and may be stale once the concurrent work lands.** The surrounding
prose names the function and the field in each case, which is what a reader
should re-anchor on.

This is the first document in `docs/contracts/`. Contracts are **normative**:
"must" and "never" here are requirements on code, not advice.

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
(`src/lib/scoring/enginePipeline.js:735`), whose `probe` functions are invoked at
`src/lib/workers/scanWorker.js:987`. That runs inside `runScanChunk`, which is
called from `src/app/api/scan/route.js:62` (POST /api/scan) and from
`src/app/api/scan/worker/route.js:138`, whose route is on the daily cron in
`vercel.json:4-5`. **This chain executes in production.** It is not a legacy
path.

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
| `brand_mentioned_in_text` | boolean | both | **initialised `false`** (`:90`, `:187`) |
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
CHECK constraint. **Neither is wired to anything yet**: `probeBatch` at
`worker/src/lib/probe.js:26-31` throws rather than returning zero-valued rows,
and no adapter writes `probe_tasks.outcome`. The vocabulary is decided; the
producer is not built. This contract is what the adapters of R1.3 and R1.4 must
satisfy.

### 2.4 How v1 is persisted

`src/lib/workers/scanWorker.js:1025-1048` (`const rows = batchResults.map`) maps the probe row onto
`prompt_results` (`supabase/migrations/005_analytics_platform.sql:8-27`):
`answered` ← `answer_present` (`:1039`), `answer_text` ← `text`, and the entire
probe result verbatim into `raw` jsonb (`:1047`). The row is unique on
`(job_id, engine, query)` (`005_analytics_platform.sql:26`).

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

The vocabulary is closed. It is the one already frozen at
`worker/src/lib/probe.js:15-24` and constrained at
`supabase/migrations/010_probe_tasks.sql:57-61`. A ninth value **must not** be
invented; adding one is a migration plus an edit to this contract.

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

This is not a stylistic choice. Setting `no_answer` there would put the row back
into the coverage denominator and undo R2.2.1, which exists precisely because an
empty 200 from a text engine was being scored as an answered non-mention
(`src/lib/scoring/enginePipeline.js:217-241`; regression test
`src/lib/scoring/emptyAnswer.test.mjs:86`).

`skipped` is never a success. It is the state for "an engine frozen into a
checkpoint no longer resolves", "no credential", "budget exhausted" — the same
class of discarded decision `CHUNK_SKIP_REASONS`
(`src/lib/workers/scanWorker.js:189-204`) was created to stop losing.

### 3.3 `state_reason`

`state_reason` **must** be present and non-empty for every `state` except
`answered`. It **must** be snake_case and drawn from a per-state closed list
owned by the adapter, not a free-text message. The free-text detail belongs in
`error_detail` (§3.10), never in `state_reason`.

This mirrors what the schema already enforces one level up: `scan_runs.reason`
is required for every outcome except `succeeded`
(`supabase/migrations/011_scan_runs.sql:110-112`), and `recordSkip` throws on a
reason-less skip (`src/lib/workers/scanWorker.js:228-233`). A skip with no
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
cost: { amount_usd: number|null, basis: "vendor_reported"|"estimated"|"unpriced" }
```

- `basis: "vendor_reported"` — the vendor returned a price and `amount_usd` is
  it.
- `basis: "estimated"` — we computed it from a rate card we hold; `amount_usd`
  is non-null.
- `basis: "unpriced"` — nobody priced this call. `amount_usd` **must** be
  `null`, never `0`.

`amount_usd: 0` therefore means *this call genuinely cost nothing*, and nothing
else. Standing rule 5 of the rebuild — an unpriced model id fails loud, never
`$0` — applied to the probe row. A consumer summing `amount_usd` **must** report
how many rows were `unpriced` alongside the total, or report the total as
unavailable.

### 3.10 Citation honesty — `citations_state`

```
citations_state: "measured" | "unverified" | "not_applicable"
```

Required on every row.

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

> **Only `answered` and `no_answer` may enter a scoring denominator. No other
> state may enter any denominator or any numerator, ever.**

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
- `citations_state: "measured"` with `citations: null`.

The refusal precedent is already in the tree: `probeBatch`
(`worker/src/lib/probe.js:26-31`) throws rather than returning zero-valued rows,
and `claim`-side helpers in `worker/src/lib/queue.js` do the same. Failing loud
at the boundary is cheaper than a plausible row in the denominator.

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
  "cost": { "amount_usd": 0, "basis": "vendor_reported" }
}
```

`amount_usd: 0` with `basis: "vendor_reported"` is the honest shape for a
logged-out UI probe: the vendor charged nothing because we did not call the API.

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
  "cost": { "amount_usd": null, "basis": "unpriced" },
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
  "cost": { "amount_usd": null, "basis": "unpriced" },
  "error_detail": "redirected to /auth/login before any assistant turn rendered"
}
```

Every measurement field is `null`. This row is in **no** denominator. It appears
in the slice's `not_measured` tally as `login_wall / auth_required_before_answer`,
and the screenshot is what lets a human confirm that classification.

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

Each of these is a real, currently-reproducing gap between §3 and HEAD. None is
fixed by this document; each needs a task. Verified at `8502166`.

| # | Violation | Where | Existing task |
|---|---|---|---|
| V1 | No `state` field exists. Outcome is inferred from `answer_present` plus a free-text `error`. | `src/lib/scoring/enginePipeline.js:78-98`, `:176-196` | none — needs one |
| V2 | Measurement fields are initialised `false` and left `false` on the failure path, so not-measured is stored as measured-absent. | `enginePipeline.js:90-92`, `:188-190`; failure return at `:200-205` | none — needs one |
| V3 | `coverage_pct`'s denominator is every non-branded row **including errored ones**, so a Bright Data outage reads identically to Google genuinely serving no AI Overview. | `enginePipeline.js:386-389` (denominator `nonBranded.length`, which includes rows filtered as `errored` at `:331`) | none — needs one |
| V4 | `share_of_ai_pct` is `0` for an empty eliciting pool, where §3.12 requires `null`. | `enginePipeline.js:393-396` | R2.1.1 |
| V5 | Perplexity search-leg failure returns `error: null` and `citations: []`; no `citations_state`. | `src/lib/engines/perplexity.js:174-180` | R2.2.2 |
| V6 | `cost` is a bare number and is never null; two hardcoded `0.005` constants and one `0.0015` are reported as spend. | `perplexity.js:67`, `perplexity.js:121`, `enginePipeline.js:111` | none — needs one |
| V7 | No `engine_surface` anywhere. Every row today is `api`, and nothing says so. | `enginePipeline.js:78-98`, `:176-196` | R1.4.4 (partially) |
| V8 | No `geo` on the result. `resolveSerpGeo()` is called per request but discarded; the two chat adapters hardcode `country: "IN"` in the body. | `enginePipeline.js:101` via `brightdata.js:361`; `openai.js:28`; `perplexity.js:47` | none — needs one |
| V9 | No `evidence`, no `timings`, no `attempt`, no `probed_at`. | both result literals | R1.5.1/R1.5.2 (evidence); none for timings |
| V10 | `error` is free text with no closed vocabulary; `EMPTY_ANSWER` is the only sentinel. | `enginePipeline.js:162`, `:234`; `:148` | none — needs one |
| V11 | Three adapters return a "skipped" sentinel with `cost: 0.0` and no error at all — a missing credential is indistinguishable from a successful empty answer. | `src/lib/engines/gemini.js:15`, `:29`; `src/lib/engines/serp.js:162`, `:275` | see note below |
| V12 | `probe_tasks.outcome` has the right eight-value CHECK, but nothing writes it: `probeBatch` throws. The vocabulary is enforced on a column that receives no rows. | `supabase/migrations/010_probe_tasks.sql:57-61`; `worker/src/lib/probe.js:26-31` | R1.3.3, R1.4.3 |

**Note on V11 — dead code, deliberately not counted as live.** Following standing
rule 10, I traced these before listing them. `probeGemini`
(`src/lib/engines/gemini.js:11`) has **no importer anywhere** in `src/`,
`worker/` or `scripts/` outside its own file. `probeGoogleAiOverview`
(`src/lib/engines/serp.js:158`) is imported only by
`src/lib/engines/serp.test.mjs:3` and `src/lib/engines/serpGeo.test.mjs:4`. The
only live import from `serp.js` is `fetchPeopleAlsoAsk` / `fetchAutocomplete`
into `src/lib/scoring/promptGen.js:9`. So V11 cannot corrupt a score today. It is
listed because the shape is the anti-pattern this contract forbids and because
these files are still reachable by one added import; the correct fix is deletion
(R1.7.3), not conformance.

### A stale citation found while verifying

`src/lib/engines/deployedEngines.js:21` cites
`resolveEnabledEngines (src/lib/scoring/enginePipeline.js:527)`. At `8502166`
that function is at `src/lib/scoring/enginePipeline.js:777`. The prose is
correct; the line number is not. Not fixed here — this contract does not edit
source. It needs a one-line follow-up.

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

## 9. What is unproven

- **No adapter has ever emitted a v2 result.** `probeBatch` throws
  (`worker/src/lib/probe.js:26-31`). Every example in §6 is constructed from the
  contract, not captured from a run. The first captured v2 result belongs in this
  document, replacing §6.1.
- **The ingest route does not exist.** R1.2.4 is `todo`; §5's `422` behaviour is
  specified and unimplemented.
- **The approve-to-publish-to-lift loop has never run end to end.** Nothing in
  this contract has been exercised against a real published change.

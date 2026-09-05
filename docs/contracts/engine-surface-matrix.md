# Contract — Engine Surface Matrix

> <!-- doc-status -->
> **Status: LIVE** as the normative record of which engines this repo probes,
> on which surface, and at what real state of completion.
> It is a description of the tree, not a plan. Where a surface is aspirational
> it is marked aspirational, and §4 says why each deferred surface is deferred.
> The v2 row shape those surfaces must produce is
> [`docs/contracts/probe-result.md`](./probe-result.md); this document does not
> restate it.

**Date:** 2026-09-05 · **Task:** R1.1.4 · **Consumes:** R1.1.1 ·
**Consumed by:** R1.1.2, R1.1.5, R1.3.x, R1.4.x, R1.6.1, R1.7.2, R1.7.3

## Baseline and citation policy

**Every claim in this document was resolved against `git show 1a5ed81:<path>`**
— the committed blob, never the working tree. There is one baseline and it is
`1a5ed81`.

**Citations here name a symbol, not a line.** That is deliberate and it is the
one thing this document does differently from its sibling. `probe-result.md`
carries 155 line citations and has been re-baselined three times because some of
them rotted. R6.3.3 is an open task about two *other* documents —
`docs/HANDOFF-2026-08-30.md` and `docs/BUILD_JOURNAL.md` — whose citations rotted
the same way and now resolve to unrelated code. Every claim below points at a
file and a function, class or constant name instead, so `git grep` for the name
re-derives it at any commit. **This document contains no line citations at all.**

**How to tell whether this file has gone stale:**

```
git log --oneline 1a5ed81..HEAD -- src/lib/scoring/enginePipeline.js \
  src/lib/scoring/aioPipeline.js src/lib/engines/ src/lib/workers/scanWorker.js \
  src/lib/vendorRegistry.js scripts/check-secrets.mjs worker/src/lib/probe.js \
  vercel.json .env.example
```

Empty output means every symbol below is still where it was read. Non-empty
means re-derive before trusting a row.

**Working-tree disclosure, true at the moment of writing.** This tree has
concurrent writers and eight of the files cited below were modified and
uncommitted when this was written:

| File | Why it matters here |
|---|---|
| `src/lib/engines/perplexity.js` | R2.2.2 (`in_verification`) is landing a `citations_state` vocabulary in it. §3.3's citations row describes `1a5ed81` and is **already being changed**. |
| `src/lib/scoring/enginePipeline.js` | Under edit; `ENGINE_REGISTRY` and `probeAio`/`probeTextEngine` are cited by symbol for this reason. |
| `src/lib/engines/brightdata.js`, `src/lib/workers/scanWorker.js`, `src/lib/db.js`, `src/app/api/scan/route.js` | Under edit; cited by symbol only. |
| `src/lib/engines/perplexity.test.mjs`, `src/lib/engines/serp.test.mjs`, `src/lib/engines/types.test.mjs` | Under edit; no claim here depends on them. |

A drift table is worth writing only if it is true when read. If you are reading
this after those commits landed, treat the table as history and re-run the
tripwire above.

**One knock-on this document creates and does not fix.**
`probe-result.md` states in its Baseline section that it "is the only document
in `docs/contracts/`". Adding this file makes that sentence false. It is not
edited here because another agent owns that file this round; it needs a one-line
follow-up.

---

## 1. Why this exists

Two failures recur, and a matrix is the cheapest thing that prevents both.

> **A green cell you cannot point at code for is a lie.** The landing page
> advertised "Google AI Overview, ChatGPT and Perplexity" while the deployment
> ran without `OPENAI_API_KEY` at all — R2.10.1, recorded in the header comment
> of `src/lib/engines/deployedEngines.js`. The claim was wrong in the direction
> that flatters.

> **"The engine is registered" and "the engine can run" are different facts.**
> `ENGINE_REGISTRY`'s `aio` entry hardcodes `isConfigured: () => true` while
> `brightDataSearch` throws without `BRIGHTDATA_API_KEY`. That is R2.10.4 and it
> is §5.1 below. This document must never be read as saying `aio` is configured
> because the registry says so.

## 2. Three engine vocabularies live in this tree, and only one of them runs

Before any row can be read, this has to be said, because grepping for "engine"
in this repo finds three different lists and two of them are dead.

| Vocabulary | Where | Live? | Evidence |
|---|---|---|---|
| `ENGINE_REGISTRY` — `aio`, `chatgpt`, `perplexity` | `src/lib/scoring/enginePipeline.js` | **Yes.** This is the fleet. | Traced in §2.1. |
| `Engine` / `ENGINES` / `ENGINE_DEFAULT_WEIGHTS` / `ENGINE_HYBRID_WEIGHTS` / `getEnabledEngines` — `gemini`, `openai`, `perplexity`, `google_ai_overview` | `src/lib/engines/types.js` | **No.** | Its only importers are `src/lib/scoring/aggregate.js` and `src/lib/scoring/qualityGate.js`. `aggregate.js` is imported only by `src/lib/scoring/computeVisibilityScore.test.mjs`; `qualityGate.js` only by `src/lib/scoring/controlPrompts.test.mjs`. Both chains terminate in tests. This is the "dead second engine registry" R1.7.3 exists to delete. |
| `PROBE_OUTCOMES` — the eight typed outcomes | `worker/src/lib/probe.js` | **Frozen and enforced, with no producer.** | `probeBatch` in the same file throws by design. See `probe-result.md` §2.3. |

The three use different names for the same engine (`openai` vs `chatgpt`,
`google_ai_overview` vs `aio`). Nothing translates between them, because nothing
needs to: only the first one runs.

### 2.1 That the registry chain executes in production

Hop by hop, each hop read at `1a5ed81`, each named by symbol:

1. `ENGINE_REGISTRY` entries are selected by `resolveEnabledEngines`
   (`src/lib/scoring/enginePipeline.js`), which reads the `ENGINES` env var and
   defaults to `"aio"`.
2. `runProbingPhase` (`src/lib/workers/scanWorker.js`) calls `resolveEngines()`
   and then `engine.probe(...)` per query.
3. `runScanChunk` (same file) calls `runProbingPhase`.
4. `runScanChunk` is imported and called by `src/app/api/scan/route.js` (`POST`),
   `src/app/api/scan/worker/route.js` (`GET`, two call sites) and
   `src/app/api/scan/[job_id]/status/route.js` (`GET`).
5. `/api/scan/worker` is on the daily cron in `vercel.json`
   (`"schedule": "0 0 * * *"`).

`runMultiEngineScan` in `enginePipeline.js` is a **second** entry point into the
same registry, used in-process rather than by the chunk worker. It is not the
production path; the chunk worker is.

`runAioScan` in `src/lib/scoring/aioPipeline.js` is a **third** and it is dead —
no importer anywhere. Only `summarizeAioResults` and `aggregateAioTopDomains`
from that file are live (imported by `scanWorker.js`), and neither probes.

---

## 3. The matrix

Read the two right-hand columns first. **"Runs today"** is the only column that
says whether a scan can produce a row from this surface, and it is the column
that gets flattered if nobody checks it.

| # | Engine (registry name) | Surface actually probed | Transport / vendor | Credential | Registered | **Runs today** | Citations | **Cost** |
|---|---|---|---|---|---|---|---|---|
| 1 | `aio` | Google web SERP, AI Overview block | Bright Data Unlocker `POST api.brightdata.com/request` proxying `google.com/search?...&brd_ai_overview=2` | `BRIGHTDATA_API_KEY` (+ optional `BRIGHTDATA_SERP_ZONE`) | yes | **yes**, on this deployment | yes — `ai_overview.references`/`sources`/`citations` | **fabricated** — flat `0.0015`, R3.6.4 |
| 2 | `chatgpt` | `api.openai.com` Responses API with the `web_search` tool | HTTPS JSON | `OPENAI_API_KEY` | yes | **no** — key unconfigured; see §3.2 | yes — `url_citation` annotations | **fabricated** — hardcoded fee + hardcoded rate card; **no owning task**, §5.2 |
| 3 | `perplexity` | `api.perplexity.ai` — two endpoints per probe | HTTPS JSON | `PERPLEXITY_API_KEY` | yes | **yes**, when the key is set | yes, from a **separate** `/search` call that can fail alone | **partly fabricated** — R3.6.5 |
| 4 | *(none)* | `perplexity.ai` logged-out UI | Playwright in `worker/` | none (logged out) | no | **no — not built.** R1.3 | planned | planned `no_charge` |
| 5 | *(none)* | `chatgpt.com` logged-out, search mode | Playwright in `worker/` | none (logged out) | no | **no — not built.** R1.4 | planned | planned `no_charge` |
| 6 | *(none)* | Google **AI Mode** | undecided | — | no | **no — stretch, §4.3** | unknown | unknown |
| 7 | `gemini` (adapter file only) | Gemini API text generation — **not a search surface** | `src/lib/gemini.js` SDK | `GEMINI_API_KEY` | **no** | **no — dead code**, §3.4 | none: returns `citations: []` unconditionally | **fabricated** — R3.6.5 |
| 8 | `google_ai_overview` via SerpAPI | Google SERP via `serpapi.com` | HTTPS JSON | `SERPAPI_KEY` | **no** | **no — dead probe path**, §3.5 | yes, when it ran | **fabricated** — flat `0.0015`, R3.6.4 |
| 9 | Copilot / Grok | — | — | — | no | **no — deferred, §4.4** | — | — |
| 10 | `gsc` | Google Search Console **query data** — not an answer engine | `searchconsole.googleapis.com` | `GSC_SERVICE_ACCOUNT_KEY` | n/a | **scripts only**, §3.6 | n/a | n/a |

No row in this table is `no_answer`-capable except row 1. That restriction is
`probe-result.md` §3.2 and it is a property of the surface, not of the adapter.

### 3.1 `aio` — Google AI Overview via Bright Data

| | |
|---|---|
| **Producer** | `probeAio`, `src/lib/scoring/enginePipeline.js` |
| **Transport** | `brightDataSearch` → `extractBrightDataAiOverview` / `extractBrightDataOrganic`, all in `src/lib/engines/brightdata.js` |
| **Request** | `buildGoogleSearchUrl` builds `https://www.google.com/search?q=…&hl=en&gl=<geo>&brd_json=1&brd_ai_overview=2`, posted to `https://api.brightdata.com/request` with `format: "json"` and `country: <geo>`. |
| **Geo** | `resolveSerpGeo` (`src/lib/engines/serpGeo.js`), `DEFAULT_SERP_GEO = "in"`, overridable by `SERP_GEO`. Used for the request and **discarded** — not recorded on the row (R1.6.1). |
| **Answer** | `answer_present: true`, `aio_present: true`, `text`, `citations`, `references` with a `domain` added, plus `organic` and `brand_organic_position`, which no other engine populates. |
| **Answered-but-absent** | A SERP that renders with **no AI Overview block** returns `text: ""` and no citations from `extractBrightDataAiOverview` (its first branch: `if (!ao) return { text: "", citations: [], references: [] }`), so `probeAio` leaves `answer_present: false`, `error: null` — and still charges `0.0015`. This is the **only genuine `no_answer` surface in the product**. |
| **Unavailable** | `brightDataSearch` throws (unconfigured, zone rejection, HTTP error, truncated body). `probeAio`'s `catch` sets `result.error = err.message` — free text — and leaves `cost: 0`, because `result.cost = 0.0015` is assigned *after* the awaited call. |
| **The distinguishability problem** | A no-AI-Overview SERP and a Bright Data outage differ on this row only by `error` being a free-text string vs `null`, and `summarizeEngineSlice` puts both in the coverage denominator. That is V3 in `probe-result.md` §7 — reproduced there, **still unfixed, still unowned**. |
| **Cost** | Hardcoded `0.0015` in `probeAio`. The same constant is duplicated in `probeGoogleAiOverviewBrightData` (`src/lib/engines/serp.js`) and in `probeQueryOnce` (`src/lib/scoring/aioPipeline.js`). Three copies, R3.6.4. |
| **Honest status** | **Implemented and live.** The extractor tolerates four response shapes (`texts`, `text_blocks`, `paragraphs`, bare `text`/`snippet`), which is a measured vendor quirk, not defensive padding — see `docs/vendors/brightdata.md`. |

### 3.2 `chatgpt` — OpenAI Responses API, `web_search` tool

| | |
|---|---|
| **Producer** | `probeChatGpt`, `src/lib/engines/openai.js`, wrapped by `probeTextEngine` in `enginePipeline.js` |
| **Request** | `POST https://api.openai.com/v1/responses`, model from `OPENAI_MODEL` (default `gpt-4o-mini`), `tools: [{ type: "web_search", user_location: { type: "approximate", country: "IN" } }]`. |
| **Geo** | `country: "IN"` is **hardcoded in the request body** and ignores `SERP_GEO`. It is not recorded on the row. |
| **Answer** | Text assembled from `output[].content[].output_text`; citations from `url_citation` annotations, normalized through `normalizeUrl`. |
| **Unavailable** | No key → `{ text: "", citations: [], references: [], cost: 0, error: "OPENAI_API_KEY not set" }`. After `MAX_RETRIES` → the same shape with the last error message. Both are free-text `error`; neither is a typed skip. Unlike the `gemini` and SerpAPI sentinels (§3.4, §3.5) this adapter **does** set `error`, so a missing credential is at least distinguishable from an answer. |
| **Cost** | `0.01` base web-search fee **plus** tokens priced at literal `0.15` / `0.60` per million. Never vendor-reported. |
| **Runs today** | **No.** `docs/vendors/chatgpt.md` records `check:secrets` reporting `openai UNCONFIGURED` with `ENGINES=aio,perplexity`. That is a second-hand claim about a deployment's environment and is **not verified in this document** — verifying it requires reading production env, which this document must not do. Verify with `npm run check:secrets` against the target environment. |
| **Honest status** | **Implemented, unconfigured, and not the product surface.** Decision D1 of the rebuild is that the API is not what a buyer sees. `chatgpt.com` (row 5) is the real target. |

### 3.3 `perplexity` — two API calls per probe

| | |
|---|---|
| **Producer** | `probePerplexity`, `src/lib/engines/perplexity.js`, wrapped by `probeTextEngine` |
| **Request** | **Two independent calls in parallel**, via `Promise.all([probeAnswer, probeSearch])`: `POST https://api.perplexity.ai/chat/completions` (model from `PERPLEXITY_MODEL`, default `sonar`, `web_search_options.user_location.country = "IN"`) and `POST https://api.perplexity.ai/search` (`max_results: 10`). |
| **Which leg supplies what** | The **answer** leg supplies `text` and nothing else. The **search** leg supplies **every** citation and reference. They are separate products, billed separately. |
| **Geo** | `country: "IN"` hardcoded in the answer body only. The `/search` call carries no geo at all. Neither is recorded on the row. |
| **Unavailable** | No key → `error: "PERPLEXITY_API_KEY not set"`. Both legs failing → `error` from the answer leg. |
| **Degraded — search leg alone fails** | `probeSearch` exhausts its retries and returns `{ references: [], citations: [], cost: 0, error: … }`, but `probePerplexity` **discards that error** and returns a hardcoded `error: null` with `citations: []`. "Cited nothing" and "citations unverifiable" become the same value. Filed as **R2.2.2**, currently `in_verification`, and **being written into this file right now** — see the working-tree disclosure above. |
| **Degraded — answer leg alone fails** | `probePerplexity` returns `text: ""` with the answer leg's `error` **and** the search leg's real `citations`/`references`. `probeTextEngine` then early-returns on `probeResult.error` before assigning `result.citations`, so **measured citations are thrown away**. See §5.3: no task owns this. |
| **Cost** | `answer.cost + search.cost`. The answer leg is `usage.cost.total_cost ?? usage.total_cost ?? 0.005` — a real vendor number *or* a hardcoded guess, with **no field distinguishing which**. The search leg is a flat `0.005` on success that no vendor reported. R3.6.5. |
| **Honest status** | **Implemented and live where the key is set** — and the only engine other than `aio` that can produce rows today. It is still an API surface, not the product surface. |

### 3.4 `gemini` — an adapter with no caller

`probeGemini` (`src/lib/engines/gemini.js`) wraps `generateContent` from
`src/lib/gemini.js`.

- **It is dead.** `git grep "engines/gemini"` over `src/`, `worker/` and
  `scripts/` returns nothing. It is not in `ENGINE_REGISTRY`. Nothing imports it.
- **Beware the near-miss.** `src/lib/gemini.js` is a *different, live* file whose
  `generateContent` is imported by `src/lib/prompts.js` and
  `src/lib/scoring/judge.js`. Grepping for `gemini.js` finds those and proves
  nothing about the adapter.
- **It is also not a search surface.** It returns `citations: []`
  unconditionally, so it could never measure citation share even if wired.
- **Three fabricated costs in thirty-one lines:** the no-key path returns
  `cost: 0.0` with **no `error` at all**; the success path banks `res.cost || 0.0`;
  the `catch` returns `{ text: "", cost: 0.0 }`, so a failed call reads as a free
  successful one. R3.6.5.
- **Correct fix is deletion** (R1.7.3 / R6.5.2), not conformance.

### 3.5 The SerpAPI AI-Overview path — dead probe, live sibling

`src/lib/engines/serp.js` contains a complete second AIO probe,
`probeGoogleAiOverview`, which dispatches on `getSerpProvider()` to either
`probeGoogleAiOverviewBrightData` or a direct `serpapi.com` call.

- **The probe is dead:** `probeGoogleAiOverview`'s only importers are
  `src/lib/engines/serp.test.mjs` and `src/lib/engines/serpGeo.test.mjs`.
- **Its failure shape is the anti-pattern:** every failure path returns
  `{ text: "", model_used: "google_ai_overview-skipped", citations: [], cost: 0.0, tokens: 0 }`
  with **no error field**. A missing provider, an invalid credential and a
  successful SERP with no AI Overview are one value.
- **The file is not dead.** `fetchPeopleAlsoAsk` and `fetchAutocomplete` from the
  same module are imported by `src/lib/scoring/promptGen.js`, which is imported
  by `scanWorker.js` and runs on every scan. So `serp.js` is **live code
  containing a dead probe** — the distinction that matters when someone proposes
  deleting the file.
- **`SERPAPI_KEY` can still spend money.** `getSerpProvider` still falls back to
  `"serpapi"`, and the PAA path does not consult the engine capability gate.
  That is **R1.7.4**, open.
- **Bright Data is the decided provider**
  (`docs/decisions/2026-08-29-serp-provider-bright-data.md`). `SERPAPI_KEY` is
  deliberately absent from `.env.example`.

### 3.6 `gsc` — in `engines/`, but not an engine

`src/lib/engines/gsc.js` reads Google Search Console query data via a service
account (`GSC_SERVICE_ACCOUNT_KEY`). It probes nothing and answers nothing. Its
only importers are `scripts/check-secrets.mjs` (a dynamic import, for a health
read) and `scripts/test-gsc.mjs`. Nothing in `src/app/` or `src/lib/workers/`
imports it, so **it is not wired into prompt sourcing today** — R4.1.2 is the
task that would wire it. It is listed here only so that "there are six files in
`src/lib/engines/`" never gets read as "there are six engines".

---

## 4. Deferred and planned surfaces, with the reason for each deferral

A deferral with no reason is indistinguishable from an oversight. Each of these
names what would have to be true to undeploy the deferral.

### 4.1 `perplexity.ai`, logged out — **first**, R1.3

The first real-surface adapter, by decision. Logged out, so no credential and no
account to lose. `worker/src/lib/probe.js`'s own header names it as first.

**Not deferred — not built.** `probeBatch` throws; there is no Playwright
adapter; there are no fixtures. R1.3.1 requires five or more committed fixtures
covering answered, no-answer and blocked before an adapter is written.

**Blocked on:** R1.1.2 (browser infrastructure ADR — Bright Data Scraping
Browser vs self-hosted Playwright vs Browserless, to be decided on *measured*
block rate and cost per probe from IN egress) and R1.1.3 (worker host). Neither
ADR exists. Note also that nothing in this repo deploys `worker/` — see §7.

### 4.2 `chatgpt.com`, logged out with search — **second**, R1.4

Second because the login-wall risk is real and unmeasured. R1.4.1's acceptance
criterion is explicitly *"login-wall frequency measured and recorded"* — the
spike exists to quantify a risk, not to confirm a hope.

**The rule that makes the risk safe to carry** is already normative:
`probe-result.md` §3.5 forbids falling back to `api.openai.com` and recording
the API's answer as if the UI had answered. A blocked UI probe records
`state: "login_wall"` or `"blocked"`, and any API row carries
`engine_surface: "api"` and is charted separately. R1.4.4 owns that policy.

**What would reverse the ordering:** a measured login-wall rate on
`perplexity.ai` higher than `chatgpt.com`'s. Neither has been measured.

### 4.3 Google **AI Mode** — stretch

**Deferred, not rejected.** Nothing in this tree probes it and no task in the
ledger names it. The `aio` transport is closest to it: `buildGoogleSearchUrl`
already sets `brd_ai_overview=2`, so if Bright Data exposes an AI Mode parameter
the incremental cost is an extractor plus fixtures rather than a new fleet.

**Two things must be true before it is scheduled:** a decided browser/proxy
infrastructure (R1.1.2), and evidence that AI Mode has a *genuine observable
no-answer state* the way the AI Overview block does. If it does not, it is a
chat surface and `probe-result.md` §3.2 forbids `no_answer` for it. Neither is
established.

### 4.4 Gemini, Copilot, Grok — deferred, openly

| Surface | Why deferred | What would reopen it |
|---|---|---|
| **Gemini** | The only Gemini code in the tree is `src/lib/engines/gemini.js`, which is dead (§3.4), is a text-generation API rather than a search surface, and returns no citations. Wiring it would add an engine that cannot measure citation share, priced by three fabricated zeros. | A logged-out Gemini *search* surface with extractable citations, plus a real price. The dead adapter is not a head start on it and should be deleted first. |
| **Copilot** | No code, no fixtures, no vendor doc, no ledger task. Nothing in this repo has ever contacted it. | A measured India-egress block rate and a decided browser host, i.e. R1.1.2 landing first. |
| **Grok** | Same: no code, no fixtures, no vendor doc, no ledger task. | Same. |

Recorded as three explicit "no"s rather than as absences, because an engine
nobody wrote down is an engine somebody will assume is coming.

---

## 5. Discrepancies found while writing this

Each was verified at `1a5ed81`. Where a task owns it, the task is named; where
none does, that is said plainly rather than implied.

### 5.1 The registry claims `aio` is always configured — R2.10.4, open

`ENGINE_REGISTRY`'s `aio` entry is `isConfigured: () => true`, a literal. Every
other entry delegates to a real check (`isChatGptConfigured`,
`isPerplexityConfigured`), each of which tests its env var.

The consequence: `resolveEnabledEngines` **cannot drop `aio`** when
`BRIGHTDATA_API_KEY` is absent. A deployment with `ENGINES=aio` and no Bright
Data key believes it is probing. `brightDataSearch` throws
`"Bright Data SERP is not configured (set BRIGHTDATA_API_KEY)."` on every query,
`probeAio` catches it into free-text `error`, and the scan finalizes with a
coverage denominator full of rows that measured nothing (§3.1, V3).

`scripts/check-secrets.mjs` **mirrors the same blind spot on purpose** — its
`ENGINE_API_KEY` map is `{ aio: null, … }`, with a comment saying it mirrors
`ENGINE_REGISTRY.isConfigured` deliberately so it is not stricter than the fleet.

**The partial mitigation, stated precisely so it is not over-read.**
`src/lib/vendorRegistry.js` lists `brightdata` with `required: true`, so
`check:secrets` fails a deployment that has no `BRIGHTDATA_API_KEY` **at deploy
time**. That does not close R2.10.4: it is a boot-time check on presence, not a
runtime check on validity. A key revoked, exhausted or zone-rejected after
deploy leaves `aio` "configured" for every subsequent scan, and the zone-
rejection path in `brightdata.js` (`zoneRejectedError`) exists precisely because
that happens.

**No row of this matrix may be read as "configured" on the strength of the
registry.** Row 1's "runs today" is a claim about this deployment's Bright Data
credential, not about `isConfigured`.

### 5.2 Every engine in the fleet fabricates at least part of its cost

The `cost` field on a probe row is a bare number that is never null
(`probe-result.md` §2.5.4, V6). Per engine, at `1a5ed81`:

| Engine | What is fabricated | Owning task |
|---|---|---|
| `aio` | Flat `0.0015` per query, hardcoded in three files (`probeAio`, `probeGoogleAiOverviewBrightData`, `probeQueryOnce`). No vendor reported it. | **R3.6.4** |
| `perplexity` | Answer leg falls back to `0.005` when the vendor reports nothing, **and the row cannot say which happened**. Search leg is a flat `0.005` always. | **R3.6.5** |
| `gemini` (dead) | `res.cost \|\| 0.0` banks an unreported cost as zero; the `catch` returns `cost: 0.0` for a failed call. | **R3.6.5** |
| `chatgpt` | A hardcoded `0.01` web-search fee plus a rate card embedded as two numeric literals. **`OPENAI_MODEL` is env-overridable and the literals are not**, so pointing the adapter at a different model prices every probe at `gpt-4o-mini` rates and reports it as spend. | **none — needs one** |

The `chatgpt` case is filed nowhere. R3.6.4 names the three `0.0015` sites;
R3.6.5 names `gemini` and `perplexity` explicitly and says so in its own detail;
R3.6.1 closed the OpenRouter path only. `src/lib/engines/openai.js` is in none
of them. `docs/vendors/chatgpt.md` records the `0.01` fee as a fact of the
adapter without recording that it is an invention. **This document does not file
the task; it records that one is missing.**

The vocabulary that fixes all four already exists one layer over
(`src/lib/llmPricing.js`'s `cost_source`, mapped to `cost.basis` in
`probe-result.md` §3.9) and **no probe adapter uses it**.

### 5.3 A perplexity answer-leg failure discards measured citations — no owning task

When `probeAnswer` fails and `probeSearch` succeeds, `probePerplexity` returns
the real `citations` and `references` alongside the answer leg's `error`.
`probeTextEngine` then checks `probeResult.error` first and returns immediately,
before `result.citations` or `result.references` are ever assigned. The row is
persisted with `citations: []`.

So the *inverse* of R2.2.2 is also true and is not filed: R2.2.2 covers
"answer ok, search failed" (unverifiable citations reported as zero); this is
"answer failed, search ok" (verified citations reported as zero). Both produce
`citations: []`; only one has a task.

**Recorded here, not filed.** This document does not write to the ledger.

### 5.4 The dead second registry is still importable

`src/lib/engines/types.js` and its two consumers (`aggregate.js`,
`qualityGate.js`) are reachable by one added import and carry engine weights
(`ENGINE_HYBRID_WEIGHTS`, with `google_ai_overview` at `0.50`) that no live code
honours. R1.7.3 and R6.5.2 own the deletion. Until then, a reader who greps for
engine weights finds numbers that do not affect any score.

### 5.5 A stale line citation in `deployedEngines.js`

The header comment of `src/lib/engines/deployedEngines.js` cites
`resolveEnabledEngines (src/lib/scoring/enginePipeline.js:527)`. At `1a5ed81`
that function is not at `:527` — it has moved at least three times across the
commits `probe-result.md` has been baselined at. The prose in that comment is
correct; the number is not. Already recorded in `probe-result.md` §7 and still
reproducing. The fix is to delete the number, not to update it. Not fixed here:
this document does not edit source.

---

## 6. Normative rules this matrix imposes

> **R1 — A row of this matrix must name code.** An engine may not appear with
> "runs today: yes" unless a reader can reach `engine.probe` from
> `ENGINE_REGISTRY` and from there to an HTTP route or a cron entry, by symbol
> name. §2.1 is that trace for the three registered engines. Adding an engine
> means adding its trace in the same commit.

> **R2 — "Registered" must never be written as "configured".** `isConfigured`
> returning `true` is not evidence that a credential exists, because one entry
> hardcodes it (§5.1). A statement that an engine will run must name the
> credential variable and the check that reads it.

> **R3 — UI and API rows of the same engine must never be blended.** Rows 2/3
> (API) and rows 4/5 (UI) measure different things. `engine_surface` is required
> on every row and there is no inference from `engine`
> (`probe-result.md` §3.5). A UI probe that is blocked records `blocked`; it must
> not silently fall back to the API row. R1.4.4 enforces this.

> **R4 — `no_answer` belongs to row 1 and to no other row.** Only the Google
> SERP has an observable "rendered, and there was no AI Overview" state. A chat
> surface returning an empty body is `parse_error`
> (`probe-result.md` §3.2). Adding a `no_answer`-capable surface requires
> evidence, and it changes both documents.

> **R5 — A fabricated cost must be labelled, never totalled silently.** Every
> engine in §5.2 fabricates part of its cost today. Until the `cost.basis`
> mapping of `probe-result.md` §3.9 is implemented in an adapter, **no surface
> may present a summed `cost` as measured spend.** A `$` total over these rows is
> an assertion.

> **R6 — User-facing engine names must come from `deployedEngines.js`.** Never a
> hardcoded list. That is R2.10.1's fix, and `check:secrets` fails the run on
> `ENGINES` / `NEXT_PUBLIC_ENGINES` drift and on an advertised engine with no key.

---

## 7. What would change this document

- **An engine gains or loses a row in `ENGINE_REGISTRY`.** Update §3 and the §2.1
  trace in the same commit.
- **R2.10.4 lands.** §5.1 gets struck with the fixing commit named, and row 1's
  "runs today" becomes a statement the registry itself can support.
- **The first UI adapter emits a row.** Rows 4 and 5 stop being aspirational, and
  the first captured result belongs in `probe-result.md` §6.1, not here.
- **R1.1.2 or R1.1.3 lands.** §4.1's "blocked on" clause changes, and this
  document should link the ADR rather than name the task id.
- **R1.7.3 / R6.5.2 delete the dead paths.** §2's three-vocabulary table collapses
  to one, and §3.4, §3.5 and §5.4 become history rather than description.
- **An AI Mode probe becomes possible.** §4.3's two preconditions are the test;
  meeting them reopens the row, and the `no_answer` question must be answered
  before an extractor is written.

## 8. What is unproven

Stated plainly, because the value of this document is entirely in what it
refuses to claim.

- **No UI surface has ever been probed by this repo.** Rows 4 and 5 have no
  adapter, no fixture, no captured result. `probeBatch` in
  `worker/src/lib/probe.js` throws by design.
- **Nothing in this repo deploys `worker/`.** At `1a5ed81` there is no
  Dockerfile, Procfile, fly/render config or GitHub workflow that starts
  `worker/src/index.js`. Even a finished adapter would have nowhere to run.
- **The login-wall risk on `chatgpt.com` is unmeasured.** §4.2 records it as a
  risk because R1.4.1 has not run. No number in this document describes it.
- **The block rate and cost-per-probe for every browser option are unmeasured.**
  R1.1.2 exists to measure them and has not run, so §4.1's ordering is a plan,
  not a finding.
- **"Runs today" for row 2 is second-hand.** It rests on
  `docs/vendors/chatgpt.md`'s record of a `check:secrets` run, not on anything
  verified here. Environment values are not read by this document.
- **No probe row carries `engine_surface`, `geo`, `state` or a typed `cost`
  today.** Every row in the tree is an API row and nothing says so (V7/V8 in
  `probe-result.md` §7). This matrix names the surfaces; the row shape that would
  record them is specified and unimplemented.
- **The approve-to-publish-to-lift loop has never run end to end.** Not once, not
  in staging, not with a stub at either end. Nothing here has been exercised
  against a real published change.

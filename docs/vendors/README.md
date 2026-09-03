# `docs/vendors/` — scope and index

> <!-- doc-status -->
> **Status: LIVE.** This file defines what belongs in this directory and
> records, with reasons, the integrations that deliberately have no file here.

**Date:** 2026-09-03 · **Task:** R6.3.1

## What this directory is for

One file per vendor we make a network call to, each carrying **the response
shape the code actually reads** and **the quirks that have cost us time**. Not
a copy of the vendor's documentation — a record of what this repo observed,
where the two differ, and which of our assumptions turned out to be wrong.

Three rules, because each exists to prevent a specific failure that has already
happened here:

1. **Every `file:line` must resolve at the commit the doc is written on, and
   must be read before it is written down.** Two citations in
   [`mimo.md`](./mimo.md) drifted onto unrelated code and had to be repointed
   under R6.3.1; a citation that resolves to the wrong line teaches the reader
   to distrust the whole file.
2. **Existence is not liveness.** Before describing a call site as live, trace
   it to a route file or a `vercel.json` cron entry. Before calling one dead,
   grep for importers. [`gemini.md`](./gemini.md) has a worked example in both
   directions: a live route whose only shipped UI caller is orphaned, and three
   importers of the same client that nothing reaches.
3. **A quirk that has been fixed must be rewritten as fixed, with the commit or
   the current line range.** A doc asserting a resolved bug as current is worse
   than no doc. See the R0.1.10 entry in [`brightdata.md`](./brightdata.md).

Every file here carries a `<!-- doc-status -->` header. The guard is
`src/lib/docStatus.test.mjs`, which walks `docs/` and fails on an unheadered
file.

### A note on citing `check-secrets.mjs`

Rule 1 above says a `file:line` must resolve. There is one file these docs cite
**without** line numbers, on purpose: `scripts/check-secrets.mjs`.

It drifted three times during the R6.3.1 revision — once between reading it and
writing the doc, twice more between writing and submitting — because R2.10.1 is
adding an engine-advertising check to it concurrently. Each drift silently
repointed roughly a dozen citations onto neighbouring code: the
`max_completion_tokens` branch became a comment, the Perplexity token cap became
a different comment, and `name: "gsc"` became a closing brace. A wrong line
number is worse than no line number, so these docs name **the vendor entry and a
greppable string** instead — "the `perplexity` entry", "grep `max_tokens: 16`".
Those survive the churn and point at the same code.

Every other file cited in this directory is pinned by line and was asserted to
contain the code described.

## Index

| File | Vendor | Status |
|---|---|---|
| [`brightdata.md`](./brightdata.md) | Bright Data SERP — the Google AI Overview engine | LIVE |
| [`perplexity.md`](./perplexity.md) | Perplexity — API path only; the UI path is R1.3 | LIVE (API) |
| [`chatgpt.md`](./chatgpt.md) | OpenAI Responses API | LIVE, but **not deployed** — `OPENAI_API_KEY` unconfigured |
| [`gemini.md`](./gemini.md) | Google Gemini — one operator route, not a probed engine | LIVE |
| [`firecrawl.md`](./firecrawl.md) | Firecrawl — page scraping for prompt generation and research | LIVE |
| [`mimo.md`](./mimo.md) | Xiaomi MiMo — the utility LLM gateway | LIVE |
| [`gateway-catalog.md`](./gateway-catalog.md) | Cross-vendor rule, not a vendor | LIVE |

## Deliberate omissions

Absence with a stated reason is a decision. Absence without one is a gap. These
two are decisions.

### Google Search Console — no doc, because it is script-only

`src/lib/engines/gsc.js` implements service-account auth against
`searchconsole.googleapis.com`. It has **exactly one importer**:
`scripts/test-gsc.mjs:17`, run by `npm run test:gsc` (`package.json:13`).

Verified at HEAD by grepping `src/app`, `src/lib/workers` and `src/components`
for `GSC_SERVICE_ACCOUNT_KEY`, `searchconsole`, `fetchSearchAnalytics` and
`gscQuery` — no matches. No route file and neither `vercel.json` cron entry
reaches it. The two remaining mentions of "gsc" outside the module and its
script are not calls: `src/lib/health.js:31` reports whether the credential is
*configured*, and `src/lib/db.js:37,425` is a `gsc_queries jsonb` column that is
written as `[]`. the `gsc` entry of `scripts/check-secrets.mjs` validates the
key's shape offline and says so, explicitly making no live call — grep
`offline check only`.

A vendor doc records the response shape a **running** system depends on.
Nothing running depends on this one. **This decision reverses the moment a
route or a worker imports `gsc.js`** — at that point it needs a file here
before it ships, not after.

### SerpAPI — no standalone doc, because it is superseded

SerpAPI is still **reachable**, not dead. `getSerpProvider()`
(`src/lib/engines/serp.js:10-17`) selects it when either
`SERP_PROVIDER=serpapi` with a resolvable `SERPAPI_KEY` (`:13`), or
`BRIGHTDATA_API_KEY` is absent and `SERPAPI_KEY` is present (`:15`). On that
branch `fetchPeopleAlsoAsk` (`:312`) hits `https://serpapi.com/search` (`:63`),
and that path is cron-reachable: `/api/scan/worker` → `scanWorker.js:1110`
`runScanChunk` → `:1164` `runSourcingPhase` → `:375` → `:132`
`generateUnbrandedPrompts` → `promptGen.js:2,128-129`.

> **`fetchAutocomplete` is NOT on that branch and does not touch SerpAPI.**
> `serp.js:372` calls `https://suggestqueries.google.com/complete/search`
> **unconditionally** — no provider gate, no credential, no cost. An earlier
> version of this section grouped it with `fetchPeopleAlsoAsk`, which would
> have hidden an always-on outbound call to a *different* vendor inside the
> "SerpAPI is superseded" bucket. That matters concretely for **R1.7.3**:
> deleting the SerpAPI adapter on the strength of this paragraph would have
> left `fetchAutocomplete` live, undocumented, and calling Google on every
> prompt-sourcing run. It needs its own decision, not inheritance from
> SerpAPI's.

It gets no file here for two reasons:

- **The decision is already written down, as an ADR**, which is the right
  artifact for a supersession:
  [`docs/decisions/2026-08-29-serp-provider-bright-data.md`](../decisions/2026-08-29-serp-provider-bright-data.md),
  superseding [`docs/decisions/serp-provider.md`](../decisions/serp-provider.md).
  `brightdata.md`'s "What is NOT measured" section (`brightdata.md:91-95`)
  points at it, and `src/lib/docStatus.test.mjs:103-135` enforces the
  supersession marker and the absence of unmeasured cost claims.
- **A response-shape doc would be a liability here**, because it would read as
  an invitation to keep the path alive. The plan is the opposite: `R1.7.3`
  ("Demote API adapters to explicit fallback; delete dead paths").

The live risk on this branch is filed, not documented here: `R1.7.4`
("fetchPeopleAlsoAsk bypasses the engine capability gate and can spend on a
stale SERPAPI_KEY"), status `todo`. **If SerpAPI is ever promoted back to a
primary provider, it needs a file in this directory first** — the superseded
ADR's per-query cost and coverage figures were never measured against this
system and must not be reused.

## Not covered here

Supabase and Vercel are platform dependencies rather than answer-engine
vendors, not sources of answers whose response shape a scan reads. What exists
for them today is the Database section at `README.md:142` and the Setup
section at `README.md:74`. `docs/RUNBOOK.md` does **not** exist yet — it is `R6.2.2` ("seeded with
10 symptom rows"), `todo` — so do not follow a link to it from anywhere.

---

*Every `file:line` above was read and asserted to contain the code it
describes. `scripts/check-secrets.mjs` is cited by vendor-entry name and
greppable string rather than by line, because a concurrent task is rewriting it
and its line numbers drifted three times during this revision — see
[the note in `README.md`](./README.md#a-note-on-citing-check-secretsmjs).*

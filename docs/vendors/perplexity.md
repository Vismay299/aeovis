# Vendor notes — Perplexity

> <!-- doc-status -->
> **Status: LIVE** for the API path
> ([`src/lib/engines/perplexity.js`](../../src/lib/engines/perplexity.js)).
> The **UI** path is the R1 target and does not exist yet.

**Date:** 2026-09-02 · **Revised:** 2026-09-03 · **Task:** R6.3.1

## Two different things

| | API (`api.perplexity.ai`) | UI (`perplexity.ai`) |
|---|---|---|
| Status | live today | **not built** — R1.3 |
| Credential | `PERPLEXITY_API_KEY` | none; logged out |
| Model | `PERPLEXITY_MODEL`, default `sonar` | whatever the site serves |
| What it measures | what the *API* answers | **what a buyer actually sees** |

Decision D1 of the rebuild is that the API is not the product surface. `sonar`
is not what a buyer types into perplexity.ai and reads back, so an API answer
is evidence about the API. The fleet in [`worker/`](../../worker/README.md)
exists to drive the real page.

## API contract — two endpoints, not one

One probe makes **two independent calls, in parallel**
(`perplexity.js:145-148`). They are not a request and a refinement of it. They
are separate products, they are billed separately, and **only one of them
supplies citations**.

### 1. The answer — `POST https://api.perplexity.ai/chat/completions`

| | |
|---|---|
| Body | `{ model, messages, web_search_options }` — `perplexity.js:44-48` |
| Model | `PERPLEXITY_MODEL`, default `sonar`, read **at module load** (`perplexity.js:5`) |
| Geo | `web_search_options.user_location.country = "IN"` (`perplexity.js:47`) |
| Timeout | 45 s, `AbortController` (`perplexity.js:7,17-35`) |
| Retries | 2, on 429 and 5xx, exponential backoff (`perplexity.js:6,40,55-60`) |

The request body, captured from the shipped engine against a stubbed transport
at HEAD:

```json
{"model":"sonar","messages":[{"role":"user","content":"..."}],"web_search_options":{"user_location":{"country":"IN"}}}
```

**`max_tokens` is not in it.** The engine has never sent a token cap. The only
place in this repo that sends one is the liveness probe — see
[The health check is a different request](#the-health-check-is-a-different-request)
below. An earlier revision of this file listed `max_tokens` in the engine's
body; that was wrong, and the `>= 16` rule below belongs to the probe alone.

**`user_location.country = "IN"` is a contract term, not a default.** It is geo
targeting: the answer Perplexity gives an Indian buyer is not the answer it
gives a US one, so a scan that silently lost this line would keep producing
numbers while measuring a different market. Note that it is **hardcoded in the
engine** — it does not come from `resolveSerpGeo()`
([`serpGeo.js`](../../src/lib/engines/serpGeo.js)), which is where the SERP
engines get theirs. Two geo settings, one shared meaning, no shared source.

### 2. The citations — `POST https://api.perplexity.ai/search`

| | |
|---|---|
| Body | `{ query, max_results: 10 }` (`perplexity.js:93`) |
| Timeout / retries | same as the answer leg (`perplexity.js:17-35,89`) |

```json
{"query":"...","max_results":10}
```

## Response shape

### Answer leg

Text is read from **`choices[0].message.content`** and trimmed
(`perplexity.js:66,69`). Nothing else on that response body is kept except
`usage` (`perplexity.js:67,69`).

### Search leg

`results` is an array; each entry contributes `url` and `title`
(`perplexity.js:110-117`). URLs are then run through `normalizeUrl`
([`scoring/citations.js`](../../src/lib/scoring/citations.js)) and de-duplicated
into a `Set` (`perplexity.js:119`), so `citations.length` counts *distinct
normalised URLs*, not results returned.

### What the caller gets

```js
{ text, citations: string[], references: [{ href, title, source }], cost, error }
```

`references[].source` is set to the result's **title**, not to a host
(`perplexity.js:116`).

## Quirks

### Citations come only from `/search`. The completion's own citations are discarded.

This is the correction that prompted this revision — an earlier draft of this
file said citations were "returned alongside the completion; a second search
call enriches them". There is no enrichment and no merge. `probeAnswer` reads
`choices`, `usage`, and nothing else (`perplexity.js:65-69`); every field
Perplexity has used to attach sources to a completion — `citations`,
`search_results` — is dropped on the floor. What the caller receives is
`search.citations` and `search.references`, unconditionally
(`perplexity.js:155-156,176-177`).

Verified by execution against the shipped module: a stubbed completion carrying
both `citations: ["https://completion-citation.example/a"]` and
`search_results: [{ url: "https://completion-citation.example/b" }]`, with
`/search` returning one unrelated URL, produced
`citations: ["https://search-endpoint.example/x"]` — 0 of 2 completion
citations survived; 100% of the result came from the second endpoint.

**Consequence:** the citation count on a Perplexity row is a measurement of
`/search`, and the answer text is a measurement of `/chat/completions`. They
are two observations of the same query, not one. Any claim of the form "the
answer cited N sources" is not supported by this integration.

### A failed `/search` produces zero citations with `error: null`

The two legs fail independently, but only one failure is reported. If the
answer leg succeeds and the search leg exhausts its retries, `probePerplexity`
returns the answer text with `citations: []`, `references: []` and
**`error: null`** — the final return hardcodes `error: null`
(`perplexity.js:174-180`).

Reproduced at HEAD: a 200 on `/chat/completions` with a persistent 403 on
`/search` gave three search attempts and then
`{"text":"Answer text.","citations":[],"references":[],"cost":0.005,"error":null}`.
A consumer cannot distinguish that from an answer that genuinely cited nothing
— the exact silent-degradation shape this rebuild exists to close. Filed as
`R2.2.2` ("Perplexity citation-leg failure marks citations_state unverified"),
status `todo` at the time of writing. **Until R2.2.2 lands, a zero-citation
Perplexity row is not evidence of anything.**

The mirror case is handled better: if the *answer* leg fails, the error is
propagated (`perplexity.js:151-159`), and a missing `PERPLEXITY_API_KEY`
returns `error: "PERPLEXITY_API_KEY not set"` rather than a bare empty result
(`perplexity.js:140-143`).

### Cost is an estimate, and partly a constant

- The answer leg prefers `usage.cost.total_cost`, then `usage.total_cost`, and
  falls back to a hardcoded **`0.005`** when the vendor reports neither
  (`perplexity.js:67`).
- The search leg **never** reads a vendor figure. It returns a flat `0.005` on
  success and `0` on failure (`perplexity.js:121,133`).

So a per-probe cost of `0.01` can mean "two calls, neither of which reported a
price". Do not aggregate these and call the total measured spend.

### `PERPLEXITY_MODEL` is read once, at import

`perplexity.js:5` evaluates `process.env.PERPLEXITY_MODEL` at module scope,
while the API key is read per call (`perplexity.js:139`). Changing the model
env var after the module is loaded — in a test, or in a long-lived worker that
reloads config — has no effect until the process restarts.

## The health check is a different request

`npm run check:secrets` does **not** call the engine. It builds its own body at
the `perplexity` entry of `scripts/check-secrets.mjs` (grep
`name: "perplexity"`), and that one *does* carry a token cap.

**`max_tokens` must be at least 16.** Perplexity rejects anything lower with a
`400 invalid_request`, so a 1-token liveness probe reports `FAIL` for a
perfectly good credential. `check-secrets.mjs` did exactly that until
2026-08-30; it now sends 16 — grep `max_tokens: 16` in
`scripts/check-secrets.mjs` — and the same key reports PASS.

**The ordering, measured rather than assumed.** An earlier version of this note
and of the source comment said the 400 came back *before* authentication. That
is wrong, and wrong in the direction that misleads. The full 2×2 against the
live API:

| | `max_tokens: 1` | `max_tokens: 16` |
|---|---|---|
| **real key** | `400` invalid_request | `200` |
| **bogus key** | `401` invalid_api_key | `401` invalid_api_key |

Perplexity **authenticates first**. So a `400` from this endpoint actually
*proves* the key is good — the opposite of what the old comment told the next
reader.

The transferable lesson survives, and is sharper for it: a health check's
*smallest possible* request is not always a *valid* request, and a 400 is not a
401. A liveness probe has to distinguish "the key is bad" from "the request
was" — and it must not guess which of the two the vendor checks first.

The corollary is why this section is separate from the contract above: **the
probe's request shape is not the engine's.** A `PASS` here proves the key works
and the model id exists. It exercises neither `web_search_options` nor
`/search`, so it cannot tell you that geo targeting is applied or that
citations are flowing.

---

*Every `file:line` above was read and asserted to contain the code it
describes. `scripts/check-secrets.mjs` is cited by vendor-entry name and
greppable string rather than by line, because a concurrent task is rewriting it
and its line numbers drifted three times during this revision — see
[the note in `README.md`](./README.md#a-note-on-citing-check-secretsmjs).*

*The captured request
bodies, the citation-discard result, and the search-failure result were
produced by executing the shipped module against a stubbed `fetch` — not
transcribed from vendor documentation.*

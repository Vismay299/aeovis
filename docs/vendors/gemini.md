# Vendor notes — Google Gemini (`generativelanguage.googleapis.com`)

> <!-- doc-status -->
> **Status: LIVE**, on exactly one route. Client:
> [`src/lib/gemini.js`](../../src/lib/gemini.js), via the
> `@google/generative-ai` SDK (`^0.24.1`, `package.json:20`; the installed
> build identifies itself on the wire as `x-goog-api-client: genai-js/0.24.1`).

**Date:** 2026-09-03 · **Task:** R6.3.2, revising R6.3.1 · **Verified at:**
`18fa380`, re-asserted at `ef9909b` and `86c1f07`

> **How to tell whether this file has gone stale**, without needing to trust the
> commit above. Every line citation here points into one of **ten** tracked
> files, and the most recently touched of them was last changed by `ee5504e`:
>
> ```
> git log --oneline ee5504e..HEAD -- src/lib/gemini.js src/lib/geminiAbort.test.mjs \
>   src/app/api/opportunities/route.js src/lib/health.js src/lib/prompts.js \
>   src/lib/scoring/judge.js src/lib/openrouter.test.mjs package.json \
>   scripts/test-dynamic-prompts.mjs src/components/studio/StudioView.jsx \
>   src/components/dashboard/OpportunitiesPanel.jsx
> ```
>
> Empty output means every line number below is still the one that was read.
> Non-empty means **re-derive before trusting this file** — that is the whole
> lesson of the drift described in
> [the README](./README.md#the-r656-drift-and-the-guard-that-was-not-built).
>
> The one set of citations that command does **not** cover is
> `node_modules/@google/generative-ai/dist/index.mjs`, which git does not track:
> those line numbers are pinned to **`0.24.1`** (the installed version, checked
> in `node_modules`) and must be re-derived on any version bump.
> `package.json:20` is the tripwire for that one.
>
> HEAD moved twice while this revision was being written; all 43 line citations
> were re-asserted against the committed blob at each of the three commits, and
> zero failed at any of them. Every executed measurement below was produced
> against `src/lib/gemini.js` as of `ee5504e`, which is byte-identical at all
> three.

> **What changed in this revision.** R6.3.1's quirk 3 said the SDK never
> receives the abort signal. **That was fixed in `ee5504e` (R6.5.6)** and this
> file asserted it as current for one commit. Quirk 3 below is rewritten as
> fixed, and every `gemini.js` line number in this file moved and was
> re-derived. See
> ["The R6.5.6 drift"](./README.md#the-r656-drift-and-the-guard-that-was-not-built)
> in this directory's README for why no test caught it and what was decided
> about that.

## Where it actually runs — and where it does not

Gemini is **not a probed engine**. It appears in neither
[`deployedEngines.js`](../../src/lib/engines/deployedEngines.js) nor
`enginePipeline.js`, and no scan result is attributed to it. It is a utility
LLM on one operator surface.

**The one live path**, traced hop by hop at HEAD:

`POST /api/opportunities` → [`src/app/api/opportunities/route.js:2,27`](../../src/app/api/opportunities/route.js)
→ `generateContent` → [`src/lib/gemini.js:3`](../../src/lib/gemini.js) →
`@google/generative-ai` → `generativelanguage.googleapis.com`.

That is a route file under `src/app/api`, so Next.js serves it whether or not
anything in this repo calls it. It sits behind the operator perimeter:
`src/middleware.js` matches every API path (grep `matcher: ["/api/:path*"]`),
`/api/opportunities` appears in neither `PUBLIC_EXACT` nor `PUBLIC_PATTERNS` in
`src/lib/operatorPerimeter.js`, and `src/lib/operatorPerimeter.test.mjs` lists
it in the `closed` table of the test *"every operator surface is closed to an
anonymous caller"* (grep that test name, then the row `["GET",
"/api/opportunities"]`), whose assertion runs a few lines below the table.

**Two caveats on that chain, both checked rather than assumed:**

- That test row is `["GET", "/api/opportunities"]`. The shipped handler is
  **`POST`** (`route.js:4`). `POST` is gated by the same mechanism — absence
  from the public lists — but **no test asserts the `POST` case specifically**.
  R6.3.1's `:94` for that row is **correct at `18fa380`** and **wrong at
  `ef9909b`**, where it is `:95`. That is why it is not repeated as a line
  number here. Within this one revision the row was `:94` committed, `:95` in a
  concurrent working tree, and then `:95` committed — a number that is three
  things in an afternoon is not a citation. See
  ["The R6.5.6 drift"](./README.md#the-r656-drift-and-the-guard-that-was-not-built).
- The in-repo browser caller,
  `src/components/dashboard/OpportunitiesPanel.jsx:33`, is **not mounted** — no
  module imports it. (`src/components/studio/StudioView.jsx:26` imports a
  *different* component of the same name,
  `src/components/studio/OpportunitiesPanel.jsx`, which does not call this
  route.) The route is live; its only shipped UI caller is currently orphaned.

The other three importers of `src/lib/gemini.js` are **not** live, verified by
grepping for importers rather than by reading the files:

| Module | Reachability |
|---|---|
| `src/lib/engines/gemini.js` (`probeGemini`) | **no importers at all** |
| `src/lib/prompts.js:1,30,86` | only `scripts/test-dynamic-prompts.mjs:10` (`npm run test:prompts`) |
| `judgeWithLLM`, `src/lib/scoring/judge.js:1,360,388` | **no callers**, in or out of the file. The live judge path is `judgeBrandsSymmetric`/`judgeDeterministic`, which make no vendor call |

Do not confuse this client with the utility LLM used by the scan path — that is
`src/lib/openrouter.js`, documented in [`mimo.md`](./mimo.md) and
[`gateway-catalog.md`](./gateway-catalog.md).

## Contract

| | |
|---|---|
| Credential | `GEMINI_API_KEY`, read **per call** (`gemini.js:4`) |
| Transport | the SDK, not `fetch` — it builds the URL and headers |
| Endpoint | `POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent` |
| Auth | header `x-goog-api-key`, **not** a `key=` query parameter — captured off the SDK's own fetch init, whose header names are exactly `content-type`, `x-goog-api-client`, `x-goog-api-key`. The liveness probe does the opposite: `?key=` on `GET /v1beta/models` — the `gemini` entry of `scripts/check-secrets.mjs`, grep `generativelanguage` |
| Timeout | `options.timeout` or `20000` (`gemini.js:34`), enforced **twice over**: an `AbortController` deadline that cancels the HTTP request (`gemini.js:35-36`) **and** a `Promise.race` that settles the promise (`gemini.js:58-63`). Both timers are cleared in a `finally` block (`gemini.js:92-93`) |
| Retries | `retries = 2` by default, *outside* the model ladder (`gemini.js:32,99-103`) |
| Required? | **No.** `required: false` on the `gemini` entry of `scripts/check-secrets.mjs`, and `src/lib/health.js:30` |

Request body, captured from the shipped client against a stubbed transport with
`{ jsonMode: true, temperature: 0.2 }`:

```json
{"generationConfig":{"responseMimeType":"application/json","temperature":0.2},"safetySettings":[],"contents":[{"role":"user","parts":[{"text":"hi"}]}]}
```

`jsonMode` sets `responseMimeType: "application/json"` **and** pins temperature
to `0.1`, which an explicit `options.temperature` then overrides
(`gemini.js:21-27` — the order matters, the explicit value wins).

## Response shape

The client never touches the raw JSON. It reads three things off the SDK's
response object (`gemini.js:65-81`):

| Read | Source on the wire |
|---|---|
| `response.text()` | `candidates[0].content.parts[].text`, concatenated |
| `response.usageMetadata.promptTokenCount` / `.candidatesTokenCount` / `.totalTokenCount` | `usageMetadata` (`gemini.js:69-73`) |
| — | everything else, including `finishReason` and `safetyRatings`, is **not read** |

A response blocked by a safety filter, or truncated by `finishReason: "MAX_TOKENS"`,
therefore arrives as ordinary short text with no marker.

What the caller gets:

```js
// success (gemini.js:81)
{ text: string, model_used: string, tokens: number, cost: number }

// missing key (gemini.js:4-8)  AND  every model failed (gemini.js:106-107)
{ text: "", model_used: "" }
```

Note that the two failure returns carry **no `tokens` and no `cost` keys at
all** — a caller doing `res.cost` gets `undefined`, not `0`. Confirmed by
execution: with `GEMINI_API_KEY` deleted, the returned object's own keys are
exactly `["text","model_used"]`, and `fetch` was called zero times.

## Quirks

### 1. A five-model fallback ladder, walked silently

`gemini.js:12-18` hardcodes five model ids and tries each in order until one
answers:

```
gemini-2.5-flash-lite → gemini-flash-lite-latest → gemini-3.1-flash-lite
  → gemini-2.5-flash → gemini-3-flash-preview
```

The inner `catch` at `gemini.js:82-84` swallows **every** error — 404 on an
unknown model id, 429, 5xx, a safety block, the race timeout, the abort — and
`continue`s to the next. Nothing is logged per model. The outer retry loop then
repeats the whole ladder, so with the default `retries = 2` a single
`generateContent` call can make **15 upstream requests** before returning.

Re-derived by execution at `18fa380`: with the first two ids stubbed to
`404 NOT_FOUND` and the third answering, the client hit, in order,
`…/models/gemini-2.5-flash-lite:generateContent`,
`…/models/gemini-flash-lite-latest:generateContent`,
`…/models/gemini-3.1-flash-lite:generateContent`, and returned
`{"text":"the answer","model_used":"gemini-3.1-flash-lite","tokens":46,"cost":0.000011099999999999999}`.
With every id failing and `retries = 0`, exactly 5 requests were made; with
`retries = 2`, exactly 15.

This is the [gateway-catalog rule](./gateway-catalog.md) in a different shape:
Google's catalogue moves, ids are deprecated, and a ladder that falls through is
how you keep working after one disappears. The costs are:

- **`model_used` is the only record of which model answered**, and the one live
  caller discards it — `route.js:27` destructures `text` alone. Nothing
  persists which of the five produced a given recommendation.
- **All five ids are asserted to exist by no test and no health check.**
  `check:secrets` lists models (the `gemini` entry of `check-secrets.mjs`); it
  does not check
  that any id in this ladder is among them. Three of the five could be dead and
  every surface would still report green.

### 2. A missing key fails soft, and is indistinguishable from a real empty answer

```js
// src/lib/gemini.js:4-8
const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error("GEMINI_API_KEY is not configured.");
  return { text: "", model_used: "" };
}
```

It does not throw. Verified by execution with the variable deleted: the call
resolves to `{"text":"","model_used":""}` and writes one line to stderr.

**A caller cannot distinguish this from a genuine empty answer.** Nor from total
vendor failure: `gemini.js:106-107` returns the *identical* object after all five
models fail on all three attempts. Three different conditions — no credential,
vendor outage, model said nothing — collapse into one indistinguishable value.
This is the exact class of silent degradation the rebuild exists to close.

The contrast with the utility LLM client is deliberate and instructive:
`src/lib/openrouter.js` throws `LlmUnavailableError` for a missing key and for
exhausted retries, and reserves a resolved `text: ""` for a genuinely empty
model answer — pinned by three tests in `src/lib/openrouter.test.mjs:90,101,122`.
`src/lib/gemini.js` has had no equivalent change. **R6.5.6 did not touch this**;
it fixed the abort path only.

On the one live route the degradation is at least *loud at the HTTP boundary*,
by accident rather than design: `route.js:29` calls `.replace()` on the empty
string and `route.js:30` `JSON.parse("")` throws, so the `catch` at
`route.js:40-43` returns `500 {"error":"Failed to generate recommendations"}`.
The operator sees a 500 that names neither the vendor nor the missing key. Any
future caller that tolerates an empty string — as `prompts.js:30` and
`judge.js:388` both would if they were ever wired up — gets no signal at all.

**No ledger item covers this.** It is recorded here so that the absence is a
stated fact rather than an oversight.

### 3. FIXED in `ee5504e` (R6.5.6) — the abort signal now reaches the SDK's fetch

**This section described a live bug until 2026-09-03. It is fixed. The shipped
behaviour comes first; the defect is kept below it so the old shape stays
recognisable if it ever comes back.**

#### What ships now

```js
// src/lib/gemini.js:55-56
const requestOptions = { signal: controller.signal };
const resultPromise = model.generateContent(prompt, requestOptions);
```

`requestOptions` is handed to the SDK **flat, as the second argument**. The
deadline that drives it is `gemini.js:35-36`; the `Promise.race` at
`gemini.js:58-63` is now a genuine second line of defence rather than the only
one; and `gemini.js:85-95` is a `finally` block that clears both timers
(`:92-93`) and aborts the rung (`:94`) before the ladder advances.

Re-derived at `18fa380` by executing the shipped module against a stubbed
`fetch` — no key, no network:

| Claim | Observed |
|---|---|
| the SDK's fetch init carries a signal | init keys are `["body","headers","method","signal"]`, and `init.signal instanceof AbortSignal` is `true` |
| the second argument is flat, and carries only the signal | its own keys are exactly `["signal"]`; `arg.requestOptions` is `undefined`; `arg.timeout` is `undefined` |
| aborting cancels rather than abandons | on every rung the stub's `abort` listener fired exactly once and the stubbed request rejected with `AbortError` |
| what the caller sees on timeout now | `GoogleGenerativeAIAbortError: [GoogleGenerativeAI Error]: Request aborted when fetching …` — **not** the old `Error: Gemini timeout` |
| nothing outlives the call | `retries = 2` → 15 requests, **15 torn down, 0 still live** |
| the timers go too | after a 5-rung failure against a `fetch` that rejects instantly, the delta in `process.getActiveResourcesInfo()` `Timeout` entries is **0** |

**Object identity will mislead you here.** The signal on the fetch init is
**not** the same object as `controller.signal`. `buildFetchOptions` in
`@google/generative-ai@0.24.1`
(`node_modules/@google/generative-ai/dist/index.mjs:439-454`) builds its **own**
`AbortController` and relays the caller's signal into it with
`requestOptions.signal.addEventListener("abort", …)` (`:447-449`), then puts
*its* signal on the init (`:451`). A reader checking
`init.signal === controller.signal` will find `false` and wrongly conclude the
signal was dropped again — measured as `false` here. **Linkage, not identity, is
the test**: abort the caller's controller and assert `init.signal.aborted`
becomes `true`. That is what `src/lib/geminiAbort.test.mjs` asserts.

#### Why the SDK's own `timeout` option is deliberately not passed

The same `buildFetchOptions` branch that would honour `timeout` does this
(`index.mjs:443-445`):

```js
if (requestOptions?.timeout >= 0) {
    setTimeout(() => controller.abort(), requestOptions.timeout);
}
```

**It is never cleared.** Measured: a single
`model.generateContent(p, { timeout: 30000 })` leaves `+1` pending `Timeout`
resource that nothing retires for the full 30 s. Across the five-model ladder ×
three attempts that is the same fifteen-timer leak the fix removed, relocated
into the SDK where `gemini.js` cannot reach it. So the deadline stays in
`gemini.js` (`:35-36`), where the `finally` block owns it. The rationale is in
the source at `gemini.js:51-54`, and `src/lib/geminiAbort.test.mjs` asserts
`arg.timeout === undefined`, so a well-meaning "let the SDK handle it" change
fails loudly.

#### The defect, for recognition

The shipped call used to be `model.generateContent(prompt, { requestOptions })`
with `requestOptions = { timeout: timeoutMs, signal: controller.signal }`. The
SDK's signature is `generateContent(request, requestOptions)` — the second
argument **is** the request options — so wrapping it nested it one level too
deep, and `buildFetchOptions` received an object carrying neither `signal` nor
`timeout`.

Reproduced at `18fa380` by rebuilding that shape against a stubbed `fetch`: the
init keys came back `["body","headers","method"]` with no signal at all; the
caller saw `Error: Gemini timeout` from the race; and the stubbed request was
**still hanging, never settled**, after the controller was aborted. That is
*abandoned*, not *cancelled*.

Pinned so it cannot return: `src/lib/geminiAbort.test.mjs` (8 tests) asserts the
old shape is inert, the new shape is not, and that the ladder ends with zero
live requests and zero stranded timers. `gemini.js:45-49` carries a
"do not re-wrap this" comment naming the same finding.

### 4. Cost is computed locally, at one model's prices, whichever model answered

`gemini.js:73`:

```js
cost = (promptTokens * 0.075 / 1e6) + (candidatesTokens * 0.30 / 1e6);
```

Those rates are hardcoded and are **not** re-derived when the ladder falls
through to a different — and differently priced — model. Google reports no
price on this API, so there is nothing to reconcile against. Treat the number as
an estimate at Flash-Lite rates, never as measured spend. It is added to
`options.stats.cost` (`gemini.js:75-78`), so anything aggregating `stats.cost`
inherits the estimate without a marker.

Confirmed arithmetic: 12 prompt + 34 candidate tokens returned
`cost: 0.000011099999999999999`, matching the formula's own float result
exactly. R6.3.1 rounded this to `0.0000111` inside what it presented as a
literal `JSON.stringify` capture; the value above is the transcript.

---

*All 43 `file:line` citations above were checked against the **committed blob**
— `git show HEAD:<file>`, not the working tree, which concurrent tasks had
dirty throughout — first at `18fa380` and again at `ef9909b` after HEAD moved.
Zero failed at either commit. Every
`src/lib/gemini.js` citation in R6.3.1 below the ladder had drifted when the
R6.5.6 fix added 30 lines, and was re-derived rather than nudged — thirteen of
them: `:40`, `:44`, `:44-46`, `:46`, `:48-51`, `:53`, `:54-70`, `:62`,
`:64-67`, `:70`, `:71-74`, `:78-82`, `:85-86`.*

*Four files are cited by greppable anchor rather than by line, for the reason
given in [the note in `README.md`](./README.md#a-note-on-citing-check-secretsmjs):
`scripts/check-secrets.mjs`, `src/middleware.js`,
`src/lib/operatorPerimeter.js` and `src/lib/operatorPerimeter.test.mjs` are all
under concurrent edit as this is written. Each anchor string was grepped in the
HEAD blob before being written down.*

*The endpoint URL, the auth header and its exact header-name set, the request
body, the ladder order, the request counts at `retries = 0` and `retries = 2`,
the missing-key return and its key set, the all-fail return, the cost
arithmetic, the presence of `signal` on the fetch init, the abort teardown of
all 15 rungs, the zero-pending-timer measurement, the
`GoogleGenerativeAIAbortError` class name, the SDK's uncleared `setTimeout`, and
the pre-fix `{ requestOptions }` reproduction were each produced by executing
the shipped module (or the SDK directly) against a stubbed `fetch` — not
transcribed from vendor documentation, and not copied from the task brief. No
live `GEMINI_API_KEY` was used and no network call was made.*

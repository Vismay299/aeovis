# Vendor notes — Google Gemini (`generativelanguage.googleapis.com`)

> <!-- doc-status -->
> **Status: LIVE**, on exactly one route. Client:
> [`src/lib/gemini.js`](../../src/lib/gemini.js), via the
> `@google/generative-ai` SDK (`0.24.1`, `package.json:20`).

**Date:** 2026-09-03 · **Task:** R6.3.1

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
anything in this repo calls it. It sits behind the operator perimeter —
`src/middleware.js:48-51` matches `/api/:path*`, `/api/opportunities` is not in
the public list, and `src/lib/operatorPerimeter.test.mjs:94` asserts an
anonymous caller is refused.

**One caveat on that chain, checked rather than assumed:** the in-repo browser
caller, `src/components/dashboard/OpportunitiesPanel.jsx:33`, is **not
mounted** — no module imports it. (`StudioView.jsx:26` imports a *different*
component of the same name, `src/components/studio/OpportunitiesPanel.jsx`,
which does not call this route.) The route is live; its only shipped UI caller
is currently orphaned.

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
| Auth | header `x-goog-api-key` (SDK). Note the liveness probe instead uses `?key=` on `GET /v1beta/models` — the `gemini` entry of `scripts/check-secrets.mjs`, grep `generativelanguage` |
| Timeout | `options.timeout || 20000` (`gemini.js:40`) — see the quirk below, it is enforced by a `Promise.race` only |
| Retries | `retries = 2` by default, *outside* the model ladder (`gemini.js:32,78-82`) |
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
response object (`gemini.js:54-70`):

| Read | Source on the wire |
|---|---|
| `response.text()` | `candidates[0].content.parts[].text`, concatenated |
| `response.usageMetadata.promptTokenCount` / `.candidatesTokenCount` / `.totalTokenCount` | `usageMetadata` |
| — | everything else, including `finishReason` and `safetyRatings`, is **not read** |

A response blocked by a safety filter, or truncated by `finishReason: "MAX_TOKENS"`,
therefore arrives as ordinary short text with no marker.

What the caller gets:

```js
// success (gemini.js:70)
{ text: string, model_used: string, tokens: number, cost: number }

// missing key (gemini.js:4-8)  AND  every model failed (gemini.js:85-86)
{ text: "", model_used: "" }
```

Note that the two failure returns carry **no `tokens` and no `cost` keys at
all** — a caller doing `res.cost` gets `undefined`, not `0`.

## Quirks

### 1. A five-model fallback ladder, walked silently

`gemini.js:12-18` hardcodes five model ids and tries each in order until one
answers:

```
gemini-2.5-flash-lite → gemini-flash-lite-latest → gemini-3.1-flash-lite
  → gemini-2.5-flash → gemini-3-flash-preview
```

The inner `catch` at `gemini.js:71-74` swallows **every** error — 404 on an
unknown model id, 429, 5xx, a safety block, the timeout — and `continue`s to the
next. Nothing is logged per model. The outer retry loop then repeats the whole
ladder, so with the default `retries = 2` a single `generateContent` call can
make **15 upstream requests** before returning.

Verified by execution: with the first two ids stubbed to `404 NOT_FOUND` and the
third answering, the client hit, in order,
`…/models/gemini-2.5-flash-lite:generateContent`,
`…/models/gemini-flash-lite-latest:generateContent`,
`…/models/gemini-3.1-flash-lite:generateContent`, and returned
`{"text":"the answer","model_used":"gemini-3.1-flash-lite","tokens":46,"cost":0.0000111}`.
With every id failing and `retries = 0`, exactly 5 requests were made.

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
vendor failure: `gemini.js:85-86` returns the *identical* object after all five
models fail on all three attempts. Three different conditions — no credential,
vendor outage, model said nothing — collapse into one indistinguishable value.
This is the exact class of silent degradation the rebuild exists to close.

The contrast with the utility LLM client is deliberate and instructive:
`src/lib/openrouter.js` throws `LlmUnavailableError` for a missing key and for
exhausted retries, and reserves a resolved `text: ""` for a genuinely empty
model answer — pinned by three tests in `src/lib/openrouter.test.mjs:90,101,122`.
`src/lib/gemini.js` has had no equivalent change.

On the one live route the degradation is at least *loud at the HTTP boundary*,
by accident rather than design: `route.js:29` calls `.replace()` on the empty
string and `route.js:30` `JSON.parse("")` throws, so the `catch` at
`route.js:40-43` returns `500 {"error":"Failed to generate recommendations"}`.
The operator sees a 500 that names neither the vendor nor the missing key. Any
future caller that tolerates an empty string — as `prompts.js:30` and
`judge.js:388` both would if they were ever wired up — gets no signal at all.

**No ledger item covers this.** It is recorded here so that the absence is a
stated fact rather than an oversight.

### 3. The SDK never receives the timeout or the abort signal

`gemini.js:44-46` intends to hand the SDK an `AbortController`:

```js
const requestOptions = { timeout: timeoutMs, signal: controller.signal };
const resultPromise = model.generateContent(prompt, { requestOptions });
```

The SDK's signature is `generateContent(request, requestOptions)` — the second
argument **is** the request options. Wrapping it in `{ requestOptions }` nests
it one level too deep, so the SDK sees an object with neither `timeout` nor
`signal` on it.

Proven by execution, against `@google/generative-ai@0.24.1` in this repo:

| Call | `signal` present on the SDK's `fetch` init? |
|---|---|
| `generateContent(p, { timeout, signal })` — correct nesting | **YES** |
| `generateContent(p, { requestOptions })` — as `gemini.js:46` does | **NO** |
| the shipped `src/lib/gemini.js` path | **NO** (`init` keys were `method,headers,body`) |

Consequences, in order of how much they matter:

- The `Promise.race` at `gemini.js:48-51` is not a "safety net", as the comment
  at `:44` calls it — it is the **only** timeout. It resolves the *promise* at
  20 s; it does not cancel the HTTP request, which keeps running to completion.
- `clearTimeout(timeoutId)` runs only on the success path (`gemini.js:53`). On
  any throw the timer stays armed, and its `controller.abort()` fires into a
  signal nobody is listening to.
- A hung endpoint therefore leaves one live request per model per attempt — up
  to 15 — outliving the call that started them.

**No ledger item covers this either.** Fixing it is a one-line change to
`gemini.js:46`; it is named here rather than fixed because R6.3.1 is a
documentation task and this file must not silently become a code change.

### 4. Cost is computed locally, at one model's prices, whichever model answered

`gemini.js:62`:

```js
cost = (promptTokens * 0.075 / 1e6) + (candidatesTokens * 0.30 / 1e6);
```

Those rates are hardcoded and are **not** re-derived when the ladder falls
through to a different — and differently priced — model. Google reports no
price on this API, so there is nothing to reconcile against. Treat the number as
an estimate at Flash-Lite rates, never as measured spend. It is added to
`options.stats.cost` (`gemini.js:64-67`), so anything aggregating `stats.cost`
inherits the estimate without a marker.

Confirmed arithmetic: 12 prompt + 34 candidate tokens returned
`cost: 0.0000111`, matching the formula exactly.

---

*Every `file:line` above was read and asserted to contain the code it
describes. `scripts/check-secrets.mjs` is cited by vendor-entry name and
greppable string rather than by line, because a concurrent task is rewriting it
and its line numbers drifted three times during this revision — see
[the note in `README.md`](./README.md#a-note-on-citing-check-secretsmjs).*

*The endpoint URL, auth
header, request body, ladder order, request counts, missing-key return, all-fail
return, cost arithmetic and the `requestOptions` nesting were each produced by
executing the shipped module (or the SDK directly) against a stubbed `fetch` —
not transcribed from vendor documentation. No live `GEMINI_API_KEY` was used.*

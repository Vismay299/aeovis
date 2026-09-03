# Vendor notes — Google Autocomplete (`suggestqueries.google.com`)

> <!-- doc-status -->
> **Status: LIVE**, ungated and uncredentialed. Sole call site:
> [`src/lib/engines/serp.js:372`](../../src/lib/engines/serp.js), inside
> `fetchAutocomplete` (`serp.js:366-384`).

**Date:** 2026-09-03 · **Task:** R6.3.1

## Why this vendor has a file at all

It has no API key and no provider gate. Contrast `fetchPeopleAlsoAsk` in the
same file, which returns `[]` behind `isSerpConfigured()` at `serp.js:313`;
`fetchAutocomplete` has no equivalent guard anywhere in `serp.js:366-384`. It
also has **no entry in `scripts/check-secrets.mjs`** — that script's nine
vendors are `supabase`, `brightdata`, `llm`, `perplexity`, `firecrawl`,
`openai`, `gemini`, `gsc` and `cron`, and `suggestqueries` appears in it
nowhere — so no health surface will ever mention this call.

It was previously described only as a footnote inside the SerpAPI omission in
[`docs/vendors/README.md`](./README.md), which had grouped it with
`fetchPeopleAlsoAsk`, a call to a *different* vendor that **is** gated. That
directory's own rule at `docs/vendors/README.md:11` is one file per vendor we
make a network call to. This is one.

## The request

```
GET https://suggestqueries.google.com/complete/search?client=chrome&q=<term>
```

`serp.js:372`, via bare `fetch` — no headers, no auth, and **no timeout or
`AbortSignal` on the request itself**. `client=chrome` is hardcoded; that is
what selects the JSON array response below rather than the XML the endpoint
returns by default.

The two call sites inside `generateUnbrandedPrompts` differ on that, and only
one compensates: on the seeding path the PAA+autocomplete pair is raced against
a 10-second timer (`promptGen.js:198-201`), but on the realism top-up path
`autoFn(topic)` is plainly awaited (`promptGen.js:258`) with nothing bounding
it. A hung socket there hangs the sourcing phase.

The function accepts an array and caps it at three terms
(`serp.js:370`, `terms.slice(0, 3)`), one sequential request each — but both
call sites pass a single term (`promptGen.js:199`, `:258`), so in practice one
call is one request.

## The response shape the code actually reads

The body is parsed with `res.json()` and then **indexed like an array**, so the
code assumes a top-level JSON array, not an object. It reads **exactly one
element**, `data[1]`, and requires it to be an array (`serp.js:375-377`):

```js
if (data && Array.isArray(data[1])) {
  data[1].forEach(sug => suggestions.add(sug));
}
```

`data[1]` is the array of suggestion strings. That is the whole contract this
repo depends on.

**What is deliberately not written down here:** what `data[0]`, `data[2]` and
`data[3]` contain. No live call was made while writing this doc, so any
description of them would be copied from Google's documentation rather than
observed — which is the one thing `docs/vendors/README.md:11-14` says this
directory is not for. The code never touches them, so nothing here depends on
the answer.

Suggestions across all terms land in one `Set` (`serp.js:367`) and come back as
an array (`:383`), so **duplicates across terms are silently collapsed** and the
caller cannot tell which term produced which suggestion.

Confirmed by driving `fetchAutocomplete` against a stubbed `fetch` (no live
call): a response body of
`["acme crm", ["acme crm pricing", "acme crm login"], [], {}]` returns
`["acme crm pricing","acme crm login"]` — i.e. `data[1]` and nothing else.

## The quirk that matters: every failure returns `[]`

**There is no failure this function can report.** All four of these produce an
empty array and no thrown error, which is byte-identical to the legitimate
answer "Google had no suggestions for this term":

| Condition | Path | Returns | Throws? | Logs? |
|---|---|---|---|---|
| Network failure / DNS / refused | `catch` at `serp.js:379-381` | `[]` | no | `console.warn` |
| Any `res.ok === false` (429, 5xx, a block page) | `if (res.ok)` at `serp.js:373` simply falls through | `[]` | no | **nothing at all** |
| 200 with a body where `data[1]` is not an array | `Array.isArray(data[1])` at `:375` is false | `[]` | no | **nothing at all** |
| Genuinely no suggestions | `data[1]` is `[]` | `[]` | no | nothing |

Rows 1-3 were reproduced by execution against a stubbed `fetch` (no live call):
`ECONNREFUSED` → `returned: []`, `threw: false`; a `429` with `ok: false` →
`[]`; a `200` whose body is `{ "error": "quota" }` → `[]`. Row 4 follows from
`serp.js:376` being a no-op on an empty array.

The 429 and unexpected-body rows are the dangerous ones, because they are
**completely silent** — the `console.warn` at `:380` only covers the thrown
case. This is the silent-degrade class this rebuild exists to close: a scan
whose prompt set was seeded with zero real search suggestions looks exactly
like a scan whose seeds Google simply had none of.

Nothing downstream checks. In `generateUnbrandedPrompts` the result is spread
into a merged list (`promptGen.js:203`) and, on the top-up path, each item is
`add`ed with `source: "autocomplete"` (`promptGen.js:259`); an empty array is a
no-op in both.

## When it actually fires

Not on every scan. The chain is
`/api/scan/worker` → `runScanChunk` (`scanWorker.js:1110`) →
`runSourcingPhase` (`:1164`, defined `:374`) → `sourceUnbrandedQueries`
(called at `:398`, defined `:129`) → `generateUnbrandedPrompts`
(`:132`, `promptGen.js:2,128-129`)
→ `autoFn` (`promptGen.js:199`, and `:258` on the top-up path).

`sourceUnbrandedQueries` **early-returns the stored frozen set** when
`existing.length >= target` (`scanWorker.js:197-205`), so
`generateUnbrandedPrompts` is never entered in steady state — which, under the
locked frozen-prompt-set contract, is the normal case. Executed with injected
deps: 30 stored prompts against a target of 30 → `generateUnbrandedPrompts`
called **0 times**; 29 stored → called **once**.

So autocomplete fires on a **first scan for a domain**, or when the stored set
is short of target. When it does fire, it is called once per unique seed term,
up to five terms (`promptGen.js:192,195`), plus up to one more call per topic on
the realism top-up (`promptGen.js:246-263`).

## What this means for `R1.7.3`

`R1.7.3` ("Demote API adapters to explicit fallback; delete dead paths") is
scoped to the SerpAPI adapter. Deleting that adapter **does not** remove this
call — `fetchAutocomplete` has no provider gate and shares nothing with
`serpFetch` (`serp.js:63`) but the file it lives in. It needs its own decision.
The two candidates, neither taken yet:

- **Keep it and make it loud** — return a discriminated result, or at minimum
  `console.warn` on the non-ok and unexpected-body branches, so an empty seed
  list is attributable.
- **Delete it** — the LLM passes already carry prompt generation
  (`promptGen.js:227`, `:241`), and autocomplete only contributes seed terms.

Unverified either way: nobody has measured how much of a real prompt set comes
from this endpoint versus the LLM.

---

*Every `file:line` above was read at HEAD and asserted to contain the code it
describes. The response-shape and failure-mode rows were produced by executing
`fetchAutocomplete` against a stubbed `fetch`; no live call was made to Google.*

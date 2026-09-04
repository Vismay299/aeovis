# Vendor notes — Firecrawl (`api.firecrawl.dev`)

> <!-- doc-status -->
> **Status: LIVE.** Client:
> [`src/lib/firecrawl.js`](../../src/lib/firecrawl.js) — `scrapeSite(url, deps)`,
> plus `normalizeScrapeResult` and `summarizeScrape` for callers. **R3.7.2
> renamed the entry point and changed its return type**: it was
> `scrapeForSummary(url)`, returning a bare string. That name no longer exists.

**Date:** 2026-09-02 · **Revised:** 2026-09-05 · **Task:** R6.3.1, revised by R3.7.2

## Where it actually runs

Three live entry points, all verified by tracing the import chain to a route
file or a cron entry at HEAD:

| Trigger | Chain |
|---|---|
| Cron `/api/content/worker` (`vercel.json`) | `route.js:7` → `contentWorker.js:265` `runResearch` → `steps/research.js:3,24` → `scrapeSite` |
| Cron `/api/scan/worker` (`vercel.json`) | `route.js:5` → `scanWorker.js:1110` `runScanChunk` → `:1164` `runSourcingPhase` → `:375` `sourceUnbrandedQueries` → `:132` `generateUnbrandedPrompts` → `promptGen.js:1` → `scrapeSite` |
| HTTP `POST /api/knowledge` (operator-gated) | `src/app/api/knowledge/route.js:8,51` |

## Contract

| | |
|---|---|
| Credential | `FIRECRAWL_API_KEY`, read **per call** since R3.7.2, or injected as `deps.apiKey` |
| Request | `POST https://api.firecrawl.dev/v1/scrape` (`firecrawl.js:19`) |
| Body | `{ url, formats: ["markdown"], onlyMainContent: true }` (`firecrawl.js:25-29`) |
| Timeout | 20 s via `AbortSignal.timeout` (`firecrawl.js:30`) |
| Retries | **none** — one attempt, then the fallback below |
| Liveness probe | a real scrape of `example.com` — the `firecrawl` entry of `scripts/check-secrets.mjs` |
| Required? | **No.** `required: false` on the `firecrawl` entry of `check-secrets.mjs`, and `src/lib/health.js:27` |

## Response shape

The client reads, in this order (`firecrawl.js:33-51`):

1. `const result = data.data || data;` — `firecrawl.js:35`, with the client's own
   comment: *"Firecrawl sometimes wraps differently"*.
2. `result.metadata.title` → prefixed `Title: ` (`:39-41`)
3. `result.metadata.description` → prefixed `Description: ` (`:42-44`)
4. `result.markdown` → appended verbatim (`:45-47`)
5. The concatenation, truncated to **7000 characters** (`:50`) — *only if* it is
   longer than 50 characters after trimming (`:49`).

The return type is an **envelope**, not a bare string: `{ content, content_chars,
state, state_reason, reasons, detail, source, degraded }`. `content` is
`string | null` — never a sentence standing in for a page. `state` is one of
`ok` / `degraded` / `unavailable` and `source` names which path produced the
content. Before R3.7.2 this was a bare string with no status, no source field
and no error channel.

### The wrap ambiguity is real and is handled

Confirmed by execution against the shipped module: `{ data: { metadata, markdown } }`
and a bare `{ metadata, markdown }` produce byte-identical output, both from a
single `api.firecrawl.dev` call. This is worth keeping. Firecrawl has shipped
both envelopes, and `data.data || data` is the whole defence — a refactor that
"cleans up" line 35 to `data.data` will silently start producing the raw-HTML
fallback described below for every scrape.

## Quirks

### ~~A failure does not record "uncrawled". It silently substitutes stripped HTML.~~ CLOSED by R3.7.2

An earlier revision of this file said a scrape failure meant the page was
*"recorded as uncrawled, which is a measured outcome"*. **That is not what the
code does**, and the difference matters more than the original claim did.

On a non-ok response (`firecrawl.js:52-54`) or a thrown request
(`:55-58`), control falls through to a **plain `fetch` of the target URL plus a
regex HTML strip** (`firecrawl.js:61-81`): match `<body>`, delete every `<...>`,
collapse whitespace, truncate to 4000 characters. The caller receives a string
either way and **cannot tell which path produced it**.

Reproduced at HEAD. Firecrawl stubbed to `402`, target page
`<html><head><title>T</title></head><body><h1>Acme Pumps</h1><p>We   make pumps.</p><script>var x=1;</script></body></html>`:

```
[Firecrawl] API error 402 for https://acme.example
CALLS:    https://api.firecrawl.dev/v1/scrape  ||  https://acme.example
RETURNED: "Acme Pumps We make pumps. var x=1;"
```

Note `var x=1;` in the output: the strip removes *tags*, not *script bodies*, so
JavaScript source, inline JSON-LD and CSS all land in the string that is then
fed to an LLM as "the brand's website content". The console warning at
`firecrawl.js:53` is the only trace, and it goes to server logs, not to the
scan record.

**This was true through R3.7.1 and is fixed in R3.7.2.** The stripped-HTML
fallback still runs — it is better than nothing — but it now returns
`state: "degraded"`, `source: "fallback_fetch"` and the reason it fell back
(`firecrawl_http_error`, `firecrawl_request_failed`, `firecrawl_thin_content`
or `firecrawl_not_configured`), and the caller records that rather than
discarding it. The paragraphs above describe the pre-R3.7.2 behaviour and are
kept because the failure mode is the reason the envelope exists.

**Still open:** the script/CSS bodies noted above are still in the stripped
text — the strip removes tags, not script contents. That is a separate defect
from the missing state and has not been fixed here.

### The same silent fallback fires on a *successful* 200

Two more paths reach the raw-HTML fallback without any HTTP failure at all:

- **Thin content.** If title + description + markdown trims to **50 characters
  or fewer**, the `if` at `firecrawl.js:49` is not taken and execution falls
  through. A legitimately short page is treated as a failed scrape.
- **A 200 that is not a scrape.** `{ success: false, error: "..." }` returns
  `response.ok === true`, so `result.markdown` is simply `undefined`, content
  stays empty, and the fallback runs.

Both confirmed by execution; each made one Firecrawl call followed by one raw
fetch, and returned the stripped HTML.

### The fallback fetches an arbitrary URL from the server

The fallback issues a server-side `fetch` to a URL that, on the
`POST /api/knowledge` path, came from a request body
(`src/app/api/knowledge/route.js:51`). It is behind the operator perimeter, and
there is no allowlist or private-range check on it. Filed as `R3.7.1` ("SSRF
guard module for Firecrawl fallback and crawlability"), status `todo`. Do not
widen that route's exposure before R3.7.1 lands.

### ~~The key is captured at import, not per call~~ CLOSED by R3.7.2

It used to be: `firecrawl.js:1` evaluated `process.env.FIRECRAWL_API_KEY` at
module scope, so setting the variable after first import left the client on the
raw-fetch path for the life of the process. `scrapeSite` now reads the variable
on every call, and accepts `deps.apiKey` so a test can exercise the keyed and
the unkeyed path in the same process.

### Optional means optional — and that part was right

An unconfigured Firecrawl reports `UNCONFIGURED`, never `FAIL`
(`required: false` on the `firecrawl` entry of
`scripts/check-secrets.mjs`; `src/lib/health.js:27`),
and must never fail a scan or a health check. Crawlability is an enrichment on
top of the visibility reading, not an input to it. Note the interaction with the
quirk above: with no key at all **every** call takes the stripped-HTML path —
no longer quietly, since R3.7.2 that path returns
`state: "degraded"`, `state_reason: "firecrawl_not_configured"`.

### v1 only

`v1/scrape` is what both the client and the liveness probe target. v0 response
shapes differ and are not supported.

---

*Every `file:line` above was read and asserted to contain the code it
describes. `scripts/check-secrets.mjs` is cited by vendor-entry name and
greppable string rather than by line, because a concurrent task is rewriting it
and its line numbers drifted three times during this revision — see
[the note in `README.md`](./README.md#a-note-on-citing-check-secretsmjs).*

*The fallback behaviour,
the wrap-ambiguity equivalence, the thin-content and `success:false`
fallthroughs, and the import-time key capture were each reproduced by executing
`scrapeForSummary` against a stubbed `fetch` — not inferred from reading. The
R3.7.2 revisions above were re-verified the same way against `scrapeSite`.*

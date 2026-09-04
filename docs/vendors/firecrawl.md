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
| Cron `/api/scan/worker` (`vercel.json`) | `route.js:5` → `scanWorker.js:2006` `runScanChunk` → `:1060` `runSourcingPhase` → `:652` `sourceUnbrandedQueries` → `:655` `generateUnbrandedPrompts` → `promptGen.js:175`, calling `scrapeSite` at `promptGen.js:220` |
| HTTP `POST /api/knowledge` (operator-gated) | `src/app/api/knowledge/route.js:8,51` |

## Contract

| | |
|---|---|
| Credential | `FIRECRAWL_API_KEY`, read **per call** since R3.7.2, or injected as `deps.apiKey` |
| Request | `POST https://api.firecrawl.dev/v1/scrape` (`firecrawl.js:200`) |
| Body | `{ url, formats: ["markdown"], onlyMainContent: true }` (`firecrawl.js:206-210`) |
| Timeout | 20 s via `AbortSignal.timeout` (`firecrawl.js:211`) |
| Retries | **none** — one attempt, then the fallback below |
| Liveness probe | a real scrape of `example.com` — the `firecrawl` entry of `scripts/check-secrets.mjs` |
| Required? | **No.** `required: false` on the `firecrawl` entry of `check-secrets.mjs`, and `src/lib/health.js:27` |

## Response shape

The client reads, in this order (`firecrawl.js:214-237`):

1. `const payload = data.data || data;` — `firecrawl.js:216`, with the client's own
   comment: *"Firecrawl sometimes wraps differently"*.
2. `payload.metadata.title` → prefixed `Title: ` (`:220-222`)
3. `payload.metadata.description` → prefixed `Description: ` (`:223-225`)
4. `payload.markdown` → appended verbatim (`:226-228`)
5. The concatenation, truncated to **7000 characters** (`:232`) — *only if* it is
   longer than 50 characters after trimming (`:230`).

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
"cleans up" line 216 to `data.data` will silently start producing the raw-HTML
fallback described below for every scrape.

## Quirks

### A failure does not record "uncrawled". It silently substitutes stripped HTML. — state and recording CLOSED by R3.7.2; script/CSS bodies still open

An earlier revision of this file said a scrape failure meant the page was
*"recorded as uncrawled, which is a measured outcome"*. **That is not what the
code does**, and the difference matters more than the original claim did.

On a non-ok response (`firecrawl.js:245-248`) or a thrown request
(`:249-253`), control falls through to a **plain `fetch` of the target URL plus a
regex HTML strip** (`firecrawl.js:259-297`, the strip itself at `:270-278`):
match `<body>`, delete every `<...>`, collapse whitespace, truncate to 4000
characters. Before R3.7.2 the caller received a string either way and **could
not tell which path produced it**.

Reproduced at HEAD. Firecrawl stubbed to `402`, target page
`<html><head><title>T</title></head><body><h1>Acme Pumps</h1><p>We   make pumps.</p><script>var x=1;</script></body></html>`:

```
[Firecrawl] API error 402 for https://acme.example
CALLS:    https://api.firecrawl.dev/v1/scrape  ||  https://acme.example
RETURNED: "Acme Pumps We make pumps. var x=1;"
```

Note `var x=1;` in the output: the strip removes *tags*, not *script bodies*, so
JavaScript source, inline JSON-LD and CSS all land in the string that is then
fed to an LLM as "the brand's website content". Through R3.7.1 the console
warning at `firecrawl.js:247` was the only trace, and it went to server logs,
not to the scan record.

**Fixed in R3.7.2, in both halves.** The stripped-HTML fallback still runs — it
is better than nothing — but:

1. It now returns `state: "degraded"`, `source: "fallback_fetch"` and the reason
   it fell back (`firecrawl_http_error`, `firecrawl_request_failed`,
   `firecrawl_thin_content` or `firecrawl_not_configured`) instead of a bare
   string, so the caller can tell which path produced the content
   (`firecrawl.js:282-288`).
2. The scan **records** that state rather than discarding it.
   `generateUnbrandedPrompts` writes it onto the `stats` accumulator
   (`src/lib/scoring/promptGen.js:264`) and `runSourcingPhase` reads it back and
   calls `recordSkip(tally, CHUNK_SKIP_REASONS.WEBSITE_SCRAPE_DEGRADED, …)`
   (`src/lib/workers/scanWorker.js:1112-1124`; the reason constant itself is at
   `scanWorker.js:216`), so the degrade lands in the chunk's `scan_runs` row
   under `detail.skips` carrying its `state_reason` and its character count. It
   is also frozen onto the job checkpoint (`scanWorker.js:1216`, preserved
   across the per-batch rebuild at `:1390`) so a resumed chunk can still see it.
   Held by `src/lib/workers/scanChunkLedger.test.mjs:1912-2185`.

A scrape that never happened at all — the tracked prompt pool was already at
target, so generation never ran — records **nothing** here, deliberately: it is
`prompt_source` that says the set was reused, and filing a degrade for an
unattempted measurement would be the same lie pointing the other way.

The paragraphs above describe the pre-R3.7.2 behaviour and are kept because the
failure mode is the reason the envelope exists.

**Still open:** the script/CSS bodies noted above are still in the stripped
text — the strip removes tags, not script contents (`firecrawl.js:274-277`).
That is a separate defect from the missing state, was deliberately left
untouched by R3.7.2, and needs its own task.

### The same silent fallback fires on a *successful* 200

Two more paths reach the raw-HTML fallback without any HTTP failure at all:

- **Thin content.** If title + description + markdown trims to **50 characters
  or fewer**, the `if` at `firecrawl.js:230` is not taken and execution falls
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

It used to be: line 1 of the **pre-R3.7.2** `firecrawl.js` evaluated
`process.env.FIRECRAWL_API_KEY` at module scope, so setting the variable after
first import left the client on the raw-fetch path for the life of the process.
(That line no longer exists, so it has no current citation.) `scrapeSite` now
reads the variable on every call at `firecrawl.js:178-181`, and accepts
`deps.apiKey` so a test can exercise the keyed and the unkeyed path in the same
process.

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

*Every `file:line` above was re-read and asserted to contain the code it
describes at the R3.7.2 re-fix commit; the citations in the "Quirks" section
were stale before that pass and pointed at the `SCRAPE_REASON` constant block.
`scripts/check-secrets.mjs` is cited by vendor-entry name and
greppable string rather than by line, because a concurrent task is rewriting it
and its line numbers drifted three times during this revision — see
[the note in `README.md`](./README.md#a-note-on-citing-check-secretsmjs).*

*The fallback behaviour,
the wrap-ambiguity equivalence, the thin-content and `success:false`
fallthroughs, and the import-time key capture were each reproduced by executing
the pre-R3.7.2 `scrapeForSummary` against a stubbed `fetch` — not inferred from
reading. The R3.7.2 revisions above were re-verified the same way against
`scrapeSite`; the recording claim in the first quirk is held by executable tests
in `src/lib/workers/scanChunkLedger.test.mjs`, each of which was confirmed to
fail when its `recordSkip` call is removed.*

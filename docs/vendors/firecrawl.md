# Vendor notes — Firecrawl (`api.firecrawl.dev`)

> <!-- doc-status -->
> **Status: LIVE.** Used for crawlability checks and page fetches.

**Date:** 2026-09-02 · **Task:** R6.3.1

| | |
|---|---|
| Credential | `FIRECRAWL_API_KEY` |
| Request | `POST https://api.firecrawl.dev/v1/scrape` |
| Liveness probe | a scrape of `example.com` (`check-secrets.mjs`) |
| Required? | **No.** Optional — its absence degrades crawlability, never the scan. |

## Quirks

- **Optional means optional.** An unconfigured Firecrawl reports
  `UNCONFIGURED`, not `FAIL`, and must never fail a scan or a health check.
  Crawlability is an enrichment on top of the visibility reading, not an input
  to it.
- **v1 only.** The `v1/scrape` endpoint is what the client and the liveness
  probe target; v0 response shapes differ and are not supported.
- A scrape failure for one URL must not abort a batch — the page is recorded as
  uncrawled, which is a measured outcome, not an error state for the scan.

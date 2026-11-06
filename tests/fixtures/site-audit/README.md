# Site Audit Test Fixtures

In-memory, zero-network test fixture infrastructure for Perceev site audit crawler and issue detection.

## Architecture

Adapted from OpenSEO's `badseo` test suite:
- **Virtual Hosts (`SITES`)**:
  - `main` (`main.audit.test`): Default host with robots.txt disallowing specific bots, 404 llms.txt. Expected site issues: `ai-training-crawler-blocked`, `llms-txt-missing`.
  - `llmsbad` (`llmsbad.audit.test`): llms.txt served as HTML. Expected site issue: `llms-txt-invalid`.
  - `robots500` (`robots500.audit.test`): robots.txt returns 500 error. Expected site issue: `robots-txt-unavailable`.
  - `robotshtml` (`robotshtml.audit.test`): robots.txt returns HTML. Expected site issue: `robots-txt-malformed`.
  - `closed` (`closed.audit.test`): robots.txt disallows all (`User-agent: *\nDisallow: /`). Expected site issue: `crawl-blocked-by-robots`.
  - `throttled` (`throttled.audit.test`): Every page returns 429 with `Retry-After: 7200`. Expected site issue: `crawl-rate-limited`, page issue: `rate-limited-page`.

- **Page-Level Fixtures**:
  - Cover every issue type in `AUDIT_ISSUE_TYPES` (48 total issue types).
  - Defined across modules under `tests/fixtures/site-audit/fixtures/`.
  - Standardized chrome emitting valid JSON-LD WebPage, Open Graph tags, unique titles, and meta descriptions so individual pages only trigger their intended defects.

- **Server and Networking**:
  - `server.ts`: Starts a lightweight `node:http` server on `127.0.0.1:0`.
  - `fixtureFetch.ts`: Rewrites requests targeting `http://<site>.audit.test/...` to the local loopback server with an `x-fixture-site: <site>` header.
  - `fixtureLookup`: Maps `*.audit.test` to public IP `93.184.216.34` so F01's SSRF guard passes without performing real DNS network calls.

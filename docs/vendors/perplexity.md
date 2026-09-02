# Vendor notes — Perplexity

> <!-- doc-status -->
> **Status: LIVE** for the API path
> ([`src/lib/engines/perplexity.js`](../../src/lib/engines/perplexity.js)).
> The **UI** path is the R1 target and does not exist yet.

**Date:** 2026-09-02 · **Task:** R6.3.1

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

## API contract

| | |
|---|---|
| Request | `POST https://api.perplexity.ai/chat/completions` |
| Body | `{ model, messages, max_tokens }` |
| Citations | returned alongside the completion; a second search call enriches them |
| Cost | two calls per query — completion plus search |

### The quirk that made a working key look broken

**`max_tokens` must be at least 16.** Perplexity rejects anything lower with a
`400 invalid_request` **before it authenticates**, so a 1-token liveness probe
reports `FAIL` for a perfectly good credential. `check-secrets.mjs` did exactly
that until 2026-08-30; it now sends 16, and the same key reports PASS.

The transferable lesson: a health check's *smallest possible* request is not
always a *valid* request, and a 400 is not a 401. A liveness probe has to
distinguish "the key is bad" from "the request was".

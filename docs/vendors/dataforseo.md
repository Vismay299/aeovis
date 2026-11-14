# Vendor notes — DataForSEO (`api.dataforseo.com`)

> <!-- doc-status -->
> **Status: LIVE.** Implemented in
> [`src/lib/providers/dataforseo/`](../../src/lib/providers/dataforseo/);
> decision record
> [`docs/decisions/2026-11-10-dataforseo-answer-provider.md`](../decisions/2026-11-10-dataforseo-answer-provider.md).

**Date:** 2026-11-14 · **Task:** F02 phase 5 (owner cutover kit) · **Verified at:** `aee3edb`
**Applies to:** the answer-engine collection path (ChatGPT / Gemini consumer
capture, Google AI Overview SERP) and the metered client used by F13–F18.

## Contract

| | |
|---|---|
| Credential | `DATAFORSEO_API_KEY` (name only; base64 of `login:password`). Read in `core.ts:42-52`, sent as `Authorization: Basic <value>` (`core.ts:167-168`). Never printed, never logged. |
| Base URL | `https://api.dataforseo.com` (`core.ts:15`); the only alternative is the sandbox `https://sandbox.dataforseo.com` (`core.ts:16`). Anything else is refused before any request (`core.ts:152-158`). |
| Timeout | 60 s default, 170 s max (`core.ts:17-18`). Live scraper answers use 140 s (`ai-tracking.ts:68`). A POST timeout is billed-unknown, never retried. |
| Retries | POST: zero retries on any status (`core.ts:235-253`, only GET retries). GET (task_get, catalogue, user_data): 2 retries on 5xx with 250 ms backoff (`core.ts:19-20`, `core.ts:235-241`). |
| Body | POST bodies are an array of task objects; GET is used for `task_get` and catalogues. Response bodies over 1,600 chars are truncated in error details; details never contain request bodies or headers. |

## Endpoints the code actually calls

| Use | Path | Code |
|---|---|---|
| ChatGPT / Gemini queued capture | `POST …/llm_scraper/task_post` (≤ 100 tasks), then free `GET …/llm_scraper/task_get/advanced/{id}` | `ai-tracking.ts:23-30` (paths), `:115-170` (post), `:172-189` (poll) |
| ChatGPT / Gemini live capture (canaries, bake-off, F11 only — never scans) | `POST …/llm_scraper/live/advanced` | `ai-tracking.ts:207-233` |
| Google AI Overviews queued / live | `POST /v3/serp/google/organic/task_post` or `/live/advanced` with `depth: 10, load_async_ai_overview: true`; free `GET …/task_get/advanced/{id}` | `ai-tracking.ts:27-30`, `ai-tracking.ts:89-103` (body), `serp.ts:100`, `serp.ts:315` |
| Claude / Perplexity model API (F11 only; not an approved scan engine) | `POST /v3/ai_optimization/{slug}/llm_responses/live` | `ai.ts:255` |
| Model catalogue (free, 1 h process cache, failures not cached) | `GET /v3/ai_optimization/{slug}/llm_responses/models` | `llm-models.ts:97` |
| Account balance (free) | `GET /v3/appendix/user_data` (`money.balance`) | `appendix.ts:44-54` |

Queued posts are billed at post; collection reads are free. Task lifecycle
codes 20100/40601/40602 mean "pending" (`envelope.ts`). The ChatGPT scraper
cannot collect in location codes 2275, 2344, 2831, 2832, 2833, 2862; Gemini,
Google and the model endpoints have no exclusions (`locations.ts:27-33`).

## Sandbox

The sandbox host (`core.ts:16`) validates requests like production at zero
cost. The bake-off `--dry-run` calls only the sandbox plus the free model
catalogue and exits with zero paid requests. The owner live check
(`scripts/qa/check-dataforseo-live.mjs --mode engines`) runs against
production under `--max-spend-usd` (default 0.10) and `--max-requests`
(default 10) on a loopback `aeovis_live_qa` ledger, and refuses to start
unless every ceiling and the loopback database hold.

## Error codes (product surface)

Full table: F02 §6.2.2; implemented in `core.ts:72-121` and `envelope.ts`.
What the operator sees:

| Situation | Code |
|---|---|
| Key missing | 503 `dataforseo_not_configured` (before any request) |
| HTTP 401 | 502 `dataforseo_auth_failed` |
| Balance / billing (HTTP 402, status 40200/40210, billing words) | 402 `dataforseo_balance` (opens the shared `dataforseo` circuit) |
| HTTP 429 | 429 `dataforseo_rate_limited` |
| HTTP 5xx on POST | 503 `dataforseo_unavailable` (billed-unknown; never retried) |
| Timeout on POST | 504 `dataforseo_timeout` (billed-unknown) |
| Charged task failure | 502 `dataforseo_task_failed` (settled at the reported cost) |
| Invalid Field with cost 0 | 422 `dataforseo_invalid_field` (not billed) |
| 40501 "No Search Results" where allowed | empty success, not an error |
| Backend codes 40101, 40103, 50000, 50301–50304, 50401–50402 | upstream/transient, retryable as a new claimed attempt |

Every error carries `details.providerCode` (`dataforseo_<status>`), which the
engine adapters hand to `classifyProviderFailure`.

## Price source

Prices live in F03, not here: `src/shared/ai-visibility-pricing.ts:42-92`
(one queued answer 0.0012, one live answer 0.004, LLM-responses table) and
`src/lib/pricing/dataforseo.ts:14-29` (estimators are upper bounds; the
metering seam reserves the estimate and settles on the provider's reported
`cost`). No price constant appears under `src/lib/providers/dataforseo/`
(`noPrices.test.mjs`). A 30-question × 3-engine queued scan costs about
USD 0.11 at these prices.

## India support

India is location code 2356 (`locations.ts:7-15`) with languages `en`/`hi`.
The owner-run bake-off (decision record above) measured 100% India acceptance
on every arm that ran, 32/32 queued answers for ChatGPT and Gemini, 29/32
queued AI Overviews with 3 valid result pages without one, and queued
collection in 2–4 minutes. Perplexity through DataForSEO was not tested and
is not approved.

## Never logged

`DATAFORSEO_API_KEY`, Authorization headers, request bodies (prompts), answer
markdown, task payloads, `user_data.login`. Allowed: balance deltas, the
`[dataforseo] task_post rejected` / `upstream failure` lines, per-engine
canary state without answer text.

## What is NOT verified

- Perplexity through DataForSEO; live AI Overviews; live Gemini reliability
  (live scraper mode is not approved — scans use the queue).
- Which model answered a scraper request (responses carry no model name).
- Same-run comparison with the current providers (no `current` arm ran).
- DataForSEO LLM Responses for any engine (needed by F11, separate check).
- Refund behaviour beyond the async-overview discount observed in the bake-off.

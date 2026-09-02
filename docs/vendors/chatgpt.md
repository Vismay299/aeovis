# Vendor notes — ChatGPT / OpenAI

> <!-- doc-status -->
> **Status: LIVE** for the API path
> ([`src/lib/engines/openai.js`](../../src/lib/engines/openai.js)), but
> **NOT DEPLOYED**: `OPENAI_API_KEY` is unconfigured, so the engine is skipped.
> The **UI** path is the R1.4 target and does not exist yet.

**Date:** 2026-09-02 · **Task:** R6.3.1

## Deployment status first

`check:secrets` reports `openai UNCONFIGURED`, and `ENGINES=aio,perplexity`.
ChatGPT does not run on this deployment today. That matters beyond the engine
list: the landing page advertised it as a probed engine until R2.10.1, which is
a claim about coverage the product could not have honoured even if the key had
been present.

Any user-facing surface naming engines derives them from
[`deployedEngines.js`](../../src/lib/engines/deployedEngines.js). Do not
hardcode a list.

## API contract

| | |
|---|---|
| Credential | `OPENAI_API_KEY` |
| Request | `POST https://api.openai.com/v1/responses` |
| Model | `OPENAI_MODEL`, default `gpt-4o-mini` |
| Tool | `web_search`, with `user_location.country = "IN"` |
| Cost | `0.01` base web-search fee, plus token cost |
| Retries | 2, on 429 and 5xx, exponential backoff |

## Response shape

The Responses API returns `output` as an array. Text extraction walks it for
items where **`type === "message"` AND `role === "assistant"`**, then reads
`content[].type === "output_text"`.

**Both conditions matter.** A fixture omitting `role: "assistant"` parses to
empty text with no error — which silently turns a "real answer" test case into
an empty-answer one. That happened while writing
[`emptyAnswer.test.mjs`](../../src/lib/scoring/emptyAnswer.test.mjs): two tests
passed for entirely the wrong reason, and only the *failing* neighbours
revealed it.

Citations are `annotations` with `type === "url_citation"`, carrying `url` and
`title`.

## Quirks

- **An empty 200 is possible**, and is not a non-mention. `enginePipeline.js`
  types it as `EMPTY_ANSWER` and keeps it out of the rate's denominator
  (R2.2.1).
- The UI path will need the same typed-outcome discipline: a login wall or a
  bot check is `login_wall` / `blocked`, never `no_answer`.

# The gateway-catalog rule

> <!-- doc-status -->
> **Status: LIVE.** This is the lesson R6.3.1 asked to be written down. It has
> now cost this project twice.

**Date:** 2026-09-02 · **Findings:** C4, S19 · **Tasks:** R5.1.1, R5.1.3

## The rule

> **A model id valid on one gateway is not valid on another, and the variable
> name does not tell you which gateway you are on.**

Every OpenAI-compatible gateway — OpenRouter, Xiaomi MiMo, Together, a
self-hosted vLLM — speaks the same wire protocol and accepts a different
catalogue of model ids. `mimo-v2.5` is valid on MiMo and meaningless on
OpenRouter. `z-ai/glm-5.2:free` is valid on OpenRouter and meaningless on MiMo.
A request carrying the wrong one fails at the **model**, not at the **key**, so
the error rarely says what is actually wrong.

## How it has bitten

**2026-07 → 2026-08 (C4/S19).** The utility LLM was configured by
`OPENROUTER_BASE_URL` / `OPENROUTER_MODEL` / `OPENROUTER_API_KEY` while the
deployed base URL was `https://api.xiaomimimo.com/v1`. The variables named a
vendor that was not answering. Fixed by renaming to the canonical `LLM_*` names
and writing [`mimo.md`](./mimo.md).

**2026-08-30 (R5.1.3).** It happened again, because the rename had not reached
`.env.local`. MiMo returned `402 Insufficient account balance`. Because the
variable said `OPENROUTER_`, that 402 was read as an OpenRouter billing problem
for a week — by the roadmap, which recorded the key as "disabled
provider-side"; by the handoff, which said to rotate it at openrouter.ai/keys;
and by the first pass of the session that eventually caught it. Every proposed
fix targeted an account nothing was calling.

The diagnosis took one experiment: send the same key to both hosts.

| Host | Result |
|---|---|
| `api.xiaomimimo.com` | **402** Insufficient account balance |
| `openrouter.ai` | **401** Missing Authentication header |

The key was a MiMo key: `sk-` plus 48 characters. An OpenRouter key is
`sk-or-v1-` plus 64 hex, about 73 characters. OpenRouter did not recognise the
token **shape**, which is why its error mentions the header rather than the
account.

## What the code now does

- Canonical names are `LLM_BASE_URL` / `LLM_MODEL` / `LLM_API_KEY`. The
  `OPENROUTER_*` names still work as deprecated aliases and warn once per
  process ([`llmConfig.js`](../../src/lib/llmConfig.js)).
- Per-gateway request quirks derive from the **base URL**, never from a
  variable name — MiMo reads `max_completion_tokens` where others read
  `max_tokens`.
- `check:secrets` prints the **resolved host** on the FAIL line, not only on
  PASS: `HTTP 402 from mimo (https://api.xiaomimimo.com/v1)`. That one line is
  what would have caught this in a minute rather than a week.

## The check before changing a model id

1. Read `LLM_BASE_URL`. Do not infer the vendor from a variable name.
2. Confirm the id exists in **that gateway's** catalogue. OpenRouter publishes
   `GET https://openrouter.ai/api/v1/models` unauthenticated — 396 models as of
   2026-09-02, of which sixteen are `z-ai/` and exactly one is free. A
   near-miss like `z-ai/glm-5.2` (no `:free`) is billed at $1.19/M.
3. Run `npm run check:secrets` and read the host on the verdict line.

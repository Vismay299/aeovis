# Vendor notes — Xiaomi MiMo (`api.xiaomimimo.com`)

> <!-- doc-status -->
> **Status: LIVE.** The quirks below are implemented in
> [`src/lib/openrouter.js`](../../src/lib/openrouter.js) and selected by
> [`src/lib/llmConfig.js`](../../src/lib/llmConfig.js).

**Date:** 2026-08-30
**Task:** R5.1.1 · **Findings:** C4, S19
**Applies to:** the *utility* LLM path (prompt generation, competitor
extraction, classification chores) — anything routed through
`src/lib/llm.js`'s `llmJson`.

---

## Why this file exists

The utility LLM was configured by `OPENROUTER_BASE_URL` /
`OPENROUTER_MODEL` / `OPENROUTER_API_KEY` while the deployed base URL was
`https://api.xiaomimimo.com/v1`. The variable names named a vendor that was not
answering the calls, so the client had to sniff the base URL to recover the
truth the config had lost, and any reader trying to answer "which model
produced this scan?" had to read the client to find out.

The names are now provider-neutral — `LLM_BASE_URL` / `LLM_MODEL` /
`LLM_API_KEY` — and the gateway is identified once, from the URL:
`getLlmProvider()` at `src/lib/llmConfig.js:99`, returning `openrouter`,
`mimo`, or `custom` (`src/lib/llmConfig.js:100-103`). The `OPENROUTER_*` names
still work as a **deprecated** fallback and warn once per process
(`readLlmEnv`, `src/lib/llmConfig.js:53-70`) so an existing deployment does not break on
deploy.

The quirks below did not go away with the rename. They are gateway behaviour,
not naming, and each one is load-bearing.

---

## The quirks

### 1. `max_completion_tokens`, not `max_tokens`

MiMo takes the newer spelling; the portable `max_tokens` is not what this
gateway reads. The client has branched on this since the MiMo cutover and the
branch is preserved verbatim: `max_completion_tokens` when the provider is
`mimo`, `max_tokens` everywhere else.

- `src/lib/openrouter.js:48-52` — the branch.
- `scripts/check-secrets.mjs:104-106` — the same choice in the liveness probe,
  so a 1-token check does not report `FAIL` for a working deployment merely by
  spelling the cap the other way.

**Symptom if this regresses:** the cap is rejected or silently ignored. A
rejection surfaces as a gateway HTTP error, which `generateContent` turns into
`LlmUnavailableError` (`src/lib/openrouter.js:134-137`) — an outage, correctly,
rather than an empty answer. Being ignored is the worse case: unbounded
completions, and cost only OpenRouter would have reported.

*Not verified live in this environment* — no gateway credential is present
here, so this is the behaviour the shipped client encodes, not a fresh probe.

### 2. Thinking must be disabled

MiMo is a reasoning model. Left to itself it interleaves a reasoning trace with
the answer in `message.content`, and the trace is prose, so the JSON the caller
asked for arrives wrapped in something no parser should have to guess at. The
client sends `thinking: { type: "disabled" }` for MiMo only.

- `src/lib/openrouter.js:62-67` — the branch and the reason.

**Symptom if this regresses:** `robustJsonParse` returns `null` far more often,
`llmJson` exhausts its JSON retries and returns `null`, and prompt generation
falls through to the industry pack — a *quietly worse* scan, not a loud
failure. This is the quirk most worth a regression test, and it has one:
`src/lib/openrouter.test.mjs` — "MiMo keeps max_completion_tokens,
thinking-disable, and NO usage.include".

### 3. JSON Lines instead of a JSON array

Asked for "a JSON array of objects", MiMo routinely answers with one top-level
`{...}` per line and no enclosing `[ ]`. `robustJsonParse` balance-scans for
every top-level object and returns them as an array when it finds more than
one.

- `src/lib/openrouter.js:169-190` — the JSON-Lines recovery.
- `src/lib/openrouter.js:196-222` — `scanBalanced`, which respects quoted
  strings and escapes so a `}` inside a string does not end the object early.

This one is **provider-agnostic on purpose**: it runs for every gateway,
because free models of every vendor wrap JSON in prose or fences. Nothing about
it is keyed to MiMo, and it must not become so.

### 4. `usage: { include: true }` is an OpenRouter extension — never sent to MiMo

Only OpenRouter echoes real USD spend back in `usage.cost`, and the content
pipeline's per-item cost cap depends on that number being actual spend rather
than an estimate. The request field is sent only when the provider is
`openrouter` **and** the model is not `:free`.

- `src/lib/openrouter.js:56-61` — the request side.
- `src/lib/openrouter.js:106-108` — the response side.

The `HTTP-Referer` / `X-Title` attribution headers are the same story:
OpenRouter-only, `src/lib/openrouter.js:82`.

---

## The gateway-catalog lesson

**A model id valid on one OpenAI-compatible gateway is not valid on another.**
The wire protocol is portable; the catalog is not. `MiMo-VL-7B-RL` means
nothing to OpenRouter, and `z-ai/glm-5.2:free` means nothing to
`api.xiaomimimo.com`. Both gateways answer a bad id with an HTTP error, not
with a fallback model — so the failure is loud, but it is loud *at scan time*,
per call, after the deploy is already live.

Consequences that are already wired:

- **`LLM_MODEL` must be changed in the same edit as `LLM_BASE_URL`.** Pointing
  the base URL at a new gateway while keeping the old model id is a broken
  deployment whose env vars all look set.
- **`npm run check:secrets` is the check that catches it**, because it makes a
  real 1-token completion against the configured model rather than merely
  observing that a key is non-empty — `scripts/check-secrets.mjs:88-116`. Its
  pass line names the model, provider and base URL it actually reached.
- **`/api/health` cannot catch it**, by design: it reports whether a credential
  is *configured*, never the result of a live call, so polling health never
  spends vendor budget (`src/lib/health.js:1-13`). "Configured" and "works" are
  different questions and the two surfaces answer one each.
- **A `:free` suffix is a pricing claim, not decoration.** Cost is taken as 0
  only for an id ending in `:free` (`src/lib/openrouter.js:108`); a paid id on a
  gateway that does not report `usage.cost` is a known gap, tracked separately —
  do not treat the 0 it produces as a measurement.

## Switching gateway — the checklist

1. Set `LLM_BASE_URL`, `LLM_API_KEY` and `LLM_MODEL` together, in the
   environment. Never in a file: no key belongs in the repo.
2. If the new gateway is neither OpenRouter nor MiMo, it is `custom` and gets
   the portable request shape only. Add its quirks to `getLlmProvider` and a
   sibling of this file *before* relying on it.
3. Run `npm run check:secrets`. A `PASS` on the `llm` row is the only evidence
   that the model id exists on that gateway.
4. Remove the `OPENROUTER_*` variables once the canonical names are set — while
   both are present the canonical one wins and the legacy one is dead weight.

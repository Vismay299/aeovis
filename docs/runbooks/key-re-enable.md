# Runbook: LLM key re-enable checklist

> <!-- doc-status -->
> **Status: LIVE.** The three gates that must pass, in order, before any R5
> content work starts after an LLM key or model change. Fulfills R5.1.2.

**Date:** 2026-09-15 · **Lane:** docs · **Gateway:** OpenRouter (`LLM_BASE_URL`)

Run the whole checklist again whenever `LLM_API_KEY`, `LLM_MODEL`,
`CONTENT_MODEL` or `LLM_BASE_URL` changes, locally or on Vercel.

## Gate 1 — `check:secrets` passes

```
npm run check:secrets
```

**Pass:** every `required` vendor (`supabase`, `llm`, `brightdata`, `cron`) is
`PASS`, and the `llm` line names the model and gateway you expect.
A `FAIL` or `UNCONFIGURED` on a required vendor stops here.

## Gate 2 — one metered call records a cost with a named source

The rule is not "cost must be non-zero"; it is **"the price must be known"**
(standing rule 5: an unpriced model id fails loud, never `$0`). A free model
passes honestly when its zero is *stated* — by the `:free` suffix, the price
table, or the gateway's own `usage.cost` — rather than defaulted.

Make one real call through `generateContent` (`src/lib/openrouter.js`) with a
`stats` object and read the result:

- **Pass:** `cost` is a number and `cost_source` is one of `gateway`,
  `free_tier`, `price_table`.
- **Also check the refusal still bites:** `assertModelPriceable` on an id with
  no rate, on a gateway that does not report cost, must throw
  `UnpricedModelError`.

## Gate 3 — share of voice exits "not assessed"

Run one real scan of a brand with at least one rival in its roster, then:

```sql
SELECT brand, date, engine, sov_pct, sov_state, sov_state_reason
  FROM brand_metrics_daily
 WHERE scan_id = '<the scan id>'
 ORDER BY engine;
```

**Pass:** at least one row with `sov_state` in (`measured`, `measured_zero`)
and a non-null `sov_pct`. `not_assessed` with reason `self_only_roster` means
the roster had no rival — not a key problem, but the gate is not passed.

## Evidence log

| Date | Model | Gate 1 | Gate 2 | Gate 3 |
|---|---|---|---|---|
| 2026-09-15 | `openrouter/free` on OpenRouter | PASS — 8 pass, 0 fail; openai unconfigured (optional) | PASS — `cost: 0`, `cost_source: "gateway"`, 60 tokens; unknown id on `custom` gateway threw `UnpricedModelError` | see ledger R5.1.2 note |

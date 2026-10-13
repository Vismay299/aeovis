# Scan and Content Studio audit — 13 October 2026

> <!-- doc-status -->
> **Status: LIVE.** Current audit and acceptance evidence; implementation is incomplete.

No PR until the requested live/local acceptance passes.

## Observed failures and repairs

- Inspected the signed-in `perceev.xyz/portal/scans` and Content Studio in Dia.
  Scans fail during prompt sourcing; Studio exposes only a basic composer.
- Local utility health request answered in 2.2 seconds. Full Italica prompt
  generation returned 30 buyer questions in 32.1 seconds. A per-attempt 25-second
  generation timeout is still vulnerable to model latency. Generation now has
  60 seconds per call and a shared 120-second deadline across passes/retries.
- Gemini existed only in legacy helpers, not the active scan registry. It now
  participates in probing, scoring, analytics filters, advertising/config checks,
  and per-engine reporting using the shared configured gateway model.
- Sonar received a function/tool request and consistently returned HTTP 404
  (“No endpoints found that support tool use”). Native Sonar search now runs
  without tools. Live retest returned an answer and 16 citations in 2.9 seconds.
- A ChatGPT probe exhausted its output budget and returned no text/citations.
  Gateway probes now use minimal reasoning, more token headroom and bounded
  retries of empty responses. The failing query returned text and five citations
  on retest. Empty attempts still contribute their real reported cost.
- The agent/crew builder remained in source but customer Studio no longer
  rendered it. It is restored through customer-authenticated, workspace-scoped
  agent CRUD routes. Content jobs snapshot the selected agent. Operator APIs
  remain protected. Reads use the customer's RLS client; privileged mutations
  check both ID and exact workspace key.
- All generation step modules still load the markdown skills. A regression
  verifies customer facts reach the actual draft skill. Unrelated brands no
  longer inherit the healthcare preset; only the exact legacy automatic seed
  is repaired, preserving customer-edited briefs. Run facts do not overwrite
  durable workspace facts.
- Customer reports discarded engines whose visibility was null, hiding provider
  failures. Failed engines now remain visible with answer/error counts, an
  unmeasured visibility state and a report-level collection warning.
- Measured missing-brand answers can open a prefilled Content Studio topic.
- `/demo` exercises the actual scan worker/scoring against fixed fixtures,
  with every persistence/provider effect isolated. Browser verification completed
  30 prompts × four engines (120 answers), then created a comparison agent with
  an added fact-checker. Demo output is prominently marked simulated and never
  enters customer history. The workflow canvas no longer invents a running job
  when no run exists or implies approval automatically publishes content.

## Competitor review and product implications

Reviewed public vendor pages in the browser; these are vendor-described
capabilities, not authenticated product trials or independently verified claims.
“AU Engine” appears to mean AEO Engine; that identification is an inference.
Its page blocked the browser request with HTTP 403, so its public content was
read through web retrieval instead.

| Reference | Relevant workflow | Implication for Perceev |
| --- | --- | --- |
| [Profound platform](https://www.tryprofound.com/features) | Prompt demand, visibility/citations, competitor benchmarking, crawler/traffic analysis, custom agents with human checkpoints | Restore the scan → evidence → agent → review loop; keep consumer captures distinct from model API measurements. |
| [Search Atlas LLM Visibility](https://searchatlas.com/llm-visibility/) | Brand and competitor setup, engine selection, mentions/position/sentiment/share of voice, history and growth actions | Keep engine coverage and failure states visible; connect real missing-brand answers to drafting. |
| [AEO Engine](https://aeoengine.ai/) | Audit → technical/content/authority work → weekly measurement; managed human strategy with specialized agents | Use scan evidence to choose content and site changes, then rescan the frozen prompt set. Content volume alone is not proof of improvement. |

Further product work: expose customer prompt management and region controls;
connect existing citation/crawlability intelligence to prioritized opportunities;
make before/after content impact review a normal workflow. Do not fabricate prompt
volumes, crawler visits, rank improvements or causal attribution. Profound says
it captures consumer experiences; Perceev's text-engine gateway probes are model
API measurements and must be labelled accordingly.

## Acceptance evidence and remaining blockers

- Baseline: 3,171 passing tests, 30 explicitly skipped live tests, no failures.
- Final automated suite: 3,186 passing tests, 30 skipped live tests, zero
  failures (3,216 total). Production build passed. Lint passed with two existing
  hook warnings in the operator dashboard OpportunitiesPanel.
- Mock scan: real checkpoint worker completed 120/120 probes with zero network
  calls in the regression test; the browser also displayed completion.
- Live one-query checks: Google AIO, ChatGPT, Gemini and Perplexity all returned
  answers. Gemini retest returned six citations; the Sonar fix removed the 404.
- Full 30-question Italica scan completed four chunks and 136 total query/engine
  attempts (including four branded checks per engine). 109 answers were present.
  Google AIO had only 7/30 non-branded answers and 26 collection errors overall:
  “No ready cookies”, proxy failures and provider-reported captcha failures.
  Its visibility remained null and it was excluded from the headline. Smaller
  concurrency did not resolve the provider failures. Full live acceptance failed.
- Live content used the real markdown skill pipeline and selected FAQ agent.
  It checkpointed after drafting, resumed without repeating completed context
  steps, revised once, and reached `awaiting_approval` with a 7,683-character
  draft. Review remained failed (weighted 0.72); it was correctly flagged for
  human review, not auto-approved. Total recorded cost: $0.0128.
- Production variable registration and migration ledger passed the existing
  read-only `check:uat` gate. This does not prove credential validity.
- Local authenticated customer browser UAT is not verified: the signed-in Dia
  production session cannot authenticate localhost, and the local server lacks
  `SUPABASE_SERVICE_ROLE_KEY`. Route tests cover workspace authorization and the
  shared builder was exercised in the browser, but those are separate evidence.

Before a PR: restore reliable India Google AI Overview collection; repeat the
complete live scan with all engines healthy; validate content quality from a healthy real scan and complete authenticated local customer CRUD/generation/report UAT. Provider
errors must remain errors, not substituted model-generated “Google” answers.

## Repeatable checks

- `npm test`
- `npm run lint`
- `npm run build`
- `node scripts/verify-local-product.mjs` (no provider calls)
- `node --env-file=.env.local scripts/verify-local-product.mjs --live --content`
  (provider credits; isolated memory persistence and a local JSON result)

Deploying the eventual PR also requires both `ENGINES` and `NEXT_PUBLIC_ENGINES`
to be `aio,chatgpt,gemini,perplexity`, plus matching provider credentials/model IDs.

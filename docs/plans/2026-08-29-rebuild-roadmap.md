# Rebuild roadmap — R0-R6

> Status: **LIVE**. Generated from `.claude/orchestration/tasks.json` by
> `node .claude/orchestration/orchestrate.mjs render`. Do not hand-edit —
> edits belong in the ledger, which the orchestration CLI is the only writer for.

Source: The Real-Surface Rebuild (artifact d5db8fa1), 29 Aug 2026
Companion: The Honesty Gap (artifact bbd113a7) — findings A1-C12, suggestions S1-S30
Baseline commit: `5111219`

**7 / 121 closed** · 4 blocked · legend: `[x]` done · `[~]` in flight · `[-]` blocked · `[ ]` open

## Standing rules

1. A skip is not a success; an empty state is not a clean one; measured zero must look different from never ran.
2. Never fail-soft a create call; preserve the error envelope.
3. 'Set in the environment' and 'works' are different claims — run check:secrets before blaming code.
4. Run the SQL with the merge, never after.
5. An unpriced model id fails loud, never $0.
6. Trust source, git log, and the tracker over any prose claiming completeness; close items with file:line in the same commit.
7. Ledger what is unproven — today: the publish->lift loop, and each UI surface until its soak passes.

## R0 — Ground zero  `7/17`

*2-3 days.* Stop the active lies, seal the obvious holes, freeze a baseline to measure the rebuild against.

### R0.1

- [-] **R0.1.1** CRON_SECRET set and both worker gates fail closed in prod `needs-vercel` — blocked: needs-vercel
- [x] **R0.1.2** Gate or delete /chart-preview — closed at `src/lib/scoring/publicRouteExposure.test.mjs:49`, `src/lib/scoring/publicRouteExposure.test.mjs:55`, `src/components/dashboard/RankAndSharePanel.jsx:9`, `src/components/dashboard/SectionStrap.jsx:5`
- [-] **R0.1.3** Minimal operator perimeter in src/middleware.js — blocked: needs-vercel
- [-] **R0.1.4** Per-IP rate limit on POST /api/scan — blocked: needs-vercel
- [x] **R0.1.5** Unique partial index on scan_jobs(brand) while running — closed at `supabase/migrations/007_scan_seal.sql:25`, `src/lib/duplicateScan.js:56`, `src/lib/duplicateScan.js:41`, `src/lib/db.js:383`, `src/app/api/scan/route.js:49`, `src/lib/duplicateScan.test.mjs:72`
- [-] **R0.1.6** scripts/check-secrets.mjs — smallest live call per vendor — blocked: needs-secrets
- [x] **R0.1.7** /api/health route — closed at `src/app/api/health/route.js:29`, `src/lib/health.js:61`, `src/lib/health.js:38`, `src/lib/db/analytics.js:494`, `src/lib/db/analytics.js:510`, `supabase/migrations/008_system_heartbeats.sql:12`, `src/lib/health.test.mjs:23`, `src/app/api/scan/worker/route.js:47`
### R0.2

- [ ] **R0.2.1** Create docs/BUILD_JOURNAL.md seeded with the 37 findings
- [ ] **R0.2.2** Tracker rule in force; status headers on all plans
- [ ] **R0.2.3** Supersede the SerpAPI ADR with a dated Bright Data ADR
### R0.3

- [x] **R0.3.1** openrouter.js throws LlmUnavailableError instead of returning empty text — closed at `src/lib/llmErrors.js:15`, `src/lib/openrouter.js:26`, `src/lib/openrouter.js:134`, `src/lib/llm.js:3`, `src/lib/openrouter.test.mjs:70`, `src/lib/openrouter.test.mjs:81`, `src/lib/analytics/citationEnrich.js:528`
- [x] **R0.3.2** SOV donut, Rivals view and verdict panel render 'not assessed' while extraction is offline — closed at `src/lib/scoring/rosterContinuity.js:140`, `src/components/perceev/charts/Donut.jsx:52`, `src/components/dashboard/RivalsView.jsx:50`, `src/components/dashboard/VisibilityVerdictPanel.jsx:52`, `src/components/dashboard/RankAndSharePanel.jsx:32`, `src/components/dashboard/DashboardShell.jsx:715`, `src/services/api.js:334`, `src/services/api.js:528`, `src/lib/scoring/rosterContinuity.test.mjs:139`, `src/lib/scoring/rosterOfflineSurfaces.test.mjs:37`
- [x] **R0.3.3** Roster continuity — reuse the last persisted roster, labelled carried_forward — closed at `src/lib/scoring/rosterContinuity.js:73`, `src/lib/scoring/rosterContinuity.js:42`, `src/lib/db/analytics.js:467`, `src/lib/workers/scanWorker.js:668`, `src/lib/workers/scanWorker.js:683`, `src/lib/db/scanRow.js:33`, `src/lib/db.js:119`, `src/lib/scoring/rosterContinuity.test.mjs:50`, `src/lib/scoring/rosterContinuity.test.mjs:70`, `src/lib/db/scanRow.test.mjs:5`
- [x] **R0.3.4** New-brand scan fails loud at sourcing when the LLM is off — closed at `src/lib/scoring/promptSource.js:45`, `src/lib/scoring/promptSource.js:68`, `src/lib/workers/scanWorker.js:219`, `src/lib/workers/scanWorker.js:815`, `src/lib/db.js:88`, `src/lib/workers/promptSourcing.test.mjs:170`, `src/lib/workers/promptSourcing.test.mjs:208`, `src/lib/scoring/promptSource.test.mjs:24`
### R0.4

- [ ] **R0.4.1** Reference scans for 3 brands, archived as the 'before' corpus `needs-secrets`
- [ ] **R0.4.2** Hand-label 60-100 answers as calibration fixtures `needs-secrets`
- [ ] **R0.4.3** CI on push; fix the test glob; add .gitattributes

## R1 — Real-surface probe fleet  `0/28`

*2-3 weeks.* Bots drive perplexity.ai and chatgpt.com, extract the answers buyers actually see, capture screenshots as evidence, report typed outcomes.

### R1.1

- [ ] **R1.1.1** Probe Result Contract v2
- [ ] **R1.1.2** ADR + 2-day spike: browser infrastructure `needs-secrets` `needs-decision`
- [ ] **R1.1.3** ADR: worker host `needs-decision`
- [ ] **R1.1.4** Engine surface matrix
- [ ] **R1.1.5** Politeness & risk budget
### R1.2

- [ ] **R1.2.1** worker/ workspace: long-lived Node + Playwright
- [ ] **R1.2.2** probe_tasks queue table; fleet claims batches via jobLease
- [ ] **R1.2.3** Create the scan_runs ledger table
- [ ] **R1.2.4** Authenticated ingest POST /api/internal/probe-results
- [ ] **R1.2.5** Dev runbook for the fleet
- [ ] **R1.2.6** Fleet config validated at boot
### R1.3

- [ ] **R1.3.1** Spike: Playwright against perplexity.ai `needs-secrets`
- [ ] **R1.3.2** Perplexity extractor as a pure function + fixture tests
- [ ] **R1.3.3** Perplexity adapter: retries, block classification, evidence capture
- [ ] **R1.3.4** Perplexity canary
- [ ] **R1.3.5** Perplexity soak: 3+ days x ~30 prompts/day `needs-soak` `needs-secrets`
### R1.4

- [ ] **R1.4.1** Spike: logged-out chatgpt.com with search `needs-secrets`
- [ ] **R1.4.2** ChatGPT extractor + fixtures
- [ ] **R1.4.3** ChatGPT adapter + canary + soak `needs-soak` `needs-secrets`
- [ ] **R1.4.4** Fallback policy: UI blocked records blocked
### R1.5

- [ ] **R1.5.1** Storage bucket probe-evidence `needs-secrets`
- [ ] **R1.5.2** prompt_results evidence-id columns
- [ ] **R1.5.3** AnswersView 'View evidence' -> signed-URL screenshot
### R1.6

- [ ] **R1.6.1** Verify IN egress per engine `needs-secrets`
- [ ] **R1.6.2** Fix the SERP_GEO default inconsistency
### R1.7

- [ ] **R1.7.1** Dual-run the reference corpus through API and UI paths `needs-secrets`
- [ ] **R1.7.2** Cutover per engine behind the ENGINES flag `needs-soak`
- [ ] **R1.7.3** Demote API adapters to explicit fallback; delete dead paths

## R2 — Scoring truth  `0/28`

*1 week.* Four-state vocabulary, roster feeding the headline, de-fake sweep, provenance on every number.

### R2.1

- [ ] **R2.1.1** Per-engine summaries emit state + state_reason
- [ ] **R2.1.2** Delete every ?? 0 null-coalescing metric in the normalize layer
- [ ] **R2.1.3** UI chips for did-not-report / not-assessed / small-sample; render engines_counted
- [ ] **R2.1.4** Tests: a fully-errored engine renders failed and contributes nothing
### R2.2

- [ ] **R2.2.1** answer_present set only after the text check
- [ ] **R2.2.2** Perplexity citation-leg failure marks citations_state unverified
- [ ] **R2.2.3** upsertPrompts throws; audit all write helpers for the return-{error} idiom
- [ ] **R2.2.4** Remove insertScan's silent 3-tier column-drop cascade
### R2.3

- [ ] **R2.3.1** Two-pass finalize: discovered roster feeds the headline
- [ ] **R2.3.2** Tests: an empty-competitors scan gets the gate, SOV and top rivals
- [ ] **R2.3.3** Persist the roster to scans.competitors with roster_source provenance
### R2.4

- [ ] **R2.4.1** Top-level scan fields become blended/index values
- [ ] **R2.4.2** One gate-honoring score selector used by hero, history, sidebar and homepage
### R2.5

- [ ] **R2.5.1** Point the calibration harness at the live judge `needs-secrets`
- [ ] **R2.5.2** Alias hardening: stoplist, domain-stem context rule, short-alias guard
### R2.6

- [ ] **R2.6.1** Finalize writes per-prompt brands_elicited
- [ ] **R2.6.2** isDudPrompt -> suggested_retire, surfaced in the Queries tab
### R2.7

- [ ] **R2.7.1** SOV donut consumes the real share_of_voice_pct
- [ ] **R2.7.2** SourcesView reads v9 field names
- [ ] **R2.7.3** Delete the new Date() timestamp fallback
- [ ] **R2.7.4** Persist and render the collection window
### R2.8

- [ ] **R2.8.1** Gate Studio and Opportunities on data quality
- [ ] **R2.8.2** Engine gauges: a zero-row engine says 'no data'
- [ ] **R2.8.3** Unknown status renders 'reconnecting', never rewinds to 0 percent
- [ ] **R2.8.4** DB-down state distinct from 'no scans yet'
### R2.9

- [ ] **R2.9.1** Provenance strip under the hero
### R2.10

- [ ] **R2.10.1** De-fake the landing page
- [ ] **R2.10.2** Probe counter backed by a real count query

## R3 — Durable backend  `0/20`

*1 week.* Real cadence, a reaper, a run ledger, a scheduler that reconciles, spend that cannot silently read $0.

### R3.1

- [ ] **R3.1.1** Scan worker cron every 10 minutes `needs-vercel`
- [ ] **R3.1.2** Add the missing ?batch=1 cron entry `needs-vercel` `needs-llm`
### R3.2

- [ ] **R3.2.1** One scan_runs row per chunk execution
- [ ] **R3.2.2** Every discarded skip reason becomes a ledger row
- [ ] **R3.2.3** Status route and dashboard read run history
### R3.3

- [ ] **R3.3.1** attempts column with a cap of 3
- [ ] **R3.3.2** Sweep reaps heartbeat-stale runs
- [ ] **R3.3.3** Content cost accumulates across rescues
### R3.4

- [ ] **R3.4.1** First scan of a brand upserts its schedule row
- [ ] **R3.4.2** Skips bump next_run_at and write a skip row
- [ ] **R3.4.3** display_name written so scheduled and manual scans share one identity
- [ ] **R3.4.4** Worker honors per-brand prompt_target, engines and geo
### R3.5

- [ ] **R3.5.1** Per-block checkpoints in content jobs
- [ ] **R3.5.2** Natural key on content_items (job_id, cycle)
- [ ] **R3.5.3** Stage transitions warn-to-throw after a quiet telemetry week `needs-soak`
### R3.6

- [ ] **R3.6.1** Price table that fails loud on an unknown model id
- [ ] **R3.6.2** Per-scan and per-day spend caps enforced from the ledger
- [ ] **R3.6.3** Weekly report metered per brand per day
### R3.7

- [ ] **R3.7.1** SSRF guard module for Firecrawl fallback and crawlability
- [ ] **R3.7.2** Firecrawl degrade becomes a recorded state

## R4 — Ground truth & analytics completion  `0/6`

*1 week.* Probe scores sitting next to Google-verified numbers, change detection, referral capture.

### R4.1

- [ ] **R4.1.1** Wire the orphaned GSC client `needs-secrets`
- [ ] **R4.1.2** Prompt grounding seeds from real GSC queries `needs-llm`
### R4.2

- [ ] **R4.2.1** Dual-number pattern where our probe meets a verifiable source
### R4.3

- [ ] **R4.3.1** crawlability_audits history and change detection
### R4.4

- [ ] **R4.4.1** AI-referral capture `needs-secrets`
### R4.5

- [ ] **R4.5.1** Decide-or-delete pass on schema-only subsystems `needs-decision`

## R5 — Content OS quality  `0/11`

*1 week.* Model-layer truth, a publish loop that stops pretending, drafts benchmarked against what engines cite.

### R5.1

- [ ] **R5.1.1** Provider-neutral LLM config
- [ ] **R5.1.2** Key re-enable checklist `needs-llm` `needs-secrets`
### R5.2

- [ ] **R5.2.1** Kill the fabricated studio.perceev.app URL
- [ ] **R5.2.2** Explicit publish step with verification
- [ ] **R5.2.3** Lift copy honest until PUBLISHED exists
### R5.3

- [ ] **R5.3.1** Benchmark step grounded in winners `needs-llm`
- [ ] **R5.3.2** Fact-check on revision cycles too, cost-gated `needs-llm`
- [ ] **R5.3.3** Rubric versioning on review verdicts
### R5.4

- [ ] **R5.4.1** Lessons loop test `needs-llm`
- [ ] **R5.4.2** Weekly report integrity `needs-llm`
- [ ] **R5.4.3** One end-to-end run on a real brand `needs-llm` `needs-secrets`

## R6 — Apparatus & guards  `0/11`

*starts day one, finishes last.* The paper trail and the tests that keep every earlier phase from regressing.

### R6.1

- [ ] **R6.1.1** Migrations ledger and transaction per file
- [ ] **R6.1.2** docs/PROD_MIGRATIONS.md with per-migration verification queries
### R6.2

- [ ] **R6.2.1** docs/OPERATOR_LEDGER.md
- [ ] **R6.2.2** docs/RUNBOOK.md seeded with 10 symptom rows
### R6.3

- [ ] **R6.3.1** Vendor contract docs
### R6.4

- [ ] **R6.4.1** Guard: route-perimeter walker
- [ ] **R6.4.2** Guard: fail-loud walker
- [ ] **R6.4.3** Guard: infra vendors never in rendered copy, engine names required
- [ ] **R6.4.4** Guard: engine-count-agnostic UI
### R6.5

- [ ] **R6.5.1** Route tests for the money paths and Bright Data parser fixtures
- [ ] **R6.5.2** The great deletion


# Rebuild roadmap — R0-R6

> Status: **LIVE**. Generated from `.claude/orchestration/tasks.json` by
> `node .claude/orchestration/orchestrate.mjs render`. Do not hand-edit —
> edits belong in the ledger, which the orchestration CLI is the only writer for.

Source: The Real-Surface Rebuild (artifact d5db8fa1), 29 Aug 2026
Companion: The Honesty Gap (artifact bbd113a7) — findings A1-C12, suggestions S1-S30
Baseline commit: `5111219`

**65 / 185 closed** · 4 blocked · legend: `[x]` done · `[~]` in flight · `[-]` blocked · `[ ]` open

## Standing rules

1. A skip is not a success; an empty state is not a clean one; measured zero must look different from never ran.
2. Never fail-soft a create call; preserve the error envelope.
3. 'Set in the environment' and 'works' are different claims — run check:secrets before blaming code.
4. Run the SQL with the merge, never after.
5. An unpriced model id fails loud, never $0.
6. Trust source, git log, and the tracker over any prose claiming completeness; close items with file:line in the same commit.
7. Ledger what is unproven — today: the publish->lift loop, and each UI surface until its soak passes.
8. Closing a task is an act on a verifier's word, never the implementer's. The agent that wrote the code never closes it.
9. A change to the orchestration tooling is itself ledger work. The machine is not exempt from the discipline it enforces.
10. Trace a call site to an HTTP route or a cron entry before describing it as live. A correct file:line proves a line exists, not that anything reaches it.
11. Close an item only when, in the same commit, its box is ticked, the commit body cites the file:line where the change lives, and the acceptance criterion was exercised — run, not read and not reasoned about. If it could not be exercised here, the item is blocked with the reason, never closed.

## R0 — Ground zero  `23/31`

*2-3 days.* Stop the active lies, seal the obvious holes, freeze a baseline to measure the rebuild against.

### R0.1

- [x] **R0.1.1** CRON_SECRET set and both worker gates fail closed in prod `needs-vercel` — closed at `src/lib/cronAuth.js:43`, `src/app/api/scan/worker/route.js:34`, `src/app/api/content/worker/route.js:39`, `.env.example:19`, `src/lib/cronAuth.test.mjs:19`
- [x] **R0.1.2** Gate or delete /chart-preview — closed at `src/lib/scoring/publicRouteExposure.test.mjs:49`, `src/lib/scoring/publicRouteExposure.test.mjs:55`, `src/components/dashboard/RankAndSharePanel.jsx:9`, `src/components/dashboard/SectionStrap.jsx:5`
- [x] **R0.1.3** Minimal operator perimeter in src/middleware.js — closed at `src/middleware.js:24`, `src/lib/operatorPerimeter.js:128`, `src/lib/operatorPerimeter.js:72`, `src/lib/operatorPerimeter.js:154`, `src/lib/operatorPerimeter.test.mjs:262`, `src/lib/operatorPerimeter.test.mjs:231`
- [x] **R0.1.4** Per-IP rate limit on POST /api/scan — closed at `src/lib/rateLimit.js:73`, `src/lib/rateLimit.js:76`, `src/lib/rateLimit.js:106`, `src/lib/rateLimit.js:164`, `src/lib/scanRateLimitSpoof.route.test.mjs:100`, `src/lib/rateLimit.test.mjs:133`
- [x] **R0.1.5** Unique partial index on scan_jobs(brand) while running — closed at `supabase/migrations/007_scan_seal.sql:25`, `src/lib/duplicateScan.js:56`, `src/lib/duplicateScan.js:41`, `src/lib/db.js:383`, `src/app/api/scan/route.js:49`, `src/lib/duplicateScan.test.mjs:72`
- [x] **R0.1.6** scripts/check-secrets.mjs — smallest live call per vendor — closed at `scripts/check-secrets.mjs:286-296`, `scripts/check-secrets.mjs:232-237`, `src/lib/checkSecrets.test.mjs:181-209`, `docs/vendors/README.md:117-118`, `docs/vendors/README.md:130-140`
- [x] **R0.1.7** /api/health route — closed at `src/app/api/health/route.js:29`, `src/lib/health.js:61`, `src/lib/health.js:38`, `src/lib/db/analytics.js:494`, `src/lib/db/analytics.js:510`, `supabase/migrations/008_system_heartbeats.sql:12`, `src/lib/health.test.mjs:23`, `src/app/api/scan/worker/route.js:47`
- [x] **R0.1.8** Remove the forgeable x-vercel-cron bypass from the worker gate — closed at `src/lib/cronAuth.js:48-55`, `src/lib/cronAuth.js:22`, `src/lib/cronAuth.test.mjs:47`, `src/lib/cronAuth.test.mjs:57`, `src/lib/cronAuth.test.mjs:69`, `src/lib/cronAuth.test.mjs:77`, `src/app/api/scan/worker/route.js:28`, `src/app/api/content/worker/route.js:33`, `docs/BUILD_JOURNAL.md:136`, `README.md:111`, `README.md:130`
- [x] **R0.1.9** Stop SERPAPI_KEY counting as a configured SERP provider — closed at `src/lib/engines/types.js:47`, `src/lib/engines/types.test.mjs:55`, `src/lib/engines/types.test.mjs:98`, `src/lib/engines/types.test.mjs:114`
- [x] **R0.1.10** check:secrets validates the wrong Bright Data credential `needs-secrets` — closed at `src/lib/checkSecretsBrightdata.test.mjs:154`, `src/lib/checkSecretsBrightdataNoZone.test.mjs:54`, `src/lib/checkSecretsBrightdata.test.mjs:191`, `scripts/check-secrets.mjs:111`
- [x] **R0.1.11** Migrations 007-009 are unapplied in production, and 007 cannot apply as-is `needs-decision` — closed at `supabase/migrations/007_scan_seal.sql:28`, `supabase/migrations/008_system_heartbeats.sql:12`, `supabase/migrations/009_scan_rate_limit.sql:44`, `src/lib/rateLimit.js:112`
- [-] **R0.1.12** Confirm CRON_SECRET and OPERATOR_TOKEN are live on the Vercel project `needs-vercel` — blocked: needs-vercel
- [x] **R0.1.13** cronAuth fails OPEN when NODE_ENV is unset — closed at `src/lib/cronAuth.js:20`, `src/lib/cronAuth.js:55`, `src/lib/cronAuth.js:116`, `src/lib/cronAuth.test.mjs:244`, `src/lib/cronAuth.test.mjs:269`, `src/lib/cronAuth.test.mjs:318`, `src/lib/cronAuth.test.mjs:187`
- [x] **R0.1.14** The operator perimeter opens silently in a non-production NODE_ENV — closed at `src/lib/operatorPerimeter.js:180`, `src/lib/operatorPerimeter.js:189`, `src/middleware.js:24`, `src/middleware.js:54`, `src/lib/operatorPerimeter.test.mjs:308`, `src/lib/operatorPerimeter.test.mjs:428`
- [-] **R0.1.15** ROTATE the GSC service-account key — leaked into an agent transcript `needs-secrets` — blocked: needs-secrets
- [x] **R0.1.16** health.js keeps a second vendor list and claims it is shared — closed at `src/lib/vendorRegistry.js:49`, `src/lib/vendorRegistry.js:92`, `src/lib/health.js:28`, `src/lib/health.js:15`, `scripts/check-secrets.mjs:43`, `scripts/check-secrets.mjs:96`, `scripts/check-secrets.mjs:380`, `scripts/check-secrets.mjs:526`, `src/lib/vendorRegistry.test.mjs:46`, `src/lib/vendorRegistry.test.mjs:61`, `src/lib/engines/types.test.mjs:122`
- [ ] **R0.1.17** Nothing detects a NODE_ENV that lies
- [~] **R0.1.18** Three footguns in the rate-limit trust knob — submitted `src/lib/rateLimit.test.mjs:327`, `src/lib/rateLimit.test.mjs:46`, `src/lib/rateLimit.test.mjs:456`, `src/lib/rateLimit.test.mjs:476`, `src/lib/rateLimit.js:196`, `src/lib/rateLimit.js:231`, `src/lib/rateLimit.js:240`, `src/lib/rateLimit.js:110`, `src/lib/rateLimit.js:145`, `.env.example:60`
- [ ] **R0.1.19** The perimeter warn-once guard is evadable in one added line
- [ ] **R0.1.20** Nothing proves Vercel strips an inbound x-vercel-forwarded-for `needs-vercel`
### R0.2

- [x] **R0.2.1** Create docs/BUILD_JOURNAL.md seeded with the 37 findings — closed at `docs/BUILD_JOURNAL.md:123`, `docs/BUILD_JOURNAL.md:124`, `docs/BUILD_JOURNAL.md:127`, `src/lib/scoring/enginePipeline.js:510`, `src/lib/scoring/enginePipeline.js:450`, `src/lib/scoring/enginePipeline.js:98`, `src/lib/workers/scanWorker.js:472`, `src/lib/workers/scanWorker.js:436`, `src/lib/db.js:11`, `src/lib/db.js:298`, `src/lib/db.js:62`, `src/app/api/scan/route.js:62`, `src/app/api/scan/worker/route.js:60`, `src/lib/buildJournal.test.mjs:62`
- [x] **R0.2.2** Tracker rule in force; status headers on all plans — closed at `docs/plans/2026-08-29-rebuild-roadmap.md:25`, `docs/plans/README.md:36`, `DESIGN.md:4`, `src/lib/docStatus.test.mjs:32`
- [~] **R0.2.3** Supersede the SerpAPI ADR with a dated Bright Data ADR — submitted `docs/decisions/2026-08-29-serp-provider-bright-data.md:12`, `docs/decisions/2026-08-29-serp-provider-bright-data.md:19`, `docs/decisions/2026-08-29-serp-provider-bright-data.md:674`, `docs/decisions/2026-08-29-serp-provider-bright-data.md:709`, `docs/decisions/2026-08-29-serp-provider-bright-data.md:746`, `docs/decisions/2026-08-29-serp-provider-bright-data.md:749`, `docs/decisions/2026-08-29-serp-provider-bright-data.md:773`, `docs/decisions/2026-08-29-serp-provider-bright-data.md:796`, `docs/decisions/serp-provider.md:31`, `docs/decisions/serp-provider.md:42`, `src/lib/engines/serp.js:342`, `src/lib/scoring/aioPipeline.js:110`, `src/lib/scoring/promptGen.js:185`, `src/lib/workers/scanWorker.js:1`, `src/lib/docStatus.test.mjs:130`
- [x] **R0.2.4** Correct the false evidence claims in the Bright Data ADR — closed at `docs/decisions/2026-08-29-serp-provider-bright-data.md:79`, `docs/decisions/2026-08-29-serp-provider-bright-data.md:96`, `docs/decisions/2026-08-29-serp-provider-bright-data.md:113`, `docs/decisions/2026-08-29-serp-provider-bright-data.md:131`, `docs/decisions/2026-08-29-serp-provider-bright-data.md:153`, `docs/decisions/2026-08-29-serp-provider-bright-data.md:183`, `docs/decisions/2026-08-29-serp-provider-bright-data.md:208`, `docs/decisions/2026-08-29-serp-provider-bright-data.md:306`, `docs/decisions/2026-08-29-serp-provider-bright-data.md:384`, `src/lib/engines/adapter.js:3`, `src/lib/engines/openai.js:8`, `src/lib/scoring/probe.js:1`, `src/lib/scoring/probe.js:70`, `src/lib/engines/types.js:32`, `src/lib/engines/types.test.mjs:90`, `src/lib/engines/serp.js:157`, `src/lib/engines/serp.js:335`, `src/lib/scoring/promptGen.js:127`, `src/lib/workers/scanWorker.js:1088`, `src/lib/scoring/enginePipeline.js:488`, `src/lib/scoring/enginePipeline.js:52`, `src/lib/scoring/enginePipeline.js:62`, `src/lib/scoring/aioPipeline.js:171`
### R0.3

- [x] **R0.3.1** openrouter.js throws LlmUnavailableError instead of returning empty text — closed at `src/lib/llmErrors.js:15`, `src/lib/openrouter.js:26`, `src/lib/openrouter.js:134`, `src/lib/llm.js:3`, `src/lib/openrouter.test.mjs:70`, `src/lib/openrouter.test.mjs:81`, `src/lib/analytics/citationEnrich.js:528`
- [x] **R0.3.2** SOV donut, Rivals view and verdict panel render 'not assessed' while extraction is offline — closed at `src/lib/scoring/rosterContinuity.js:140`, `src/components/perceev/charts/Donut.jsx:52`, `src/components/dashboard/RivalsView.jsx:50`, `src/components/dashboard/VisibilityVerdictPanel.jsx:52`, `src/components/dashboard/RankAndSharePanel.jsx:32`, `src/components/dashboard/DashboardShell.jsx:715`, `src/services/api.js:334`, `src/services/api.js:528`, `src/lib/scoring/rosterContinuity.test.mjs:139`, `src/lib/scoring/rosterOfflineSurfaces.test.mjs:37`
- [x] **R0.3.3** Roster continuity — reuse the last persisted roster, labelled carried_forward — closed at `src/lib/scoring/rosterContinuity.js:73`, `src/lib/scoring/rosterContinuity.js:42`, `src/lib/db/analytics.js:467`, `src/lib/workers/scanWorker.js:668`, `src/lib/workers/scanWorker.js:683`, `src/lib/db/scanRow.js:33`, `src/lib/db.js:119`, `src/lib/scoring/rosterContinuity.test.mjs:50`, `src/lib/scoring/rosterContinuity.test.mjs:70`, `src/lib/db/scanRow.test.mjs:5`
- [x] **R0.3.4** New-brand scan fails loud at sourcing when the LLM is off — closed at `src/lib/scoring/promptSource.js:45`, `src/lib/scoring/promptSource.js:68`, `src/lib/workers/scanWorker.js:219`, `src/lib/workers/scanWorker.js:815`, `src/lib/db.js:88`, `src/lib/workers/promptSourcing.test.mjs:170`, `src/lib/workers/promptSourcing.test.mjs:208`, `src/lib/scoring/promptSource.test.mjs:24`
### R0.4

- [x] **R0.4.1** Reference scans for 3 brands, archived as the 'before' corpus `needs-secrets` — closed at `test_reports/baseline-2026-08/italicatiles.com.json`, `test_reports/baseline-2026-08/snitch.com.json`, `test_reports/baseline-2026-08/zouk.co.in.json`, `test_reports/baseline-2026-08/README.md:3`, `scripts/archive-reference-scan.mjs:84`
- [-] **R0.4.2** Hand-label 60-100 answers as calibration fixtures `needs-secrets` — blocked: needs-secrets
- [x] **R0.4.3** CI on push; fix the test glob; add .gitattributes — closed at `package.json:11`, `.github/workflows/ci.yml:8`, `.gitattributes:5`, `src/lib/testCoverageGuard.test.mjs:46`, `src/components/perceev/charts/chartMath.test.mjs:309`

## R1 — Real-surface probe fleet  `6/33`

*2-3 weeks.* Bots drive perplexity.ai and chatgpt.com, extract the answers buyers actually see, capture screenshots as evidence, report typed outcomes.

### R1.1

- [~] **R1.1.1** Probe Result Contract v2 — submitted `docs/contracts/probe-result.md:15`, `docs/contracts/probe-result.md:74`, `docs/contracts/probe-result.md:304`, `docs/contracts/probe-result.md:647`, `docs/contracts/probe-result.md:694`, `docs/contracts/probe-result.md:952`, `docs/contracts/probe-result.md:981`, `docs/contracts/probe-result.md:1049`, `docs/contracts/probe-result.md:1106`, `docs/contracts/probe-result.md:1145`, `src/lib/scoring/enginePipeline.js:331`, `src/lib/scoring/enginePipeline.js:386`, `src/lib/scoring/enginePipeline.js:466`, `src/lib/scoring/enginePipeline.js:480`, `src/lib/scoring/enginePipeline.js:735`, `src/lib/scoring/enginePipeline.js:818`, `src/lib/scoring/enginePipeline.js:939`, `src/lib/workers/scanWorker.js:1227`, `src/lib/workers/scanWorker.js:1307`, `src/lib/workers/scanWorker.js:1769`, `src/lib/workers/scanWorker.js:2181`, `src/lib/db.js:123`, `src/lib/db.js:147`, `src/lib/content/weeklyReport.js:24`, `src/lib/llmPricing.js:79`, `src/lib/llmPricing.js:229`, `src/lib/llmPricing.js:335`, `src/lib/engines/deployedEngines.js:21`, `worker/src/lib/queue.js:207`, `worker/src/index.js:174`, `worker/src/index.js:211`
- [ ] **R1.1.2** ADR + 2-day spike: browser infrastructure `needs-secrets` `needs-decision`
- [ ] **R1.1.3** ADR: worker host `needs-decision`
- [ ] **R1.1.4** Engine surface matrix
- [ ] **R1.1.5** Politeness & risk budget
### R1.2

- [x] **R1.2.1** worker/ workspace: long-lived Node + Playwright — closed at `worker/package.json`, `worker/src/index.js`, `worker/src/config.js`, `worker/README.md`, `src/lib/workerIsolation.test.mjs`
- [x] **R1.2.2** probe_tasks queue table; fleet claims batches via jobLease — closed at `supabase/migrations/010_probe_tasks.sql:21`, `supabase/migrations/010_probe_tasks.sql:23`, `supabase/migrations/010_probe_tasks.sql:166`, `supabase/migrations/010_probe_tasks.sql:172`, `supabase/migrations/010_probe_tasks.sql:183`, `src/lib/probeTasksRace.test.mjs:275`, `src/lib/probeTasksRace.test.mjs:282`, `src/lib/probeTasksRace.test.mjs:124`, `src/lib/probeQueue.test.mjs:135`, `worker/src/lib/queue.js:172`, `src/lib/probeQueue.js:111`, `src/lib/liveDbGate.js:22`, `worker/src/index.js:40`, `scripts/setup-supabase.mjs:85`
- [x] **R1.2.3** Create the scan_runs ledger table — closed at `supabase/migrations/011_scan_runs.sql:78`, `scripts/setup-supabase.mjs:111`, `scripts/setup-supabase.mjs:493`, `src/lib/scanRunsLive.test.mjs:346`, `src/lib/scanRunsLive.test.mjs:44`, `worker/src/lib/probe.js:27`
- [ ] **R1.2.4** Authenticated ingest POST /api/internal/probe-results
- [ ] **R1.2.5** Dev runbook for the fleet
- [ ] **R1.2.6** Fleet config validated at boot
- [x] **R1.2.7** The Bright Data zone cache never invalidates — closed at `src/lib/engines/brightdata.js:81`, `src/lib/engines/brightdata.js:91`, `src/lib/engines/brightdata.js:116`, `src/lib/engines/brightdata.js:145`, `src/lib/engines/brightdata.js:291`, `src/lib/engines/brightdata.js:313`, `src/lib/engines/brightdata.js:398`, `src/lib/engines/brightdata.js:478`, `src/lib/engines/brightdataZone.test.mjs:101`, `src/lib/engines/brightdataZone.test.mjs:167`, `src/lib/engines/brightdataZone.test.mjs:249`
- [ ] **R1.2.8** The six-way race tests pass with SKIP LOCKED removed
- [x] **R1.2.9** Two records describe the zone cache R1.2.7 just replaced — closed at `docs/vendors/brightdata.md:113`, `docs/vendors/brightdata.md:150`, `docs/vendors/brightdata.md:217`, `docs/vendors/brightdata.md:253`, `docs/vendors/brightdata.md:314`, `src/lib/engines/serp.js:5`, `src/lib/engines/serp.js:14`, `src/lib/engines/serp.js:286`, `src/lib/engines/serp.js:325`, `src/lib/engines/serp.js:352-354`, `src/lib/scoring/promptGen.js:129`, `src/lib/scoring/promptGen.js:212`, `src/lib/scoring/promptGen.js:222-224`, `src/lib/scoring/promptGen.js:266-268`, `src/lib/scoring/aioPipeline.js:99`, `src/lib/scoring/enginePipeline.js:101`, `src/lib/engines/brightdata.js:69`, `src/lib/engines/brightdata.js:145`, `src/lib/engines/brightdata.js:192`, `src/lib/checkSecretsBrightdataNoZone.test.mjs:21`, `src/lib/engines/brightdataZone.test.mjs:206`, `src/app/api/scan/route.js:62`, `src/app/api/scan/worker/route.js:138`
- [ ] **R1.2.10** The Bright Data 200-envelope zone rejection has no test
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
- [x] **R1.6.2** Fix the SERP_GEO default inconsistency — closed at `src/lib/engines/serp.js:340`, `src/lib/engines/serpGeo.test.mjs:147`, `src/lib/engines/serpGeo.test.mjs:158`, `src/lib/engines/serpGeo.test.mjs:175`, `src/lib/engines/serpGeo.test.mjs:204`, `src/lib/engines/serpGeo.js:15`
### R1.7

- [ ] **R1.7.1** Dual-run the reference corpus through API and UI paths `needs-secrets`
- [ ] **R1.7.2** Cutover per engine behind the ENGINES flag `needs-soak`
- [ ] **R1.7.3** Demote API adapters to explicit fallback; delete dead paths
- [ ] **R1.7.4** fetchPeopleAlsoAsk bypasses the engine capability gate and can spend on a stale SERPAPI_KEY

## R2 — Scoring truth  `13/40`

*1 week.* Four-state vocabulary, roster feeding the headline, de-fake sweep, provenance on every number.

### R2.1

- [ ] **R2.1.1** Per-engine summaries emit state + state_reason
- [ ] **R2.1.2** Delete every ?? 0 null-coalescing metric in the normalize layer
- [ ] **R2.1.3** UI chips for did-not-report / not-assessed / small-sample; render engines_counted
- [ ] **R2.1.4** Tests: a fully-errored engine renders failed and contributes nothing
### R2.2

- [x] **R2.2.1** answer_present set only after the text check — closed at `src/lib/scoring/enginePipeline.js:177`, `src/lib/scoring/enginePipeline.js:180`, `src/lib/scoring/emptyAnswer.test.mjs`
- [ ] **R2.2.2** Perplexity citation-leg failure marks citations_state unverified
- [ ] **R2.2.3** upsertPrompts throws; audit all write helpers for the return-{error} idiom
- [ ] **R2.2.4** Remove insertScan's silent 3-tier column-drop cascade
- [x] **R2.2.5** dataSourceIssue still assumes text engines always answer — closed at `src/lib/scoring/enginePipeline.js:35`, `src/lib/scoring/enginePipeline.js:416`, `src/lib/scoring/enginePipeline.js:441`, `src/lib/scoring/enginePipeline.test.mjs:507`, `src/lib/scoring/aioConstants.js:4`
- [x] **R2.2.6** The scan-level data_source_issue banner is derived from aio alone — closed at `src/lib/scoring/enginePipeline.js:606`, `src/lib/scoring/enginePipeline.js:910`, `src/lib/scoring/enginePipeline.js:56`, `src/components/dashboard/DashboardShell.jsx:369`, `src/components/dashboard/DashboardShell.jsx:383`, `src/components/dashboard/DashboardShell.jsx:704`, `src/components/dashboard/DashboardShell.jsx:823`, `src/lib/scoring/enginePipeline.test.mjs:637`, `src/components/dashboard/degradedEngineBanner.test.mjs:54`
- [ ] **R2.2.7** The degraded-banner guard proves a declaration, not a gate
- [ ] **R2.2.8** promptGen swallows a PAA failure with no log at all
### R2.3

- [x] **R2.3.1** Two-pass finalize: discovered roster feeds the headline — closed at `src/lib/workers/scanWorker.js:757`, `src/lib/workers/scanWorker.js:781`, `src/lib/workers/scanWorker.js:798`, `src/lib/workers/twoPassFinalize.test.mjs`
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

- [x] **R2.7.1** SOV donut consumes the real share_of_voice_pct — closed at `src/components/perceev/charts/shareOfVoice.js:129`, `src/components/perceev/charts/Donut.jsx:53`, `src/components/dashboard/RankAndSharePanel.jsx:30`, `src/components/dashboard/RankAndSharePanel.jsx:43`, `src/components/perceev/charts/shareOfVoice.test.mjs:50`, `src/components/perceev/charts/shareOfVoice.test.mjs:326`
- [x] **R2.7.2** SourcesView reads v9 field names — closed at `src/components/dashboard/SourcesView.jsx:19`, `src/components/dashboard/SourcesView.jsx:71`, `src/components/dashboard/sourcesMetrics.js:41`, `src/components/dashboard/sourcesMetrics.js:97`, `src/components/dashboard/sourcesMetrics.test.mjs:90`
- [x] **R2.7.3** Delete the new Date() timestamp fallback — closed at `src/services/api.js:568`, `src/utils/format.js:34`, `src/utils/format.js:55`, `src/components/dashboard/DashboardShell.jsx:439`, `src/components/dashboard/DashboardShell.jsx:29`, `src/components/home/HomeDashboard.jsx:26`, `src/utils/format.test.mjs:63`, `src/services/api.test.mjs:493`
- [x] **R2.7.4** Persist and render the collection window — closed at `src/lib/db.js:97`, `src/lib/db.js:98`, `src/components/dashboard/DashboardShell.jsx:431`, `src/components/dashboard/DashboardShell.jsx:503`, `src/lib/collectionWindowPersist.test.mjs:393`, `src/lib/collectionWindowPersist.test.mjs:336`, `src/lib/collectionWindowPersist.test.mjs:185`, `src/lib/collectionWindowPersist.test.mjs:471`
- [ ] **R2.7.5** share_of_voice_pct exists only per engine; the scan-level field is never written
- [ ] **R2.7.6** ScoreBreakdown prints a confident 0% for a share of voice nobody computed
- [ ] **R2.7.7** The demo data does not carry the fields a real scan carries, so the sample report reads as broken
### R2.8

- [ ] **R2.8.1** Gate Studio and Opportunities on data quality
- [ ] **R2.8.2** Engine gauges: a zero-row engine says 'no data'
- [x] **R2.8.3** Unknown status renders 'reconnecting', never rewinds to 0 percent — closed at `src/lib/scanProgress.js:50`, `src/lib/scanProgress.js:74`, `src/lib/scanProgress.js:92`, `src/app/scan/page.js:134`, `src/app/scan/page.js:341`, `src/services/api.js:805`, `src/app/api/scan/[job_id]/status/route.js:37`, `src/lib/scanProgress.test.mjs:40`, `src/lib/scanStatusTransient.route.test.mjs:99`
- [x] **R2.8.4** DB-down state distinct from 'no scans yet' — closed at `src/lib/db.js:241`, `src/lib/db.js:255`, `src/lib/db.js:204`, `src/app/api/scans/[brand]/latest/route.js:27`, `src/lib/latestScanRoute.route.test.mjs:209`, `src/lib/latestScanRoute.route.test.mjs:245`, `src/app/api/content/worker/route.js:141`, `src/lib/content/dailyBatch.js:70`, `src/lib/content/weeklyReport.js:109`, `src/lib/content/contentWorker.js:226`
- [ ] **R2.8.5** The remaining fail-quiet DB reads, same class as R2.8.4
- [~] **R2.8.6** insertScan fail-softs on a missing client and returns undefined — submitted `src/lib/db.js:120`, `src/lib/db.js:122`, `src/lib/db.js:126`, `src/lib/db.js:75`, `src/lib/db.js:255`, `src/lib/db.js:263`, `src/lib/insertScanWriteFailure.test.mjs:67`, `src/lib/insertScanWriteFailure.test.mjs:124`, `src/lib/insertScanWriteFailure.test.mjs:166`
### R2.9

- [ ] **R2.9.1** Provenance strip under the hero
### R2.10

- [x] **R2.10.1** De-fake the landing page — closed at `src/data/mockData.js:51`, `src/data/mockData.js:106`, `src/data/mockData.js:123`, `src/app/page.js:70`, `src/app/page.js:80`, `src/app/scan/page.js:50`, `src/lib/landingHonesty.test.mjs:111`, `src/lib/landingHonesty.test.mjs:291`, `scripts/check-secrets.mjs:320`, `src/lib/engines/deployedEngines.js:75`
- [ ] **R2.10.2** Probe counter backed by a real count query
- [ ] **R2.10.4** ENGINE_REGISTRY says aio is always configured
- [x] **R2.10.5** The hero sample card hardcodes a Perplexity chip — closed at `src/components/landing/AnswerSheet.jsx:72`, `src/components/landing/AnswerSheet.jsx:22`, `src/lib/engines/deployedEngines.js:107`, `src/lib/landingHonesty.test.mjs:57`, `src/lib/landingHonesty.test.mjs:348`
- [x] **R2.10.6** A second hardcoded engine chip survives at page.js:295 — closed at `src/lib/landingHonesty.test.mjs:99`, `src/lib/landingHonesty.test.mjs:107`, `src/lib/landingHonesty.test.mjs:145`, `src/lib/landingHonesty.test.mjs:179`, `src/lib/landingHonesty.test.mjs:189`, `src/lib/landingHonesty.test.mjs:214`, `src/lib/landingHonesty.test.mjs:225`, `src/lib/landingHonesty.test.mjs:235`, `src/lib/landingHonesty.test.mjs:245`, `src/lib/landingHonesty.test.mjs:305`, `src/lib/landingHonesty.test.mjs:710`, `src/app/page.js:76`, `src/app/page.js:308`

## R3 — Durable backend  `10/34`

*1 week.* Real cadence, a reaper, a run ledger, a scheduler that reconciles, spend that cannot silently read $0.

### R3.1

- [ ] **R3.1.1** Scan worker cron every 10 minutes `needs-vercel`
- [ ] **R3.1.2** Add the missing ?batch=1 cron entry `needs-vercel` `needs-llm`
- [x] **R3.1.3** The scan worker route reports processed:1 for a request that failed — closed at `src/app/api/scan/worker/route.js:79`, `src/app/api/scan/worker/route.js:104`, `src/app/api/scan/worker/route.js:138`, `src/app/api/scan/worker/route.js:160`, `src/app/api/scan/worker/route.js:187`, `src/app/api/scan/worker/route.js:249`, `src/lib/scanWorkerRoute.route.test.mjs:101`, `src/lib/scanWorkerRoute.route.test.mjs:119`, `src/lib/scanWorkerRoute.route.test.mjs:203`
- [ ] **R3.1.4** The content worker sweep counts dispatched as done, and an in-memory scan leaves no ledger row
### R3.2

- [x] **R3.2.1** One scan_runs row per chunk execution — closed at `src/lib/workers/scanWorker.js:1540`, `src/lib/workers/scanWorker.js:1555`, `src/lib/workers/scanWorker.js:321`, `src/lib/workers/scanWorker.js:854`, `src/lib/workers/scanWorker.js:203`, `src/lib/workers/scanWorker.js:270`, `src/lib/workers/scanChunkLedger.test.mjs:327`, `src/lib/workers/scanChunkLedgerLive.test.mjs:176`
- [x] **R3.2.2** Every discarded skip reason becomes a ledger row — closed at `src/lib/scoring/enginePipeline.js:829`, `src/lib/scoring/enginePipeline.js:834`, `src/lib/scoring/enginePipeline.js:846`, `src/lib/scoring/enginePipeline.js:796`, `src/lib/workers/scanWorker.js:283`, `src/lib/workers/scanWorker.js:211`, `src/lib/workers/scanWorker.js:1142`, `src/lib/workers/scanWorker.js:2230`, `src/lib/workers/scanChunkLedger.test.mjs:1409`, `src/lib/workers/scanChunkLedger.test.mjs:1493`, `src/lib/workers/scanChunkLedger.test.mjs:1940`, `src/lib/workers/scanChunkLedger.test.mjs:1089`, `src/lib/scoring/enginePipeline.test.mjs:241`
- [ ] **R3.2.3** Status route and dashboard read run history
- [~] **R3.2.4** A live test wrote to production because only its reads were stubbed — submitted `src/lib/liveWriteGuardAuto.mjs:64`, `package.json:11`, `package.json:16`, `src/lib/liveWriteGuard.js:326`, `src/lib/liveWriteGuard.js:410`, `src/lib/liveWriteGuard.js:594`, `src/lib/liveWriteGuard.js:686`, `src/lib/liveWriteGuard.test.mjs:338`, `src/lib/liveWriteGuard.test.mjs:413`, `src/lib/workers/scanChunk.test.mjs:216`, `src/lib/workers/scanChunkLedger.test.mjs:21`, `src/lib/workers/scanChunkLedger.test.mjs:240`, `src/lib/workers/scanJobAttempts.test.mjs:21`, `src/lib/content/contentWorker.test.mjs:30`, `src/lib/content/crewCanvas.test.mjs:24`, `src/lib/scoring/contentLift.test.mjs:24`, `src/lib/scoring/asyncJob.test.mjs:17`
- [~] **R3.2.5** A frozen engine that stops resolving silently shrinks the headline — submitted `src/lib/scoring/enginePipeline.js:770`, `src/lib/scoring/enginePipeline.js:693`, `src/lib/scoring/enginePipeline.js:801`, `src/lib/workers/scanWorker.js:1860`, `src/lib/workers/scanWorker.js:1595`, `src/lib/workers/scanWorker.js:1313`, `src/lib/workers/scanWorker.js:1338`, `src/lib/workers/engineSetChange.test.mjs:199`, `src/lib/workers/engineSetChange.test.mjs:236`, `src/lib/workers/engineSetChange.test.mjs:277`, `src/lib/workers/engineSetChange.test.mjs:343`
- [~] **R3.2.6** The cron reports a scheduler tick that declined every brand as a clean empty tick — submitted `src/app/api/scan/worker/route.js:390`, `src/app/api/scan/worker/route.js:179`, `src/app/api/scan/worker/route.js:257`, `src/app/api/scan/worker/route.js:236`, `src/lib/scanWorkerRoute.route.test.mjs:356`, `src/lib/scanWorkerRoute.route.test.mjs:496`
- [ ] **R3.2.7** The live write guard cannot force its own adoption
- [ ] **R3.2.9** On a refrozen scan, finalize summarizes engines that produced nothing and ignores the rows that exist
### R3.3

- [~] **R3.3.1** attempts column with a cap of 3 — submitted `supabase/migrations/012_scan_job_attempts.sql:81`, `src/lib/workers/scanWorker.js:2086`, `src/lib/workers/scanJobAttempts.test.mjs:279`
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

- [x] **R3.6.1** Price table that fails loud on an unknown model id — closed at `docs/vendors/mimo.md:47`, `docs/vendors/mimo.md:54`, `docs/vendors/mimo.md:68`, `docs/vendors/mimo.md:84`, `docs/vendors/mimo.md:99`, `docs/vendors/mimo.md:107`, `docs/vendors/mimo.md:172`, `src/lib/llmPricing.js:244`, `src/lib/llmPricing.js:267`, `src/lib/llmPricing.js:355`, `src/lib/openrouter.js:111`, `src/lib/openrouter.test.mjs:504`, `src/lib/llmPricing.test.mjs:221`
- [ ] **R3.6.2** Per-scan and per-day spend caps enforced from the ledger
- [ ] **R3.6.3** Weekly report metered per brand per day
- [ ] **R3.6.4** The Bright Data per-query price is hardcoded in three places
- [ ] **R3.6.5** gemini and perplexity still fabricate costs; llmPricing does not reach them
### R3.7

- [x] **R3.7.1** SSRF guard module for Firecrawl fallback and crawlability — closed at `src/lib/ssrfGuard.js:366`, `src/lib/ssrfGuard.js:482`, `src/lib/ssrfGuard.js:552`, `src/lib/firecrawl.js:45`, `src/lib/firecrawl.js:115`, `src/lib/ssrfGuard.test.mjs:1`, `src/lib/firecrawl.test.mjs:1`
- [x] **R3.7.2** Firecrawl degrade becomes a recorded state — closed at `src/lib/workers/scanWorker.js:216`, `src/lib/workers/scanWorker.js:1112`, `src/lib/workers/scanWorker.js:1216`, `src/lib/workers/scanWorker.js:1390`, `src/lib/workers/scanChunkLedger.test.mjs:1982`, `src/lib/workers/scanChunkLedger.test.mjs:2073`, `src/lib/workers/scanChunkLedger.test.mjs:2155`, `src/lib/scoring/promptGen.js:255`, `src/lib/workers/scanChunk.test.mjs:496`, `docs/vendors/firecrawl.md:65`, `docs/vendors/firecrawl.md:96`
- [x] **R3.7.4** Apply the SSRF guard to the crawlability route — closed at `src/app/api/brands/[brand]/crawlability/route.js:243`, `src/app/api/brands/[brand]/crawlability/route.js:105`, `src/app/api/brands/[brand]/crawlability/route.js:312`, `src/app/api/brands/[brand]/crawlability/route.js:376`, `src/app/api/brands/[brand]/crawlability/route.js:412`, `src/app/api/brands/[brand]/crawlability/route.js:131`, `src/app/api/brands/[brand]/crawlability/route.js:345`, `src/app/api/brands/[brand]/crawlability/route.js:76`, `src/app/api/knowledge/route.js:114`, `src/app/api/knowledge/route.js:71`, `src/lib/scoring/promptGen.js:176`, `src/lib/crawlabilitySsrf.route.test.mjs:112`, `src/lib/crawlabilitySsrf.route.test.mjs:293`, `src/lib/crawlabilitySsrf.route.test.mjs:487`, `src/lib/ssrfRefusalSurfacing.test.mjs:60`, `src/lib/ssrfRefusalSurfacing.test.mjs:140`
- [x] **R3.7.5** Seven IPv6 ranges classifyAddress still allows — closed at `src/lib/ssrfGuard.js:335`, `src/lib/ssrfGuard.js:358`, `src/lib/ssrfGuard.js:385`, `src/lib/ssrfGuard.js:412`, `src/lib/ssrfGuard.test.mjs:108`, `src/lib/ssrfGuard.test.mjs:201`, `src/lib/ssrfGuard.test.mjs:270`
- [x] **R3.7.6** promptGen leaks an uncleared 10-second timer per seed term — closed at `src/lib/scoring/promptGen.js:346`, `src/lib/scoring/promptGen.js:318`, `src/lib/scoring/promptGen.js:342`, `src/lib/scoring/promptGen.js:355`, `src/lib/scoring/promptGen.js:25`, `src/lib/scoring/promptGenSeedTimer.test.mjs:195`, `src/lib/scoring/promptGenSeedTimer.test.mjs:108`, `src/lib/scoring/promptGenSeedTimer.test.mjs:137`
- [x] **R3.7.7** The crawlability UI shows a refused rival as unreachable — closed at `src/components/dashboard/CrawlabilityView.jsx:641`, `src/components/dashboard/CrawlabilityView.jsx:593`, `src/components/dashboard/CrawlabilityView.jsx:546`, `src/lib/crawlabilityOutcome.js:86`, `src/lib/crawlabilityOutcome.js:146`, `src/components/dashboard/crawlabilityRivalOutcome.test.mjs:202`, `src/components/dashboard/crawlabilityRivalOutcome.test.mjs:292`
- [ ] **R3.7.8** The primary-domain crawlability banner conflates a customer typo with a network problem

## R4 — Ground truth & analytics completion  `0/7`

*1 week.* Probe scores sitting next to Google-verified numbers, change detection, referral capture.

### R4.1

- [ ] **R4.1.1** Wire the orphaned GSC client `needs-secrets`
- [ ] **R4.1.2** Prompt grounding seeds from real GSC queries `needs-llm`
### R4.2

- [ ] **R4.2.1** Dual-number pattern where our probe meets a verifiable source
### R4.3

- [ ] **R4.3.1** crawlability_audits history and change detection
- [ ] **R4.3.2** computeBrandRollups still yields a real 100% for a self-only roster
### R4.4

- [ ] **R4.4.1** AI-referral capture `needs-secrets`
### R4.5

- [ ] **R4.5.1** Decide-or-delete pass on schema-only subsystems `needs-decision`

## R5 — Content OS quality  `1/12`

*1 week.* Model-layer truth, a publish loop that stops pretending, drafts benchmarked against what engines cite.

### R5.1

- [x] **R5.1.1** Provider-neutral LLM config — closed at `src/lib/llmConfig.js:53`, `src/lib/llmConfig.js:99`, `src/lib/openrouter.js:20`, `src/lib/openrouter.js:48`, `src/lib/health.js:25`, `scripts/check-secrets.mjs:95`, `src/lib/scoring/promptGen.js:275`, `.env.example:11`, `docs/vendors/mimo.md:40`, `src/lib/openrouter.test.mjs:191`
- [ ] **R5.1.2** Key re-enable checklist `needs-llm` `needs-secrets`
- [-] **R5.1.3** The LLM gateway is MiMo while every var is named OPENROUTER_* `needs-llm` — blocked: needs-llm
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

## R6 — Apparatus & guards  `12/28`

*starts day one, finishes last.* The paper trail and the tests that keep every earlier phase from regressing.

### R6.1

- [x] **R6.1.1** Migrations ledger and transaction per file — closed at `scripts/setup-supabase.mjs:28`, `scripts/setup-supabase.mjs:192`, `scripts/setup-supabase.mjs:215`, `scripts/setup-supabase.mjs:250`, `scripts/setup-supabase.mjs:255`, `scripts/setup-supabase.mjs:200`, `src/lib/migrationsRunner.test.mjs:277`, `src/lib/migrationsLedger.test.mjs:98`
- [ ] **R6.1.2** docs/PROD_MIGRATIONS.md with per-migration verification queries
- [x] **R6.1.3** Track the orchestration tooling change made outside the ledger — closed at `.claude/orchestration/orchestrate.mjs:436`, `docs/BUILD_JOURNAL.md`
- [~] **R6.1.4** Agents grep secrets into transcripts; the exclusion must be in the brief, not the discipline — submitted `.claude/agents/rebuild-verifier.md:25`, `.claude/agents/rebuild-surveyor.md:35`, `.claude/agents/rebuild-scribe.md:40`, `.claude/agents/rebuild-test-author.md:45`, `.claude/agents/rebuild-implementer.md:50`, `.claude/agents/rebuild-controller.md:100`, `src/lib/agentSecretsGuard.test.mjs:62`, `src/lib/agentSecretsGuard.test.mjs:87`, `src/lib/agentSecretsGuard.test.mjs:115`
- [x] **R6.1.5** The checksum drift warning asserts a schema mismatch that may not exist — closed at `scripts/setup-supabase.mjs:48`, `scripts/setup-supabase.mjs:166`, `scripts/setup-supabase.mjs:296`, `scripts/setup-supabase.mjs:335`, `scripts/setup-supabase.mjs:353`, `scripts/setup-supabase.mjs:448`, `scripts/setup-supabase.mjs:497`, `src/lib/migrationsRunner.test.mjs:480`, `src/lib/migrationsRunner.test.mjs:614`
- [x] **R6.1.6** The migrations ordering guard measures from the first anchor, not the last — closed at `src/lib/migrationsRunner.test.mjs:318`, `src/lib/migrationsRunner.test.mjs:323`, `src/lib/migrationsRunner.test.mjs:347`, `src/lib/migrationsRunner.test.mjs:395`
- [ ] **R6.1.7** The ordering guard trusts the runner self-report as the stage marker
### R6.2

- [ ] **R6.2.1** docs/OPERATOR_LEDGER.md
- [ ] **R6.2.2** docs/RUNBOOK.md seeded with 10 symptom rows
### R6.3

- [x] **R6.3.1** Vendor contract docs — closed at `docs/vendors/suggestqueries.md:1`, `docs/vendors/README.md:90`, `docs/vendors/README.md:186`, `docs/vendors/README.md:208`, `docs/vendors/README.md:59`, `docs/vendors/brightdata.md:65`, `src/lib/engines/serp.js:372`, `src/lib/engines/serp.js:375`, `src/lib/engines/serp.js:379`, `src/lib/workers/scanWorker.js:197`
- [x] **R6.3.2** gemini.md asserts a bug R6.5.6 just fixed as still current — closed at `src/lib/workers/scanWorker.js:1506`
### R6.4

- [ ] **R6.4.1** Guard: route-perimeter walker
- [ ] **R6.4.2** Guard: fail-loud walker
- [ ] **R6.4.3** Guard: infra vendors never in rendered copy, engine names required
- [ ] **R6.4.4** Guard: engine-count-agnostic UI
- [x] **R6.4.5** testCoverageGuard fails on Windows: path.relative yields backslashes — closed at `src/lib/testCoverageGuard.test.mjs:29`, `src/lib/testCoverageGuard.test.mjs:41`
- [x] **R6.4.6** archive-reference-scan takes a URL host but --list prints brand names — closed at `scripts/archive-reference-scan.mjs:83`, `scripts/archive-reference-scan.mjs:105`, `scripts/archive-reference-scan.mjs:54`, `scripts/archive-reference-scan.mjs:155`
- [ ] **R6.4.7** The working tree is half CRLF despite .gitattributes eol=lf
- [ ] **R6.4.8** Doc-to-source staleness tripwire, recommended by R6.3.2 and not buildable there
- [ ] **R6.4.9** withoutComments strips engine names out of strings in every other guarded file
- [ ] **R6.4.10** A NUL byte in a source file makes it invisible to every grep-based guard
### R6.5

- [x] **R6.5.1** Route tests for the money paths and Bright Data parser fixtures — closed at `src/lib/scanRoute.route.test.mjs`, `src/lib/engines/brightdataParser.test.mjs`, `src/lib/cronAuth.route.test.mjs`
- [ ] **R6.5.2** The great deletion
- [x] **R6.5.3** Delete the orphaned adapter.js/probe.js pair — it does not even parse — closed at `docs/BUILD_JOURNAL.md`, `src/lib/engines/openai.js:8`, `src/lib/scoring/enginePipeline.js`
- [x] **R6.5.4** serp.test.mjs passes only because no BRIGHTDATA_API_KEY is in the environment — closed at `src/lib/engines/serp.test.mjs:65`, `src/lib/engines/serp.test.mjs:72`, `src/lib/engines/serp.test.mjs:29`, `src/lib/engines/serp.test.mjs:246`
- [ ] **R6.5.5** serp.test.mjs env guard stops looking if a test is appended below it
- [x] **R6.5.6** gemini.js abort signal never reaches the SDK — closed at `src/lib/gemini.js:56`, `src/lib/gemini.js:55`, `src/lib/gemini.js:92`, `src/lib/geminiAbort.test.mjs:155`, `src/lib/geminiAbort.test.mjs:187`, `src/lib/geminiAbort.test.mjs:97`, `src/lib/geminiAbort.test.mjs:220`, `src/lib/geminiAbort.test.mjs:256`
- [ ] **R6.5.7** liveWriteGuard.test.mjs:290 passes alone and fails in the full run


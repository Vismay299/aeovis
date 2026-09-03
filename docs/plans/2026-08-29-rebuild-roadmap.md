# Rebuild roadmap — R0-R6

> Status: **LIVE**. Generated from `.claude/orchestration/tasks.json` by
> `node .claude/orchestration/orchestrate.mjs render`. Do not hand-edit —
> edits belong in the ledger, which the orchestration CLI is the only writer for.

Source: The Real-Surface Rebuild (artifact d5db8fa1), 29 Aug 2026
Companion: The Honesty Gap (artifact bbd113a7) — findings A1-C12, suggestions S1-S30
Baseline commit: `5111219`

**49 / 164 closed** · 4 blocked · legend: `[x]` done · `[~]` in flight · `[-]` blocked · `[ ]` open

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

## R0 — Ground zero  `22/30`

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
- [ ] **R0.1.16** health.js keeps a second vendor list and claims it is shared
- [ ] **R0.1.17** Nothing detects a NODE_ENV that lies
- [ ] **R0.1.18** Three footguns in the rate-limit trust knob
- [ ] **R0.1.19** The perimeter warn-once guard is evadable in one added line
### R0.2

- [x] **R0.2.1** Create docs/BUILD_JOURNAL.md seeded with the 37 findings — closed at `docs/BUILD_JOURNAL.md:123`, `docs/BUILD_JOURNAL.md:124`, `docs/BUILD_JOURNAL.md:127`, `src/lib/scoring/enginePipeline.js:510`, `src/lib/scoring/enginePipeline.js:450`, `src/lib/scoring/enginePipeline.js:98`, `src/lib/workers/scanWorker.js:472`, `src/lib/workers/scanWorker.js:436`, `src/lib/db.js:11`, `src/lib/db.js:298`, `src/lib/db.js:62`, `src/app/api/scan/route.js:62`, `src/app/api/scan/worker/route.js:60`, `src/lib/buildJournal.test.mjs:62`
- [x] **R0.2.2** Tracker rule in force; status headers on all plans — closed at `docs/plans/2026-08-29-rebuild-roadmap.md:25`, `docs/plans/README.md:36`, `DESIGN.md:4`, `src/lib/docStatus.test.mjs:32`
- [ ] **R0.2.3** Supersede the SerpAPI ADR with a dated Bright Data ADR
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

## R1 — Real-surface probe fleet  `5/33`

*2-3 weeks.* Bots drive perplexity.ai and chatgpt.com, extract the answers buyers actually see, capture screenshots as evidence, report typed outcomes.

### R1.1

- [ ] **R1.1.1** Probe Result Contract v2
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
- [~] **R1.2.9** Two records describe the zone cache R1.2.7 just replaced — submitted `docs/vendors/brightdata.md:18`, `docs/vendors/brightdata.md:73`, `docs/vendors/brightdata.md:80`, `docs/vendors/brightdata.md:103`, `docs/vendors/brightdata.md:169`, `docs/vendors/brightdata.md:195`, `docs/vendors/brightdata.md:213`, `docs/vendors/brightdata.md:238`, `scripts/check-secrets.mjs:166`, `src/lib/engines/brightdata.js:72`, `src/lib/engines/brightdata.js:81`, `src/lib/engines/brightdata.js:116`, `src/lib/engines/brightdata.js:145`, `src/lib/engines/brightdata.js:160`, `src/lib/engines/brightdata.js:291`, `src/lib/engines/brightdata.js:313`, `src/lib/engines/brightdata.js:441`, `src/lib/engines/brightdata.js:478`, `src/lib/engines/brightdataZone.test.mjs:66`, `src/lib/engines/brightdataZone.test.mjs:101`, `src/lib/engines/brightdataZone.test.mjs:334`, `worker/src/lib/probe.js:28`, `src/lib/workerIsolation.test.mjs:72`, `src/app/api/scan/route.js:62`, `src/lib/scoring/aioPipeline.js:171`
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

## R2 — Scoring truth  `10/34`

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
- [~] **R2.2.6** The scan-level data_source_issue banner is derived from aio alone — submitted `src/lib/scoring/enginePipeline.js:606`, `src/lib/scoring/enginePipeline.js:910`, `src/lib/scoring/enginePipeline.js:56`, `src/components/dashboard/DashboardShell.jsx:369`, `src/components/dashboard/DashboardShell.jsx:383`, `src/components/dashboard/DashboardShell.jsx:704`, `src/components/dashboard/DashboardShell.jsx:823`, `src/lib/scoring/enginePipeline.test.mjs:637`, `src/components/dashboard/degradedEngineBanner.test.mjs:54`
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

- [ ] **R2.7.1** SOV donut consumes the real share_of_voice_pct
- [x] **R2.7.2** SourcesView reads v9 field names — closed at `src/components/dashboard/SourcesView.jsx:19`, `src/components/dashboard/SourcesView.jsx:71`, `src/components/dashboard/sourcesMetrics.js:41`, `src/components/dashboard/sourcesMetrics.js:97`, `src/components/dashboard/sourcesMetrics.test.mjs:90`
- [x] **R2.7.3** Delete the new Date() timestamp fallback — closed at `src/services/api.js:568`, `src/utils/format.js:34`, `src/utils/format.js:55`, `src/components/dashboard/DashboardShell.jsx:439`, `src/components/dashboard/DashboardShell.jsx:29`, `src/components/home/HomeDashboard.jsx:26`, `src/utils/format.test.mjs:63`, `src/services/api.test.mjs:493`
- [x] **R2.7.4** Persist and render the collection window — closed at `src/lib/db.js:97`, `src/lib/db.js:98`, `src/components/dashboard/DashboardShell.jsx:431`, `src/components/dashboard/DashboardShell.jsx:503`, `src/lib/collectionWindowPersist.test.mjs:393`, `src/lib/collectionWindowPersist.test.mjs:336`, `src/lib/collectionWindowPersist.test.mjs:185`, `src/lib/collectionWindowPersist.test.mjs:471`
### R2.8

- [ ] **R2.8.1** Gate Studio and Opportunities on data quality
- [ ] **R2.8.2** Engine gauges: a zero-row engine says 'no data'
- [x] **R2.8.3** Unknown status renders 'reconnecting', never rewinds to 0 percent — closed at `src/lib/scanProgress.js:50`, `src/lib/scanProgress.js:74`, `src/lib/scanProgress.js:92`, `src/app/scan/page.js:134`, `src/app/scan/page.js:341`, `src/services/api.js:805`, `src/app/api/scan/[job_id]/status/route.js:37`, `src/lib/scanProgress.test.mjs:40`, `src/lib/scanStatusTransient.route.test.mjs:99`
- [x] **R2.8.4** DB-down state distinct from 'no scans yet' — closed at `src/lib/db.js:241`, `src/lib/db.js:255`, `src/lib/db.js:204`, `src/app/api/scans/[brand]/latest/route.js:27`, `src/lib/latestScanRoute.route.test.mjs:209`, `src/lib/latestScanRoute.route.test.mjs:245`, `src/app/api/content/worker/route.js:141`, `src/lib/content/dailyBatch.js:70`, `src/lib/content/weeklyReport.js:109`, `src/lib/content/contentWorker.js:226`
- [ ] **R2.8.5** The remaining fail-quiet DB reads, same class as R2.8.4
### R2.9

- [ ] **R2.9.1** Provenance strip under the hero
### R2.10

- [x] **R2.10.1** De-fake the landing page — closed at `src/data/mockData.js:51`, `src/data/mockData.js:106`, `src/data/mockData.js:123`, `src/app/page.js:70`, `src/app/page.js:80`, `src/app/scan/page.js:50`, `src/lib/landingHonesty.test.mjs:111`, `src/lib/landingHonesty.test.mjs:291`, `scripts/check-secrets.mjs:320`, `src/lib/engines/deployedEngines.js:75`
- [ ] **R2.10.2** Probe counter backed by a real count query
- [ ] **R2.10.4** ENGINE_REGISTRY says aio is always configured
- [x] **R2.10.5** The hero sample card hardcodes a Perplexity chip — closed at `src/components/landing/AnswerSheet.jsx:72`, `src/components/landing/AnswerSheet.jsx:22`, `src/lib/engines/deployedEngines.js:107`, `src/lib/landingHonesty.test.mjs:57`, `src/lib/landingHonesty.test.mjs:348`
- [~] **R2.10.6** A second hardcoded engine chip survives at page.js:295 — submitted `src/lib/landingHonesty.test.mjs:47`, `src/lib/landingHonesty.test.mjs:102`, `src/lib/landingHonesty.test.mjs:110`, `src/lib/landingHonesty.test.mjs:132`, `src/lib/landingHonesty.test.mjs:139`, `src/lib/landingHonesty.test.mjs:579`, `src/lib/landingHonesty.test.mjs:608`, `src/app/page.js:76`, `src/app/page.js:308`

## R3 — Durable backend  `0/24`

*1 week.* Real cadence, a reaper, a run ledger, a scheduler that reconciles, spend that cannot silently read $0.

### R3.1

- [ ] **R3.1.1** Scan worker cron every 10 minutes `needs-vercel`
- [ ] **R3.1.2** Add the missing ?batch=1 cron entry `needs-vercel` `needs-llm`
- [ ] **R3.1.3** The scan worker route reports processed:1 for a request that failed
### R3.2

- [~] **R3.2.1** One scan_runs row per chunk execution — submitted `src/lib/workers/scanWorker.js:1540`, `src/lib/workers/scanWorker.js:1555`, `src/lib/workers/scanWorker.js:321`, `src/lib/workers/scanWorker.js:854`, `src/lib/workers/scanWorker.js:203`, `src/lib/workers/scanWorker.js:270`, `src/lib/workers/scanChunkLedger.test.mjs:327`, `src/lib/workers/scanChunkLedgerLive.test.mjs:176`
- [ ] **R3.2.2** Every discarded skip reason becomes a ledger row
- [ ] **R3.2.3** Status route and dashboard read run history
- [ ] **R3.2.4** A live test wrote to production because only its reads were stubbed
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
- [ ] **R3.6.4** The Bright Data per-query price is hardcoded in three places
### R3.7

- [~] **R3.7.1** SSRF guard module for Firecrawl fallback and crawlability — submitted `src/lib/ssrfGuard.js:366`, `src/lib/ssrfGuard.js:482`, `src/lib/ssrfGuard.js:552`, `src/lib/firecrawl.js:45`, `src/lib/firecrawl.js:115`, `src/lib/ssrfGuard.test.mjs:1`, `src/lib/firecrawl.test.mjs:1`
- [ ] **R3.7.2** Firecrawl degrade becomes a recorded state
- [ ] **R3.7.4** Apply the SSRF guard to the crawlability route

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

## R6 — Apparatus & guards  `11/25`

*starts day one, finishes last.* The paper trail and the tests that keep every earlier phase from regressing.

### R6.1

- [x] **R6.1.1** Migrations ledger and transaction per file — closed at `scripts/setup-supabase.mjs:28`, `scripts/setup-supabase.mjs:192`, `scripts/setup-supabase.mjs:215`, `scripts/setup-supabase.mjs:250`, `scripts/setup-supabase.mjs:255`, `scripts/setup-supabase.mjs:200`, `src/lib/migrationsRunner.test.mjs:277`, `src/lib/migrationsLedger.test.mjs:98`
- [ ] **R6.1.2** docs/PROD_MIGRATIONS.md with per-migration verification queries
- [x] **R6.1.3** Track the orchestration tooling change made outside the ledger — closed at `.claude/orchestration/orchestrate.mjs:436`, `docs/BUILD_JOURNAL.md`
- [ ] **R6.1.4** Agents grep secrets into transcripts; the exclusion must be in the brief, not the discipline
- [x] **R6.1.5** The checksum drift warning asserts a schema mismatch that may not exist — closed at `scripts/setup-supabase.mjs:48`, `scripts/setup-supabase.mjs:166`, `scripts/setup-supabase.mjs:296`, `scripts/setup-supabase.mjs:335`, `scripts/setup-supabase.mjs:353`, `scripts/setup-supabase.mjs:448`, `scripts/setup-supabase.mjs:497`, `src/lib/migrationsRunner.test.mjs:480`, `src/lib/migrationsRunner.test.mjs:614`
- [x] **R6.1.6** The migrations ordering guard measures from the first anchor, not the last — closed at `src/lib/migrationsRunner.test.mjs:318`, `src/lib/migrationsRunner.test.mjs:323`, `src/lib/migrationsRunner.test.mjs:347`, `src/lib/migrationsRunner.test.mjs:395`
- [ ] **R6.1.7** The ordering guard trusts the runner self-report as the stage marker
### R6.2

- [ ] **R6.2.1** docs/OPERATOR_LEDGER.md
- [ ] **R6.2.2** docs/RUNBOOK.md seeded with 10 symptom rows
### R6.3

- [x] **R6.3.1** Vendor contract docs — closed at `docs/vendors/suggestqueries.md:1`, `docs/vendors/README.md:90`, `docs/vendors/README.md:186`, `docs/vendors/README.md:208`, `docs/vendors/README.md:59`, `docs/vendors/brightdata.md:65`, `src/lib/engines/serp.js:372`, `src/lib/engines/serp.js:375`, `src/lib/engines/serp.js:379`, `src/lib/workers/scanWorker.js:197`
- [~] **R6.3.2** gemini.md asserts a bug R6.5.6 just fixed as still current — submitted `docs/vendors/gemini.md:9`, `docs/vendors/gemini.md:47`, `docs/vendors/gemini.md:88`, `docs/vendors/gemini.md:205`, `docs/vendors/gemini.md:232`, `docs/vendors/gemini.md:253`, `docs/vendors/gemini.md:264`, `docs/vendors/gemini.md:290`, `docs/vendors/README.md:41`, `docs/vendors/README.md:94`, `docs/vendors/README.md:127`, `docs/vendors/README.md:167`, `src/lib/gemini.js:55`, `src/lib/gemini.js:85`, `src/lib/gemini.js:92`, `src/lib/docStatus.test.mjs:19`, `node_modules/@google/generative-ai/dist/index.mjs:444`
### R6.4

- [ ] **R6.4.1** Guard: route-perimeter walker
- [ ] **R6.4.2** Guard: fail-loud walker
- [ ] **R6.4.3** Guard: infra vendors never in rendered copy, engine names required
- [ ] **R6.4.4** Guard: engine-count-agnostic UI
- [x] **R6.4.5** testCoverageGuard fails on Windows: path.relative yields backslashes — closed at `src/lib/testCoverageGuard.test.mjs:29`, `src/lib/testCoverageGuard.test.mjs:41`
- [x] **R6.4.6** archive-reference-scan takes a URL host but --list prints brand names — closed at `scripts/archive-reference-scan.mjs:83`, `scripts/archive-reference-scan.mjs:105`, `scripts/archive-reference-scan.mjs:54`, `scripts/archive-reference-scan.mjs:155`
- [ ] **R6.4.7** The working tree is half CRLF despite .gitattributes eol=lf
- [ ] **R6.4.8** Doc-to-source staleness tripwire, recommended by R6.3.2 and not buildable there
### R6.5

- [x] **R6.5.1** Route tests for the money paths and Bright Data parser fixtures — closed at `src/lib/scanRoute.route.test.mjs`, `src/lib/engines/brightdataParser.test.mjs`, `src/lib/cronAuth.route.test.mjs`
- [ ] **R6.5.2** The great deletion
- [x] **R6.5.3** Delete the orphaned adapter.js/probe.js pair — it does not even parse — closed at `docs/BUILD_JOURNAL.md`, `src/lib/engines/openai.js:8`, `src/lib/scoring/enginePipeline.js`
- [x] **R6.5.4** serp.test.mjs passes only because no BRIGHTDATA_API_KEY is in the environment — closed at `src/lib/engines/serp.test.mjs:65`, `src/lib/engines/serp.test.mjs:72`, `src/lib/engines/serp.test.mjs:29`, `src/lib/engines/serp.test.mjs:246`
- [ ] **R6.5.5** serp.test.mjs env guard stops looking if a test is appended below it
- [x] **R6.5.6** gemini.js abort signal never reaches the SDK — closed at `src/lib/gemini.js:56`, `src/lib/gemini.js:55`, `src/lib/gemini.js:92`, `src/lib/geminiAbort.test.mjs:155`, `src/lib/geminiAbort.test.mjs:187`, `src/lib/geminiAbort.test.mjs:97`, `src/lib/geminiAbort.test.mjs:220`, `src/lib/geminiAbort.test.mjs:256`


# Rebuild roadmap — R0-R6

> Status: **LIVE**. Generated from `.claude/orchestration/tasks.json` by
> `node .claude/orchestration/orchestrate.mjs render`. Do not hand-edit —
> edits belong in the ledger, which the orchestration CLI is the only writer for.

Source: The Real-Surface Rebuild (artifact d5db8fa1), 29 Aug 2026
Companion: The Honesty Gap (artifact bbd113a7) — findings A1-C12, suggestions S1-S30
Baseline commit: `5111219`

**155 / 258 closed** · 9 blocked · legend: `[x]` done · `[~]` in flight · `[-]` blocked · `[ ]` open

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

## R0 — Ground zero  `32/35`

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
- [x] **R0.1.17** Nothing detects a NODE_ENV that lies — closed at `src/lib/operatorPerimeter.js:206`, `src/lib/operatorPerimeter.js:161`, `src/lib/operatorPerimeter.js:133`, `src/lib/cronAuth.js:76`, `src/lib/cronAuth.js:135`, `src/lib/cronAuth.js:153`, `src/lib/health.js:106`, `src/lib/health.js:124`, `src/lib/envTruth.test.mjs:44`, `src/lib/envTruth.test.mjs:132`, `src/lib/envTruth.test.mjs:167`, `src/lib/envTruth.test.mjs:215`, `src/lib/cronAuth.test.mjs:324`
- [x] **R0.1.18** Three footguns in the rate-limit trust knob — closed at `src/lib/rateLimit.test.mjs:327`, `src/lib/rateLimit.test.mjs:46`, `src/lib/rateLimit.test.mjs:456`, `src/lib/rateLimit.test.mjs:476`, `src/lib/rateLimit.js:196`, `src/lib/rateLimit.js:231`, `src/lib/rateLimit.js:240`, `src/lib/rateLimit.js:110`, `src/lib/rateLimit.js:145`, `.env.example:60`
- [x] **R0.1.19** The perimeter warn-once guard is evadable in one added line — closed at `src/lib/operatorPerimeter.middleware.test.mjs:131`, `src/lib/operatorPerimeter.test.mjs:454`
- [x] **R0.1.20** Nothing proves Vercel strips an inbound x-vercel-forwarded-for `needs-vercel` — closed at `src/lib/rateLimit.js:326`, `src/lib/rateLimit.js:121`, `src/lib/rateLimit.js:352`, `src/lib/rateLimit.js:458`, `src/lib/rateLimit.test.mjs:515`, `src/lib/rateLimit.test.mjs:535`, `src/lib/rateLimit.test.mjs:622`, `docs/decisions/2026-09-05-withhold-vercel-forwarded-for-trust.md:1`
- [x] **R0.1.21** POST /api/scan returns 201 off a job that only exists in memory `needs-decision` — closed at `src/app/api/scan/route.js:105`, `src/lib/scanRoute.unpersisted.route.test.mjs:122`, `docs/decisions/2026-09-05-unpersisted-scan-jobs.md:55`
- [x] **R0.1.22** The rate limiter warns and continues on a caller-settable client address when off Vercel — closed at `src/lib/rateLimit.js:187`, `src/lib/rateLimit.js:248`, `src/lib/rateLimit.js:257`, `src/lib/rateLimit.js:530`, `src/lib/rateLimit.js:677`, `src/lib/rateLimit.js:708`, `src/lib/rateLimit.js:718`, `src/lib/rateLimit.js:733`, `src/app/api/scan/route.js:84`, `src/lib/scanRateLimitUnverified.route.test.mjs:124`, `src/lib/rateLimit.test.mjs:750`, `src/lib/rateLimit.test.mjs:927`, `src/lib/rateLimit.test.mjs:1067`
- [x] **R0.1.23** .env.example still tells the operator the Vercel forwarded-for header is trusted — closed at `.env.example:95`, `docs/OPERATOR_LEDGER.md:276`, `src/lib/rateLimit.test.mjs:823`
- [x] **R0.1.24** The two ceiling-exempt trust bases are still an unbounded anonymous spend path — closed at `src/lib/rateLimit.js:342`, `src/lib/rateLimit.js:387`, `src/lib/rateLimit.js:354`, `src/lib/rateLimit.js:311`, `src/lib/rateLimit.js:681`, `src/lib/rateLimit.js:756`, `src/lib/rateLimit.js:846`, `src/lib/rateLimit.js:888`, `src/lib/rateLimit.test.mjs:1242`, `src/lib/rateLimit.test.mjs:1284`, `src/lib/rateLimit.test.mjs:1308`, `src/lib/rateLimit.test.mjs:1329`, `src/lib/scanRateLimitAttested.route.test.mjs:146`, `src/lib/scanRateLimitAttested.route.test.mjs:276`, `.env.example:148`, `docs/OPERATOR_LEDGER.md:295`
### R0.2

- [x] **R0.2.1** Create docs/BUILD_JOURNAL.md seeded with the 37 findings — closed at `docs/BUILD_JOURNAL.md:123`, `docs/BUILD_JOURNAL.md:124`, `docs/BUILD_JOURNAL.md:127`, `src/lib/scoring/enginePipeline.js:510`, `src/lib/scoring/enginePipeline.js:450`, `src/lib/scoring/enginePipeline.js:98`, `src/lib/workers/scanWorker.js:472`, `src/lib/workers/scanWorker.js:436`, `src/lib/db.js:11`, `src/lib/db.js:298`, `src/lib/db.js:62`, `src/app/api/scan/route.js:62`, `src/app/api/scan/worker/route.js:60`, `src/lib/buildJournal.test.mjs:62`
- [x] **R0.2.2** Tracker rule in force; status headers on all plans — closed at `docs/plans/2026-08-29-rebuild-roadmap.md:25`, `docs/plans/README.md:36`, `DESIGN.md:4`, `src/lib/docStatus.test.mjs:32`
- [x] **R0.2.3** Supersede the SerpAPI ADR with a dated Bright Data ADR — closed at `docs/decisions/2026-08-29-serp-provider-bright-data.md:12`, `docs/decisions/2026-08-29-serp-provider-bright-data.md:19`, `docs/decisions/2026-08-29-serp-provider-bright-data.md:675`, `docs/decisions/2026-08-29-serp-provider-bright-data.md:709`, `docs/decisions/2026-08-29-serp-provider-bright-data.md:746`, `docs/decisions/2026-08-29-serp-provider-bright-data.md:749`, `docs/decisions/2026-08-29-serp-provider-bright-data.md:773`, `docs/decisions/2026-08-29-serp-provider-bright-data.md:796`, `docs/decisions/serp-provider.md:31`, `docs/decisions/serp-provider.md:42`, `src/lib/engines/serp.js:342`, `src/lib/scoring/aioPipeline.js:110`, `src/lib/scoring/promptGen.js:185`, `src/lib/workers/scanWorker.js`, `src/lib/docStatus.test.mjs:130`
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

## R1 — Real-surface probe fleet  `18/38`

*2-3 weeks.* Bots drive perplexity.ai and chatgpt.com, extract the answers buyers actually see, capture screenshots as evidence, report typed outcomes.

### R1.1

- [x] **R1.1.1** Probe Result Contract v2 — closed at `docs/contracts/probe-result.md:15`, `docs/contracts/probe-result.md:74`, `docs/contracts/probe-result.md:304`, `docs/contracts/probe-result.md:647`, `docs/contracts/probe-result.md:694`, `docs/contracts/probe-result.md:952`, `docs/contracts/probe-result.md:981`, `docs/contracts/probe-result.md:1049`, `docs/contracts/probe-result.md:1106`, `docs/contracts/probe-result.md:1145`, `src/lib/scoring/enginePipeline.js:331`, `src/lib/scoring/enginePipeline.js:386`, `src/lib/scoring/enginePipeline.js:466`, `src/lib/scoring/enginePipeline.js:480`, `src/lib/scoring/enginePipeline.js:735`, `src/lib/scoring/enginePipeline.js:818`, `src/lib/scoring/enginePipeline.js:939`, `src/lib/workers/scanWorker.js:1227`, `src/lib/workers/scanWorker.js:1307`, `src/lib/workers/scanWorker.js:1769`, `src/lib/workers/scanWorker.js:2181`, `src/lib/db.js:123`, `src/lib/db.js:147`, `src/lib/content/weeklyReport.js:24`, `src/lib/llmPricing.js:79`, `src/lib/llmPricing.js:229`, `src/lib/llmPricing.js:335`, `src/lib/engines/deployedEngines.js:21`, `worker/src/lib/queue.js:207`, `worker/src/index.js:174`, `worker/src/index.js:211`
- [-] **R1.1.2** ADR + 2-day spike: browser infrastructure `needs-secrets` `needs-decision` — blocked: needs-secrets
- [-] **R1.1.3** ADR: worker host `needs-decision` — submitted `docs/decisions/2026-09-05-worker-host.md:430`, `docs/decisions/2026-09-05-worker-host.md:617`, `docs/decisions/2026-09-05-worker-host.md:325`, `docs/decisions/2026-09-05-worker-host.md:388`, `docs/decisions/2026-09-05-worker-host.md:628`, `src/lib/liveWriteGuard.js:126`, `worker/src/index.js:38`, `worker/src/index.js:270` — blocked: needs-decision
- [x] **R1.1.4** Engine surface matrix — closed at `docs/contracts/engine-surface-matrix.md:81`
- [x] **R1.1.5** Politeness & risk budget — closed at `worker/src/config.js:72`, `worker/src/config.js:206`, `worker/src/config.js:666`, `worker/src/config.js:764`, `docs/contracts/politeness-budget.md:579`, `docs/contracts/politeness-budget.md:656`, `src/lib/fleetConfig.test.mjs:521`, `worker/README.md:55`, `.env.example:192`
### R1.2

- [x] **R1.2.1** worker/ workspace: long-lived Node + Playwright — closed at `worker/package.json`, `worker/src/index.js`, `worker/src/config.js`, `worker/README.md`, `src/lib/workerIsolation.test.mjs`
- [x] **R1.2.2** probe_tasks queue table; fleet claims batches via jobLease — closed at `supabase/migrations/010_probe_tasks.sql:21`, `supabase/migrations/010_probe_tasks.sql:23`, `supabase/migrations/010_probe_tasks.sql:166`, `supabase/migrations/010_probe_tasks.sql:172`, `supabase/migrations/010_probe_tasks.sql:183`, `src/lib/probeTasksRace.test.mjs:275`, `src/lib/probeTasksRace.test.mjs:282`, `src/lib/probeTasksRace.test.mjs:124`, `src/lib/probeQueue.test.mjs:135`, `worker/src/lib/queue.js:172`, `src/lib/probeQueue.js:111`, `src/lib/liveDbGate.js:22`, `worker/src/index.js:40`, `scripts/setup-supabase.mjs:85`
- [x] **R1.2.3** Create the scan_runs ledger table — closed at `supabase/migrations/011_scan_runs.sql:78`, `scripts/setup-supabase.mjs:111`, `scripts/setup-supabase.mjs:493`, `src/lib/scanRunsLive.test.mjs:346`, `src/lib/scanRunsLive.test.mjs:44`, `worker/src/lib/probe.js:27`
- [x] **R1.2.4** Authenticated ingest POST /api/internal/probe-results — closed at `src/app/api/internal/probe-results/route.js:80`, `src/app/api/internal/probe-results/route.js:114`, `src/app/api/internal/_lib/ingestAuth.js:111`, `src/app/api/internal/_lib/ingestAuth.js:87`, `src/app/api/internal/_lib/probeResultContract.js:693`, `src/lib/probeResultsIngest.route.test.mjs:254`, `src/lib/probeResultsIngest.route.test.mjs:356`, `src/lib/probeResultsIngest.route.test.mjs:793`, `.env.example:68`
- [x] **R1.2.5** Dev runbook for the fleet — closed at `docs/runbooks/fleet-dev.md:1`, `docs/runbooks/fleet-dev.md:48`, `docs/runbooks/fleet-dev.md:124`, `worker/README.md:32`, `package.json:18`
- [x] **R1.2.6** Fleet config validated at boot — closed at `worker/src/config.js:62`, `worker/src/config.js:152`, `worker/src/config.js:187`, `worker/src/config.js:346`, `worker/src/config.js:45`, `worker/src/index.js:380`, `src/lib/fleetConfig.test.mjs:72`, `worker/README.md:59`
- [x] **R1.2.7** The Bright Data zone cache never invalidates — closed at `src/lib/engines/brightdata.js:81`, `src/lib/engines/brightdata.js:91`, `src/lib/engines/brightdata.js:116`, `src/lib/engines/brightdata.js:145`, `src/lib/engines/brightdata.js:291`, `src/lib/engines/brightdata.js:313`, `src/lib/engines/brightdata.js:398`, `src/lib/engines/brightdata.js:478`, `src/lib/engines/brightdataZone.test.mjs:101`, `src/lib/engines/brightdataZone.test.mjs:167`, `src/lib/engines/brightdataZone.test.mjs:249`
- [x] **R1.2.8** The six-way race tests pass with SKIP LOCKED removed — closed at `src/lib/probeClaimLock.test.mjs:207`, `src/lib/probeClaimLock.test.mjs:243`, `src/lib/probeClaimLock.test.mjs:263`, `src/lib/probeClaimLock.test.mjs:275`, `src/lib/probeTasksRace.test.mjs:154`, `src/lib/probeTasksRace.test.mjs:211`, `src/lib/probeTasksRace.test.mjs:244`, `src/lib/probeTasksRace.test.mjs:260`, `src/lib/probeQueue.test.mjs:459`
- [x] **R1.2.9** Two records describe the zone cache R1.2.7 just replaced — closed at `docs/vendors/brightdata.md:113`, `docs/vendors/brightdata.md:150`, `docs/vendors/brightdata.md:217`, `docs/vendors/brightdata.md:253`, `docs/vendors/brightdata.md:314`, `src/lib/engines/serp.js:5`, `src/lib/engines/serp.js:14`, `src/lib/engines/serp.js:286`, `src/lib/engines/serp.js:325`, `src/lib/engines/serp.js:352-354`, `src/lib/scoring/promptGen.js:129`, `src/lib/scoring/promptGen.js:212`, `src/lib/scoring/promptGen.js:222-224`, `src/lib/scoring/promptGen.js:266-268`, `src/lib/scoring/aioPipeline.js:99`, `src/lib/scoring/enginePipeline.js:101`, `src/lib/engines/brightdata.js:69`, `src/lib/engines/brightdata.js:145`, `src/lib/engines/brightdata.js:192`, `src/lib/checkSecretsBrightdataNoZone.test.mjs:21`, `src/lib/engines/brightdataZone.test.mjs:206`, `src/app/api/scan/route.js:62`, `src/app/api/scan/worker/route.js:138`
- [x] **R1.2.10** The Bright Data 200-envelope zone rejection has no test — closed at `src/lib/engines/brightdata.js:299`
- [x] **R1.2.11** The widened zone-rejection regex has no committed negative-case test — closed at `src/lib/engines/brightdataZone.test.mjs:819`, `src/lib/engines/brightdataZone.test.mjs:748`, `src/lib/engines/brightdataZone.test.mjs:968`, `src/lib/engines/brightdataZone.test.mjs:940`, `src/lib/engines/brightdataZone.test.mjs:892`, `src/lib/engines/brightdataZone.test.mjs:713`, `src/lib/engines/brightdata.js:291`
- [~] **R1.2.12** A laptop fleet worker inherits production credentials and the write guard cannot see it — submitted `worker/src/config.js:586`, `worker/src/config.js:594-606`, `worker/src/config.js:515-518`, `src/lib/fleetConfig.test.mjs:633`, `src/lib/fleetConfig.test.mjs:700`
- [x] **R1.2.13** The SKIP LOCKED static guard matches prose comments, so the migration documentation certifies itself — closed at `src/lib/probeQueue.test.mjs:463`, `src/lib/probeQueue.test.mjs:494`, `src/lib/probeQueue.test.mjs:505`, `src/lib/probeClaimLock.guard.mjs:134`, `src/lib/probeClaimLock.guard.mjs:172`, `src/lib/probeClaimLock.test.mjs:110`
- [x] **R1.2.15** The probe-claim guard CTE scoping has no fixture pinning it, so a refactor could retire it silently — closed at `src/lib/probeClaimLock.test.mjs:403`, `src/lib/probeClaimLock.test.mjs:430`, `src/lib/probeClaimLock.test.mjs:509`, `src/lib/probeClaimLock.test.mjs:525`, `src/lib/probeClaimLock.test.mjs:550`, `src/lib/probeClaimLock.test.mjs:574`, `src/lib/probeClaimLock.test.mjs:592`, `src/lib/probeClaimLock.test.mjs:623`, `src/lib/probeClaimLock.guard.mjs:650`, `src/lib/probeClaimLock.guard.mjs:755`, `src/lib/probeClaimLock.guard.mjs:775`, `src/lib/fixtures/probeClaimLock/base-as-in-migration-010.sql.txt:4`, `src/lib/fixtures/probeClaimLock/lock-parked-in-the-claimed-cte.sql.txt:4`, `src/lib/fixtures/probeClaimLock/scope-widened-any-live-lease-claimable.sql.txt:4`, `src/lib/fixtures/probeClaimLock/scope-narrowed-to-pending-only.sql.txt:4`, `src/lib/fixtures/probeClaimLock/candidate-select-unordered.sql.txt:4`, `src/lib/fixtures/probeClaimLock/lock-downgraded-to-bare-for-update.sql.txt:4`
- [x] **R1.2.16** The zone-corpus negative test passes vacuously on an empty corpus, and the submit note miscounts it — closed at `src/lib/engines/brightdataZone.test.mjs:66`, `src/lib/engines/brightdataZone.test.mjs:116`, `src/lib/engines/brightdataZone.test.mjs:634`, `src/lib/engines/brightdataZone.test.mjs:652`, `src/lib/engines/brightdataZone.test.mjs:700`, `src/lib/engines/brightdataZone.test.mjs:956`, `src/lib/engines/brightdataZone.test.mjs:1043`, `src/lib/engines/brightdataZone.test.mjs:1068`, `src/lib/engines/brightdataZone.test.mjs:1138`, `src/lib/engines/brightdataZone.test.mjs:1166`
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

- [-] **R1.5.1** Storage bucket probe-evidence `needs-secrets` — blocked: needs-secrets
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

## R2 — Scoring truth  `46/67`

*1 week.* Four-state vocabulary, roster feeding the headline, de-fake sweep, provenance on every number.

### R2.1

- [x] **R2.1.1** Per-engine summaries emit state + state_reason — closed at `src/lib/scoring/enginePipeline.js:541`, `src/lib/scoring/enginePipeline.js:493`, `src/lib/scoring/enginePipeline.js:1523`, `src/components/perceev/Sidebar.jsx:168`, `src/components/dashboard/DashboardShell.jsx:61`, `src/components/dashboard/DashboardShell.jsx:96`, `src/components/dashboard/DashboardShell.jsx:340`, `src/components/dashboard/DashboardShell.jsx:1085`, `src/components/dashboard/DashboardShell.jsx:1171`, `src/components/dashboard/historyScoreSurface.test.mjs:504`, `src/components/dashboard/historyScoreSurface.test.mjs:697`
- [x] **R2.1.2** Delete every ?? 0 null-coalescing metric in the normalize layer — closed at `src/utils/format.js:32`, `src/components/dashboard/DashboardShell.jsx:605`, `src/components/dashboard/DashboardShell.jsx:680`, `src/components/dashboard/heroVerdictNullScore.test.mjs:419`, `src/components/dashboard/heroVerdictNullScore.test.mjs:471`, `src/components/dashboard/heroVerdictNullScore.test.mjs:494`, `src/components/dashboard/heroVerdictNullScore.test.mjs:507`, `src/components/dashboard/heroVerdictNullScore.test.mjs:520`, `src/components/dashboard/heroVerdictNullScore.test.mjs:537`, `src/components/dashboard/heroVerdictNullScore.test.mjs:569`, `src/components/dashboard/heroVerdictNullScore.test.mjs:579`
- [x] **R2.1.3** UI chips for did-not-report / not-assessed / small-sample; render engines_counted — closed at `src/lib/scoring/enginePipeline.js:518-554`, `src/components/dashboard/ScoreBand.jsx:47-59`, `src/components/dashboard/ScoreBand.jsx:157-165`, `src/components/dashboard/DashboardShell.jsx:592-629`, `src/components/dashboard/DashboardShell.jsx:817-854`, `src/components/dashboard/DashboardShell.jsx:1292`, `src/components/dashboard/dashboardChipsAndEnginesCounted.test.mjs:1-418`
- [ ] **R2.1.4** Tests: a fully-errored engine renders failed and contributes nothing
- [x] **R2.1.5** A legacy zero row is labelled Measured zero with a detail asserting a measurement that never happened — closed at `src/lib/scoring/enginePipeline.js:626`, `src/lib/scoring/enginePipeline.js:567`, `src/lib/scoring/enginePipeline.js:541`, `src/lib/scoring/enginePipeline.js:518`, `src/components/dashboard/historyScoreSurface.test.mjs:899`, `src/components/dashboard/historyScoreSurface.test.mjs:922`, `src/components/dashboard/historyScoreSurface.test.mjs:954`, `src/components/dashboard/historyScoreSurface.test.mjs:1010`
### R2.2

- [x] **R2.2.1** answer_present set only after the text check — closed at `src/lib/scoring/enginePipeline.js:177`, `src/lib/scoring/enginePipeline.js:180`, `src/lib/scoring/emptyAnswer.test.mjs`
- [x] **R2.2.2** Perplexity citation-leg failure marks citations_state unverified — closed at `src/lib/scoring/enginePipeline.js:227`, `src/lib/scoring/enginePipeline.js:573`, `src/lib/scoring/enginePipeline.js:732`, `src/lib/scoring/enginePipeline.js:1353`, `src/lib/analytics/rollup.js:270`, `src/lib/analytics/rollup.js:328`, `src/lib/analytics/rollup.js:417`, `src/lib/scoring/citationDenominator.test.mjs:137`, `src/lib/scoring/citationDenominator.test.mjs:173`, `src/lib/scoring/citationDenominator.test.mjs:276`, `src/lib/engines/perplexity.js:61`
- [x] **R2.2.3** upsertPrompts throws; audit all write helpers for the return-{error} idiom — closed at `src/lib/db/prompts.js:18`, `src/lib/db/prompts.js:140`, `src/lib/db/prompts.js:158`, `src/lib/db/prompts.js:204`, `src/lib/db/prompts.js:208`, `src/lib/db/prompts.js:230`, `src/lib/db/prompts.js:237`, `src/lib/db/prompts.js:251`, `src/lib/db/promptWriteFailure.test.mjs:126`, `src/lib/db/promptWriteFailure.test.mjs:193`, `src/lib/db/promptWriteFailure.test.mjs:280`, `src/lib/db/promptWriteRoute.route.test.mjs:99`
- [x] **R2.2.4** Remove insertScan's silent 3-tier column-drop cascade — closed at `src/lib/db.js:264`, `src/lib/db.js:300`, `src/lib/db.js:320`, `src/lib/insertScanCascade3.test.mjs:624`, `src/lib/insertScanCascade3.test.mjs:721`, `src/lib/insertScanWriteFailure.test.mjs:155`, `src/lib/collectionWindowPersist.test.mjs:185`
- [x] **R2.2.5** dataSourceIssue still assumes text engines always answer — closed at `src/lib/scoring/enginePipeline.js:35`, `src/lib/scoring/enginePipeline.js:416`, `src/lib/scoring/enginePipeline.js:441`, `src/lib/scoring/enginePipeline.test.mjs:507`, `src/lib/scoring/aioConstants.js:4`
- [x] **R2.2.6** The scan-level data_source_issue banner is derived from aio alone — closed at `src/lib/scoring/enginePipeline.js:606`, `src/lib/scoring/enginePipeline.js:910`, `src/lib/scoring/enginePipeline.js:56`, `src/components/dashboard/DashboardShell.jsx:369`, `src/components/dashboard/DashboardShell.jsx:383`, `src/components/dashboard/DashboardShell.jsx:704`, `src/components/dashboard/DashboardShell.jsx:823`, `src/lib/scoring/enginePipeline.test.mjs:637`, `src/components/dashboard/degradedEngineBanner.test.mjs:54`
- [x] **R2.2.7** The degraded-banner guard proves a declaration, not a gate — closed at `src/components/dashboard/degradedEngineBanner.test.mjs:28`, `src/components/dashboard/degradedEngineBanner.test.mjs:151`, `src/components/dashboard/degradedEngineBanner.test.mjs:420`, `src/components/dashboard/degradedEngineBanner.test.mjs:542`, `src/components/dashboard/degradedEngineBanner.test.mjs:602`
- [x] **R2.2.8** promptGen swallows a PAA failure with no log at all — closed at `src/lib/engines/serp.js:365`, `src/lib/engines/serp.js:406`, `src/lib/scoring/promptGen.js:42`, `src/lib/scoring/promptGen.js:330`, `src/lib/scoring/promptGen.js:423`, `src/lib/scoring/promptGen.js:428`, `src/lib/scoring/promptGen.js:501`, `src/lib/scoring/promptGen.js:508`, `src/lib/scoring/promptGen.js:561`, `src/lib/scoring/promptGen.js:576`, `src/lib/scoring/promptGenSeedProvenance.test.mjs:1`
- [x] **R2.2.9** probeTextEngine drops measured citations when the answer leg fails - the mirror of R2.2.2 — closed at `src/lib/scoring/enginePipeline.js:238-263`, `src/lib/scoring/citationDenominator.test.mjs:278-302`, `src/lib/scoring/answerFailsCitationsPreserved.test.mjs:106-140`, `docs/contracts/engine-surface-matrix.md:182`
- [x] **R2.2.10** The perplexity retry guard is dead code, so a 401 costs three calls and three seconds — closed at `src/lib/engines/perplexity.js:53`, `src/lib/engines/perplexity.js:70`, `src/lib/engines/perplexity.js:208`, `src/lib/engines/perplexity.js:218`, `src/lib/engines/perplexity.js:230`, `src/lib/engines/perplexity.js:271`, `src/lib/engines/perplexity.js:130`, `src/lib/engines/perplexity.js:364`, `src/lib/engines/perplexity.test.mjs:395`, `src/lib/engines/perplexity.test.mjs:427`, `src/lib/engines/perplexity.test.mjs:441`, `src/lib/engines/perplexity.test.mjs:459`
- [x] **R2.2.11** The legacy scan-level mirror emits citation_share_pct 0 on an empty denominator instead of null — closed at `src/components/dashboard/SourcesView.jsx:50`, `src/components/dashboard/SourcesView.jsx:196`, `src/services/api.js:508`, `src/lib/scoring/enginePipeline.js:1577`, `src/lib/scoring/enginePipeline.js:1613`, `src/lib/analytics/rollup.js:347`, `src/components/dashboard/sourcesCitationShareSurface.test.mjs:287`, `src/components/dashboard/sourcesCitationShareSurface.test.mjs:339`, `src/components/dashboard/sourcesCitationShareSurface.test.mjs:381`
- [x] **R2.2.12** The prompt-seeding verdict never leaves the process, and the zone abort also discards the autocomplete leg — closed at `src/lib/scoring/promptGen.js:458`, `src/lib/scoring/promptGen.js:523`, `src/lib/scoring/promptGen.js:561`, `src/lib/scoring/promptGen.js:354`, `src/lib/workers/scanWorker.js:250`, `src/lib/workers/scanWorker.js:1344`, `src/lib/workers/scanWorker.js:1446`, `src/lib/workers/scanWorker.js:1667`, `src/lib/workers/promptSeedingRecord.test.mjs:117`, `src/lib/workers/promptSeedingRecord.test.mjs:152`, `src/lib/workers/promptSeedingRecord.test.mjs:298`, `src/lib/workers/promptSeedingRecord.test.mjs:408`, `src/lib/workers/promptSeedingRecord.test.mjs:512`, `src/lib/scoring/promptGenSeedProvenance.test.mjs:131`, `src/lib/workers/scanChunk.test.mjs:534`
- [x] **R2.2.13** openai.js carries the identical dead retry guard, so a 401 there still costs three calls — closed at `src/lib/engines/openai.js:299`, `src/lib/engines/openai.js:200`, `src/lib/engines/httpFailureKind.js:52`, `src/lib/engines/perplexity.js:133`, `src/lib/engines/openai.test.mjs:466`, `src/lib/engines/openai.test.mjs:550`
- [~] **R2.2.14** REGRESSION: the R2.2.9 citation-preservation fix is absent from source while its tests remain — submitted `src/lib/scoring/enginePipeline.js:241`, `src/lib/scoring/enginePipeline.js:255`, `src/lib/scoring/enginePipeline.js:256`, `src/lib/scoring/enginePipeline.js:264`, `src/lib/scoring/enginePipeline.js:269`, `src/lib/scoring/enginePipeline.js:272`, `src/lib/scoring/enginePipeline.js:316`
### R2.3

- [x] **R2.3.1** Two-pass finalize: discovered roster feeds the headline — closed at `src/lib/workers/scanWorker.js:757`, `src/lib/workers/scanWorker.js:781`, `src/lib/workers/scanWorker.js:798`, `src/lib/workers/twoPassFinalize.test.mjs`
- [x] **R2.3.2** Tests: an empty-competitors scan gets the gate, SOV and top rivals — closed at `src/lib/scoring/emptyCompetitorsScan.test.mjs:161`, `src/lib/scoring/emptyCompetitorsScan.test.mjs:204`, `src/lib/scoring/emptyCompetitorsScan.test.mjs:217`
- [x] **R2.3.3** Persist the roster to scans.competitors with roster_source provenance — closed at `src/lib/db.js:165`, `src/lib/db/scanRow.js:33`, `src/lib/scoring/rosterContinuity.js:25`, `src/lib/scoring/rosterContinuity.js:78`, `src/lib/workers/scanWorker.js:1890`, `src/lib/db/rosterProvenancePersist.test.mjs:37`
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
- [~] **R2.7.5** share_of_voice_pct exists only per engine; the scan-level field is never written
- [x] **R2.7.6** ScoreBreakdown prints a confident 0% for a share of voice nobody computed — closed at `src/components/dashboard/ScoreBreakdown.jsx:86`, `src/components/perceev/charts/shareOfVoice.js:298`, `src/components/dashboard/scoreBreakdownShare.test.mjs:176`
- [x] **R2.7.7** The demo data does not carry the fields a real scan carries, so the sample report reads as broken — closed at `src/data/mockData.js:202-227`, `src/data/mockData.js:336-372`, `src/data/mockData.js:416-421`, `src/data/mockDataShapeContract.test.mjs:42`, `src/data/mockDataShapeContract.test.mjs:67`, `src/data/mockDataShapeContract.test.mjs:93`, `src/data/mockDataShapeContract.test.mjs:110`
- [x] **R2.7.8** ScoreBand hardcodes a percent sign, so no engine chip can carry a non-numeric state — closed at `src/components/dashboard/ScoreBand.jsx:42`, `src/components/dashboard/ScoreBand.jsx:104`, `src/components/dashboard/DashboardShell.jsx:441`, `src/components/dashboard/DashboardShell.jsx:465`, `src/components/dashboard/DashboardShell.jsx:482`, `src/components/dashboard/scoreBandEngineChips.test.mjs:430`
- [x] **R2.7.9** EngineRail renders a metric as 0 when there is nothing behind it — closed at `src/components/landing/EngineRail.jsx:61`, `src/components/landing/EngineRail.jsx:106`, `src/components/landing/EngineRail.jsx:114`, `src/components/landing/EngineRail.jsx:127`, `src/lib/landingProbeCounter.test.mjs:234`, `src/lib/landingProbeCounter.test.mjs:293`, `src/lib/landingProbeCounter.test.mjs:473`, `src/components/landing/engineRailAbsentTotal.test.mjs:128`, `src/components/landing/engineRailAbsentTotal.test.mjs:163`
- [x] **R2.7.10** ScoreBreakdown is imported by nothing, so the honesty fixes in it reach no user — closed at `src/components/dashboard/routeReachability.test.mjs:187`, `src/components/dashboard/routeReachability.test.mjs:351`, `src/components/dashboard/routeReachability.test.mjs:431`, `src/components/dashboard/routeReachability.test.mjs:533`, `src/components/dashboard/routeReachability.test.mjs:571`, `src/components/dashboard/routeReachability.test.mjs:634`
- [x] **R2.7.11** The landing page fabricates the per-engine total one layer above the rail that was just fixed — closed at `src/app/page.js:122-136`, `src/app/page.js:250`, `src/lib/landingProbeCounter.test.mjs:237-245`, `src/lib/landingProbeCounter.test.mjs:695-771`
- [x] **R2.7.12** OverviewView renders a confident 0 for competitors nobody counted, on a route-reachable surface — closed at `src/components/dashboard/OverviewView.jsx:58`, `src/components/dashboard/OverviewView.jsx:130`, `src/components/dashboard/OverviewView.jsx:177`, `src/components/dashboard/OverviewView.jsx:135`, `src/components/dashboard/DashboardShell.jsx:905`, `src/components/dashboard/DashboardShell.jsx:914`, `src/components/dashboard/overviewCompetitorCountSurface.test.mjs:299`, `src/components/dashboard/overviewCompetitorCountSurface.test.mjs:348`
- [x] **R2.7.13** The degraded banner prints nullish-to-0 metrics beside its own refusal to trust the measurement — closed at `src/components/dashboard/DashboardShell.jsx:893`, `src/components/dashboard/DashboardShell.jsx:904`, `src/components/dashboard/DashboardShell.jsx:927`, `src/components/dashboard/DashboardShell.jsx:936`, `src/components/dashboard/DashboardShell.jsx:1198`, `src/components/dashboard/ScoreBand.jsx:190`, `src/components/home/HomeDashboard.jsx:39`, `src/components/dashboard/degradedBannerNullMetrics.test.mjs:175`, `src/components/dashboard/degradedBannerNullMetrics.test.mjs:219`
- [~] **R2.7.16** REGRESSION: one per-engine degraded-banner row still coerces an unmeasured metric to 0% — submitted `src/lib/scoring/enginePipeline.js:1348`, `src/lib/scoring/enginePipeline.js:1369`, `src/lib/scoring/enginePipeline.js:1395`, `src/lib/scoring/enginePipeline.js:1367`, `src/components/dashboard/DashboardShell.jsx:1004`
### R2.8

- [ ] **R2.8.1** Gate Studio and Opportunities on data quality
- [ ] **R2.8.2** Engine gauges: a zero-row engine says 'no data'
- [x] **R2.8.3** Unknown status renders 'reconnecting', never rewinds to 0 percent — closed at `src/lib/scanProgress.js:50`, `src/lib/scanProgress.js:74`, `src/lib/scanProgress.js:92`, `src/app/scan/page.js:134`, `src/app/scan/page.js:341`, `src/services/api.js:805`, `src/app/api/scan/[job_id]/status/route.js:37`, `src/lib/scanProgress.test.mjs:40`, `src/lib/scanStatusTransient.route.test.mjs:99`
- [x] **R2.8.4** DB-down state distinct from 'no scans yet' — closed at `src/lib/db.js:241`, `src/lib/db.js:255`, `src/lib/db.js:204`, `src/app/api/scans/[brand]/latest/route.js:27`, `src/lib/latestScanRoute.route.test.mjs:209`, `src/lib/latestScanRoute.route.test.mjs:245`, `src/app/api/content/worker/route.js:141`, `src/lib/content/dailyBatch.js:70`, `src/lib/content/weeklyReport.js:109`, `src/lib/content/contentWorker.js:226`
- [x] **R2.8.5** The remaining fail-quiet DB reads, same class as R2.8.4 — closed at `src/lib/db.js:489`, `src/app/api/scans/_lib/scanRow.js:36`, `src/app/api/content/worker/route.js:98`, `src/app/api/content/worker/route.js:126`, `src/app/api/content/worker/route.js:209`, `src/app/api/content/worker/route.js:238`, `src/lib/workers/scanWorker.js:1813`, `src/lib/dbReadOutage.route.test.mjs:170`, `src/lib/dbReadOutage.route.test.mjs:312`, `src/lib/dbReadOutage.route.test.mjs:422`, `src/lib/scanByIdUnconfigured.route.test.mjs:103`
- [x] **R2.8.6** insertScan fail-softs on a missing client and returns undefined — closed at `src/lib/db.js:120`, `src/lib/db.js:122`, `src/lib/db.js:126`, `src/lib/db.js:75`, `src/lib/db.js:255`, `src/lib/db.js:263`, `src/lib/insertScanWriteFailure.test.mjs:67`, `src/lib/insertScanWriteFailure.test.mjs:124`, `src/lib/insertScanWriteFailure.test.mjs:166`
- [x] **R2.8.7** insertScan cascade 3 writes the row and reports failure, so a re-finalize inserts a duplicate — closed at `src/lib/db.js:268`, `src/lib/db.js:270`, `src/lib/db.js:275`, `src/lib/db.js:314`, `src/lib/insertScanCascade3.test.mjs:243`, `src/lib/insertScanCascade3.test.mjs:473`, `src/lib/insertScanCascade3.test.mjs:524`
- [~] **R2.8.8** The content event and lease writers take no deps and swallow their own errors — submitted `src/lib/db.js:911`, `src/lib/db.js:930`
- [x] **R2.8.9** insertScan cascades 1 and 2 can retry an already-written row into a duplicate — closed at `src/lib/db.js:264`, `src/lib/insertScanCascade3.test.mjs:339`
- [~] **R2.8.10** runFinalizePhase flattens the write-error code into prose, so an operator cannot branch on it — submitted `src/lib/workers/scanWorker.js:2164`, `src/lib/insertScanWriteFailure.test.mjs:294`
- [x] **R2.8.12** getScansByDomain fabricates never-scanned from a missing client — closed at `src/lib/db.js:477`, `src/lib/db.js:481`, `src/lib/db.js:491`, `src/lib/scansByDomainUnconfigured.test.mjs:81`, `src/lib/scansByDomainUnconfigured.test.mjs:117`, `src/lib/scansByDomainUnconfigured.test.mjs:140`, `src/lib/scansByDomainUnconfigured.test.mjs:158`, `src/lib/scansByDomainUnconfigured.test.mjs:197`
- [~] **R2.8.13** Four more fail-quiet reads, including the other half of the endpoint R2.8.5 just fixed — submitted `src/lib/db/content.js:6`
- [~] **R2.8.14** The content cron returns HTTP 200 with processed:0 when supabase is unset — submitted `src/app/api/content/worker/route.js:187`
- [x] **R2.8.15** A false history comment in the R2.8.12 guard, plus the last two fail-quiet reads in db.js — closed at `src/lib/coverageUnconfigured.route.test.mjs:12`, `src/lib/coverageUnconfigured.route.test.mjs:118`, `src/lib/coverageUnconfigured.route.test.mjs:123`, `src/lib/scansByDomainUnconfigured.test.mjs:21`, `src/lib/scansByDomainUnconfigured.test.mjs:36`, `src/lib/scansByDomainUnconfigured.test.mjs:280`, `src/lib/scansByDomainUnconfigured.test.mjs:384`, `src/lib/db.js:513`, `src/lib/db.js:585`
- [x] **R2.8.16** The last fail-quiet read in db.js, and the history route that turns any refusal into a 200 empty workspace — closed at `src/lib/db.js:608`, `src/lib/db.js:612`, `src/app/api/history/route.js:74`, `src/app/api/history/route.js:67`, `src/lib/historyStoreState.js:48`, `src/lib/historyStoreState.js:77`, `src/components/home/HomeDashboard.jsx:143`, `src/lib/historyStoreRefusal.route.test.mjs:255`, `src/lib/historyStoreRefusal.route.test.mjs:372`, `src/lib/historyUnconfigured.route.test.mjs:97`
- [x] **R2.8.17** insertScanCascade3.test.mjs breaks in fresh git worktrees due to relative postgrest-js path — closed at `src/lib/insertScanCascade3.test.mjs:69`
### R2.9

- [ ] **R2.9.1** Provenance strip under the hero
- [ ] **R2.9.6** probeTextEngine drops every cost_state field and coerces a deliberate null cost to a measured $0
- [ ] **R2.9.7** SWEEP: bare Number() and || 0 on nullable metric fields across the scoring layer
### R2.10

- [x] **R2.10.1** De-fake the landing page — closed at `src/data/mockData.js:51`, `src/data/mockData.js:106`, `src/data/mockData.js:123`, `src/app/page.js:70`, `src/app/page.js:80`, `src/app/scan/page.js:50`, `src/lib/landingHonesty.test.mjs:111`, `src/lib/landingHonesty.test.mjs:291`, `scripts/check-secrets.mjs:320`, `src/lib/engines/deployedEngines.js:75`
- [x] **R2.10.2** Probe counter backed by a real count query — closed at `src/lib/landingProbeCounter.test.mjs:155`, `src/lib/landingProbeCounter.test.mjs:205`, `src/lib/landingProbeCounter.test.mjs:238`, `src/lib/landingProbeCounter.test.mjs:473`, `src/lib/landingProbeCounter.test.mjs:506`, `src/lib/landingProbeCounter.test.mjs:368`, `src/lib/landingProbeCounter.test.mjs:415`, `src/lib/landingProbeCounter.test.mjs:39`, `src/lib/landingProbeCounter.test.mjs:87`, `src/app/page.js:55`
- [~] **R2.10.4** ENGINE_REGISTRY says aio is always configured — submitted `src/lib/scoring/enginePipeline.js:1367`, `src/lib/scoring/enginePipeline.js:1468`, `src/lib/scoring/enginePipeline.test.mjs:312`, `src/lib/scoring/enginePipeline.test.mjs:325`, `src/lib/scoring/enginePipeline.test.mjs:337`, `src/lib/scoring/enginePipeline.test.mjs:348`, `src/lib/scoring/enginePipeline.test.mjs:361`
- [x] **R2.10.5** The hero sample card hardcodes a Perplexity chip — closed at `src/components/landing/AnswerSheet.jsx:72`, `src/components/landing/AnswerSheet.jsx:22`, `src/lib/engines/deployedEngines.js:107`, `src/lib/landingHonesty.test.mjs:57`, `src/lib/landingHonesty.test.mjs:348`
- [x] **R2.10.6** A second hardcoded engine chip survives at page.js:295 — closed at `src/lib/landingHonesty.test.mjs:99`, `src/lib/landingHonesty.test.mjs:107`, `src/lib/landingHonesty.test.mjs:145`, `src/lib/landingHonesty.test.mjs:179`, `src/lib/landingHonesty.test.mjs:189`, `src/lib/landingHonesty.test.mjs:214`, `src/lib/landingHonesty.test.mjs:225`, `src/lib/landingHonesty.test.mjs:235`, `src/lib/landingHonesty.test.mjs:245`, `src/lib/landingHonesty.test.mjs:305`, `src/lib/landingHonesty.test.mjs:710`, `src/app/page.js:76`, `src/app/page.js:308`
- [ ] **R2.10.7** The landing-copy guard is blind to two apostrophes on one line

## R3 — Durable backend  `28/46`

*1 week.* Real cadence, a reaper, a run ledger, a scheduler that reconciles, spend that cannot silently read $0.

### R3.1

- [ ] **R3.1.1** Scan worker cron every 10 minutes `needs-vercel`
- [ ] **R3.1.2** Add the missing ?batch=1 cron entry `needs-vercel` `needs-llm`
- [x] **R3.1.3** The scan worker route reports processed:1 for a request that failed — closed at `src/app/api/scan/worker/route.js:79`, `src/app/api/scan/worker/route.js:104`, `src/app/api/scan/worker/route.js:138`, `src/app/api/scan/worker/route.js:160`, `src/app/api/scan/worker/route.js:187`, `src/app/api/scan/worker/route.js:249`, `src/lib/scanWorkerRoute.route.test.mjs:101`, `src/lib/scanWorkerRoute.route.test.mjs:119`, `src/lib/scanWorkerRoute.route.test.mjs:203`
- [~] **R3.1.4** The content worker sweep counts dispatched as done, and an in-memory scan leaves no ledger row — submitted `src/app/api/content/worker/route.js:137-157`
- [ ] **R3.1.5** The post-response scan trigger has no keepalive, and three compensations hide it `needs-vercel`
### R3.2

- [x] **R3.2.1** One scan_runs row per chunk execution — closed at `src/lib/workers/scanWorker.js:1540`, `src/lib/workers/scanWorker.js:1555`, `src/lib/workers/scanWorker.js:321`, `src/lib/workers/scanWorker.js:854`, `src/lib/workers/scanWorker.js:203`, `src/lib/workers/scanWorker.js:270`, `src/lib/workers/scanChunkLedger.test.mjs:327`, `src/lib/workers/scanChunkLedgerLive.test.mjs:176`
- [x] **R3.2.2** Every discarded skip reason becomes a ledger row — closed at `src/lib/scoring/enginePipeline.js:829`, `src/lib/scoring/enginePipeline.js:834`, `src/lib/scoring/enginePipeline.js:846`, `src/lib/scoring/enginePipeline.js:796`, `src/lib/workers/scanWorker.js:283`, `src/lib/workers/scanWorker.js:211`, `src/lib/workers/scanWorker.js:1142`, `src/lib/workers/scanWorker.js:2230`, `src/lib/workers/scanChunkLedger.test.mjs:1409`, `src/lib/workers/scanChunkLedger.test.mjs:1493`, `src/lib/workers/scanChunkLedger.test.mjs:1940`, `src/lib/workers/scanChunkLedger.test.mjs:1089`, `src/lib/scoring/enginePipeline.test.mjs:241`
- [x] **R3.2.3** Status route and dashboard read run history — closed at `src/app/api/scan/[job_id]/status/route.js:178`, `src/app/api/scan/[job_id]/status/route.js:226`, `src/app/api/scan/[job_id]/status/route.js:240`, `src/app/api/scan/[job_id]/status/route.js:317`, `src/app/api/scan/[job_id]/status/route.js:330`, `src/app/api/scan/[job_id]/status/route.js:544`, `src/app/api/scan/[job_id]/status/route.js:567`, `src/lib/scanStatusRunHistory.route.test.mjs:468`, `src/lib/scanStatusRunHistory.route.test.mjs:615`, `src/lib/scanStatusRunHistory.route.test.mjs:683`, `src/lib/scanStatusRunHistory.route.test.mjs:704`, `src/lib/scanStatusRunHistory.route.test.mjs:729`, `src/lib/scanStatusRunHistory.route.test.mjs:760`, `src/lib/scanStatusRunHistory.route.test.mjs:1140`
- [x] **R3.2.4** A live test wrote to production because only its reads were stubbed — closed at `src/lib/liveDbGate.js:141`, `src/lib/liveDbGate.js:90`, `src/lib/liveDbGate.js:53`, `src/lib/liveWriteGuard.js:370`, `src/lib/liveWriteGuard.test.mjs:488`, `src/lib/liveWriteGuard.test.mjs:451`, `src/lib/liveWriteGuard.test.mjs:571`, `src/lib/liveWriteGuard.test.mjs:605`, `src/lib/liveWriteGuard.test.mjs:413`, `src/lib/scanRuns.test.mjs:669`, `package.json:12`, `src/lib/scanRunsLive.test.mjs:50`, `src/lib/probeTasksRace.test.mjs:41`, `src/lib/workers/scanChunkLedgerLive.test.mjs:52`, `src/lib/liveWriteGuardAuto.mjs:64`
- [x] **R3.2.5** A frozen engine that stops resolving silently shrinks the headline — closed at `src/services/api.js:598`, `src/components/dashboard/DashboardShell.jsx:394`, `src/components/dashboard/DashboardShell.jsx:802`, `src/components/dashboard/DashboardShell.jsx:812`, `src/components/dashboard/engineSetChangeSurface.test.mjs:136`, `src/components/dashboard/engineSetChangeSurface.test.mjs:361`, `src/components/dashboard/engineSetChangeSurface.test.mjs:394`, `src/components/dashboard/engineSetChangeSurface.test.mjs:322`
- [x] **R3.2.6** The cron reports a scheduler tick that declined every brand as a clean empty tick — closed at `src/app/api/scan/worker/route.js:390`, `src/app/api/scan/worker/route.js:179`, `src/app/api/scan/worker/route.js:257`, `src/app/api/scan/worker/route.js:236`, `src/lib/scanWorkerRoute.route.test.mjs:356`, `src/lib/scanWorkerRoute.route.test.mjs:496`
- [ ] **R3.2.7** The live write guard cannot force its own adoption
- [ ] **R3.2.9** On a refrozen scan, finalize summarizes engines that produced nothing and ignores the rows that exist
- [x] **R3.2.10** A live test can spread process.env into the gate and bypass the write guard — closed at `src/lib/liveDbGate.js:87`, `src/lib/liveDbGate.js:107`, `src/lib/liveWriteGuard.test.mjs:522`, `src/lib/liveWriteGuard.test.mjs:531`, `src/lib/liveWriteGuard.test.mjs:696`, `src/lib/liveWriteGuard.js:81`
### R3.3

- [x] **R3.3.1** attempts column with a cap of 3 — closed at `supabase/migrations/012_scan_job_attempts.sql:81`, `src/lib/workers/scanWorker.js:2086`, `src/lib/workers/scanJobAttempts.test.mjs:279`
- [x] **R3.3.2** Sweep reaps heartbeat-stale runs — closed at `src/lib/workers/scanWorker.js:2878`, `src/lib/workers/scanWorker.js:3040`, `src/lib/workers/scanWorker.js:3177`, `src/lib/workers/scanWorker.js:2783`, `src/lib/workers/scanRunReaper.test.mjs:317`, `src/lib/workers/scanRunReaper.test.mjs:436`
- [x] **R3.3.3** Content cost accumulates across rescues — closed at `src/lib/content/contentWorker.js:201`, `src/lib/content/contentWorker.js:248`, `src/lib/content/contentWorker.js:269`, `src/lib/content/contentWorker.js:494`, `src/lib/content/contentWorker.test.mjs:730`, `src/lib/content/contentWorker.test.mjs:773`, `src/lib/content/contentWorker.test.mjs:797`, `src/lib/content/contentWorker.test.mjs:826`
- [x] **R3.3.4** Wire the stale-run reaper into the cron sweep; nothing calls it yet — closed at `src/app/api/scan/worker/route.js:560`, `src/app/api/scan/worker/route.js:427`, `src/app/api/scan/worker/route.js:312`, `src/lib/scanRuns.js:83`, `src/lib/scanRuns.js:356`, `src/lib/workers/scanWorker.js:3165`, `src/lib/workers/scanWorker.js:3136`, `src/lib/workers/scanRunReaper.test.mjs:809`, `src/lib/scanWorkerRoute.route.test.mjs:656`, `src/lib/scanWorkerRoute.route.test.mjs:620`, `worker/src/lib/runLedger.js:70`
- [ ] **R3.3.5** The reaper idempotence rests on plpgsql behaviour proven only by a fake that re-implements it `needs-secrets`
- [ ] **R3.3.6** The reaper SQL-side self-exclusion is untested and can be deleted with the suite still green
### R3.4

- [x] **R3.4.1** First scan of a brand upserts its schedule row — closed at `src/lib/workers/scanWorker.js:1245`, `src/lib/workers/scanWorker.js:530`, `src/lib/workers/scanWorker.js:1146`, `src/lib/workers/scanSchedule.test.mjs:74`, `src/lib/workers/scanSchedule.test.mjs:154`, `src/lib/workers/scanSchedule.test.mjs:223`
- [x] **R3.4.2** Skips bump next_run_at and write a skip row — closed at `src/lib/workers/scanWorker.js:2671`, `src/lib/workers/scanWorker.js:2664`, `src/lib/workers/scanWorker.js:2581`, `src/lib/workers/scanWorker.js:2564`, `src/lib/workers/scanWorker.js:2734`, `src/lib/workers/scanWorker.js:2749`, `src/lib/workers/schedulerSkipBackoff.test.mjs:153`, `src/lib/workers/schedulerSkipBackoff.test.mjs:191`, `src/lib/workers/schedulerSkipBackoff.test.mjs:343`, `src/lib/workers/schedulerSkipBackoff.test.mjs:386`
- [ ] **R3.4.3** display_name written so scheduled and manual scans share one identity
- [ ] **R3.4.4** Worker honors per-brand prompt_target, engines and geo
- [~] **R3.4.5** The first-scan schedule registration is a non-atomic get-then-upsert, and its wiring is untested — submitted `src/lib/db/analytics.js:740`, `src/lib/workers/scanWorker.js:1177`, `src/lib/workers/scanSchedule.test.mjs:82`, `src/lib/workers/scanSchedule.test.mjs:155`, `src/lib/workers/scanSchedule.test.mjs:197`, `src/lib/workers/scanSchedule.test.mjs:285`
### R3.5

- [~] **R3.5.1** Per-block checkpoints in content jobs — submitted `src/lib/content/contentWorker.js:136`, `src/lib/content/contentWorker.js:344`, `src/lib/content/contentWorker.js:374`, `src/lib/content/contentWorker.js:448`, `supabase/migrations/014_content_job_checkpoints.sql:1`, `src/lib/db/content.js:122`, `src/lib/content/contentWorker.test.mjs:859`, `src/lib/content/contentWorker.test.mjs:953`, `src/lib/content/contentWorker.test.mjs:1008`
- [ ] **R3.5.2** Natural key on content_items (job_id, cycle)
- [ ] **R3.5.3** Stage transitions warn-to-throw after a quiet telemetry week `needs-soak`
- [~] **R3.5.4** REGRESSION: migration 014 is on disk but in no ledger, so three registry guards fail — submitted `README.md:161`, `docs/OPERATOR_LEDGER.md:336`, `docs/OPERATOR_LEDGER.md:379`, `docs/OPERATOR_LEDGER.md:398`, `scripts/setup-supabase.mjs:176`, `supabase/migrations/014_content_job_checkpoints.sql:11`, `src/lib/db/content.js:192`, `src/lib/content/contentWorker.js:401`
### R3.6

- [x] **R3.6.1** Price table that fails loud on an unknown model id — closed at `docs/vendors/mimo.md:47`, `docs/vendors/mimo.md:54`, `docs/vendors/mimo.md:68`, `docs/vendors/mimo.md:84`, `docs/vendors/mimo.md:99`, `docs/vendors/mimo.md:107`, `docs/vendors/mimo.md:172`, `src/lib/llmPricing.js:244`, `src/lib/llmPricing.js:267`, `src/lib/llmPricing.js:355`, `src/lib/openrouter.js:111`, `src/lib/openrouter.test.mjs:504`, `src/lib/llmPricing.test.mjs:221`
- [ ] **R3.6.2** Per-scan and per-day spend caps enforced from the ledger
- [ ] **R3.6.3** Weekly report metered per brand per day
- [x] **R3.6.4** The Bright Data per-query price is hardcoded in three places — closed at `src/lib/llmPricing.js:385`, `src/lib/llmPricing.js:484`, `src/lib/llmPricing.js:558`, `src/lib/engines/serp.js:177`, `src/lib/engines/serp.js:302`, `src/lib/scoring/aioPipeline.js:105`, `src/lib/scoring/enginePipeline.js:108`, `src/lib/serpQueryPrice.test.mjs:194`, `src/lib/serpQueryPrice.test.mjs:216`, `src/lib/serpQueryPrice.test.mjs:298`, `.env.example:118`
- [x] **R3.6.5** gemini and perplexity still fabricate costs; llmPricing does not reach them — closed at `src/lib/gemini.js:186`, `src/lib/gemini.js:61`, `src/lib/gemini.js:24`, `src/lib/engines/gemini.js:77`, `src/lib/engines/gemini.js:93`, `src/lib/engines/perplexity.js:373`, `src/lib/engines/perplexity.js:468`, `src/lib/engines/perplexity.js:527`, `src/lib/engines/perplexity.js:38`, `src/lib/engines/geminiCost.test.mjs:1`, `src/lib/engines/perplexityCost.test.mjs:1`, `src/lib/engines/costStateVocabulary.test.mjs:1`
- [x] **R3.6.6** openai.js fabricates a cost from a hardcoded rate while the model id is env-overridable — closed at `src/lib/engines/openai.js:122`, `src/lib/engines/openai.js:221`, `src/lib/engines/openai.js:43`, `src/lib/engines/openai.js:30`, `src/lib/llmPricing.js:80`, `src/lib/llmPricing.js:107`, `src/lib/llmPricing.js:342`, `src/lib/llmPricing.js:251`, `src/lib/engines/openai.test.mjs:266`, `src/lib/engines/openai.test.mjs:296`, `src/lib/engines/openai.test.mjs:354`, `src/lib/llmPricing.test.mjs:348`
- [x] **R3.6.7** openai.js has the identical dead retry guard perplexity just fixed, so a 401 costs three calls and three seconds — closed at `src/lib/openrouter.js:207`, `src/lib/openrouter.js:215`, `src/lib/openrouter.test.mjs:624`, `src/lib/openrouter.test.mjs:702`, `src/lib/openrouter.test.mjs:720`, `src/lib/llmErrors.js:27`
- [ ] **R3.6.8** cost_unmeasured_calls is write-only, an unmeasured-token row persists cost 0, and the new price rows are undated
- [x] **R3.6.9** brightdata.js keeps a private retry classifier that never retries a 408 — closed at `src/lib/engines/brightdata.js:419`, `src/lib/engines/brightdataRetryBudget.test.mjs:104`
### R3.7

- [x] **R3.7.1** SSRF guard module for Firecrawl fallback and crawlability — closed at `src/lib/ssrfGuard.js:366`, `src/lib/ssrfGuard.js:482`, `src/lib/ssrfGuard.js:552`, `src/lib/firecrawl.js:45`, `src/lib/firecrawl.js:115`, `src/lib/ssrfGuard.test.mjs:1`, `src/lib/firecrawl.test.mjs:1`
- [x] **R3.7.2** Firecrawl degrade becomes a recorded state — closed at `src/lib/workers/scanWorker.js:216`, `src/lib/workers/scanWorker.js:1112`, `src/lib/workers/scanWorker.js:1216`, `src/lib/workers/scanWorker.js:1390`, `src/lib/workers/scanChunkLedger.test.mjs:1982`, `src/lib/workers/scanChunkLedger.test.mjs:2073`, `src/lib/workers/scanChunkLedger.test.mjs:2155`, `src/lib/scoring/promptGen.js:255`, `src/lib/workers/scanChunk.test.mjs:496`, `docs/vendors/firecrawl.md:65`, `docs/vendors/firecrawl.md:96`
- [x] **R3.7.4** Apply the SSRF guard to the crawlability route — closed at `src/app/api/brands/[brand]/crawlability/route.js:243`, `src/app/api/brands/[brand]/crawlability/route.js:105`, `src/app/api/brands/[brand]/crawlability/route.js:312`, `src/app/api/brands/[brand]/crawlability/route.js:376`, `src/app/api/brands/[brand]/crawlability/route.js:412`, `src/app/api/brands/[brand]/crawlability/route.js:131`, `src/app/api/brands/[brand]/crawlability/route.js:345`, `src/app/api/brands/[brand]/crawlability/route.js:76`, `src/app/api/knowledge/route.js:114`, `src/app/api/knowledge/route.js:71`, `src/lib/scoring/promptGen.js:176`, `src/lib/crawlabilitySsrf.route.test.mjs:112`, `src/lib/crawlabilitySsrf.route.test.mjs:293`, `src/lib/crawlabilitySsrf.route.test.mjs:487`, `src/lib/ssrfRefusalSurfacing.test.mjs:60`, `src/lib/ssrfRefusalSurfacing.test.mjs:140`
- [x] **R3.7.5** Seven IPv6 ranges classifyAddress still allows — closed at `src/lib/ssrfGuard.js:335`, `src/lib/ssrfGuard.js:358`, `src/lib/ssrfGuard.js:385`, `src/lib/ssrfGuard.js:412`, `src/lib/ssrfGuard.test.mjs:108`, `src/lib/ssrfGuard.test.mjs:201`, `src/lib/ssrfGuard.test.mjs:270`
- [x] **R3.7.6** promptGen leaks an uncleared 10-second timer per seed term — closed at `src/lib/scoring/promptGen.js:346`, `src/lib/scoring/promptGen.js:318`, `src/lib/scoring/promptGen.js:342`, `src/lib/scoring/promptGen.js:355`, `src/lib/scoring/promptGen.js:25`, `src/lib/scoring/promptGenSeedTimer.test.mjs:195`, `src/lib/scoring/promptGenSeedTimer.test.mjs:108`, `src/lib/scoring/promptGenSeedTimer.test.mjs:137`
- [x] **R3.7.7** The crawlability UI shows a refused rival as unreachable — closed at `src/components/dashboard/CrawlabilityView.jsx:641`, `src/components/dashboard/CrawlabilityView.jsx:593`, `src/components/dashboard/CrawlabilityView.jsx:546`, `src/lib/crawlabilityOutcome.js:86`, `src/lib/crawlabilityOutcome.js:146`, `src/components/dashboard/crawlabilityRivalOutcome.test.mjs:202`, `src/components/dashboard/crawlabilityRivalOutcome.test.mjs:292`
- [x] **R3.7.8** The primary-domain crawlability banner conflates a customer typo with a network problem — closed at `src/lib/crawlabilityOutcome.js:181`, `src/components/dashboard/CrawlabilityView.jsx:310`, `src/components/dashboard/crawlabilityRivalOutcome.test.mjs:502`, `src/components/dashboard/crawlabilityRivalOutcome.test.mjs:616`
- [x] **R3.7.9** SSRF guard corpus gap: src/lib/ssrfGuard.test.mjs has no length assertion across six security corpora — closed at `src/lib/ssrfGuard.test.mjs:29-664`

## R4 — Ground truth & analytics completion  `1/10`

*1 week.* Probe scores sitting next to Google-verified numbers, change detection, referral capture.

### R4.1

- [ ] **R4.1.1** Wire the orphaned GSC client `needs-secrets`
- [ ] **R4.1.2** Prompt grounding seeds from real GSC queries `needs-llm`
### R4.2

- [ ] **R4.2.1** Dual-number pattern where our probe meets a verifiable source
### R4.3

- [ ] **R4.3.1** crawlability_audits history and change detection
- [x] **R4.3.2** computeBrandRollups still yields a real 100% for a self-only roster — closed at `src/lib/analytics/rollup.js:172`, `src/lib/analytics/rollup.js:339`, `supabase/migrations/013_brand_metrics_sov_state.sql:120`, `src/lib/analytics/rollup.test.mjs:193`, `src/lib/analytics/rollup.test.mjs:796`, `src/lib/workers/scanChunk.test.mjs:1021`, `scripts/setup-supabase.mjs:131`, `docs/PROD_MIGRATIONS.md:139`, `README.md:160`
- [ ] **R4.3.3** The analytics backfill cannot re-derive a citation denominator for historical rows
- [ ] **R4.3.4** The metrics endpoint drops the new SOV state, so the client still gets a bare null
- [ ] **R4.3.5** The new sov_state columns never reach the metrics API, and a scanWorker comment now states the opposite of what the code does
### R4.4

- [ ] **R4.4.1** AI-referral capture `needs-secrets`
### R4.5

- [ ] **R4.5.1** Decide-or-delete pass on schema-only subsystems `needs-decision`

## R5 — Content OS quality  `1/12`

*1 week.* Model-layer truth, a publish loop that stops pretending, drafts benchmarked against what engines cite.

### R5.1

- [x] **R5.1.1** Provider-neutral LLM config — closed at `src/lib/llmConfig.js:53`, `src/lib/llmConfig.js:99`, `src/lib/openrouter.js:20`, `src/lib/openrouter.js:48`, `src/lib/health.js:25`, `scripts/check-secrets.mjs:95`, `src/lib/scoring/promptGen.js:275`, `.env.example:11`, `docs/vendors/mimo.md:40`, `src/lib/openrouter.test.mjs:191`
- [-] **R5.1.2** Key re-enable checklist `needs-llm` `needs-secrets` — blocked: needs-llm
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

## R6 — Apparatus & guards  `29/50`

*starts day one, finishes last.* The paper trail and the tests that keep every earlier phase from regressing.

### R6.1

- [x] **R6.1.1** Migrations ledger and transaction per file — closed at `scripts/setup-supabase.mjs:28`, `scripts/setup-supabase.mjs:192`, `scripts/setup-supabase.mjs:215`, `scripts/setup-supabase.mjs:250`, `scripts/setup-supabase.mjs:255`, `scripts/setup-supabase.mjs:200`, `src/lib/migrationsRunner.test.mjs:277`, `src/lib/migrationsLedger.test.mjs:98`
- [x] **R6.1.2** docs/PROD_MIGRATIONS.md with per-migration verification queries — closed at `docs/PROD_MIGRATIONS.md:42`, `docs/PROD_MIGRATIONS.md:84`, `docs/PROD_MIGRATIONS.md:112`, `docs/PROD_MIGRATIONS.md:180`, `docs/PROD_MIGRATIONS.md:426`, `docs/PROD_MIGRATIONS.md:676`, `docs/PROD_MIGRATIONS.md:1038`, `scripts/setup-supabase.mjs:57`, `scripts/setup-supabase.mjs:85`, `scripts/setup-supabase.mjs:382`, `src/lib/scanRunsLive.test.mjs:110`, `supabase/migrations/012_scan_job_attempts.sql:189`
- [x] **R6.1.3** Track the orchestration tooling change made outside the ledger — closed at `.claude/orchestration/orchestrate.mjs:436`, `docs/BUILD_JOURNAL.md`
- [x] **R6.1.4** Agents grep secrets into transcripts; the exclusion must be in the brief, not the discipline — closed at `.claude/agents/rebuild-verifier.md:25`, `.claude/agents/rebuild-surveyor.md:35`, `.claude/agents/rebuild-scribe.md:40`, `.claude/agents/rebuild-test-author.md:45`, `.claude/agents/rebuild-implementer.md:50`, `.claude/agents/rebuild-controller.md:100`, `src/lib/agentSecretsGuard.test.mjs:62`, `src/lib/agentSecretsGuard.test.mjs:87`, `src/lib/agentSecretsGuard.test.mjs:115`
- [x] **R6.1.5** The checksum drift warning asserts a schema mismatch that may not exist — closed at `scripts/setup-supabase.mjs:48`, `scripts/setup-supabase.mjs:166`, `scripts/setup-supabase.mjs:296`, `scripts/setup-supabase.mjs:335`, `scripts/setup-supabase.mjs:353`, `scripts/setup-supabase.mjs:448`, `scripts/setup-supabase.mjs:497`, `src/lib/migrationsRunner.test.mjs:480`, `src/lib/migrationsRunner.test.mjs:614`
- [x] **R6.1.6** The migrations ordering guard measures from the first anchor, not the last — closed at `src/lib/migrationsRunner.test.mjs:318`, `src/lib/migrationsRunner.test.mjs:323`, `src/lib/migrationsRunner.test.mjs:347`, `src/lib/migrationsRunner.test.mjs:395`
- [x] **R6.1.7** The ordering guard trusts the runner self-report as the stage marker — closed at `src/lib/migrationsRunner.test.mjs:413`, `src/lib/migrationsRunner.test.mjs:613`, `src/lib/migrationsRunner.test.mjs:664`, `src/lib/migrationsRunner.test.mjs:702`, `src/lib/migrationsRunner.test.mjs:526`
- [ ] **R6.1.8** orchestrate.mjs silently swallows a long submit note
- [-] **R6.1.9** The secrets rule binds six rebuild agents; every other agent this project spawns is uncovered `needs-decision` — blocked: needs-decision
- [x] **R6.1.10** The ledger validates a citation by checking the file exists, never the line — closed at `.claude/orchestration/orchestrate.mjs:138-202`, `.claude/orchestration/orchestrate.mjs:266-285`, `src/lib/evidenceValidation.test.mjs:13`, `src/lib/evidenceValidation.test.mjs:20`, `src/lib/evidenceValidation.test.mjs:63`, `src/lib/evidenceValidation.test.mjs:125`
- [ ] **R6.1.11** submit silently keeps only the last of repeated --evidence flags
- [ ] **R6.1.12** The migration runner cannot verify a column, so column-only migrations are checked by proxy
- [ ] **R6.1.13** orchestrate.mjs takes the submit note as a shell argument, so backticks in a note execute and write command output into the ledger
- [ ] **R6.1.14** The migration verify list checks object COUNT and presence but never that the names match the SQL, so a rename reports an applied migration as missing forever
### R6.2

- [x] **R6.2.1** docs/OPERATOR_LEDGER.md — closed at `docs/OPERATOR_LEDGER.md:268`, `docs/OPERATOR_LEDGER.md:298`, `docs/OPERATOR_LEDGER.md:405`, `docs/OPERATOR_LEDGER.md:433`, `docs/OPERATOR_LEDGER.md:435`, `docs/OPERATOR_LEDGER.md:473`, `docs/OPERATOR_LEDGER.md:568`, `src/lib/docStatus.test.mjs:161`, `src/lib/rateLimit.js:128`, `scripts/setup-supabase.mjs:485`, `scripts/setup-supabase.mjs:522`, `src/lib/db/analytics.js:672`, `src/lib/workers/scanWorker.js:1643`, `docs/PROD_MIGRATIONS.md:144`
- [ ] **R6.2.2** docs/RUNBOOK.md seeded with 10 symptom rows
- [x] **R6.2.4** SCAN_RATE_LIMIT_UNVERIFIED_CEILING is undocumented and unguarded, and section E of the operator ledger is not exhaustive — closed at `docs/OPERATOR_LEDGER.md:287`, `docs/OPERATOR_LEDGER.md:276`, `docs/OPERATOR_LEDGER.md:446`, `docs/OPERATOR_LEDGER.md:469`, `.env.example:105`, `src/lib/rateLimit.test.mjs:713`, `src/lib/rateLimit.test.mjs:728`, `src/lib/rateLimit.test.mjs:770`, `src/lib/operatorLedgerGates.test.mjs:86`, `src/lib/operatorLedgerGates.test.mjs:104`
### R6.3

- [x] **R6.3.1** Vendor contract docs — closed at `docs/vendors/suggestqueries.md:1`, `docs/vendors/README.md:90`, `docs/vendors/README.md:186`, `docs/vendors/README.md:208`, `docs/vendors/README.md:59`, `docs/vendors/brightdata.md:65`, `src/lib/engines/serp.js:372`, `src/lib/engines/serp.js:375`, `src/lib/engines/serp.js:379`, `src/lib/workers/scanWorker.js:197`
- [x] **R6.3.2** gemini.md asserts a bug R6.5.6 just fixed as still current — closed at `src/lib/workers/scanWorker.js:1506`
- [x] **R6.3.3** Two dated handoff and journal docs cite line numbers that resolve to unrelated code — closed at `docs/BUILD_JOURNAL.md:72`, `docs/BUILD_JOURNAL.md:74`, `docs/BUILD_JOURNAL.md:170`, `docs/BUILD_JOURNAL.md:220`, `docs/BUILD_JOURNAL.md:397`, `docs/BUILD_JOURNAL.md:550`, `docs/BUILD_JOURNAL.md:561`, `docs/BUILD_JOURNAL.md:594`, `docs/BUILD_JOURNAL.md:614`, `docs/BUILD_JOURNAL.md:679`, `docs/HANDOFF-2026-08-30.md:248`
- [ ] **R6.3.4** Stale cross-references to a cascade that no longer exists, and a contracts doc that claims to be alone
- [x] **R6.3.5** PRODUCT.md flags a simulated probe counter that no longer exists — closed at `PRODUCT.md:75`, `PRODUCT.md:80`, `PRODUCT.md:86`, `PRODUCT.md:94`, `PRODUCT.md:103`, `PRODUCT.md:116`, `docs/design/DESIGN-SYSTEM.md:413`, `src/app/page.js:55`, `src/lib/landingProbeCounter.test.mjs:347`, `src/lib/landingProbeCounter.test.mjs:620`
- [x] **R6.3.6** One journal citation has already rotted since it was written, and two more assertions are true only at an older commit — closed at `docs/BUILD_JOURNAL.md:101`, `docs/BUILD_JOURNAL.md:131`, `docs/BUILD_JOURNAL.md:257`, `docs/BUILD_JOURNAL.md:287`, `docs/BUILD_JOURNAL.md:308`, `docs/BUILD_JOURNAL.md:322`, `docs/BUILD_JOURNAL.md:419`, `docs/BUILD_JOURNAL.md:487`, `docs/BUILD_JOURNAL.md:536`, `docs/BUILD_JOURNAL.md:566`, `docs/BUILD_JOURNAL.md:577`, `docs/BUILD_JOURNAL.md:791`, `docs/BUILD_JOURNAL.md:807`, `docs/BUILD_JOURNAL.md:823`, `docs/BUILD_JOURNAL.md:830`, `docs/HANDOFF-2026-08-30.md:21`, `docs/HANDOFF-2026-08-30.md:30`, `docs/HANDOFF-2026-08-30.md:88`, `docs/HANDOFF-2026-08-30.md:173`, `docs/HANDOFF-2026-08-30.md:193`, `docs/HANDOFF-2026-08-30.md:268`, `docs/HANDOFF-2026-08-30.md:351`, `docs/HANDOFF-2026-08-30.md:401`, `docs/HANDOFF-2026-08-30.md:423`, `docs/HANDOFF-2026-08-30.md:478`, `src/lib/engines/deployedEngines.js:21`, `src/lib/engines/openai.js:20`, `src/lib/engines/openai.js:90`, `src/lib/engines/openai.js:98`, `src/app/api/scan/route.js:36`, `src/app/api/scan/route.js:116`, `src/app/api/scan/route.js:121`, `src/app/api/scan/worker/route.js:515`, `src/app/api/scan/worker/route.js:560`, `src/lib/vendorRegistry.js:51`, `src/lib/llmPricing.js:390`, `src/lib/llmPricing.js:484`, `src/lib/llmPricing.js:505`, `src/lib/engines/serp.js:2`, `src/lib/scoring/aioPipeline.js:2`, `scripts/setup-supabase.mjs:29`, `scripts/setup-supabase.mjs:85`
- [ ] **R6.3.7** docs/PROD_MIGRATIONS.md has zero references to migration 014, and no guard notices
### R6.4

- [ ] **R6.4.1** Guard: route-perimeter walker
- [ ] **R6.4.2** Guard: fail-loud walker
- [ ] **R6.4.3** Guard: infra vendors never in rendered copy, engine names required
- [ ] **R6.4.4** Guard: engine-count-agnostic UI
- [x] **R6.4.5** testCoverageGuard fails on Windows: path.relative yields backslashes — closed at `src/lib/testCoverageGuard.test.mjs:29`, `src/lib/testCoverageGuard.test.mjs:41`
- [x] **R6.4.6** archive-reference-scan takes a URL host but --list prints brand names — closed at `scripts/archive-reference-scan.mjs:83`, `scripts/archive-reference-scan.mjs:105`, `scripts/archive-reference-scan.mjs:54`, `scripts/archive-reference-scan.mjs:155`
- [ ] **R6.4.7** The working tree is half CRLF despite .gitattributes eol=lf
- [ ] **R6.4.8** Doc-to-source staleness tripwire, recommended by R6.3.2 and not buildable there
- [x] **R6.4.9** withoutComments strips engine names out of strings in every other guarded file — closed at `src/lib/landingHonesty.test.mjs:627`, `src/lib/landingHonesty.test.mjs:519`, `src/lib/landingHonesty.test.mjs:574`, `src/lib/landingHonesty.test.mjs:1481`, `src/lib/landingHonesty.test.mjs:1530`, `src/lib/landingHonesty.test.mjs:2034`, `src/lib/landingHonesty.test.mjs:2163`, `src/lib/landingHonesty.test.mjs:1864`, `src/lib/fixtures/landingHonesty/quote-phase-shift.jsx.txt:55`
- [ ] **R6.4.10** A NUL byte in a source file makes it invisible to every grep-based guard
- [ ] **R6.4.11** No component-render harness, so every UI guard is a text scan that can pass while the component is broken
- [x] **R6.4.12** Two crawlability surfaces and two engine-chip renderers each duplicate a taxonomy — closed at `src/lib/crawlabilityOutcome.js:91`, `src/lib/crawlabilityOutcome.js:127`, `src/lib/crawlabilityOutcome.js:152`, `src/lib/crawlabilityOutcome.js:266`, `src/lib/crawlabilityTaxonomy.test.mjs:105`, `src/lib/crawlabilityTaxonomy.test.mjs:153`, `src/lib/crawlabilityTaxonomy.test.mjs:184`, `src/lib/crawlabilityTaxonomy.test.mjs:401`, `src/components/dashboard/AnswersView.jsx:69`, `src/components/dashboard/answersEngineFilters.test.mjs:169`, `src/components/dashboard/answersEngineFilters.test.mjs:300`, `src/components/dashboard/answersEngineFilters.test.mjs:320`
- [x] **R6.4.13** The perimeter once-ness test varies only the query string, so a per-pathname flag passes it — closed at `src/lib/operatorPerimeter.middleware.test.mjs:263`, `src/lib/operatorPerimeter.middleware.test.mjs:307`, `src/lib/operatorPerimeter.middleware.test.mjs:117`, `src/lib/operatorPerimeter.middleware.test.mjs:379`
- [x] **R6.4.14** A JSX apostrophe opens a phantom string literal in every comment-stripping guard in the repo — closed at `src/components/dashboard/routeReachability.test.mjs:187`, `src/components/dashboard/routeReachability.test.mjs:571`, `src/components/dashboard/routeReachability.test.mjs:601`, `src/components/dashboard/routeReachability.test.mjs:608`, `src/lib/landingHonesty.test.mjs:627`
- [~] **R6.4.15** Vacuous-corpus sweep: assertCorpusIntact with length floors across 10 security and guard suites — submitted `src/lib/docStatus.test.mjs:18`, `src/lib/ssrfRefusalSurfacing.test.mjs:56`, `src/lib/crawlabilitySsrf.route.test.mjs:32`, `src/lib/firecrawl.test.mjs:47`, `src/lib/serpQueryPrice.test.mjs:169`, `src/lib/engines/serp.test.mjs:329`, `src/services/servicesApiNullMetrics.test.mjs:144`, `src/lib/insertScanCascade3.test.mjs:174`, `src/lib/scoring/publicRouteExposure.test.mjs:32`, `src/lib/agentSecretsGuard.test.mjs:29`
- [ ] **R6.4.16** A source-reading guard test passes or fails depending on concurrent writes, so the suite is not deterministic
### R6.5

- [x] **R6.5.1** Route tests for the money paths and Bright Data parser fixtures — closed at `src/lib/scanRoute.route.test.mjs`, `src/lib/engines/brightdataParser.test.mjs`, `src/lib/cronAuth.route.test.mjs`
- [ ] **R6.5.2** The great deletion
- [x] **R6.5.3** Delete the orphaned adapter.js/probe.js pair — it does not even parse — closed at `docs/BUILD_JOURNAL.md`, `src/lib/engines/openai.js:8`, `src/lib/scoring/enginePipeline.js`
- [x] **R6.5.4** serp.test.mjs passes only because no BRIGHTDATA_API_KEY is in the environment — closed at `src/lib/engines/serp.test.mjs:65`, `src/lib/engines/serp.test.mjs:72`, `src/lib/engines/serp.test.mjs:29`, `src/lib/engines/serp.test.mjs:246`
- [x] **R6.5.5** serp.test.mjs env guard stops looking if a test is appended below it — closed at `src/lib/engines/types.test.mjs:167`
- [x] **R6.5.6** gemini.js abort signal never reaches the SDK — closed at `src/lib/gemini.js:56`, `src/lib/gemini.js:55`, `src/lib/gemini.js:92`, `src/lib/geminiAbort.test.mjs:155`, `src/lib/geminiAbort.test.mjs:187`, `src/lib/geminiAbort.test.mjs:97`, `src/lib/geminiAbort.test.mjs:220`, `src/lib/geminiAbort.test.mjs:256`
- [x] **R6.5.7** liveWriteGuard.test.mjs:290 passes alone and fails in the full run — closed at `src/lib/liveWriteGuard.test.mjs:586`, `src/lib/liveWriteGuard.test.mjs:615`, `src/lib/liveWriteGuard.test.mjs:642`, `src/lib/liveWriteGuard.test.mjs:714`, `src/lib/liveWriteGuard.test.mjs:295`, `src/lib/liveWriteGuard.test.mjs:349`, `src/lib/liveWriteGuard.test.mjs:89`
- [ ] **R6.5.8** The sweep branch of the scan worker route cannot be reached by any test
- [x] **R6.5.9** An assert.equal on a credential env var prints the live value into CI logs when it fails — closed at `src/lib/engines/serp.test.mjs:93`, `src/lib/engines/serp.test.mjs:96`, `src/lib/engines/serp.test.mjs:98`, `src/lib/credentialAssertionGuard.test.mjs:265`, `src/lib/credentialAssertionGuard.test.mjs:360`, `src/lib/credentialAssertionGuard.test.mjs:412`
- [x] **R6.5.10** The credential-assertion guard cannot follow a key through a local variable — closed at `src/lib/credentialAssertionGuard.test.mjs:318`, `src/lib/credentialAssertionGuard.test.mjs:410`, `src/lib/credentialAssertionGuard.test.mjs:650`, `src/lib/credentialAssertionGuard.test.mjs:704`, `src/lib/credentialAssertionGuard.test.mjs:521`, `src/lib/credentialAssertionGuard.test.mjs:455`, `src/lib/fixtures/credentialAssertionGuard/local-alias-leaks.test.mjs.txt:57`, `src/lib/fixtures/credentialAssertionGuard/non-secret-local-near-miss.test.mjs.txt:34`


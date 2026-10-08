# Customer launch readiness — 3 October 2026

> <!-- doc-status -->
> **Status: LIVE.** Readiness snapshot from the repository and read-only production checks on 3 October 2026. This is a launch checklist; the orchestration ledger remains the authority for tracked task closure.

## Decision

The engineering ledger is **248/285 closed (87%)**, with **31 todo and 6 blocked**. The generated roadmap is stale at 246/285. This percentage measures task closure, not customer readiness. Authentication and customer data isolation are outside that denominator.

The requested release is a full customer product, including Content Studio, for **Snitch, Kalika Tiles, and Offcult**. A managed pilot is not the requested outcome. Full readiness cannot honestly be claimed today: real browser adapters are absent, required reliability measurements span several days, and customer authentication/isolation needs implementation.

## What is working and verified

- Local unit suite: 3,100 passed, zero failed, 30 skipped, including a full rerun after lint fixes. Skips leave live integrations unverified.
- Fixed lint errors by renaming local test/harness identifiers in 14 files. Lint now exits successfully; two existing OpportunitiesPanel hook-dependency warnings remain. No production behavior was changed by these renames. git diff --check passed.
- Next.js production build passed. Fleet self-test and real Supabase client construction passed; the self-test uses stubs for execution and proves no real browser probing.
- GitHub main checks: tests, build, fleet, and Zeabur all report success.
- PR #1 merged on 15 September; the checkout is on main. Older handoff claims that it remains unmerged are stale.
- Vercel production deployment is Ready, created 22 September, serving https://aeo-vis.vercel.app.
- Live GET /api/health and /api/industries return 200. No-token GET /api/scan/worker, POST /api/content, and GET /api/history return 401.
- Production health reports required vendors configured and database reachable. This proves configuration and connectivity, not current provider-call success.
- Production migration ledger contains all 23 migration files, including 021 and 022. Catalog checks confirm the five evidence columns, content checkpoint column, and retention function exist. This is not a full verification of every migration's policies, constraints, or function bodies.
- Scan-worker tick was current; database records show the fleet also has a live idle heartbeat. Neither proves a real probe succeeded.
- The explicit content publish endpoint exists and verifies a submitted live URL. Older prose saying the system cannot record publication is stale; the full publish/lift chain remains unverified.

## Release blockers, ordered

| Priority | Work | Current evidence | Done when |
|---|---|---|---|
| P0 | Customer login and data isolation | Shared OPERATOR_TOKEN perimeter, no customer login/tenant implementation found. Production has 25 unrestricted anon policies. Catalog confirms anon can read/delete scans and update content. | Login, session lifecycle, customer/brand ownership and authorization work. Replace broad policies; server-side privileged access is constrained. Customer A cannot read or mutate customer B through either API or direct Supabase requests. |
| P0 | Verify fresh complete scans for all three brands | 61 stored scans; latest is 16 September. Zero enabled recurring schedules; sole schedule is disabled. | Each exact domain yields a persisted report with prompt set, engine/surface/geo, honest coverage states, citations and rivals; subsequent scheduled scans update history without browser polling. |
| P0 | Repair/verify Content Studio execution | 22 jobs in processing stages; 20 with heartbeat older than one day. Nine items await approval. Some processing rows date to 16 September. | Diagnose leases, item links, checkpoints, provider errors and self-continue responses; safely reconcile backlog. New batch reaches draft the same day and preserves cost/checkpoints through restart. |
| P0 | Full content acceptance | No evidenced whole scan → gap → draft → revision → approval → real publication → next-scan lift chain. | Run and record the complete flow on real customer content; rejected/unapproved items cannot publish; revisions receive fact checks; failed generation and weekly reports render honestly. Lift is described as correlation, not causation. |
| P0 | Multi-engine capability | Production lacks OPENAI_API_KEY and PERPLEXITY_API_KEY. worker/src/lib/probe.js unconditionally throws: browser fleet is infrastructure only. | Build browser spikes, fixtures, extractors, adapters, typed outcomes, evidence capture, pacing/shared spend limits, canaries and India egress verification. Clearly label API and browser surfaces; no silent fallback. |
| P0 | Engine reliability and cutover | Perplexity/ChatGPT browser adapters have not begun the required acceptance soaks. | Meet the roadmap's 3+ day adapter soak and 7+ day cutover soak, ≥90% answered and quiet canaries. Use reversible flags and surface-change markers. This cannot finish in one day. |
| P0 | Scoring calibration | Required 60–100 production-grounded human labels are absent; calibration harness still calls legacy judgeDeterministic. | Human labels pass fixture validation; harness exercises the live judge; publish precision/recall and investigate errors against agreed release targets. |
| P0 | Operations/security signoff | No-token gates pass; authenticated current production gate checks and documented OPERATOR_TOKEN rotation remain unproven. Content health flags its daily tick stale. | Verify rotated access credentials, authenticated route behavior, customer access, cron success, retention execution, backups/restore, alerts, rollback and recovery from killed jobs. Assess health freshness against actual configured daily cadence. |
| P1 | GSC and attribution | GSC credential configured but zero connected properties. AI referral capture remains todo. | Authorize properties, connect per brand, persist dated GSC rows, ground prompts with traceable queries, implement attribution and verified-source comparisons. |
| P1 | Cleanup and verification | Tracker has superseded tasks and implemented-but-unverified work; lint initially failed in test helpers. | Reconcile evidence via ledger CLI, exercise remaining database behavior tests, remove dead subsystems/code, close only on executed acceptance. |

The P1 items remain required for the user's full scope; priority sets execution order, not permission to omit features.

## Today's execution order

1. Confirm exact customer domains, users/ownership and Content Studio reviewers. Freeze the full release acceptance checklist.
2. Implement customer authentication/ownership and restrictive database access before customer onboarding. Verify access through API and database, including cross-customer negative cases.
3. Verify current production providers. Existing production LLM/cron configuration must not be requested again merely because the laptop lacks it. Configure missing engine credentials/account funding securely where needed.
4. Diagnose the content backlog, reconcile delivered versus genuinely unfinished jobs, and exercise one new complete batch with measured cost. Avoid blindly re-running already-delivered work.
5. Run the three-brand scan acceptance suite and enable the approved schedules. Observe continuation with the client closed, forced interruption/recovery, duplicates, provider failure and rate/spend controls.
6. Build real browser adapters and start canary/soak runs as soon as their prerequisites pass. Keep the launch gated on the completed measurements.
7. Prepare human calibration samples and wire the live calibration harness; run Content Studio review/revision/publication checks with the designated reviewer.
8. Deploy reviewed changes, verify production behavior, and record a release/rollback checklist. Full customer release follows only after every required gate passes.

This is the order of work, not a claim that eight substantial workstreams fit into today. The release date depends on implementation plus the required successful multi-day soak.

## Pending from the user

- Exact domains for Snitch, Kalika Tiles, and Offcult; names alone are unsafe identifiers, particularly Kalika Tiles. Confirm intended geography and initial customer users/brand ownership.
- Fund/authorize OpenAI and Perplexity if their API paths are required; authorize browser/proxy infrastructure with India egress for the real browser path. An existing Bright Data SERP zone does not establish browser infrastructure access. Use provider/project settings; do not paste credentials into chat.
- A human reviewer for 60–100 calibration samples and first customer drafts. Provide content briefs, claim/source constraints, and the real publishing target/live URL for publication acceptance.
- Add the configured GSC service account to each relevant Search Console property; provide GA4 access or authorize first-party AI referral capture.
- Confirm/document OPERATOR_TOKEN rotation after the historical transcript exposure. CRON_SECRET was already documented as rotated; production currently lists both variables and rejects unauthenticated worker calls.

Not newly owed: PR #1 merge, supplying an LLM key merely because old docs ask, applying 021/022 merely because README says unapplied, or selecting a new fleet host. Those were resolved or partly resolved; remaining validation is narrower.

## Local versus production configuration

Local check:secrets: Supabase, Bright Data, Firecrawl and Gemini passed; required LLM and cron are unconfigured. OpenAI, Perplexity and GSC are also absent locally. Production health reports LLM/cron/GSC configured, but OpenAI/Perplexity unconfigured. A production environment export returned empty credential values, so no live production vendor-call verdict was obtained from it; those results must not be interpreted as missing production keys. The temporary export was removed.

## Safety and verification limits

Production database audit used read-only transactions and catalog/aggregate queries. No customer records, schedules, jobs, schema or deployment were changed during this audit. Unauthenticated content POST was denied before work creation. No real customer scan, paid content generation, publication, browser adapter run or soak was executed. Healthy infrastructure and passing unit tests are necessary but do not establish those end-to-end outcomes.

## Remaining engineering ledger items

The list below reflects tasks.json, not stale generated prose. R1.2.19 and R3.1.1 are superseded records held blocked by immutable acceptance text. Several other entries have shipped code but still lack their complete acceptance evidence.

| ID | Ledger status | Task |
|---|---|---|
| R0.1.12 | blocked | Confirm CRON_SECRET and OPERATOR_TOKEN are live on the Vercel project |
| R0.4.2 | blocked | Hand-label 60-100 answers as calibration fixtures |
| R1.1.2 | blocked | ADR + 2-day spike: browser infrastructure |
| R1.2.19 | blocked | Deploy the fleet to Zeabur: image definition, K3s manifest, CI check |
| R1.2.20 | todo | Deploy the fleet to Zeabur against the live project, explicitly armed |
| R1.3.1 | todo | Spike: Playwright against perplexity.ai |
| R1.3.2 | todo | Perplexity extractor as a pure function + fixture tests |
| R1.3.3 | todo | Perplexity adapter: retries, block classification, evidence capture |
| R1.3.4 | todo | Perplexity canary |
| R1.3.5 | todo | Perplexity soak: 3+ days x ~30 prompts/day |
| R1.4.1 | todo | Spike: logged-out chatgpt.com with search |
| R1.4.2 | todo | ChatGPT extractor + fixtures |
| R1.4.3 | todo | ChatGPT adapter + canary + soak |
| R1.4.4 | todo | Fallback policy: UI blocked records blocked |
| R1.5.4 | todo | Evidence signing must use a client that can sign a private bucket, and no query param may reach the key |
| R1.5.5 | todo | Historical scans carry no result_id in raw_results, so View evidence can never appear for them |
| R1.6.1 | todo | Verify IN egress per engine |
| R1.7.1 | todo | Dual-run the reference corpus through API and UI paths |
| R1.7.2 | todo | Cutover per engine behind the ENGINES flag |
| R1.7.3 | todo | Demote API adapters to explicit fallback; delete dead paths |
| R1.7.4 | todo | fetchPeopleAlsoAsk bypasses the engine capability gate and can spend on a stale SERPAPI_KEY |
| R2.5.1 | todo | Point the calibration harness at the live judge |
| R3.1.1 | blocked | Scan worker cron every 10 minutes |
| R3.1.2 | todo | Add the missing ?batch=1 cron entry |
| R3.5.3 | todo | Stage transitions warn-to-throw after a quiet telemetry week |
| R4.1.1 | blocked | Wire the orphaned GSC client |
| R4.1.2 | todo | Prompt grounding seeds from real GSC queries |
| R4.2.1 | todo | Dual-number pattern where our probe meets a verifiable source |
| R4.4.1 | todo | AI-referral capture |
| R4.5.1 | todo | Decide-or-delete pass on schema-only subsystems |
| R5.3.1 | todo | Benchmark step grounded in winners |
| R5.3.2 | todo | Fact-check on revision cycles too, cost-gated |
| R5.4.2 | todo | Weekly report integrity |
| R5.4.3 | todo | One end-to-end run on a real brand |
| R6.1.15 | todo | orchestrate.mjs verify silently discards --note-file, so a rejection reads 'no reason given' |
| R6.2.7 | todo | Guard tests on the content job store prove a filter was SENT, never that it has an effect |
| R6.5.2 | todo | The great deletion |

# P0 hosted rollout and qualification

> <!-- doc-status -->
> **Status: LIVE.** Execution record for the remaining P0 work, 20 October 2026, Asia/Kolkata. Qualification is in progress; this document does not claim a completed release.

PRs [#9](https://github.com/Vismay299/aeovis/pull/9), [#11](https://github.com/Vismay299/aeovis/pull/11) and [#12](https://github.com/Vismay299/aeovis/pull/12) are merged. The P0 follow-up landed at `c5b8e5955322c6243b33bed1dba9adf001ffbe56` after every CI job passed on its final head. Its production deployment is [aeo-kofkixzdr](https://aeo-kofkixzdr-vismays-projects-e0c6f290.vercel.app), Vercel `dpl_AncpCrnCJvnWvNZ6KxYMShNcg2sP`, confirmed READY on that commit.

The deployed production `/api/health` was read through the authenticated Vercel CLI. It reported configured credentials, working database reachability and missing migration 027. Direct catalog/ledger inspection confirmed that 027–033 were absent. The eight additive migrations 027–034, followed by 035, were applied under an advisory lock and a scan-job write lock after verifying zero active scans. Existing scan, job and result counts were unchanged. Provider dispatch remains paused during qualification.

Migration 034 repairs a real hosted integration gap: `probe-evidence` allowed PNG/gzip/HTML but rejected the JSON MIME type used by raw response capture. The bucket remains private. Evidence access also distinguishes a failed upload (409) from expired raw evidence (410), rejects invalid retention metadata, and limits signed-link lifetime to the remaining retention period.

Migration 035 allows one owned QA workspace and explicit canaries through the pause while retaining every existing fence, circuit and shared budget check. The actual PostgreSQL test demonstrates that rollback refuses new ordinary calls and still accepts an already-authorized result. It also proves that a customer role cannot change rollout controls. No existing historical attempt or report is rewritten.

Initial production authorization controls are USD 25 per scan, USD 100 per UTC day and USD 0.20 estimated reservation per attempt. These values take effect in the new deployment. Reservations bound authorization, not provider invoices; unreported billing remains unknown.

| Offered surface | Actual deployed route | Requested model | Credential variable |
|---|---|---|---|
| Google AIO | Bright Data Google SERP | Google SERP, not a model API | `BRIGHTDATA_API_KEY`, selected `BRIGHTDATA_SERP_ZONE` |
| ChatGPT | OpenRouter gateway | `openai/gpt-6-luna` | `LLM_API_KEY` |
| Gemini | OpenRouter gateway | `google/gemini-3.8-flash` | `LLM_API_KEY` |
| Perplexity | OpenRouter gateway | `perplexity/sonar` | `LLM_API_KEY` |

Native credentials, when present, select the documented native ChatGPT/Perplexity route. The first hosted canary exposed a different gateway credential rejected with HTTP 401; its shared circuit correctly stopped the other two gateway engines. The existing local credential then passed a bounded live check, and the production `LLM_API_KEY` binding was updated to that existing verified credential. The failed configuration/canary remains historical evidence. No provider key is created/revoked and no provider account, funding or billing configuration is changed. Credential values are never recorded.

The self-entity resolver uses the registered name/website and captured text/links; selected rivals are not an input. Lookalike hosts and echoed questions cannot manufacture mentions. Citation-only evidence remains a citation. Ambiguous names withhold qualified scores rather than asserting absence; the new policy version prevents comparisons against older or mixed entity labels.

The browser qualification also exposed a finalizer bug: a single ChatGPT/Gemini/Perplexity scan used the legacy Google-only summary, so a qualified measured zero appeared as missing AIO data. Single text-provider scans now retain their own answer denominators, engine health and qualified headline metadata. Legacy Google-only records retain their existing path; historical records are not rewritten.

The operator-only QA preparation action creates two disposable confirmed Auth users without sending email, two separate test workspaces, and explicitly labeled provider fixtures. It exercises actual hosted Auth/database/Storage; it does not qualify a vendor from synthetic text. QA credentials are retained only in private local files during browser verification and are never committed or logged. Cleanup validates each user's run ownership before deleting only that run's identities, objects and fixture rows. Retention advances the clock only for the exact QA object prefix.

The candidate from commit `85775bb` was rejected by Vercel with `TEAM_ACCESS_REQUIRED`: “The deployment was blocked because the commit author doesn’t have permission to create deployments for this project.” The CLI displayed this as `UNKNOWN` and waited; the deployment API established the actual `BLOCKED` state. The user explicitly authorized merging PR #12 through GitHub and using the existing owner-authorized deployment pipeline to finish hosted qualification. No attribution, project membership or deployment protection is changed. The new deployment binding cannot be qualified on the blocked candidate.

The production recovery canary used an immutable eight-request / USD 2 ceiling. ChatGPT, Gemini and Perplexity each answered and stored an actual private capture. Google again returned provider capacity failure and stored its raw capture; its readiness remains degraded. See [hosted provider evidence](./p0-hosted-provider-evidence.json). The old rejected configuration remains historical and is not cleared to force recovery.

Actual hosted Chromium checks passed anonymous refusal, two customer logins, owned signing/download, expired-versus-failed capture handling, cross-tenant history/signing denial and direct private Storage denial. The live retention action also passed actual signed-link expiry, removal of exactly the two QA objects and durable expired metadata. A subsequent test selector matched the portal's two nested main elements; the harness now checks the exact expired-capture message. Partial evidence is preserved in [the failed browser checkpoint](./p0-hosted-browser-last-failure.json), which does not count as a completed browser pass.

Cleanup exposed the existing last-owner membership guard. Recovery validated both Auth users' exact QA-run metadata, demoted only their two derived fixture memberships and successfully completed the operator cleanup; the first run's users, brands, jobs and captures were confirmed absent. The helper now performs that scoped demotion after validating every supplied identity, retaining the customer last-owner guard. The real PostgreSQL check proves ordinary owner deletion remains refused and an unrelated workspace survives cleanup.

Outstanding qualification at this checkpoint: the complete browser run including automatic fixture cleanup, health-read invariance, readiness expiry, and final promotion/rollback/cutover evidence. Google’s measured provider-capacity failure remains unresolved; it is never converted into no-AIO success. Human calibration and the seven-day consumer soak remain separate P1 work.

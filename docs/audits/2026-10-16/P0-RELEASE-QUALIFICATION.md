# P0 hosted rollout and qualification

> <!-- doc-status -->
> **Status: LIVE.** Execution record for the remaining P0 work, 20 October 2026, Asia/Kolkata. Qualification is in progress; this document does not claim a completed release.

PRs [#9](https://github.com/Vismay299/aeovis/pull/9) and [#11](https://github.com/Vismay299/aeovis/pull/11) are merged. Their combined main commit is `af69523950e8af574ec5e494b9bd5926a2a0741f`.

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

The operator-only QA preparation action creates two disposable confirmed Auth users without sending email, two separate test workspaces, and explicitly labeled provider fixtures. It exercises actual hosted Auth/database/Storage; it does not qualify a vendor from synthetic text. QA credentials are retained only in private local files during browser verification and are never committed or logged. Cleanup validates each user's run ownership before deleting only that run's identities, objects and fixture rows. Retention advances the clock only for the exact QA object prefix.

The candidate from commit `85775bb` was rejected by Vercel with `TEAM_ACCESS_REQUIRED`: “The deployment was blocked because the commit author doesn’t have permission to create deployments for this project.” The CLI displayed this as `UNKNOWN` and waited; the deployment API established the actual `BLOCKED` state. No attribution, project membership or deployment protection is changed to bypass that refusal. The new deployment binding cannot be qualified on that blocked candidate.

Outstanding qualification at this checkpoint: hosted browser ownership and signing/expiry checks, current deployed provider canaries after credential recovery, readiness expiry, and final promotion/rollback/cutover evidence. These depend on an authorized deployment of the completed follow-up. Google’s measured provider-capacity failure also remains unresolved; it is never converted into no-AIO success. Human calibration and the seven-day consumer soak remain separate P1 work.

> <!-- doc-status -->
> **Status: LIVE.** Owner procedure for the F02 phase 5 DataForSEO cutover.
> Decision: [`docs/decisions/2026-11-10-dataforseo-answer-provider.md`](../decisions/2026-11-10-dataforseo-answer-provider.md)
> (partial-go; approved engines: aio, chatgpt, gemini; scans use queued mode).

# DataForSEO cutover runbook

This is an owner-run procedure. Agents write the checks but never run them:
every command below makes paid provider calls or changes production routing.
Do not run the live check from a synced folder (Google Drive, OneDrive); use
the worktree or a plain local path. Never print `DATAFORSEO_API_KEY` or paste
it into a prompt, transcript, or this runbook — pipe it from a file.

## Before starting

1. Confirm the decision record above is committed and
   `DATAFORSEO_APPROVED_ENGINES` matches its approved list
   (`node --test src/shared/engines/dataforseoGate.test.mjs`).
2. Confirm no scan has posted rows waiting on an old code version:
   `select count(*) from probe_observations where state='posted';` must be 0
   before deploying a routing change or reverting one.
3. Have a loopback PostgreSQL database named `aeovis_live_qa` with migrations
   applied, reachable at `PGHOST=127.0.0.1`. Set `PGHOST` explicitly; the
   script refuses anything that is not loopback and any `PGDATABASE` that does
   not end in `_live_qa`.
4. Keep the credential in an owner-controlled env file outside the repository
   and outside Drive. The file holds the `DATAFORSEO_API_KEY` value (base64
   of `login:password`); nothing else in this procedure needs it.

## Cutover (production)

1. Add the credential to Vercel by piping it from the private file (never
   printing it):
   `vercel env add DATAFORSEO_API_KEY production < <private-file>`
2. Run the bounded live canary on the loopback ledger (defaults: at most
   USD 0.10 and 10 requests across the approved engines). The env file used
   here must itself set `FEATURE_DATAFORSEO_ENGINES=on` — the script refuses
   without it by design. (This is the loopback run env only; the production
   setting in step 4 is separate.)
   ```sh
   PGHOST=127.0.0.1 PGDATABASE=aeovis_live_qa node --env-file=<owner-env-file-outside-Drive> \
     scripts/qa/check-dataforseo-live.mjs --mode engines
   ```
   The script refuses to start unless `PGHOST` is loopback, `PGDATABASE` ends
   in `_live_qa`, no shared-secret variables are set,
   `DATAFORSEO_API_KEY` is configured (named only in output), and
   `FEATURE_DATAFORSEO_ENGINES=on` is set in the environment. It prints only
   per-engine state (`answered`, `blocked`, `refused`) with reasons plus the
   request count — no answer text. A non-zero exit means the cutover stops
   here: do not continue.
3. Set `ANSWER_ENGINE_ROUTES` to the approved engines' `dataforseo>…` orders,
   for example:
   `aio=dataforseo>brightdata;chatgpt=dataforseo>openrouter;gemini=dataforseo>openrouter`.
   Unknown engines or routes are refused at parse time.
4. Set `FEATURE_DATAFORSEO_ENGINES=on`.
5. Redeploy.
6. Run the existing owner-authorised Offcult scan flow and compare its report
   with the bake-off summary in the decision record (mention rates, citation
   coverage, cost per answer). Record the canary outcomes (no answer text) in
   the cutover log or PR.
7. Optional: once the record supports it, lower `SCAN_PROBE_RESERVATION_USD`
   toward the DataForSEO price (owner config change, outside any PR).

## Switch back (turn off)

Either of these returns scans to the previous providers without a code change:

- Set `FEATURE_DATAFORSEO_ENGINES=off` and redeploy. Scans already frozen
  finish on their frozen route; the next scan freezes the fallback routes.
- Or remove engines from `ANSWER_ENGINE_ROUTES` and redeploy.

A DataForSEO balance failure opens the shared `dataforseo` circuit
automatically and the next scan freezes the fallback. Do not call
`set_probe_rollout` and do not touch `probe_dispatch_control` in any step.

## Rollback (code revert)

1. Confirm `select count(*) from probe_observations where state='posted';`
   returns 0 (posted rows are collected or expired by the sweep first).
2. Revert the code. Migration 045 stays (additive; old code ignores the
   `posted` state because it never creates it).
3. Redeploy and verify the next scan freezes non-DataForSEO routes.

## Retention and cleanup

- Bake-off and canary evidence lives in the owner's private output directory,
  never in the repository. Keep `manifest.json`/`summary.md` for the record;
  delete `answers.jsonl` and `review-sample.md` after the retention period.
- No data cleanup in production: answers stay under the existing 90-day
  evidence policy and 13-month results retention.

## After the run

1. Paste the canary outcomes (per-engine state, request count, spend) into the
   phase 5 PR under Owner actions — answer text stays private.
2. If any engine failed, keep the previous routing for that engine and note
   the failure kind in the cutover log.

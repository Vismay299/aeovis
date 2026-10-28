<!-- doc-status -->
**Status: LIVE.** **Date:** 2026-10-25. **Authority:** owner procedure for the F02 phase 1 DataForSEO bake-off.

# DataForSEO answer-provider bake-off

This is an owner-run procedure. Do not run the paid bake-off until the loopback database, account credit, private output directory and provider terms are ready. The script refuses non-loopback or shared database settings and writes private answers only under `--out`.

## Before running

1. Use a disposable local PostgreSQL database named `aeovis_live_qa`, with migrations applied. Set `PGHOST=127.0.0.1` (or `localhost`) and database connection variables in the local shell. Do not set `DATABASE_URL`.
2. Put `DATAFORSEO_API_KEY` in an owner-controlled env file outside Google Drive and the repository. Never print the key or paste it into a prompt, terminal transcript or this runbook.
3. Check the current DataForSEO account credit. The accepted default for the current USD 1 credit is `dfs_queued,dfs_live` with `--max-spend-usd 0.80`.
4. Use a private `--out` directory outside the repository and Google Drive. It will contain answer text and citations. Keep that directory private and follow the approved retention period.
5. Create a run ID that has not been used in the output directory. Validate the panel locally; it must contain `context.country`, `context.language`, and 1–60 prompt objects with `text`.

## Dry run

Use the same panel, run ID and output path planned for the paid run. The dry run checks the plan and calls only DataForSEO sandbox endpoints and free model catalogues. It does not seed the QA dispatch ledger or make paid requests.

```sh
PGHOST=127.0.0.1 PGDATABASE=aeovis_live_qa node --env-file=<owner-env-file-outside-Drive> \
  scripts/qa/check-dataforseo-bakeoff.mjs \
  --panel <private-panel.json> --run-id <lowercase-run-id> \
  --arms dfs_queued,dfs_live --max-spend-usd 0.80 \
  --max-requests 400 --out <private-output-directory> --dry-run
```

Review the printed plan and estimate. The estimate must fit below USD 0.80. Fix any panel or provider configuration issue before continuing.

## Paid run

Confirm that terms questions in the decision template have been answered, account balance is sufficient, the database is loopback `aeovis_live_qa`, and the run ID/output directory are correct. The `--confirm-spend` value must exactly equal the spend ceiling.

```sh
PGHOST=127.0.0.1 PGDATABASE=aeovis_live_qa node --env-file=<owner-env-file-outside-Drive> \
  scripts/qa/check-dataforseo-bakeoff.mjs \
  --panel <private-panel.json> --run-id <lowercase-run-id> \
  --arms dfs_queued,dfs_live --reserve-usd 0.20 \
  --max-requests 400 --max-spend-usd 0.80 --confirm-spend 0.80 \
  --out <private-output-directory>
```

The default arms cover ChatGPT, Gemini and Google AI Overviews. Perplexity's `dfs_model` arm is optional: with the current credit, limit it to five questions using `--arms dfs_queued,dfs_live,dfs_model --perplexity-questions 5`; otherwise run it only after a credit top-up and raise the ceiling to an owner-approved amount. Any expanded arm set must remain within the account balance and hard SQL spend/request limits.

Do not edit the runbook to restore the older USD 12 all-arm example until the owner explicitly approves a larger budget. A DataForSEO balance failure is a stop condition; do not retry billed requests.

## After the run

1. Let the script complete its balance-after read and write `manifest.json`, `answers.jsonl`, `summary.json`, `summary.md` and `review-sample.md` under the private output directory.
2. Inspect `summary.md` and manually review the generated sample in the private directory. Record correct/incorrect totals without copying answer text.
3. Complete the terms-of-use questions and Go / Partial go / No go decision in `docs/decisions/_template-provider-bakeoff.md` copied to a dated decision record.
4. Commit only the aggregate decision record. Never commit `answers.jsonl`, `review-sample.md`, credentials, or raw provider responses.
5. Retain or delete the private evidence directory according to the approved retention period.
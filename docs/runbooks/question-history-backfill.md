# Runbook: question history backfill

> <!-- doc-status -->
> **Status: LIVE.** The one-time owner backfill that links every collected
> answer to its stable workspace question (F12 phase 1), how to read the
> `unmatched` count, and how to re-run it. Fulfills F12-AC-02…05 rollout.

**Date:** 2026-11-14 · **Lane:** F12 · **Migration:** `095_f12_question_answer_links.sql`

Owner-run only, in the Supabase SQL editor against the production database.
Never in code, never in tests, never against a shared database from a script:
the harness `scripts/qa/check-f12-db.mjs` covers the same function against a
disposable loopback `_qa` database. Record the returned counts (numbers only,
never question or answer text) in the rollout PR.

## Step 1 — run the backfill once per workspace

```sql
select brand_key, link_question_answers(brand_key, 100000, true, 'backfill')
  from customer_brands where is_active;
```

`p_import_missing = true` creates one archived `import` question (topic
`General`, status `archived`) for every distinct historical question text that
no workspace question covers yet, then links it. The periodic
`questions.link` job keeps linking afterwards without importing, so this runs
once; re-running is safe (idempotent) but should change nothing.

**Pass:** one row per active workspace; each result reads
`{"scan": n, "explore": n, "legacy": n, "imported": m, "unmatched": k}`.
`imported` may be non-zero on the first run and must be `0` on a re-run.

## Step 2 — read `unmatched`

`unmatched` counts terminal scan answers (`answered`, `valid_no_aio`,
`failed`, `ambiguous`, `blocked`) with no workspace question to link to.
Non-terminal rows (`pending`, `leased`, `retry`, `posted`) are never linked
and never counted. Right after step 1, expect `unmatched = 0`: the import
created a question for every historical text. A non-zero `unmatched` on a
later check means new wording arrived that no question covers yet — add it in
the Questions page (F08), then re-run step 1 for that workspace only.
Unmatched answers have no link row, so inspect the source:

```sql
select o.query, o.engine, o.state, o.created_at
  from probe_observations o join scan_jobs j on j.id = o.job_id
 where j.brand_key = '<brand_key>' and o.purpose = 'scan'
   and o.state in ('answered','valid_no_aio','failed','ambiguous','blocked')
   and not exists (select 1 from question_answer_links l where l.observation_id = o.id)
 order by o.created_at desc limit 50;
```

A small `unmatched` count on a later check means questions asked in wording
the workspace set does not cover; each such text gets its archived `import`
question the next time step 1 runs for the brand. A large count means the
workspace's question set is missing live wording: add it in the Questions page
(F08), then re-run step 1 for that workspace only:

```sql
select link_question_answers('<brand_key>', 100000, true, 'backfill');
```

## Step 3 — confirm the periodic keeps up

After deploy, `FEATURE_JOBS_TICK` must be on so `questions.link` runs every
300 s. Spot-check one workspace:

```sql
select link_question_answers('<brand_key>', 2000, false, 'periodic');
```

**Pass:** `scan`, `explore`, `legacy` and `imported` are all `0` — everything
already linked. (`unmatched` may be non-zero when new uncovered wording
arrived; handle it per step 2.) If `scan` is non-zero here, the periodic is
not running; fix the tick before re-running the backfill.

## Retention

`questions.links.retention` prunes links older than 395 days in batches of
5000 (up to 20 batches per run). It deletes only `question_answer_links` rows;
`probe_observations` and `prompt_results` are never touched. Pruned links are
rebuilt by the backfill SQL above, so retention needs no runbook of its own.

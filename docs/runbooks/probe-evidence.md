# Runbook: `probe-evidence` Storage bucket

> <!-- doc-status -->
> **Status: LIVE.** The bucket, its retention job and its size budget. Fulfills
> R1.5.1. Writers arrive with R1.5.2 (evidence-id columns) and R1.5.3 (signed-URL
> viewer); until then the bucket is expected to be empty.

**Date:** 2026-09-15 · **Lane:** data · **Migration:** `019_probe_evidence_bucket.sql`

## What it is

| | |
|---|---|
| Bucket | `probe-evidence`, **private** (read only through signed URLs) |
| Per-object limit | 5 MiB (`file_size_limit`), enforced by Storage |
| Allowed types | `image/png`, `application/gzip`, `text/html` |
| Access | anon-key policies on `storage.objects` scoped to this bucket: insert, select, delete |
| Retention | **90 days**, by cron `GET /api/evidence/retention` daily 03:00 UTC |
| Code | `src/lib/evidenceRetention.js`, `src/app/api/evidence/retention/route.js` |

### Object layout (convention for R1.5.2 writers)

```
<scan_job_id>/<engine>/<prompt_result_id>.png       # full-page screenshot
<scan_job_id>/<engine>/<prompt_result_id>.html.gz   # gzipped rendered HTML
```

Keying by scan job keeps one scan's evidence under one prefix, so an operator
can inspect or delete it as a unit.

## Size budget

Planning numbers, **not measured** — no probe has written evidence yet
(R1.3.x adapters are unbuilt). Re-measure after the first soak (R1.3.5) and
update this table.

| Item | Assumption |
|---|---|
| Screenshot (PNG, 1280px wide, full page) | ~400 KB typical, 5 MiB hard cap |
| HTML, gzipped | ~60 KB typical |
| Per probe | ~0.5 MB |
| Probes per scan | 30 prompts × 2 engines = 60 |
| Per scan | ~30 MB |
| Scans per day (planning) | 10 |
| Daily ingest | ~300 MB |
| Steady state at 90-day retention | **~27 GB** |

**Budget: 30 GB steady state.** Supabase Pro includes 100 GB of storage; Free
includes 1 GB, which this budget exceeds within about 4 days — evidence capture
must not be switched on for a Free-plan project. If the soak shows the steady
state trending past 30 GB, the levers in order are: WebP/JPEG screenshots
instead of PNG, viewport-only instead of full-page, then shorter retention.

## Retention job

`pruneProbeEvidence` walks the bucket through the Storage API (SQL deletes on
`storage.objects` are refused by Supabase's `protect_objects_delete` trigger),
removes objects whose `created_at` is older than 90 days in chunks of 100, and
answers with measured counts: `scanned`, `expired`, `removed`, `undated_kept`,
`bytes_kept`, `truncated`.

- An object with no readable timestamp is **kept** and counted, never deleted.
- A pass is capped at 20,000 objects; `truncated: true` means the next day's
  pass continues.
- A list or remove failure answers **500**, never "0 expired".

Manual run:

```
curl -H "Authorization: Bearer $CRON_SECRET" https://<deployment>/api/evidence/retention
```

## Verify the bucket exists

```sql
SELECT id, public, file_size_limit, allowed_mime_types FROM storage.buckets WHERE id = 'probe-evidence';
SELECT policyname FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects'
   AND policyname LIKE 'probe-evidence%';
```

One bucket row with `public = false`, and three policies.

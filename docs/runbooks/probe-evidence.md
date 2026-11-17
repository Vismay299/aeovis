# Runbook: `probe-evidence` Storage bucket

> <!-- doc-status -->
> **Status: LIVE.** The bucket, its retention job, its size budget and the
> signed-URL read path. Fulfills R1.5.1, plus R1.5.2 (evidence-id columns) and
> R1.5.3 ("Viewing", below). No PRODUCER exists yet — no probe adapter writes
> evidence (R1.3.x is unbuilt) — so the bucket is still expected to be empty and
> every `prompt_results.evidence_*_id` is still NULL.

**Date:** 2026-09-15 · **Lane:** data · **Migration:** `019_probe_evidence_bucket.sql`

## What it is

| | |
|---|---|
| Bucket | `probe-evidence`, **private** (read only through signed URLs) |
| Per-object limit | 5 MiB (`file_size_limit`), enforced by Storage |
| Allowed types | `image/png`, `application/gzip`, `text/html` |
| Access | anon-key policies on `storage.objects` scoped to this bucket: insert, select, delete |
| Retention | **90 days**, by cron `GET /api/evidence/retention` daily 03:00 UTC |
| Code | `src/server/evidenceRetention.js`, `src/app/api/evidence/retention/route.js` |

### Object layout (convention for R1.5.2 writers)

```
<scan_job_id>/<engine>/<prompt_result_id>.png       # full-page screenshot
<scan_job_id>/<engine>/<prompt_result_id>.html.gz   # gzipped rendered HTML
```

Keying by scan job keeps one scan's evidence under one prefix, so an operator
can inspect or delete it as a unit.

## Viewing (R1.5.3)

`GET /api/scan/<job_id>/evidence?result=<prompt_result_id>&kind=screenshot`

Answers **302** to a Storage signed URL for the object whose key is stored on
that `prompt_results` row, or a plain-text refusal. `kind` is one of
`screenshot | dom | har | raw`, each mapping to its own `evidence_*_id` column.

| | |
|---|---|
| Expiry | **120 s** — `EVIDENCE_SIGNED_URL_TTL_SECONDS`, `src/server/evidenceSignedUrl.js`, the only place the number is written |
| Route | `src/app/api/scan/[job_id]/evidence/route.js` |
| UI | "View evidence" in `src/components/dashboard/AnswersView.jsx` (`evidenceScreenshotHref`) |

The URL carries a click and nothing else: it is not a share link, and pasting it
into Slack buys the reader two minutes at most. That is the whole reason the
expiry is short.

**A caller can never name an object.** It names a scan job and a result row; the
object key is read off that row (`evidence_*_id`), and the row must match BOTH
the result id and the job id in the path. No caller-supplied string ever reaches
`createSignedUrl`.

Refusals, all plain text, never a fabricated URL:

| Situation | Status |
|---|---|
| Job id not in `scan_jobs` | 404 `Job not found.` |
| Result id unknown, malformed, or belonging to another job | 404 `No such result for this scan job.` |
| Row exists, `evidence_<kind>_id` is NULL or blank | 404 "This answer has no stored `<kind>`" |
| Unknown `kind`, missing `?result` | 400 |
| Row unreadable, or Storage would not sign | 502 — unknown, explicitly NOT "no evidence" |
| Supabase not configured on the deployment | 503 |

**Perimeter:** the same one `GET /api/scan/<job_id>/status` has. It is on the
anonymous free-scan allowlist in `src/server/operatorPerimeter.js` (GET only), next
to the status poll and the `/api/scans/...` reads, because the dashboard that
renders the link is anonymous and can already fetch the TEXT of the answer this
is a screenshot of. The entry cost is knowing the brand, not holding a job
uuid: the public `GET /api/scans/<brand>` returns `raw_results.results`, which
carries `job_id` and `result_id`. There is no per-user auth on scans anywhere
yet. This route deliberately does not
invent a second, stricter door around one scan while the first stays open; when
scans get an owner, both routes change together.

**The affordance is hidden, not broken, when there is nothing to show.** The
link renders only when the row carries a non-empty `evidence_screenshot_id` plus
its own job and result ids. Today that is no rows at all, by design.

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

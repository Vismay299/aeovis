# Vendor notes — Google Search Console (`searchconsole.googleapis.com`)

> <!-- doc-status -->
> **Status: LIVE** (wired; no property connected yet as of 2026-09-15). Client:
> [`src/shared/engines/gsc.js`](../../src/shared/engines/gsc.js). Ingest:
> [`src/server/gsc/ingest.js`](../../src/server/gsc/ingest.js). Storage:
> [`src/server/db/gsc.js`](../../src/server/db/gsc.js), migration `018_gsc_daily.sql`.

**Date:** 2026-09-15 · **Task:** R4.1.1

## Where it runs

| Trigger | Chain |
|---|---|
| Cron `/api/gsc/worker`, Mondays 02:00 UTC (`vercel.json`) | `src/app/api/gsc/worker/route.js` → `runGscIngest` → `fetchDailyQueryRows` → `upsertGscDaily` |
| HTTP `GET`/`POST /api/brands/[brand]/gsc` (operator-gated) | `src/app/api/brands/[brand]/gsc/route.js` |
| Manual smoke test | `npm run test:gsc [-- example.com]` (`scripts/test-gsc.mjs`) |

## Contract

| | |
|---|---|
| Credential | `GSC_SERVICE_ACCOUNT_KEY` — the service account's JSON key, raw or base64 |
| Auth | self-signed RS256 JWT exchanged at `oauth2.googleapis.com/token`, scope `webmasters.readonly` |
| Service account | `perceev-gsc@aeovis.iam.gserviceaccount.com` |
| Request | `POST /webmasters/v3/sites/{site}/searchAnalytics/query`, dimensions `["date","query"]`, 25k rows/page, paginated by `startRow`, capped at 250k rows per pass |
| Required? | **No.** `required: false` in `src/server/vendorRegistry.js` |

## Connect flow (per brand)

1. **Property owner** opens the brand's property in Search Console →
   Settings → Users and permissions → Add user →
   `perceev-gsc@aeovis.iam.gserviceaccount.com`, permission **Restricted**.
   No OAuth, no per-client secret.
2. **Confirm access:** `npm run test:gsc` lists the property.
3. **Operator connects the brand** (needs `OPERATOR_TOKEN`):
   ```
   POST /api/brands/<brand-domain>/gsc
   { "site": "sc-domain:example.com" }   # optional; defaults to the brand domain
   ```
   The route tries `sc-domain:<bare>`, then `https://<bare>/`,
   `https://www.<bare>/`, `http://<bare>/`, and saves the first one the service
   account can read. **422** means none was readable; the body names the email
   to add and the candidates it tried.
4. The next Monday cron backfills 90 days. To ingest immediately, call
   `GET /api/gsc/worker` with `Authorization: Bearer $CRON_SECRET`.

`GET /api/brands/<brand-domain>/gsc` reports `connected`, `last_status`,
`last_error`, `last_rows_written` and `last_ingested_through`.

## Window and idempotence

- The window ends 2 days ago (GSC lag) and starts 7 days before the last
  successful `last_ingested_through`, so settling days are re-read.
  A never-ingested connection backfills 90 days.
- Rows upsert on `(brand, date, query)`; re-reading never duplicates.
- A failed pass records `last_status='failed'` and does **not** advance the
  watermark. A truncated pass (250k cap) writes what it read but does not
  advance it either.
- The cron answers **500** when the connection list is unreadable or every
  connected brand failed; 200 with `connections: 0` is a measured zero.

## Caveats

- Google drops anonymised queries from query-dimension rows. A day's summed
  `clicks` in `gsc_daily` is **not** the property total; never present it as one.
- No `system_heartbeats` tick: `/api/health` marks ticks stale after 2 hours,
  which a weekly job would always trip. Per-brand liveness lives on
  `gsc_connections.last_attempt_at` instead.

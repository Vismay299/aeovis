# Dev Runbook: Real-Surface Probe Fleet (`worker/`)

> <!-- doc-status -->
> **Status: LIVE.** Operational runbook for running the Perceev probe fleet
> on a local laptop against a non-production Supabase instance. Fulfills R1.2.5.

**Date:** 2026-09-12 · **Lane:** docs / infra · **Authority:** [worker-host ADR](../decisions/2026-09-05-worker-host.md)

---

## 1. Overview & Architecture

The probe fleet (`worker/`) is a long-lived Node.js process designed to drive real consumer AI search surfaces (such as Perplexity and ChatGPT) via Playwright browsers and write typed outcomes back to Supabase.

### Architectural Boundary
* **Independent Workspace:** `worker/` has its own `package.json` and its own dependencies (`@supabase/supabase-js`, `playwright`). It never imports from `src/app` or `next/*`.
* **Shared Logic is Copied, Not Imported:** Enforced by `src/lib/workerIsolation.test.mjs` in CI.
* **Dev Mode is Production Source:** There is no distinct "dev fleet" codebase; laptop development executes the exact production worker loop (`worker/src/index.js`) directed at non-production Supabase infrastructure.
* **Refusal Over Fabrication:** Unimplemented surface adapters (`probeBatch`) throw explicitly rather than returning artificial zero scores (Standing Rule 1: A skip is not a success).

---

## 2. Prerequisites

Before running the fleet locally, ensure your workstation has:

1. **Node.js**: `v20.x` or higher (`node -v`).
2. **npm**: `v10.x` or higher (`npm -v`).
3. **Dev Supabase Project**:
   * A dedicated non-production Supabase cloud project or local Docker Supabase instance (`npx supabase start`).
   * **Never** use production database credentials on a laptop without the explicit production override.
4. **Applied Database Migrations**:
   * Specifically migration `010_probe_tasks.sql` (implements `probe_tasks` table and `claim_probe_tasks` RPC function with `FOR UPDATE SKIP LOCKED`).
   * Migration `011_scan_runs.sql` (implements `scan_runs` ledger and `open_scan_run`, `heartbeat_scan_run`, `close_scan_run` RPC functions).

---

## 3. Environment Configuration

The fleet requires credentials with permissions to claim tasks, renew heartbeats, and write ledger rows via Postgres RPC functions.

### Configuration File: `.env.fleet.local`

Create a `.env.fleet.local` file in the repository root (or set variables directly in your terminal environment). Do not source or copy production `.env.local` keys. `npm run fleet:dev` loads `.env.local` first and `.env.fleet.local` second, so scoped dev credentials take precedence over application keys (R1.2.18).

```bash
# --- Required: Dev Supabase Credentials ---
SUPABASE_URL=https://your-dev-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-dev-service-role-key-here

# --- Ingest Authentication (R1.2.4 Section 5 Contract) ---
PROBE_INGEST_TOKEN=dev_probe_ingest_token_min_24_chars_secret

# --- Optional: Fleet Loop Controls (Sensible Defaults Apply) ---
FLEET_ENGINES=perplexity
FLEET_BATCH_SIZE=2
FLEET_IDLE_POLL_MS=10000
FLEET_LEASE_MS=300000
FLEET_HEARTBEAT_MS=30000
FLEET_WORKER_ID=laptop-worker-dev
```

### Configuration Variables Reference

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `SUPABASE_URL` | **Yes** | — | Target Supabase URL. Must point to dev/staging. |
| `SUPABASE_SERVICE_ROLE_KEY` | **Yes** | — | Service role key for queue claims and ledger writes. |
| `PROBE_INGEST_TOKEN` | Optional in dev | — | Ingest secret for `POST /api/internal/probe-results`. Minimum 24 chars. |
| `FLEET_ENGINES` | No | `perplexity` | Comma-separated engines to drive (`perplexity`, `chatgpt`). |
| `FLEET_BATCH_SIZE` | No | `2` (narrowed from 5) | Tasks claimed per batch pass. Bound by lease arithmetic. |
| `FLEET_IDLE_POLL_MS` | No | `10000` (10s) | Delay between poll attempts when the queue is empty. |
| `FLEET_LEASE_MS` | No | `300000` (5m) | Duration task claims are held before becoming reapable. |
| `FLEET_HEARTBEAT_MS` | No | `30000` (30s) | Interval for in-flight heartbeat ping to `scan_runs`. |
| `FLEET_WORKER_ID` | No | `worker-<hostname>-<pid>` | Identifier tagged on claims and ledger records. The hostname is the pod name under Kubernetes, so each pod is distinguishable; the pid distinguishes several workers on one host (R1.2.22). |

---

## 4. Step-by-Step Operator Instructions

### Step 1: Install Dependencies

From the repository root:
```bash
# Install root application dependencies
npm install

# Install isolated worker dependencies (Playwright & Supabase client)
npm --prefix worker install
```

### Step 2: Run Pre-Flight Selftest

Before connecting to the database, verify that configuration parsing, lease calculations, and ledger stubs execute cleanly:

```bash
npm run fleet:check
# Or directly:
npm --prefix worker run check
```

Expected output ends with:
```
[fleet] selftest: ledger row closed as succeeded — 0/1 probes succeeded, 1 error(s) recovered
[fleet] selftest: one pass completed — the workspace starts standalone
```

### Step 3: Verify Database Migrations

Apply pending migrations to your dev Supabase instance:
```bash
npm run setup:db
```

Ensure the following Postgres objects exist in the dev database:
* Tables: `public.probe_tasks`, `public.scan_runs`.
* Functions: `public.claim_probe_tasks`, `public.complete_probe_tasks`, `public.open_scan_run`, `public.heartbeat_scan_run`, `public.close_scan_run`.

### Step 4: Start the Fleet (One-Command)

To run the fleet against dev Supabase from the repository root:

```bash
npm run fleet:dev
```

Alternatively, from the `worker/` directory:
```bash
npm --prefix worker start
```

### Expected Boot Log Output

Upon successful startup, stdout displays:
```
[fleet] starting as laptop-worker-dev; engines=perplexity
[fleet] config: supabaseUrl=https://... supabaseKey=set engines=perplexity batchSize=2 leaseMs=300000 idlePollMs=10000 heartbeatMs=30000 workerId=laptop-worker-dev probeTimeoutMs=60000 canaryIntervalMs=3600000
config: budget perplexity (perplexity.ai): concurrency=1 delay=20000-45000ms dailyCap=400 (cap NOT ENFORCED: it is fleet-wide and no shared counter exists)
config: the budget above is VALIDATED, NOT APPLIED — no probe is paced by it yet (probeBatch has no adapter). The lease arithmetic that bounds batchSize IS enforced.
[fleet] idle heartbeat every 30000ms, worst case 40000ms between beats — 9.0x inside the sweep's 360000ms staleness threshold
[fleet] claimed 0 — the queue is empty (0 outstanding); there is nothing to do
[fleet] run <run-uuid> OPEN — probe-fleet/idle, started <time>, last heartbeat <time>
```

---

## 5. Seeding and Testing Probe Tasks

When no scans are actively submitted by web users, the queue reports that zero
tasks were claimed and keeps one open idle stretch in `scan_runs`, heartbeating
it until work arrives or the process exits. It does not insert a row per poll.

### Manually Queuing Tasks for Verification

Connect to your dev database (via Supabase Studio SQL Editor, psql, or a migration script) and insert sample tasks:

```sql
INSERT INTO probe_tasks (
  query,
  engine,
  brand,
  url,
  industry,
  status
) VALUES
  ('best crm software for startups', 'perplexity', 'Acme CRM', 'https://acmecrm.example.com', 'saas', 'pending'),
  ('top generative ai developer tools', 'perplexity', 'DevGenAI', 'https://devgen.example.com', 'devtools', 'pending');
```

On the next poll tick (within `FLEET_IDLE_POLL_MS` seconds), the worker will output:
```
[fleet] claimed 2 task(s); 2 outstanding in scope
```

---

## 6. Inspecting Execution & Ledger State

The worker logs each lifecycle transition to stdout and synchronizes execution state with Postgres.

### Check Active and Completed Runs in Supabase
Run the following SQL query in dev Supabase:
```sql
SELECT
  id,
  phase,
  outcome,
  reason,
  probes_attempted,
  probes_succeeded,
  errors_recovered,
  heartbeat_at,
  started_at,
  closed_at
FROM scan_runs
ORDER BY started_at DESC
LIMIT 10;
```

### Inspect Task Lease & Queue State
```sql
SELECT
  id,
  query,
  engine,
  status,
  lease_owner,
  lease_expires_at,
  attempts
FROM probe_tasks
ORDER BY created_at DESC;
```

---

## 7. Graceful Shutdown

To shut down the worker process:
1. Press `Ctrl+C` (or dispatch `SIGINT` / `SIGTERM`).
2. The worker traps the signal, prevents new polling cycles, finishes or releases the current batch pass, closes the `scan_runs` record, and exits:
   ```
   [fleet] SIGINT received: finishing pass in flight and stopping
   [fleet] stopped
   ```

---

## 8. Troubleshooting & Common Pitfalls

### Problem: `FleetConfigError: SUPABASE_URL is not set`
* **Cause:** Missing database connection URL.
* **Resolution:** Ensure `.env.fleet.local` exists in the repo root or export `SUPABASE_URL` in your shell.

### Problem: `PostgrestError: function claim_probe_tasks(...) does not exist`
* **Cause:** Migration `010_probe_tasks.sql` has not been applied to the dev database.
* **Resolution:** Run `npm run setup:db` to apply all migrations.

### Problem: `PostgrestError: function open_scan_run(...) does not exist`
* **Cause:** Migration `011_scan_runs.sql` has not been applied.
* **Resolution:** Run `npm run setup:db`.

### Problem: Worker Refuses to Boot with Production Error (R1.2.12 Guard)
* **Cause:** `SUPABASE_URL` or fallback values match the production database target and `FLEET_ALLOW_PRODUCTION_DB=true` was not armed.
* **Resolution:** Point `SUPABASE_URL` to your dev database. Never run dev tests against production.

### Problem: `probeBatch: unbuilt adapter throws Error`
* **Cause:** Real-surface adapters (Perplexity R1.3, ChatGPT R1.4) are under active construction.
* **Resolution:** In R1.2, this is expected behavior. Tasks are claimed and ledger records are created; adapter failures are marked as recovered errors or failed runs in `scan_runs` per design.

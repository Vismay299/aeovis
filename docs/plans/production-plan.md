# Perceev — Production Hardening & Growth Plan

**Date:** 2026-07-25
**Status:** Draft for execution — supersedes nothing; runs alongside `docs/plans/plan.md` (the P0–P7 analytics plan, of which P0–P3a + P5 are built and committed).
**Source:** the 2026-07-25 five-track production audit (77 findings: 12 critical / 31 high / 26 medium / 8 low).
**Scope decision (locked):** **authentication, multi-tenancy, and billing are explicitly OUT of scope** for this plan. We build the structure first; identity slots in later. Phase Z documents the exact seams we leave so that work is additive, not a rewrite.

---

## 1. Goal

Turn Perceev from "a project that works on the author's laptop" into "a production application" — without introducing a user model. Concretely, at the end of this plan:

1. No unauthenticated stranger can spend the owner's API budget, delete data, or reach internal networks.
2. A scan that starts always finishes (or fails loudly and recoverably) without a browser tab held open.
3. No code path can corrupt a scan's data.
4. The app survives refresh, Back, big payloads, and a bad record without a white screen.
5. The retention loop the backend already supports (recurring scans → deltas → notification) is switched on.
6. The repo contains only code that runs.

### Non-goals (this plan)

- **Authentication / user accounts / sessions.** Deferred to Phase Z.
- **Multi-tenancy / ownership columns / per-tenant RLS.** Deferred to Phase Z.
- **Billing, plans, quotas, entitlements.** Deferred to Phase Z (depends on identity).
- New answer engines (locked decision, 2026-07-23).
- Redesign of the Results Night visual language (`PRODUCT.md` / `DESIGN.md` remain authority).

### What replaces auth in the meantime

The audit's #1 critical is "31 of 32 routes are public, including every endpoint that spends money." That risk does **not** require a user model to close. Phase B installs a **single-operator perimeter**: one `middleware.js` choke point holding a shared operator token, plus rate limits, spend caps, and SSRF guards. This is deliberately the same choke point real auth will occupy later — Phase Z replaces the token check with a session check and touches nothing else.

---

## 2. Current state (verified baseline, 2026-07-25)

| Fact | Value |
|---|---|
| Branch | local `main` @ `1f1c3aa`, **11 commits ahead of `origin/main`, unpushed** |
| Tests | 629 passing (`npm run test:scoring`) — includes tests covering dead code |
| Build | `next build` green (12 routes, 35 API routes) |
| Lint | clean except 2 pre-existing `react-hooks/exhaustive-deps` warnings |
| DB | Supabase live; migrations 001–005 applied; backfill run (55 scans → 674 prompt_results, 3 667 citations, 34 metric rows) |
| Engines live | `aio`, `perplexity` (no `OPENAI_API_KEY`) |
| Cron | `vercel.json`: `/api/scan/worker` at `0 0 * * *` (daily) |
| CI | none (`.github/` absent) |
| Auth | none anywhere |

### Locked contracts this plan must not break

- **Prompt-set contract** — domain-keyed frozen sets, additive tier upgrades, fail-loud (`docs/plans/plan.md`).
- **Fail-loud** — no silent fallback that fabricates or hides data. (Phase B/C tighten this; they never loosen it.)
- **Free-model-first** — free OpenRouter model for classification/generation chores; paid models only where quality demands (content drafting).
- **Results Night** — dark-only, token-driven; charts obey role-vs-magnitude coloring.
- **Engine-count-agnostic UI** — never hardcode "three engines".

---

## 3. Phase map & dependency order

```
A ──► B ──► C ──► D ──► E
              │         │
              └────► F ─┴──► G ──► H        Z (deferred, documented only)
```

| Phase | Name | Why it comes here | Blocking? |
|---|---|---|---|
| **A** | Ground control | Nothing is safe to change without version control off-machine + a test gate | Blocks all |
| **B** | Perimeter without auth | Every hour the app is reachable is an hour of exposure | Blocks public traffic |
| **C** | Execution reliability | The "scans hang / data corrupt" class — the product's core promise | Blocks trusting any scan |
| **D** | Data layer correctness | Cheap now, expensive after more data accrues | Blocks scale |
| **E** | The great deletion | Makes every later phase faster; must follow D (D touches some of the same files) | — |
| **F** | Product credibility | The first-ten-minutes experience | — |
| **G** | Turn on the loops | Retention; mostly wiring finished backends | Needs C (reliable scans) |
| **H** | Roadmap completion | P4 / P6 / P7 from the analytics plan | Needs G |
| **Z** | Deferred | Auth, tenancy, billing | Not built |

**Rule for every step in this plan:** one step = one commit = one green `npm run test:scoring` + `next build`. If a step cannot be committed independently, it is written as sub-steps that can.

---

# Phase A — Ground control

*Goal: the work stops being one disk failure from gone, and every later change is gated by a machine.*

## A0 — Push the platform off this laptop

| | |
|---|---|
| **Why** | 11 commits (the entire analytics platform: normalized schema, chunk worker, symmetric judging, server dashboards) exist only on one disk. |
| **Risk if skipped** | Total loss of ~3 cloud sessions of work. |

- **A0.1** Confirm the remote and the diff about to be pushed:
  ```bash
  git -C . log --oneline origin/main..main
  ```
  Expect exactly 11 commits, `480fd9a`…`1f1c3aa` plus `c4b39c7`.
- **A0.2** Verify no secret is in the diff before it leaves the machine:
  ```bash
  git diff origin/main..main -- .env.example .env.local | head -20
  ```
  Expect: `.env.local` untracked (no output), `.env.example` placeholders only.
- **A0.3** Push: `git push origin main`.
- **A0.4** In the GitHub repo settings, confirm the repo is **private**.
- **Acceptance:** `git status` reports `up to date with origin/main`; GitHub shows 11 new commits.

## A1 — Normalize line endings (stop the CRLF churn)

| | |
|---|---|
| **Why** | No `.gitattributes`. Every cloud session on a different platform rewrites line endings, producing whole-file diffs that hide real changes (visible in the commit warnings from 2026-07-24). |

- **A1.1** Create `.gitattributes` at repo root:
  ```
  * text=auto eol=lf
  *.png binary
  *.jpg binary
  *.ico binary
  *.woff binary
  *.woff2 binary
  *.db binary
  ```
- **A1.2** Renormalize the working tree in one isolated commit (so it never mixes with a logic change):
  ```bash
  git add --renormalize .
  git commit -m "chore: normalize line endings via .gitattributes"
  ```
- **A1.3** Confirm the next unrelated edit produces a small diff (`git diff --stat` on a one-line change = 1 line).
- **Acceptance:** a one-character edit to any `.js` file yields a 1-line diff, not a whole-file diff.

## A2 — Continuous integration

| | |
|---|---|
| **Why** | Nothing runs the 629 tests except a human remembering to. A bad push is currently detected by users. |

- **A2.1** Create `.github/workflows/ci.yml`:
  - Triggers: `push` to `main`, `pull_request`.
  - Node 20 (matches Vercel's Node 20/22 default; pin explicitly).
  - Steps: `npm ci` → `npm run lint` → `npm test` → `npm run build`.
  - `env:` block supplying **placeholder** Supabase/API values so the build doesn't need real secrets (the build must not call out — verify `next build` succeeds with dummy envs before relying on this).
- **A2.2** Add the missing npm scripts to `package.json`:
  ```json
  "test": "npm run test:unit",
  "test:unit": "node --test \"src/**/*.test.mjs\"",
  "typecheck": "tsc --noEmit -p jsconfig.json"
  ```
  *(`test:scoring` is misnamed — it runs the whole suite. Keep it as an alias for one release, then delete. `typecheck` is a no-op until E5 turns on `checkJs`; add it now so CI wiring is done once.)*
- **A2.3** Verify the glob in `test:unit` picks up all 38 test files: `node --test "src/**/*.test.mjs"` → expect ≥629 passing.
- **A2.4** In GitHub → Settings → Branches, add a protection rule on `main` requiring the `ci` check to pass.
- **A2.5** Add a status badge to `README.md`.
- **Acceptance:** a deliberately broken test on a scratch branch blocks the PR; reverting unblocks it.

## A3 — Remove repo debris

| | |
|---|---|
| **Why** | Tracked artifacts from the pre-Next.js Python era and an old SQLite DB make the repo read as a prototype and confuse file search. |

- **A3.1** Verify each is genuinely dead before deleting (grep for any importer):
  - `data/aeo.db` (12 KB SQLite; no `sqlite`/`better-sqlite3` dependency exists)
  - `tests/test_aio_scan.py` (Python; no Python runtime in the project)
  - `test_reports/` (`iteration_1.json`, `pytest/pytest_results.xml`)
  - `memory/PRD.md` (Feb-2026 "AnswerRank" PRD — superseded by `PRODUCT.md`)
  - `memory/test_credentials.md` (verified: contains **no live secrets** — only env-var *names* and a test brand; still misleading by filename)
- **A3.2** Preserve anything historically useful first: if `memory/PRD.md` holds decisions not in `PRODUCT.md`, move them into `docs/` rather than deleting.
- **A3.3** `git rm -r data tests test_reports memory` and commit as `chore: remove pre-Next.js era artifacts`.
- **A3.4** Add to `.gitignore`: `*.db`, `test_reports/`.
- **Acceptance:** `git ls-files | wc -l` drops by 6; build and tests unaffected.

## A4 — Central config + fail-fast environment validation

| | |
|---|---|
| **Why** | 28+ tunables live in 12 files with live duplicates (`CADENCE_MS` ×2, `SERP_GEO` ×2, two engine registries reading *different* env vars). Worse: the two most catastrophic misconfigurations — missing Supabase URL/key and missing `OPENROUTER_API_KEY` — **degrade silently** (`db.js:4` yields a null client → per-instance memory mode; `openrouter.js:19` returns `{text:""}`), which is a direct violation of the fail-loud contract. |

- **A4.1** Create `src/lib/config.js` exporting one frozen object. Do **not** change behavior yet — mirror today's defaults exactly:
  ```js
  export const config = Object.freeze({
    scan: { chunkBudgetMs: 150_000, heartbeatStaleMs: 180_000, maxSourcingAttempts: 3,
            promptTargetDefault: 30, promptTargetMin: 10, promptTargetMax: 100,
            probeRuns: 3, maxConcurrentResumes: 3 },
    engines: { enabled: parseEngines(process.env.ENGINES), weights: { aio: 1, chatgpt: 1, perplexity: 1 },
               concurrency: { aio: 6, chatgpt: 4, perplexity: 4 } },
    gates: { aioErrorRatePct: 50, aioCoverage: 0.15, minSample: 5 },
    cost: { aioPerProbe: 0.0015, chatgptPerProbe: 0.01, contentMaxPerItem: 0.15 },
    timeouts: { brightdataMs: 60_000, brightdataRetries: 2, openaiMs: 45_000, openaiRetries: 2 },
    caps: { citationsRead: 5000, resultBrandsRead: 5000, metricsSeries: 400 },
    geo: process.env.SERP_GEO || "in",
  });
  ```
- **A4.2** Create `src/lib/env.js` with `assertEnv()`:
  - **Hard-required in production** (throw at boot): `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `OPENROUTER_API_KEY`, `BRIGHTDATA_API_KEY` (when `aio` enabled), `CRON_SECRET`, `OPERATOR_TOKEN` (added in B1).
  - **Conditionally required**: `OPENAI_API_KEY` if `ENGINES` includes `chatgpt`; `PERPLEXITY_API_KEY` if it includes `perplexity`; `CONTENT_MODEL` if content routes are used.
  - **Optional with defaults**: everything else, logged once at boot as a resolved summary.
  - In development, downgrade throws to a single loud warning block so local work without keys still runs.
- **A4.3** Call `assertEnv()` from `src/app/layout.js` (server component, runs once per cold start) **and** at the top of `runScanChunk`.
- **A4.4** Replace `openrouter.js`'s silent `{text:""}` return with a thrown error when the key is missing — silence here corrupts prompt generation invisibly.
- **A4.5** Delete the dead second engine registry `src/lib/engines/types.js` (`getEnabledEngines`, `ENGINES_ENABLED`, `PROBE_MODE`) — it is a divergent, unused gating implementation. *(Full deletion happens in E1; if E1 has not run yet, at minimum add a header comment marking it dead.)*
- **A4.6** Update `.env.example` with the variables it is currently missing: `PROMPT_TARGET`, `PROBE_RUNS`, `NEXT_PUBLIC_APP_URL`, `BRIGHTDATA_SERP_ZONE`, `CRON_SECRET`, `OPERATOR_TOKEN`, `SENTRY_DSN`, `RESEND_API_KEY`, `ALERT_EMAIL_TO`. Group by required/optional with a comment marking which are needed in production.
- **A4.7** Write `src/lib/env.test.mjs`: missing required var throws in prod mode; warns in dev mode; conditional rules fire per `ENGINES` value.
- **Acceptance:** deploying with `OPENROUTER_API_KEY` unset fails the boot with a named error instead of producing empty scans.

## A5 — Migration ledger

| | |
|---|---|
| **Why** | Migrations reach production only when a human runs `npm run setup:db`; `scripts/setup-supabase.mjs:52-66` re-applies **all** `.sql` files every run and relies on `IF NOT EXISTS` idempotency. There is no applied-tracking, no down-migration, no transaction per file. Any future non-idempotent migration breaks re-runs. |

- **A5.1** Add a `schema_migrations` table (in the next migration file, `006`):
  ```sql
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now(),
    checksum text
  );
  ```
- **A5.2** Rewrite `scripts/setup-supabase.mjs` to: read `supabase/migrations/*.sql` sorted → skip versions already in `schema_migrations` → wrap each file in `BEGIN/COMMIT` → insert the version row inside that transaction → stop on first failure with the file name.
- **A5.3** Seed the ledger with `001`–`005` as already-applied (they are live) so the first run of the new script is a no-op.
- **A5.4** Add `npm run migrate` (apply) and `npm run migrate:status` (list applied vs pending).
- **A5.5** Document the deploy sequence in `README.md`: migrate **before** deploying code that depends on the new schema.
- **Acceptance:** `npm run migrate:status` lists 001–006 applied, 0 pending; a second `npm run migrate` is a no-op.

---

# Phase B — Perimeter without authentication

*Goal: close every hole an anonymous stranger can exploit, using a single-operator shared secret rather than a user model. Every control here is designed to be replaced by, not rewritten for, real auth.*

> **Design principle for this phase:** one choke point. All access control lives in `src/middleware.js`. Phase Z swaps the token check inside it for a session check; no route file changes again.

## B1 — The operator gate (`middleware.js`)

| | |
|---|---|
| **Why** | 31 of 32 API routes are internet-open, including `POST /api/scan` (Bright Data + LLM spend), `POST /api/content` (paid Claude), `GET /api/content/worker?batch=1` (**zero** auth, enqueues paid jobs), and destructive `DELETE /api/agents/[id]` and `/api/knowledge/[id]`. |
| **Approach** | A shared `OPERATOR_TOKEN`, presented as an httpOnly cookie set by a tiny unlock page, or as a bearer header for programmatic use. No users, no sessions table, no DB. |

- **B1.1** Decide the public surface. Recommended split:
  - **Public (no token):** `/` (landing), `/scan` marketing shell, static assets, `/api/industries`, `robots.txt`/`sitemap.xml`.
  - **Gated (token required):** everything under `/dashboard`, `/api/**` except the public list above and the separately-secured cron endpoints.
  - Rationale: keeps the funnel demo-able while sealing all spend and all data.
  - *Note:* gating `POST /api/scan` means the public landing CTA cannot itself start a scan. Until Phase Z, that is correct — a public scan button is an open spend endpoint. Phase F4's funnel work targets the operator flow; a public "request a scan" flow returns with Phase Z.
- **B1.2** Create `src/middleware.js`:
  ```js
  import { NextResponse } from "next/server";
  export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
  export function middleware(req) { /* allowlist → cookie/bearer check → 401 or next() */ }
  ```
  - Compare tokens with a **timing-safe** comparison, not `===`.
  - Return `401` JSON for `/api/**`, redirect to `/unlock` for page routes.
  - **Fail closed in production**: if `OPERATOR_TOKEN` is unset and `process.env.VERCEL_ENV === "production"`, deny everything with a clear message. In development, allow with a one-time warning.
- **B1.3** Create `src/app/unlock/page.js`: a single password field that POSTs to `src/app/api/unlock/route.js`, which sets an httpOnly, `Secure`, `SameSite=Lax` cookie on match and rate-limits attempts (B3).
- **B1.4** Confirm the cron endpoints are **excluded from the operator gate** (they carry `CRON_SECRET` instead — B2) so the scheduler keeps working.
- **B1.5** Manually verify each of the 12 spend/mutation routes returns 401 without the cookie and 200 with it. Record the results in a table in the PR description.
- **B1.6** Write `src/middleware.test.mjs` (or a route-level test): allowlisted path passes; gated path without token → 401; with valid token → pass; production + missing token → deny.
- **Acceptance:** `curl -X POST https://<deploy>/api/scan -d '{"brand":"x"}'` returns 401; the same with the operator cookie returns 201.

## B2 — Harden the cron gate

| | |
|---|---|
| **Why** | `src/app/api/scan/worker/route.js:41` authorizes **any** request carrying an `x-vercel-cron` header *before* checking the secret — trivially spoofable if the platform does not strip client copies. `:45` accepts the secret in `?secret=`, which lands in access logs, browser history, and `Referer`. `:31-40` **fails open** when `CRON_SECRET` is unset. And `/api/content/worker` has no gate at all. |

- **B2.1** In `worker/route.js`, delete the `x-vercel-cron` branch (line 41). Vercel Cron sends `Authorization: Bearer $CRON_SECRET`, which the existing bearer branch already accepts.
- **B2.2** Delete the `searchParams.get("secret")` branch (line 45). Header-only.
- **B2.3** Change `isAuthorized` to fail **closed** when the secret is unset and `VERCEL_ENV === "production"`; keep the permissive dev path behind an explicit `NODE_ENV !== "production"` check.
- **B2.4** Extract this into `src/lib/cronAuth.js` so it is written once, then apply it to `src/app/api/content/worker/route.js` (currently ungated — the single worst gap: `?batch=1` enqueues paid content jobs).
- **B2.5** Add `/api/content/worker` to `vercel.json` crons (see C2) so content jobs get the same rescue as scans — today they have **none**, so a frozen content kick is stuck forever.
- **B2.6** Update `scanWorker.js`'s self-continue fetch (`:319`) to send the bearer header (it currently constructs a URL — verify it does not rely on `?secret=`).
- **B2.7** Tests in `src/lib/cronAuth.test.mjs`: spoofed `x-vercel-cron` → 401; `?secret=` → 401; correct bearer → pass; unset secret in prod → 401; unset in dev → pass with warning.
- **Acceptance:** `curl -H 'x-vercel-cron: 1' https://<deploy>/api/scan/worker` returns 401.

## B3 — Rate limiting

| | |
|---|---|
| **Why** | No route has any throttle. Combined with B1's token this is much less severe, but the unlock endpoint is brute-forceable and any future public endpoint needs a limiter. |

- **B3.1** Choose the mechanism. Recommended: **Vercel Firewall** rules (platform-level, zero code, no dependency) for blunt per-IP limits on `/api/*`, plus an in-DB limiter for precise per-brand rules. If Firewall is unavailable on the plan, use a Supabase-backed limiter (below) for both.
- **B3.2** Create table (migration 006):
  ```sql
  CREATE TABLE IF NOT EXISTS rate_limits (
    bucket text PRIMARY KEY,        -- e.g. "unlock:1.2.3.4" or "scan:acme.com"
    count int NOT NULL DEFAULT 0,
    window_start timestamptz NOT NULL DEFAULT now()
  );
  ```
- **B3.3** Create `src/lib/rateLimit.js` with `checkLimit(bucket, max, windowMs)` implemented as a single atomic upsert-and-increment (a Postgres function, so two concurrent calls cannot both pass).
- **B3.4** Apply: `/api/unlock` (5 attempts / 15 min / IP), `POST /api/scan` (10 / hour / IP), `POST /api/content` (20 / hour / IP).
- **B3.5** Return `429` with a `Retry-After` header.
- **B3.6** Tests: limit reached → 429; window expiry resets; concurrent calls do not double-pass.
- **Acceptance:** 6 rapid wrong-password posts to `/api/unlock` return 429.

## B4 — SSRF containment

| | |
|---|---|
| **Why** | Two live holes. (1) `crawlability/route.js:142-151`'s `isSafeDomain` blocks `10.`/`192.168.`/`172.16-31.` and exact `127.0.0.1`, but **not** `169.254.169.254` (cloud metadata), `127.0.0.2`/`127.1`, `100.64/10` (CGNAT), or `[::1]`; it is a *string* check so DNS rebinding defeats it; and the fetch uses `redirect: "follow"` (`:201`, `:222`) so an attacker's `robots.txt` can 302 to an internal host. (2) `src/lib/firecrawl.js:66` has **no guard at all** and falls back to a direct server-side `fetch(normalizedUrl)` — reachable via `POST /api/knowledge` (type `url`), the scan `url` field, and the content research step. |

- **B4.1** Create `src/lib/safeFetch.js` exporting `assertSafeUrl(url)` and `safeFetch(url, opts)`:
  1. Parse; require protocol `http:`/`https:`; reject credentials in the URL; reject non-standard ports (allow 80/443 only).
  2. **Resolve DNS** (`node:dns/promises` `lookup(hostname, { all: true })`).
  3. Reject if **any** resolved address is private, loopback, link-local (`169.254/16`, `fe80::/10`), CGNAT (`100.64/10`), unique-local (`fc00::/7`), broadcast/multicast, or `0.0.0.0/8`. Use an explicit IP-range check over parsed octets — not string prefixes.
  4. Fetch with `redirect: "manual"`; on a 3xx, re-run steps 1–3 against the `Location` and follow manually, capped at 3 hops.
  5. Enforce a timeout (`AbortSignal.timeout`) and a response-size cap (stream and abort past ~2 MB) so a hostile endpoint cannot hang or exhaust memory.
- **B4.2** Replace the ad-hoc guard in `crawlability/route.js` with `safeFetch` for both the primary domain and every `?compare=` rival.
- **B4.3** Apply `assertSafeUrl` in `src/lib/firecrawl.js` before the Firecrawl call **and** before the direct-fetch fallback.
- **B4.4** Apply at the entry points that accept user URLs: `POST /api/knowledge` (url type), `POST /api/scan` (`url` field), `src/lib/content/steps/research.js`.
- **B4.5** Tests in `src/lib/safeFetch.test.mjs` — each must be rejected: `http://169.254.169.254/latest/meta-data/`, `http://127.1/`, `http://[::1]/`, `http://100.64.0.1/`, `http://localhost:22/`, a host resolving to `10.0.0.5`, and a public URL that 302s to `http://169.254.169.254/`. Public URLs must pass.
- **Acceptance:** `GET /api/brands/169.254.169.254/crawlability` (with operator token) returns a validation error, not a metadata document.

## B5 — Spend caps and the spend ledger

| | |
|---|---|
| **Why** | The content pipeline has a hard per-item cap (`contentWorker.js:63`), but the scan path only *accumulates* cost (`scanWorker.js:445,642`) — nothing aborts a runaway. `PROMPT_TARGET`(≤100) × engines × `PROBE_RUNS`(3) has no ceiling and no daily budget. |

- **B5.1** Add a spend ledger (migration 006) — this also becomes the metering foundation later:
  ```sql
  CREATE TABLE IF NOT EXISTS spend_events (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    brand text, job_id uuid, kind text NOT NULL,      -- probe_aio | probe_chatgpt | llm_content | ...
    usd numeric(10,5) NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_spend_created ON spend_events (created_at DESC);
  ```
- **B5.2** Write a spend row at each existing cost-accumulation point in `scanWorker.js` and `contentWorker.js` (do not invent new cost math — reuse the constants already there, now sourced from `config.js`).
- **B5.3** Add `assertUnderScanCost(jobStats)` mirroring content's `assertUnderCostCap`, checked **after each probing batch**; abort the job with a clear `cost_exceeded` failure when over `config.cost.scanMaxPerJob` (new env `SCAN_MAX_COST`, default e.g. `1.00`).
- **B5.4** Add a **global daily ceiling**: before creating any job (`POST /api/scan`, and `runSchedulerTick`), sum `spend_events` for the current IST day; if over `DAILY_SPEND_CAP`, refuse with `429` and log loudly. This is the single control that bounds a runaway scheduler.
- **B5.5** Tests: per-job cap aborts mid-probing and marks the job failed with the right message; daily cap blocks job creation; ledger rows sum correctly.
- **Acceptance:** with `DAILY_SPEND_CAP=0`, `POST /api/scan` refuses with a spend-cap error.

## B6 — Double-submit protection

| | |
|---|---|
| **Why** | `hasActiveScanForBrand` (`db.js:332`) is a read and `createScanJob` (`db.js:288`) is a separate write, with no unique constraint behind them (TOCTOU). Two near-simultaneous submits both pass the check → two jobs → 2× spend. The same pattern exists in `content/route.js:78`. Also `db.js:355-360` fails **open** on a DB error, which compounds this during a Supabase blip. |

- **B6.1** Add a partial unique index (migration 006):
  ```sql
  CREATE UNIQUE INDEX IF NOT EXISTS uniq_active_scan_per_brand
    ON scan_jobs (lower(brand))
    WHERE status NOT IN ('complete','failed');
  ```
- **B6.2** Change `createScanJob` to treat a unique-violation (`23505`) as the 409 "already running" case rather than an error — the DB, not the read, becomes the arbiter.
- **B6.3** Keep `hasActiveScanForBrand` as a fast pre-check for a friendly message, but it is no longer the guarantee.
- **B6.4** Apply the same pattern to content jobs.
- **B6.5** Test: two concurrent `createScanJob` calls for one brand → exactly one row, the loser sees the conflict path.
- **Acceptance:** double-clicking Run in the UI produces one job.

## B7 — Security headers

- **B7.1** Add a `headers()` block to `next.config.mjs` applying to all routes: `Strict-Transport-Security` (2 years, includeSubDomains, preload), `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` (deny camera/microphone/geolocation).
- **B7.2** Add `poweredByHeader: false`.
- **B7.3** Add a Content-Security-Policy. Start in `Content-Security-Policy-Report-Only` mode because the app uses extensive inline styles (926 `style={{}}` usages) — a strict `style-src` will otherwise break the UI. Iterate to enforcing.
- **B7.4** Verify with `curl -I` against a deploy, and re-check the dashboard renders identically.
- **Acceptance:** all five headers present; no console CSP violations in normal use.

## B8 — Remaining input/output hygiene

- **B8.1** **Prompt injection surface** — `opportunities/route.js:12-27` interpolates attacker-controlled `brand` and `gaps[]` straight into a Gemini prompt. Bound the input lengths, strip control characters, and wrap user values in clearly delimited blocks with an instruction that content inside is data, not instructions. (This route is superseded by P7 typed opportunities in Phase H; if the decision is to retire it, do that instead.)
- **B8.2** **Stored injection** — `knowledge`/`brand-briefs` content flows verbatim into content-pipeline prompts. Apply the same delimiting at the prompt-assembly site (`src/lib/content/steps/*`), not at the storage site.
- **B8.3** **`javascript:` URIs** — `src/components/studio/Markdown.jsx:24-33` renders `href={m[2]}` from LLM/scraped markdown with no scheme check. Allowlist `http:`, `https:`, `mailto:`; render anything else as plain text.
- **B8.4** **Wildcard over-fetch** — `db.js:178,350` use `.ilike("brand", brand)`, so `brand=%` returns every brand's scans. Switch to `.eq()` on the normalized key (this lands properly in D3) or escape `%`/`_` now as an interim.
- **B8.5** **Internal errors leaking to clients** — `scanWorker.js:1031` stores `err.message` in `job.error_message`, which `status/route.js:57` returns to the browser (raw Bright Data/DB text). Map to a small set of user-safe messages (`source_unavailable`, `cost_exceeded`, `internal`); log the raw text server-side with the job id.
- **B8.6** **Side-effecting GET** — `status/route.js:44-48` can trigger a paid rescue chunk on a plain poll. With the operator gate this is no longer anonymous, but keep spend off idempotent GETs: once C2 lands a frequent cron, remove the poll-rescue entirely, or require an explicit `?rescue=1` from the client.
- **Acceptance:** a failed scan shows "The answer-engine source was unavailable" in the UI, with the raw error only in server logs.

## B9 — Dependency patching

- **B9.1** Run `npm audit` and record the baseline (currently **6 high**: `next@14.2.35` — rewrites SSRF, unauthenticated Server-Function endpoint disclosure, unbounded Server Action payload; plus bundled `postcss` — XSS and path traversal).
- **B9.2** `npm audit fix` for anything non-breaking; re-run tests + build.
- **B9.3** Bump Next within 14.2.x to the latest patch (the Server-Function advisory is patched in later 14.2.x). Verify the App Router behavior is unchanged; run the full suite and a manual dashboard pass.
- **B9.4** Defer the Next 15 major to E7 (after CI exists to catch regressions).
- **B9.5** Add a scheduled weekly `npm audit` job to the CI workflow that opens an issue on new highs.
- **Acceptance:** `npm audit` reports 0 high/critical, or a written justification for each remaining one.

## B10 — Reduce the Supabase blast radius (without auth)

| | |
|---|---|
| **Why** | Every migration ships `FOR ALL TO anon USING (true) WITH CHECK (true)` on all 18 tables (`001:118`, `004:36`, `005:133-163`). The anon key is a `NEXT_PUBLIC_` value. Today it happens to be referenced only server-side, so the practical exposure is via the open API routes (closed by B1) — but the policy is a landmine the instant the key reaches the browser. **This can be substantially fixed without introducing users.** |

- **B10.1** Confirm no client component imports `@/lib/db` or creates a Supabase client (the security audit found none — re-verify with a grep before proceeding, since the fix depends on it).
- **B10.2** Add `SUPABASE_SERVICE_ROLE_KEY` (server-only, **not** `NEXT_PUBLIC_`) to env and Vercel.
- **B10.3** In `src/lib/db.js`, create the client with the service-role key when present, falling back to anon for local dev. Add a guard that throws if this module is ever evaluated in a browser bundle (`typeof window !== "undefined"`).
- **B10.4** Once all traffic uses the service-role key, replace the anon policies in a new migration: drop `FOR ALL TO anon` and grant nothing to `anon` (service-role bypasses RLS by design). Do this **after** B10.3 is deployed and verified, in a separate migration, so a rollback is one file.
- **B10.5** Rotate the anon key.
- **B10.6** Document in the migration header that per-tenant policies replace this in Phase Z — the ownership column, not the anon grant, becomes the boundary.
- **Acceptance:** with the anon key alone (curl against the Supabase REST endpoint), `select * from scans` returns zero rows / permission denied; the app continues to work.

---

# Phase C — Execution reliability

*Goal: a scan that starts always finishes, or fails in a way that can be resumed. No code path can leave the database half-written.*

> This phase fixes the class of problem behind "a lot of things are not working." The chunk worker's internals are sound — the failures are at the platform boundary it cannot see.

## C1 — Keep background work alive (`waitUntil`)

| | |
|---|---|
| **Why** | **This is the single highest-impact fix in the plan.** Every job advancement is a bare fire-and-forget promise after the HTTP response: `scan/route.js:34`, `scan/worker/route.js:100`, `content/route.js:99`, `scanWorker.js:1091` (scheduler kick) and `:322` (self-continue). Vercel may freeze or recycle the instance the moment the response returns — the promise then never runs. There is no `waitUntil` anywhere in `src/`. |
| **Consequence today** | The kick silently dies; the job sits until something else advances it. With the tab closed and a daily cron, that is **up to 24 hours**, and the cron only resumes 3 jobs per invocation. |

- **C1.1** `npm install @vercel/functions`.
- **C1.2** In `src/app/api/scan/route.js`, wrap the kick:
  ```js
  import { waitUntil } from "@vercel/functions";
  waitUntil(runScanChunk(job.id).catch(err => console.error(...)));
  ```
  Keep the `.catch` — `waitUntil` does not swallow rejections.
- **C1.3** Same in `src/app/api/scan/worker/route.js:100` (each resumed job) and `src/app/api/content/route.js:99`.
- **C1.4** Same for the scheduler's per-schedule kick in `scanWorker.js:1091`.
- **C1.5** The self-continue fetch (`scanWorker.js:322`) is a `fetch` to the worker route, not a promise to keep alive — leave it, but confirm it awaits the response initiation before the handler returns (otherwise the fetch itself is subject to the same freeze). Wrap it in `waitUntil` too.
- **C1.6** Verify `maxDuration = 300` is set on every route that now holds work open: `/api/scan` (has it), `/api/scan/worker` (has it), `/api/content`, `/api/content/worker` (check and add).
- **C1.7** **Verification is non-trivial and matters more than the code.** Deploy to a preview, `POST /api/scan`, close the tab immediately, and confirm from the Vercel function logs that the chunk continued past the response. Repeat 3×.
- **C1.8** Add a note in `scanWorker.js`'s header comment that any new fire-and-forget must be wrapped.
- **Acceptance:** a scan submitted and immediately abandoned reaches `complete` without any poll or cron intervention.

## C2 — Cron cadence

| | |
|---|---|
| **Why** | `vercel.json` runs the worker at `0 0 * * *` — **once a day**. That single tick is the only thing that (a) rescues jobs when no browser is polling and (b) fires due `scan_schedules`. So rescue latency is up to 24 h, throughput is 3 jobs/day, and every cadence ("72h", "daily", "weekly") collapses to "checked once a day". Sub-daily scheduling is impossible. |
| **Constraint** | Vercel Hobby permits only daily crons. |

- **C2.1** Decide the mechanism. Two viable options:
  - **(a) GitHub Actions scheduled workflow** — free, no plan change. A workflow on `*/10 * * * *` curls `https://<prod>/api/scan/worker` with the `Authorization: Bearer ${{ secrets.CRON_SECRET }}` header. Note GH Actions cron is best-effort and can drift several minutes under load — acceptable for rescue.
  - **(b) Vercel Pro** — native `*/10 * * * *` crons, more reliable timing, ~$20/mo.
  - **Recommendation:** (a) now (Phase A already establishes Actions), (b) when revenue justifies it.
- **C2.2** Implement the chosen pinger; keep the daily `vercel.json` entry as a backstop.
- **C2.3** Add `/api/content/worker` to the same schedule (content jobs currently have **no** scheduled rescue at all).
- **C2.4** Raise `MAX_CONCURRENT_RESUMES` (`worker/route.js:13`) now that ticks are frequent — but bound it against the daily spend cap (B5.4). Suggest 5, and order the sweep oldest-first (`.order("created_at")`) so no job starves; today `.limit(20)` has no ordering.
- **C2.5** Once ticks are frequent, remove the poll-driven rescue from `status/route.js` (B8.6) — it exists only to compensate for the daily cron.
- **C2.6** Add a self-check: if the worker has not run in > 30 min, surface it on the health endpoint (C7).
- **Acceptance:** worker logs show invocations ~every 10 minutes; a deliberately stalled job is picked up within one interval.

## C3 — Make finalize atomic (the data-corruption fix)

| | |
|---|---|
| **Why** | `runFinalizePhase` performs ~6 sequential un-transactioned writes (`scanWorker.js:763` insertScan → `:779` stampScanId → `:790` deleteCitations → `:840` insertCitations → `:868` deleteResultBrands → `:914` insertResultBrands → `:929` upsertMetrics → job complete). Supabase-js has **no transaction API** and the repo has zero `.rpc()` calls. A throw after `:790` leaves citations **emptied**; the outer catch marks the job `failed` (`:1028`); `shouldRescueJob` (`:291`) excludes `failed` — so it **never auto-recovers**. A `scans` row exists with no citations and no rollups, permanently. |

- **C3.1** Write the Postgres function in migration `007_finalize_rpc.sql`. Sketch:
  ```sql
  CREATE OR REPLACE FUNCTION finalize_scan(
    p_job_id uuid, p_scan jsonb, p_citations jsonb,
    p_result_brands jsonb, p_metrics jsonb
  ) RETURNS uuid LANGUAGE plpgsql AS $$
  DECLARE v_scan_id uuid;
  BEGIN
    SELECT scan_id INTO v_scan_id FROM prompt_results
      WHERE job_id = p_job_id AND scan_id IS NOT NULL LIMIT 1;
    IF v_scan_id IS NULL THEN
      INSERT INTO scans SELECT * FROM jsonb_populate_record(NULL::scans, p_scan)
        RETURNING id INTO v_scan_id;
    END IF;
    UPDATE prompt_results SET scan_id = v_scan_id WHERE job_id = p_job_id;
    DELETE FROM citations WHERE job_id = p_job_id;
    INSERT INTO citations SELECT * FROM jsonb_populate_recordset(NULL::citations, p_citations);
    DELETE FROM result_brands WHERE result_id IN
      (SELECT id FROM prompt_results WHERE job_id = p_job_id);
    INSERT INTO result_brands SELECT * FROM jsonb_populate_recordset(NULL::result_brands, p_result_brands);
    INSERT INTO brand_metrics_daily SELECT * FROM jsonb_populate_recordset(NULL::brand_metrics_daily, p_metrics)
      ON CONFLICT (brand, date, engine) DO UPDATE SET /* … */;
    UPDATE scan_jobs SET status='complete', result_id=v_scan_id, progress_pct=100,
      heartbeat_at=now() WHERE id=p_job_id;
    RETURN v_scan_id;
  END $$;
  ```
  A plpgsql function body is one implicit transaction — any raise rolls the whole set back.
- **C3.2** **Keep the JS sequence.** The in-memory dev mode (no Supabase) and all 40 `scanChunk.test.mjs` tests exercise the JS path. Inject the strategy: `deps.finalizeAtomic` defaults to the RPC when a real client exists, and to the existing JS sequence otherwise. Do not delete the JS path.
- **C3.3** Rewrite `runFinalizePhase` to build the five payloads (it already builds all of them) and make **one** `supabase.rpc("finalize_scan", …)` call.
- **C3.4** Payload-size check: a 100-prompt × 3-engine scan's citations array can be large. Measure the worst-case JSON size; if it approaches request limits, split citations into a batched pre-insert into a staging table with the swap inside the RPC. Do this measurement **before** finalizing the design.
- **C3.5** Column drift: `jsonb_populate_record(NULL::scans, …)` requires payload keys to match column names exactly. Assert this in a test that inserts via RPC and reads back every column.
- **C3.6** Tests: RPC path produces byte-identical rows to the JS path for the same input (run both, compare); a forced mid-function error leaves **zero** partial rows; re-finalize after a crash is idempotent.
- **Acceptance:** killing the process mid-finalize (simulated via a raising trigger) leaves the DB exactly as before the call.

## C4 — Recoverable failures

| | |
|---|---|
| **Why** | `failed` is terminal and excluded from rescue (`scanWorker.js:291`), so any transient failure — a Supabase blip, a Bright Data 429 — permanently kills a scan that has already spent money on probing. |

- **C4.1** Introduce a distinction between **terminal** failures (bad input, cost exceeded, prompt-set contract violation) and **transient** ones (network, 5xx, DB unavailable). Add a `failure_kind` column to `scan_jobs` (migration 006).
- **C4.2** Add `retry_count` and `next_retry_at`. On a transient failure, set `status='failed'`, `failure_kind='transient'`, `next_retry_at = now() + backoff(retry_count)` with exponential backoff capped at, say, 3 attempts.
- **C4.3** Extend `shouldRescueJob` to include `failed` jobs with `failure_kind='transient'`, `retry_count < 3`, and `next_retry_at <= now()`.
- **C4.4** Because probing is resumable and finalize is idempotent (C3), a retry costs only the un-probed remainder — verify this in a test that fails a job mid-probing and confirms the retry does not re-probe completed pairs.
- **C4.5** Surface `failure_kind` and retry state in the status response and the UI ("Retrying — attempt 2 of 3").
- **C4.6** Add a one-shot repair script `scripts/repair-scan.mjs <job_id>` for the operator to force a re-finalize of an existing damaged job.
- **Acceptance:** a job failed by a simulated Supabase outage self-recovers on the next worker tick.

## C5 — Single-flight the probing phase

| | |
|---|---|
| **Why** | Sourcing (`:994`) and finalize (`:577`) claim their phase transition with `claimJobStatus`, but **probing does not**. A batch exceeding the 180 s heartbeat window plus a concurrent poll/cron rescue means two chunks probe the same job simultaneously. The `(job_id, engine, query)` unique constraint prevents duplicate rows, but both invocations still **pay** for the in-flight pairs. |

- **C5.1** Add a lightweight lease: `scan_jobs.probing_lease_until timestamptz` (migration 006).
- **C5.2** At the top of `runProbingPhase`, atomically claim the lease with a conditional update (`WHERE probing_lease_until IS NULL OR probing_lease_until < now()`), setting it to `now() + 200s`. If the claim fails, return a `busy` result without probing.
- **C5.3** Refresh the lease alongside the existing heartbeat write after each batch.
- **C5.4** Clear the lease when the phase yields or completes.
- **C5.5** Test: two concurrent `runScanChunk` calls on one probing job → exactly one probes, the other returns `busy`; the lease expires so a genuinely dead chunk does not wedge the job.
- **Acceptance:** concurrent rescue + poll on the same job issues one set of probe calls.

## C6 — Scheduler correctness

| | |
|---|---|
| **Why** | Two defects. (1) **Herd:** `runSchedulerTick` (`:1055-1094`) loops *all* due schedules and kicks each with no concurrency cap — unlike the 3-cap on resumes — so many brands due at the same tick fire simultaneously. (2) **Drift:** `computeNextRunAt` anchors to the actual `nowIso` (`:1088`) rather than the previous scheduled slot, so a late tick pushes every subsequent run later, cumulatively. |

- **C6.1** Cap scheduled starts per tick (suggest 3), oldest `next_run_at` first, and check the daily spend cap (B5.4) before each.
- **C6.2** Anchor the next run to `previous_slot + cadence`, and add ±5 min jitter so brands created together do not stay synchronized forever.
- **C6.3** Confirm the existing "bump `next_run_at` **before** the kick" ordering is preserved (it is correct — it prevents a crash loop re-firing the same schedule).
- **C6.4** Consolidate the duplicated `computeNextRunAt`/`CADENCE_MS` — currently in both `scanWorker.js:275,67` (no `off`) and `brandAnalyticsApi.js:115,97` (has `off`). Move to one module; note the two versions **differ**, so reconcile deliberately rather than picking one.
- **C6.5** Tests: 10 due schedules → 3 started, 7 remain due; drift test (a tick 90 min late still schedules the next run on the original slot grid); jitter stays within bounds.
- **Acceptance:** 10 brands on daily cadence spread across ticks instead of firing together.

## C7 — Observability floor

| | |
|---|---|
| **Why** | 175 unstructured `console.*` calls in `src/`, no error tracker, no metrics, no health endpoint, no spend/scan audit surface. When a customer says "my scan hung," the operator's only tool is grepping Vercel text logs for a job id the customer does not have. MTTR is poor. |

- **C7.1** Create `src/lib/log.js` — a tiny structured logger emitting single-line JSON: `{ level, msg, job_id, brand, phase, engine, duration_ms, err }`. No dependency needed; Vercel parses JSON lines.
- **C7.2** Convert the ~40 `console.*` calls in the scan/content worker paths first (highest diagnostic value). Leave scripts' CLI output alone. Do the rest opportunistically — do **not** do a 175-call sweep in one commit.
- **C7.3** Add Sentry (`@sentry/nextjs`): server + edge configs, `SENTRY_DSN` env, and `captureException` in every route catch and both worker outer catches. Set `tracesSampleRate` low (0.1) to control cost.
- **C7.4** Create `GET /api/health` returning `{ ok, db: <ping ms>, engines: [...], last_worker_run, pending_jobs, stale_jobs, spend_today }`. Exclude it from the operator gate (it must be reachable by uptime monitors) but do not leak sensitive values.
- **C7.5** Point an uptime monitor at `/api/health`; alert on non-200 or `stale_jobs > 0` for 30 min.
- **C7.6** Add an operator-only `/ops` page rendering: jobs in flight with phase and age, failed jobs with `failure_kind`, spend today/7d from `spend_events`, and last worker tick. This is the "my scan hung" answer in one screen.
- **C7.7** Tests: health endpoint returns 200 with a mocked DB; logger output is valid JSON with required fields.
- **Acceptance:** given only a brand name, the operator can find the job, its phase, its age, its cost, and its last error in under a minute.

---

# Phase D — Data layer correctness

*Goal: the schema and the access layer stop fighting the product. Everything here is cheap now and expensive after another 500 scans accrue.*

## D1 — The missing indexes

| | |
|---|---|
| **Why** | Six hot filters have no supporting index. Every finalize and every history read pays for them today; at 10× data they become the wall. |

- **D1.1** Cross-check each against the live query before writing it (the list below was derived by comparing `analytics.js`/`db.js` filters against migrations 001–005):

  | Table.columns | Used by | Today |
  |---|---|---|
  | `citations (job_id)` | delete + stamp on **every** finalize (`analytics.js:290,502`) | none |
  | `result_brands (result_id)` | delete-by-job join (`analytics.js:417`) | none (FK unindexed) |
  | `result_brands (brand, id)` | brand read + order (`analytics.js:445`) | none |
  | `scans (brand)` | `ilike` filter (`db.js:178`) | **no index on `scans` at all** |
  | `scans (scanned_at DESC)` | history ordering (`db.js:194-201`) | none |
  | `citations (brand, created_at DESC)` | order + limit (`analytics.js:337`) | only `(brand, domain)` |
  | `scan_jobs (brand) WHERE status active` | dup-check (`db.js:349-351`) | only `heartbeat_at` — **covered by B6.1's unique index** |

- **D1.2** Write them into migration `006` with `CREATE INDEX IF NOT EXISTS` and `CONCURRENTLY` where the table is non-trivial (note: `CONCURRENTLY` cannot run inside the transaction wrapper from A5.2 — either exclude this migration from the wrapper or run these separately and document it).
- **D1.3** Before/after timing on the two worst reads (finalize delete, brand history) against the live 55-scan dataset; record numbers in the PR.
- **Acceptance:** `EXPLAIN ANALYZE` shows index scans, not sequential scans, for all six.

## D2 — Kill the blob triplication

| | |
|---|---|
| **Why** | The full probe payload is stored **three times**: `scans.raw_results.results` (`db.js:61`), `prompt_results.raw` (`scanWorker.js:495`), and `scan_jobs.run_record` (`scanWorker.js:935`). Then it is *returned* in bulk: `GET /api/scans/[brand]` does `select("*")` over all history and expands every row (`db.js:177`, `scans/[brand]/route.js:76`) — 100 scans returns 100 full payloads; and `getScanJob` does `select("*")` so the **2-second status poll ships `run_record` on every tick** (`status/route.js:59`). |

- **D2.1** **Stop writing `run_record`.** The client already prefers the DB fetch (`services/api.js:764-775`); `run_record` is a transitional fallback. Remove the write in `scanWorker.js:935`.
- **D2.2** Remove `run_record` from the status response (`status/route.js:59`). Verify `services/api.js`'s completion path works from `result_id` alone; keep the fallback branch for one release, then delete it.
- **D2.3** Add a narrow `listScansForBrand` projection selecting only the columns the history strip renders (id, brand, scanned_at, visibility_pct, engine set, prompt counts) — **never** `raw_results`. Point `GET /api/scans/[brand]` at it.
- **D2.4** Narrow `getScanJob` to the columns the callers use; `checkpoint` is needed by the worker but not by the status route — consider two functions.
- **D2.5** Narrow `getPromptMetrics`'s `select("*")` (`analytics.js:231`) — it currently pulls `prompt_results.raw` (full answer text) for two entire scans when the endpoint needs scalar columns only.
- **D2.6** Drop the `run_record` column in a later migration, after a release confirms nothing reads it.
- **D2.7** Add a retention job: prune `prompt_results.raw` and `scans.raw_results` older than N days (default 180), keeping the derived rows. Run it on the existing cron. Make N configurable; **verify against the product promise** that verbatim answers remain available for the retention window the UI advertises.
- **D2.8** Measure: response size of `GET /api/scans/[brand]` and of one status poll, before and after. Record in the PR.
- **Acceptance:** a status poll response is < 2 KB; brand history for 55 scans is < 100 KB.

## D3 — Unify brand keying

| | |
|---|---|
| **Why** | Three incompatible schemes hide behind params both named `[brand]`: **display-name** with `ilike` (`scans`, `scan_jobs` — `db.js:178,351`), **resolved domain key** (all analytics tables, `/api/brands/[brand]/*` uses the param verbatim), and **raw unnormalized strings** (content-OS routes: `content/route.js:17`, `knowledge/route.js:17`, `agents/route.js:18`, `lessons/route.js:11`). Two routes named `[brand]` require different inputs. A brand rename silently orphans `scans` history from analytics. |
| **Risk** | This is the most invasive change in the plan. It touches live data. Sequence it carefully and do it **after** C (so scans are reliable) and with a backup. |

- **D3.1** Decide the canonical key: `resolveBrandKey(brand, website)` output (domain-first), already used by every analytics table. Display name becomes a separate, non-keying label.
- **D3.2** Migration: add `brand_key text` to `scans` and `scan_jobs`; keep `brand` as the display label. Add an index on `brand_key`.
- **D3.3** Backfill `brand_key` for all 55 historical scans using the same `resolveBrandKey(brand, website)` the pipeline uses. **Verify** the mapping by comparing derived keys against the distinct `brand` values already in `prompt_results` — any scan whose derived key has no analytics counterpart needs manual review, not a guess.
- **D3.4** Write `brand_key` on job creation and scan insert.
- **D3.5** Switch reads to `.eq("brand_key", key)` (this also closes B8.4's `%` wildcard over-fetch).
- **D3.6** Normalize the content-OS routes to accept and store the same key; backfill their brand columns.
- **D3.7** Introduce one edge resolver: routes accept either a display name or a key, normalize once at the boundary, and pass only the key inward. Document that internal code never re-resolves.
- **D3.8** Update the dashboard so it stops maintaining the dual-scheme knowledge (`DashboardShell` currently derives the domain key separately for analytics panels).
- **D3.9** Tests: rename a brand's display name → history and analytics stay joined; a key with uppercase/`www.`/trailing-slash variants resolves identically.
- **D3.10** Keep `brand` (display) as the only thing shown in UI; never render the key as a title.
- **Acceptance:** one param shape works on every `[brand]` route; renaming a brand loses nothing.

## D4 — One response envelope

| | |
|---|---|
| **Why** | Roughly 12 routes return `{ detail }` (a FastAPI-ism from the Python era), ~9 newer routes return `{ error }`, and some return `{ success: true }`. The client reads only `errData.detail` (`services/api.js:704`), so **every error from the newer routes surfaces as a generic fallback string** — real error messages are silently lost. |

- **D4.1** Create `src/lib/apiResponse.js`: `jsonOk(data, init)` and `jsonError(code, message, status)` producing `{ error: { code, message } }`, both applying the standard `no-store` headers so D4.3 is free.
- **D4.2** Convert routes in small batches (5–6 per commit), starting with the ones the dashboard actually calls, so a regression is easy to bisect.
- **D4.3** Standardize cache directives: today it is an inconsistent mix of `dynamic`, `fetchCache`, `revalidate` exports and manual `Cache-Control` headers, in different combinations per route (some GETs set none). Pick one convention and apply it in the helper.
- **D4.4** Update `services/api.js` to read `error.message` with a `detail` fallback for one release.
- **D4.5** Add a route test asserting the envelope shape for a success and an error on a representative route of each kind.
- **Acceptance:** every route returns `{error:{code,message}}` on failure; the UI shows the specific message.

## D5 — Remove the `insertScan` fallback cascade

| | |
|---|---|
| **Why** | `db.js:122-167` retries the insert three times with progressively fewer columns on **any** error, so a genuine failure (constraint violation, RLS denial) is misreported as "schema too new" and silently degrades the stored analytics columns. Cascade level 3 (`:157-159`) omits `.select()`, so it returns `undefined` → `savedScan?.[0]?.id` is null → finalize throws *after* all the work is done. It also directly contradicts the fail-loud contract. |

- **D5.1** Confirm the live schema has all the columns the full insert wants (it does — migration 005 is applied); the cascade is vestigial from the pre-migration era.
- **D5.2** Replace with a single insert with `.select()`, and let errors propagate.
- **D5.3** Keep one narrowly-scoped exception if desired: detect Postgres error `42703` (`undefined_column`) specifically and fail with a *clear* "run migrations" message — never by dropping data.
- **D5.4** Test: a constraint violation surfaces as itself, not as a degraded insert.
- **Acceptance:** an intentionally bad payload produces the real Postgres error in logs.

## D6 — Remaining data-access hygiene

- **D6.1** **`content_events` still fails soft** — `db.js:479-483,510-513` catch a DB error and fall back to the in-process `global.memory*` map: the exact poison-pill pattern P0.0 removed everywhere else. On serverless this writes to one instance's RAM, invisible to others, lost on recycle. Make it fail-loud like the rest.
- **D6.2** **Silent truncation** — `getCitationsForBrand`/`getResultBrandsForBrand` cap at 5 000 rows (`analytics.js:295,319,423,433`) and return them as if complete. Add keyset pagination and an explicit `truncated: true` signal that the UI surfaces.
- **D6.3** `listRecentScans` pulls 200 rows and dedupes client-side (`db.js:194-233`) — push the dedupe into SQL (`DISTINCT ON`).
- **D6.4** Audit every remaining `select("*")` and narrow the ones on wide tables.
- **D6.5** Add a "no unbounded read" note to the data-access layer's header comment.
- **Acceptance:** no read returns more than a page without saying so.

## D7 — De-duplicate hand-synced code

- **D7.1** `enrichScanForClient` is byte-identical (57 lines) in `api/scans/_lib/scanRow.js:39` and `api/scans/[brand]/route.js:10`. Import the `_lib` copy; delete the other.
- **D7.2** `computeNextRunAt` + `CADENCE_MS` — handled in C6.4 (the two versions differ; reconcile, don't just pick).
- **D7.3** Sweep for other duplicated helpers surfaced by the audit: `relativeTime` (`format.js:44`) vs `timeAgo` (`HomeDashboard.jsx:15`); `FilterPill` defined identically in `PromptMetricsTable.jsx:97` and `CrawlabilityView.jsx:53`.
- **Acceptance:** each helper has exactly one definition.

---

# Phase E — The great deletion

*Goal: the repo contains only code that runs. This is the single biggest contributor to "it looks like a project."*

> Run this **after** D — D touches several of the same files, and rebasing a large deletion is unpleasant. Each package here is one commit; none should change behavior.

## E1 — The dead backend island (~2 300 LOC)

| | |
|---|---|
| **Why** | An entire v6–v8 scoring/engine generation survives with **zero production importers**, kept alive only by its own tests — which means a meaningful slice of the "629 passing tests" is coverage of code that never runs. That is a false quality signal. |

- **E1.1** Re-verify each module has no non-test importer immediately before deleting (the codebase has changed since the audit):
  ```bash
  git grep -n "computeVisibilityScore\|bayesian\|controlPrompts\|qualityGate" -- src | grep -v test
  ```
- **E1.2** Delete whole modules: `scoring/computeVisibilityScore.js` (333), `scoring/bayesian.js` (203), `scoring/probe.js` (210), `scoring/controlPrompts.js`, `scoring/qualityGate.js`, `scoring/aggregate.js` (186), `engines/serp.js` (378), `engines/types.js` (49), `engines/adapter.js`, `engines/gemini.js`, `lib/prompts.js` (112).
- **E1.3** Delete their test files in the same commit.
- **E1.4** Delete dead exports inside live files: `enginePipeline.runMultiEngineScan` (:438) and `runWithConcurrency` (:424); `aioPipeline.runAioScan` (:171), `computeCompetitorAioMetrics` (:342), private `runWithConcurrency` (:157); `judge.judgeWithLLM` (:360), `isAmbiguous` (:330), `detectPosition` (:40), `judgeDeterministic` (:219 — check the calibration script first); unused imports in `services/api.js:1`.
- **E1.5** `judge.js`'s import of `generateContent` from `gemini.js` is the last tie to a paid Gemini path in the scoring tree — removing `judgeWithLLM` should remove it. Confirm.
- **E1.6** Decide on `engines/gsc.js` (222 LOC, imported only by `scripts/test-gsc.mjs`): keep it if P6 is committed to (Phase H2), otherwise delete it along with the `scan_jobs.gsc_queries` column and the hardcoded `query_source: "hybrid"` label (`db.js:300`) that implies a blending that does not happen.
- **E1.7** Re-run the suite and **record the new count** — it will drop. Note the honest number in the PR; a lower count here is an improvement.
- **E1.8** Re-run `next build` to confirm nothing was reachable through a barrel.
- **Acceptance:** ~2 300 fewer LOC; tests green at the new, honest count; build unchanged.

## E2 — The dead frontend layer

| | |
|---|---|
| **Why** | `src/components/ui/` is a 48-file shadcn kit that **nothing outside `ui/` imports**. Six of those files import packages that are not installed (`cmdk`, `vaul`, `react-day-picker`, `embla-carousel-react`, `input-otp`, `react-resizable-panels`) — so `calendar/carousel/command/drawer/input-otp/resizable.jsx` would **break `next build`** the moment anything imported them. All 24 `@radix-ui/*` dependencies plus `class-variance-authority`, `tailwind-merge`, `clsx`, and `tailwindcss-animate` exist solely for this dead kit. |

- **E2.1** Verify no importer outside `ui/`: `git grep -n "components/ui" -- src | grep -v "src/components/ui"` → expect empty.
- **E2.2** Delete `src/components/ui/` entirely.
- **E2.3** Remove the now-unused dependencies from `package.json` (24 Radix packages + cva + tailwind-merge + clsx + tailwindcss-animate). Run `npm install` and commit the lockfile change. Measure `node_modules` size before/after for the PR note.
- **E2.4** Delete orphaned dashboard components (defined, exported, never rendered): `ScoreBadge`, `TopPromptsTable`, `EngineBreakdown`, `IntentBreakdown`, `TopicBreakdown`, `ScoreBreakdown`, `ContentLiftPanel` (also the standing dark-mode violation — full of `bg-white`/`#1A1A1A`), `dashboard/OpportunitiesPanel` (note: the *studio* OpportunitiesPanel is live — do not delete that one), `HeroScoreCard`.
- **E2.5** Delete the orphaned alternate landing set (~633 LOC): `DossierModules.jsx` (392), `DossierLeftPanel.jsx` (143), `VerdictModule.jsx` (79), `ProbeCounter.jsx` (19). *(`ProbeCounter` is the simulated `Math.random()` counter — see F6; if the landing still renders it, F6 removes it first.)*
- **E2.6** Delete `format.js`'s `rankColor` (hardcoded light-mode hex values — invisible on dark, a token-system violation) and `tierClasses`, both used only by the orphans above.
- **E2.7** **Decide Tailwind's fate.** The app is inline-token-styled (926 `style={{}}` vs 362 `className=`, and most classNames are one-off utilities or in the now-deleted `ui/`). Running both systems is pure overhead. Recommended: keep Tailwind only if a concrete near-term use exists; otherwise remove `tailwind.config.js`, `postcss.config.mjs`'s Tailwind plugin, and the directives from `globals.css`. **Verify the landing page renders identically** before committing — it uses some utility classes.
- **E2.8** Full visual pass over every view after the deletion (Overview, Answers, Rivals, Sources, Queries, Crawlability, Studio) plus the landing and scan pages.
- **Acceptance:** build green, all views visually unchanged, dependency count down by ~28.

## E3 — Remove the dev-only route

- **E3.1** `/chart-preview` is a self-declared temporary harness shipping hardcoded simulated data to production. It is currently the **only** renderer of `PerformanceMatrix`, so it cannot be deleted until G4 wires that chart into a real view.
- **E3.2** Interim: exclude it from production routing (render `notFound()` unless `process.env.VERCEL_ENV !== "production"`).
- **E3.3** Delete the route once G4 lands.
- **Acceptance:** `/chart-preview` 404s in production.

## E4 — `.env.example` and README truth

- **E4.1** `README.md` was rewritten in the platform commit; re-read it against the current architecture and fix anything stale (routes, scripts, setup steps).
- **E4.2** Document the actual local dev loop: migrate → `npm run dev` → `scripts/dev-scan.mjs` (since no cron runs locally).
- **E4.3** Document the production deploy sequence: migrate → deploy → verify `/api/health`.
- **E4.4** Add a short "operational runbook" section: how to find a stuck job, how to force a re-finalize, how to check spend, where the cron pings from.
- **Acceptance:** a new machine can go from clone to a working scan using only the README.

## E5 — Type safety without a rewrite

| | |
|---|---|
| **Why** | 601 exported symbols with no compiler. The concrete bug classes already visible: manual snake/camel duality handled per-field across `services/api.js` (e.g. `getBrandMentionedInText` reads three spellings at `:95-97`) where one missed spelling silently zeroes a metric; Postgres `numeric` values arriving as strings and needing explicit `Number()` (`scanRow.js:51`, `db.js:222`) where a miss yields string concatenation in charts; deep nullable chains as the norm (`db.js:210-213`). A full TypeScript migration is **not** justified at ~130 non-test files / 34 k LOC. |

- **E5.1** Add `@ts-check` to the highest-traffic cross-boundary modules first: `src/lib/db.js`, `src/lib/db/analytics.js`, `src/services/api.js`, `src/app/api/scans/_lib/scanRow.js`.
- **E5.2** Author three `@typedef`s in a `src/lib/types.js` JSDoc file: `ScanRecord` (the client-facing scan shape), `PromptResultRow` (the DB row), `EngineSummary`. These are the three shapes that cross the most boundaries.
- **E5.3** Fix whatever the checker surfaces — expect real nullable and coercion bugs. Treat each as its own small commit if non-trivial.
- **E5.4** Turn on `checkJs` in `jsconfig.json` scoped to the annotated files (via `include`), not repo-wide, so the gate stays green.
- **E5.5** Wire `npm run typecheck` (added in A2.2) into CI as a required step.
- **E5.6** Expand coverage opportunistically; do not attempt a big-bang pass.
- **Acceptance:** `npm run typecheck` is green and runs in CI; the snake/camel readers are typed.

## E6 — Close the test seams

| | |
|---|---|
| **Why** | Unit coverage is genuinely good (behavior-asserting, dependency-injected) but there are **zero tests on all 31 API routes**, zero on `engines/brightdata.js` (the core AIO fetch/parse, 372 LOC — the single most consequential parser in the product), zero on `scoring/aliases.js` (the mention-detection foundation), and zero UI tests. Everything runs against in-memory maps, so live SQL behavior — `onConflict`, RLS, `numeric` string coercion — is unverified. |

- **E6.1** Add route-handler tests: import the handler directly, pass a constructed `Request`, inject `deps`. Start with the four the dashboard depends on (`scans/by-id`, `scans/[brand]/latest`, `brands/[brand]/metrics`, `scan/[job_id]/status`), then the mutating ones.
- **E6.2** Add `engines/brightdata.test.mjs` with **recorded real response fixtures** (sanitized): a well-formed AI Overview, one with `texts` nested blocks, one with no AIO, one error payload. This is the parser that historically returned 0 % for every brand — it deserves fixtures.
- **E6.3** Add `scoring/aliases.test.mjs` covering the mention-detection edge cases the scoring correctness depends on.
- **E6.4** Add a live-Supabase smoke test gated behind an env flag, running in CI against a **separate test project**: apply migrations → insert a scan via the finalize RPC → read it back → assert `onConflict` idempotency. This is the only way the memory-path divergence gets caught.
- **E6.5** Rename `test:scoring` → `test:unit` (done in A2.2); delete `test:prompts`/`test:gsc`/`test:calibration` if they target deleted code after E1.
- **E6.6** Add a smoke E2E (Playwright is available in this environment): load `/dashboard/[brand]`, assert the score renders and no console errors. One test, not a suite.
- **Acceptance:** CI runs unit + typecheck + build + one live-DB smoke; the four dashboard-critical routes have tests.

## E7 — Framework currency

- **E7.1** After CI is trustworthy, upgrade Next 14 → 15 (App Router param and fetch-cache semantics changed; read the upgrade guide, expect route-handler and `params` await changes).
- **E7.2** React 18 → 19 alongside it.
- **E7.3** ESLint 8 (EOL) → 9 with the flat config.
- **E7.4** Verify the unusual `lucide-react@1.22.0` pin is the genuine package (canonical versions are `0.x`) — a supply-chain check worth five minutes.
- **E7.5** Each upgrade is its own PR with a full manual pass.
- **Acceptance:** green CI on the new majors; no visual regressions.

---

# Phase F — Product credibility

*Goal: the first ten minutes. Nothing here adds a feature; everything here removes a reason to distrust the product.*

## F1 — Error boundaries

| | |
|---|---|
| **Why** | There is **no** `app/error.jsx`, `global-error.jsx`, `not-found.jsx`, or per-view boundary anywhere. Any render throw in a client view — one malformed record, one `NaN` reaching a chart — white-screens the entire route with no recovery path. |

- **F1.1** Add `src/app/error.jsx`: a Results Night-styled recovery panel with the error digest, a "Try again" (`reset()`) button, and a link home. Never render the raw stack in production.
- **F1.2** Add `src/app/global-error.jsx` for layout-level failures (needs its own `<html>`/`<body>`).
- **F1.3** Add `src/app/not-found.jsx` — a branded 404 (currently the Next default).
- **F1.4** Add `src/app/dashboard/[brand]/error.jsx` so a dashboard failure keeps the shell and chrome.
- **F1.5** Add a small reusable `<ViewBoundary>` (class component with `componentDidCatch`) and wrap each entry in the view switch (`DashboardShell.jsx:834`), so one broken view degrades to a panel-level message instead of taking the page.
- **F1.6** Report caught errors to Sentry (C7.3) with the view name as a tag.
- **F1.7** Test each by temporarily throwing in a view; confirm the rest of the dashboard still works.
- **Acceptance:** a thrown error in Sources leaves Overview, the sidebar, and navigation fully usable.

## F2 — URL state

| | |
|---|---|
| **Why** | `DashboardShell.jsx:78-89` parses `?view=` **once on mount** but `onViewChange={setView}` (`:434`) only mutates local state. So: in-app navigation never updates the URL, **refresh resets to Overview**, **browser Back does not move between views**, and the "results are shareable by URL" promise (`dashboard/page.js:19`) holds only for the initial deep link. Separately, `handleHistoryClick` (`:321`) swaps the displayed scan via `setResult` without routing — viewing a historical scan is not shareable and is lost on refresh. |

- **F2.1** Derive `view` from `useSearchParams()` rather than local state; on change call `router.replace(\`?view=${v}\`, { scroll: false })`.
- **F2.2** Route history clicks through `/dashboard/[brand]/[scanId]` (the route already exists and already fetches by id) instead of swapping state in place.
- **F2.3** Encode the sub-state that users would expect to survive a refresh or a shared link: Studio's active tab (`StudioView.jsx:158`), Answers' filter and engine chips (`AnswersView.jsx:458-459`), PromptMetrics' sort/filter (`:214-217`). Use short query keys; keep them optional.
- **F2.4** Verify Back/Forward walks the view history correctly and that `replace` vs `push` is chosen deliberately (view changes → `replace`; scan changes → `push`).
- **F2.5** Confirm `DashboardShell`'s currently-unwired `scanId` prop is either used or removed.
- **Acceptance:** every view and key filter survives refresh; Back navigates; a pasted URL reproduces the exact screen.

## F3 — Retire the sessionStorage transport

| | |
|---|---|
| **Why** | `saveScan` swallows **all** errors (`services/api.js:4-8`). A large multi-engine 100-prompt scan can exceed the ~5 MB quota that the shim itself warns about (`dashboard/page.js:16`) — `setItem` throws, is swallowed, `/dashboard` then reads `null` and shows the empty state. **The user's just-completed scan silently vanishes.** Separately, the single shared key `aeo_last_scan` is raced by the home shelf when two brands are opened in one tab. |

- **F3.1** On scan completion, navigate directly to `/dashboard/[brand]/[scanId]` — the record is already in the DB and the route already fetches it. No sessionStorage hop.
- **F3.2** Point the home "case files" shelf (`HomeDashboard.jsx:69-89`) at `/dashboard/[brand]` instead of `saveScan` + `/dashboard`.
- **F3.3** Keep sessionStorage **only** for the sample report (it has no DB row) under a distinct key, and keep `/dashboard` as the sample surface + legacy redirect.
- **F3.4** Make the remaining `saveScan` fail loudly (log + user-visible message) rather than swallowing.
- **F3.5** Remove `handleRerun`'s in-place `saveScan` (`DashboardShell`) in favor of routing to the new scan id.
- **F3.6** Test: a scan with 100 prompts × 3 engines lands on the dashboard intact (this is the case that fails today).
- **Acceptance:** no scan can be lost between completion and display, at any size.

## F4 — Fix the funnel

| | |
|---|---|
| **Why** | Three separate breaks in the first minute. (1) `ScanBar.jsx:15` writes the typed domain to `localStorage.setItem("perceev_prescan_domain", …)` and **nothing ever reads it** (verified: single grep hit) — `/scan` initializes `brand`/`website` to `""` (`scan/page.js:32-48`), so the hero's primary CTA drops the user's only input and makes them re-type. (2) Three contradictory time promises: "60 seconds" (`page.js:87,106`), "60–90 seconds" (`scan/page.js:437`), "several minutes" (`DashboardShell.jsx:421`) — and `PRODUCT.md:49` already flags the 60 s claim as stale under chunked multi-engine scans. (3) `runScan`'s `job_id` lives only in a closure (`services/api.js:679-785`); close the tab and the scan continues server-side with **no route back to it**. |

- **F4.1** Read `perceev_prescan_domain` in `/scan`'s initializer: prefill `website`, derive a `brand` guess from the domain, clear the key after use. ~5 lines.
- **F4.2** Also accept `?domain=` on `/scan` so the hero can link rather than depend on storage (more robust and shareable).
- **F4.3** Replace all three time claims with one honest, dynamic ETA driven by `progress_pct` and elapsed time ("about 2 minutes left"). Where a static claim must appear in marketing copy, make it the measured p50 and put it in one constant used everywhere.
- **F4.4** Persist the active job id per brand (localStorage keyed by brand, plus the server already knows) and add a "scan in progress" chip on the home shelf that resumes polling and links to the live progress view.
- **F4.5** Handle the returning-mid-scan case explicitly: landing on `/scan` for a brand with an active job shows progress instead of an empty form.
- **F4.6** Test the whole path: type a domain on the landing → the form is prefilled → submit → close the tab → return → find the running scan → see it complete.
- **Acceptance:** a user never types their domain twice and can always find a scan they started.

## F5 — Honest failure and empty states

- **F5.1** `dashboard/[brand]/page.js:52-56` maps **both** a 404 and any transient 500 to `setScan(null)` → "Your dashboard is waiting." A server hiccup is indistinguishable from a brand with no scans. Separate the two: distinct error state with a Retry button, empty state only for a true 404.
- **F5.2** Add cancellation to the two fetch paths that lack it — `DashboardShell.fetchScanHistory` (`:101,:353`) and `CrawlabilityView.fetchAudit` (`:89-123`). No `AbortController` is used anywhere; rapid brand/path switches can let a stale response clobber fresh state.
- **F5.3** Fix the stateful-row key bug: `AnswersView.jsx:587` uses `key={i}` over a **filtered** list whose rows own `expanded` state (`:125`) — changing the filter expands the wrong row. Key by `prompt + engine`.
- **F5.4** Give each panel a failure state rather than rendering blank on a failed fetch (Trend, PromptMetrics, Crawlability all fetch independently).
- **Acceptance:** every fetch has three visually distinct outcomes — loading, empty, failed-with-retry.

## F6 — Remove fabricated data from the UI

| | |
|---|---|
| **Why** | An evidence-first product should not ship invented numbers. |

- **F6.1** `/scan`'s "Recent scans" are three hardcoded fake brands (`scan/page.js:25-29,313-326`) that all load the sample. Replace with real entries from `/api/history`.
- **F6.2** `ProbeCounter.jsx:11-12` increments via `Math.random()` (already flagged in `PRODUCT.md:72`). Either wire it to a real cumulative probe count (`spend_events` or a counter from B5) or delete the component. *(It is also in E2.5's orphan list — if the landing does not render it, deletion is the answer.)*
- **F6.3** Audit the landing for any other simulated figure and either source it or remove it.
- **F6.4** Upgrade the sample report: it has ~8 prompt rows (`mockData.js`) versus a real 30-prompt multi-engine scan, so the demo undersells the product. Freeze one real, anonymized scan as the sample fixture.
- **Acceptance:** every number shown to a user traces to real data or a clearly-labeled sample.

## F7 — Accessibility and responsive passes

| | |
|---|---|
| **Why** | The tool targets executives who will open it on a phone and may use assistive tech. Today: **zero media queries** in the entire app (only `prefers-reduced-motion` and `print`), and several controls have no accessible name. |

**F7a — Accessibility**
- **F7.1** Charts: `TrendChart.jsx:188` and `Donut.jsx:73` render `<svg>` with no `role`/`aria-label`/`<title>`, and the trend tooltip is `onMouseMove`-only — invisible to screen readers and unusable by keyboard or touch. Add `role="img"` + a summarizing `aria-label`, plus either focusable points or an adjacent sr-only data table. (`RankTable.jsx:123` already does this correctly — follow its pattern.)
- **F7.2** `Alert.jsx:67-83` has no `role="alert"`/`status`, so errors and notices are never announced; its dismiss control is a bare `×` with no accessible name. Add the role and an `aria-label`. *(Note the deleted `ui/alert.jsx` had this right — the live one does not.)*
- **F7.3** `Sidebar.jsx:148` and `Tabs.jsx:7` are plain buttons — add `role="tablist"`/`role="tab"`, `aria-selected`, `aria-current`, and arrow-key roving focus. Also fix `Sidebar.jsx:171`, which toggles color from `e.target` (the SVG on icon hover) instead of `e.currentTarget`.
- **F7.4** `PromptMetricsTable.jsx:404` and the Crawlability bot list (`:433`) are `display:grid` divs — add `role="table"/"row"/"columnheader"/"cell"` and `aria-sort` on sortable headers (`:124`).
- **F7.5** `Input.jsx:46-57` sets no `aria-invalid` and does not link its error text via `aria-describedby`. `QueryManager.jsx:481-512`'s toggle is a 0×0 visually-hidden checkbox whose label wraps only the graphic → empty accessible name and an invisible focus target. Fix both.
- **F7.6** Gate the inline `animation:"spin 1s..."` spinners (`DashboardShell.jsx:408`, `AnswersView.jsx:346`, `StudioView.jsx:300`, `HomeDashboard.jsx:130`) behind `prefers-reduced-motion` like the charts already are.
- **F7.7** Keyboard pass: tab through every view; confirm a visible focus ring on every interactive element and no keyboard trap.

**F7b — Responsive**
- **F7.8** Add breakpoints. The `Sidebar` is a hard `width:236px; min-width:236px; height:100vh` (`:46-52`) inside a flex shell (`DashboardShell.jsx:389`) with no collapse — on a phone it consumes the screen and crushes `<main>`.
- **F7.9** Convert the sidebar to a drawer below ~900 px with a hamburger toggle; stack the shell.
- **F7.10** Fixed KPI grids (`repeat(2,1fr)` / `repeat(3,1fr)` in `OverviewView.jsx:35,82`, `CrawlabilityView.jsx:301`) and `QueryManager`'s `1fr 2fr` (`:135`) do not reflow — switch to `auto-fit`/`minmax`, the pattern Studio already uses correctly.
- **F7.11** Give `TrendChart` a touch-accessible readout (tap-to-inspect or an always-visible latest-value label).
- **F7.12** Truncate the header brand name (`DashboardShell.jsx:490`) — the sidebar version already ellipsises; the header does not.
- **F7.13** Test at 375 px, 768 px, 1280 px, and verify the print stylesheet still produces a clean report (it is a genuine strength — do not regress it).
- **Acceptance:** the dashboard is fully usable on a 375 px phone; a keyboard-only user can reach and operate every control.

## F8 — Frontend performance and decomposition

| | |
|---|---|
| **Why** | `next/dynamic` is used **zero** times. `DashboardShell` statically imports all seven views *including the entire Studio subtree* (`ContentItemView` 586 LOC, `StudioView` 419, `AgentBuilder` 335, `Markdown` 245, `KnowledgePanel` 298, `AgentTheater`), so a user who never opens Studio still downloads it. And the shell itself is a 928-line god component (~12 `useState`, 3 `useEffect`, all banners, the history strip, the score band, and the view switch). |

- **F8.1** `next/dynamic` for `StudioView`, `CrawlabilityView`, and the chart panels, with skeleton fallbacks matching the existing loading states.
- **F8.2** Remove `framer-motion` from the dashboard critical path: it is used there only for `motion.path` draw-on in `Donut` and `TrendChart`. `RankTable.jsx:34` already proves the same effect works with plain CSS plus `prefers-reduced-motion`. Keep it on the landing if desired.
- **F8.3** Fonts: Geist ships as `.woff` not `.woff2` (`globals.css:3`), and the Barlow display face used in the hero is not preloaded → FOUT on the largest headline. Convert to woff2 and preload the one display weight.
- **F8.4** Decompose the shell: extract `useScanData(scan)`, `useStudioBadge(brand)`, `<DashboardHeader/>`, `<DashboardBanners/>`, `<HistoryStrip/>`. Target under 300 lines for the shell.
- **F8.5** Introduce a small cached fetch layer (SWR, React Query, or a hand-rolled keyed cache). Today there is none, so **every tab switch refetches** — views are conditionally rendered (`:834-921`), so returning to Overview re-runs `/metrics` (`OverviewAnalytics.jsx:66`) and Queries re-fetches twice.
- **F8.6** Consolidate the duplicate pollers: `DashboardShell.jsx:112` polls `/api/content-items` every 15 s for the badge while `StudioView.jsx:172` polls the same endpoint every 3 s. One owner, one interval, shared result.
- **F8.7** Memoize the per-render derivations (`heroScore`, `mentionedNonBranded`, `citedNonBranded`, `brandAliases`, `interpretation` — `:362-384`) and the alias `RegExp` rebuilt per row per render in `AnswersView.jsx:6-13`; wrap view components in `React.memo` so a badge-poll tick stops re-rendering charts.
- **F8.8** Consider virtualization for `AnswersView` (up to ~300 rows at 100 prompts × 3 engines) — measure first; memoization may suffice.
- **F8.9** Record First Load JS before/after in the PR.
- **Acceptance:** dashboard First Load JS materially reduced; switching tabs does not refetch; charts do not re-render on badge polls.

## F9 — Metadata and GEO dogfood

| | |
|---|---|
| **Why** | The product **sells crawlability audits** and would fail its own. There is no `public/` directory at all: no `robots.txt`, no `sitemap.xml`, no `llms.txt`, no manifest, no OG image. `layout.js:4-7` is two static lines — no `metadataBase`, `openGraph`, `twitter`, `robots`, or canonical — so every route shares one generic title and **no link ever produces a social card**. Because the dashboard and scan pages are client components, they cannot export `metadata` at all. |

- **F9.1** Add `src/app/robots.js` (Next metadata route) explicitly allowing the AI crawlers the product itself tracks (GPTBot, ClaudeBot, PerplexityBot, Google-Extended, …) — sourced from the existing `src/lib/crawlers/bots.js` registry so the two never drift.
- **F9.2** Add `src/app/sitemap.js` covering the public routes.
- **F9.3** Add `public/llms.txt` describing the product for LLM consumers — the feature Perceev audits for others.
- **F9.4** Expand `layout.js` metadata: `metadataBase`, `openGraph`, `twitter`, `robots`, canonical, and a proper title template.
- **F9.5** Add an OG image (`opengraph-image.jsx` using Next's ImageResponse, so it is generated not hand-drawn) in the Results Night visual language.
- **F9.6** Give the client-rendered routes real titles via thin server wrapper components exporting `generateMetadata` (per-brand dashboard titles: "Acme — AI visibility 64/100").
- **F9.7** Add `apple-icon` and a web manifest.
- **F9.8** **Verify by dogfooding:** run Perceev's own Crawlability view against its production domain and confirm it passes. Screenshot it — that screenshot is also marketing.
- **Acceptance:** a pasted Perceev link renders a branded card; the app passes its own crawlability audit.

## F10 — Presentation consistency

- **F10.1** One date/number utility. Today: `relativeTime` (`format.js:44`) and `timeAgo` (`HomeDashboard.jsx:15`) are duplicate implementations; `formatTimestamp` uses local time (`format.js:32`) while `formatShortDate` forces UTC (`chartMath.js:199`); Sidebar and Studio call raw `toLocaleDateString`. Consolidate, **pin to IST** (the target market, and the timezone the rollups already bucket by — `rollup.js:23-29`), and label the zone.
- **F10.2** One feedback convention. Today: `/scan` uses sonner toasts (`scan/page.js:94`), `QueryManager` uses inline messages (`:309`), `DashboardShell` uses `Alert` banners. Pick per-purpose rules (toast = transient confirmation, inline = field-level, banner = persistent state) and document them in `DESIGN.md`.
- **F10.3** One number grammar per surface — the hero shows `64/100` while trend/rank/donut show `12.3%`. They are different metrics, so keep both, but label them so the difference is obvious rather than reading as inconsistency.
- **F10.4** Ensure `tabular-nums` everywhere digits align in columns.
- **Acceptance:** dates, feedback, and number formatting behave identically across all views.

---

# Phase G — Turn on the loops

*Goal: switch on the retention machinery the backend already has. Most of this phase is wiring, not building — which is exactly why it is the fastest visible 10×.*

## G1 — The scheduling UI

| | |
|---|---|
| **Why** | **The single highest-leverage screen in the app.** Everything behind it is finished and tested: the `scan_schedules` table (migration 005), `GET/PUT /api/brands/[brand]/schedule`, `runSchedulerTick`/`listDueSchedules`/`computeNextRunAt` (`scanWorker.js:1041-1092`), and the cron. **No component calls the schedule endpoint** — verified by grep. And the product default is `enabled:false` (`schedule/route.js:19-27`). So today no brand ever re-scans unless a human hand-PUTs the API, which means the trend chart can never accumulate points and the entire daily-refresh retention loop is dark. |
| **Depends on** | C2 (frequent cron — a daily tick makes cadences meaningless), B5 (spend caps — recurring scans are recurring spend). |

- **G1.1** Add a **Settings** view to the dashboard (new sidebar entry) or a settings panel on Overview.
- **G1.2** Build the cadence editor: enabled toggle; cadence select (off / 72h / daily / weekly — matching `CADENCE_MS`); engines multi-select (driven by `resolveEnabledEngines`, never hardcoded); `prompt_target` slider (10–100, honoring the additive-tier contract); geo.
- **G1.3** Show the derived state read-only: `next_run_at` (formatted IST), `last_run_at`, and **projected cost per run** computed from the same constants as `spend_events` — so enabling a daily cadence is an informed decision.
- **G1.4** Wire to the existing `GET`/`PUT`; the route already validates and derives `next_run_at` server-side, and `last_run_at` is not client-writable. Do not duplicate that logic in the client.
- **G1.5** Surface schedule state where it is noticed: a "next scan in 6h" chip in the dashboard header and on the portfolio home (G6).
- **G1.6** Handle the empty case: a brand with no schedule row shows the opt-in default (`enabled:false`), not an error.
- **G1.7** Test: enabling daily creates the row, sets `next_run_at`, and the next worker tick starts a scan for that brand and only that brand.
- **Acceptance:** a brand can be put on daily refresh from the UI in under 30 seconds, and it actually re-scans.

## G2 — Notifications

| | |
|---|---|
| **Why** | Scans **finalize silently** — the worker writes the scan and stops; nobody is told. There is no email provider in `package.json` and no webhook emitter, so there is nowhere for the incumbent loop (refresh → delta → email → return) to live. All five trigger datasets already exist. |
| **Note on scope** | Without auth there is no user table, so recipients are configured per brand (a column) or globally (env). This is genuinely sufficient for single-operator and agency use, and Phase Z converts it to per-user preferences without changing the trigger code. |

- **G2.1** Choose a provider (Resend is the simplest fit; `RESEND_API_KEY` already anticipated in A4.6). Add `src/lib/notify.js` with a single `notify(kind, payload)` entry point so triggers never touch the provider directly.
- **G2.2** Add recipients: `scan_schedules.notify_emails text[]` (per brand) plus an `ALERT_EMAIL_TO` env fallback for operator alerts.
- **G2.3** **Trigger 1 — scan complete.** Call `notify()` at the end of `runFinalizePhase` (inside `waitUntil`, after the RPC commits — never inside the transaction). Include: score, delta vs previous, top movers, deep link to `/dashboard/[brand]/[scanId]`.
- **G2.4** **Trigger 2 — score drop.** In the same place, compare against the previous `brand_metrics_daily` point; fire if the drop exceeds a threshold (configurable, default e.g. 5 points).
- **G2.5** **Trigger 3 — new competitor detected.** The roster is already computed fresh at finalize (`unionCompetitorNames`); diff against the previous scan's roster.
- **G2.6** **Trigger 4 — weekly digest.** Piggyback `runSchedulerTick`: once per week per brand, send the trend, rank movement, and top new gaps.
- **G2.7** **Trigger 5 — gap found.** After G5's gaps UI exists, fire when a high-`gap_score` domain appears. Sequence this last.
- **G2.8** Build the email template in the Results Night language but **email-safe** (tables, inline styles, no CSS variables — the design system does not survive email clients). Include a plain-text alternative.
- **G2.9** Add idempotency so a re-finalize (crash recovery) cannot double-send: record sent notifications keyed by `(job_id, kind)`.
- **G2.10** Add an unsubscribe/mute per brand — required for deliverability even at low volume.
- **G2.11** Test with the provider's sandbox; assert `notify()` is called exactly once per finalize, including after a retry.
- **Acceptance:** finishing a scan produces one email with a working deep link; a re-finalize sends nothing extra.

## G3 — Backfill the trend so charts populate

| | |
|---|---|
| **Why** | `VisibilityTrendPanel.jsx:37-38` needs `series.length >= 2` from `brand_metrics_daily`. That table only fills on **new** scans, and the historical backfill produced 34 metric rows against 55 scans with null sentiment/position (`plan.md:586`). So for existing brands the retention artifact — the line going up — structurally cannot render, which undercuts G1's whole purpose. |

- **G3.1** Extend `scripts/backfill-analytics.mjs` to emit one `brand_metrics_daily` row per (brand, scan-day, engine) for all historical scans, reusing the live `rollup.js` math (it already shares it — keep it that way).
- **G3.2** Stay null-honest: sentiment and in-answer position were **not computed** by the pre-P1.1 pipeline, so those columns stay null for historical rows. Do not fabricate them. Verify the UI renders null-gaps gracefully rather than as zero.
- **G3.3** Run with `--dry-run` first; compare the row count against expectations before writing.
- **G3.4** Verify the trend chart renders for a brand with ≥2 historical scan-days.
- **G3.5** Confirm the delta arithmetic across a backfilled/live boundary is correct (a backfilled point followed by a live point must produce a sane delta).
- **Acceptance:** brands with multiple historical scans show a real trend line immediately.

## G4 — Citations and gaps UI

| | |
|---|---|
| **Why** | `/api/brands/[brand]/citations` and `/gaps` are fully implemented, tested, and have **zero UI consumers**. Gap analysis is the incumbents' signature "here is your to-do list" feature and the natural funnel into Studio content jobs. `SourcesView` today shows only per-scan domains from `result.topDomains`. |

- **G4.1** Rebuild **Sources** on the citations API: typed table (content_type, domain_type, earned/owned/social), sortable, date-ranged, with the URL-level rows the enrichment already produces.
- **G4.2** Add citation provenance — which prompt and engine cited each source (the data exists in `prompt_results`/`citations`).
- **G4.3** Add a **Gaps** view: domain and URL tabs, `gap_score` ranking, retrieval/citation-rate columns, and a per-row "Generate content" CTA that creates a Studio job pre-filled with the gap context. That CTA is the product's revenue thesis made concrete.
- **G4.4** Surface the `truncated` signal from D6.2 rather than silently showing a partial list.
- **G4.5** Wire `PerformanceMatrix` (brands × engines) into Overview or a new Insights section — it is built and currently rendered only by `/chart-preview`.
- **G4.6** Delete `/chart-preview` (E3.3) once G4.5 lands.
- **G4.7** Empty states for a brand with no citations yet.
- **Acceptance:** three finished backends become three visible features; nothing new is written server-side.

## G5 — Per-prompt drilldown and rerun-one

| | |
|---|---|
| **Why** | `PromptMetricsTable` shows visibility/sentiment/position per prompt, but rows are not clickable — there is **no path from a score to the verbatim answer that produced it**. The evidence exists (AnswersView renders it) but is disconnected from the metrics. Explainability is what converts skeptical buyers, and "Rerun Prompt" is a RadarKit parity feature. |

- **G5.1** Make prompt rows expandable/linkable to a drilldown showing the verbatim answer per engine, the citations for that answer, and the per-engine mention/position/sentiment.
- **G5.2** Deep-link it (`?prompt=<id>`) per F2's URL-state rule.
- **G5.3** Add "Rerun this prompt": a single-prompt job reusing the chunk worker (a job whose frozen query set is one query). Respect the spend cap and the frozen prompt-set contract — a rerun must not mutate the tracked set.
- **G5.4** Show run-to-run variance for that prompt across scans — the prompt-set contract makes this computable and it is a trust multiplier.
- **G5.5** Test that a single-prompt rerun writes a `prompt_results` row and updates metrics without creating a spurious full `scans` row (decide and document the semantics here — this is the one genuinely new pipeline behavior in Phase G).
- **Acceptance:** any score in the product is one click from its evidence.

## G6 — Portfolio home and brand switcher

| | |
|---|---|
| **Why** | The DB holds 55 brand-scans and there is **no cross-brand screen**. `DashboardShell` is single-brand and `Sidebar.jsx:18-26` has no brand picker, so once inside a brand the only way out is the logo. For an agency managing many brands this is the daily landing screen — and it needs no auth, only a list. |

- **G6.1** Build a portfolio view: every brand with its current score, delta, last scan time, next scheduled scan, and a sparkline.
- **G6.2** Sort/filter by score, delta, staleness; highlight brands whose score dropped.
- **G6.3** Add a brand switcher to the dashboard shell header (searchable when the list grows).
- **G6.4** Make it the default landing for a returning operator (the home "case files" shelf becomes this, or links to it).
- **G6.5** Bulk actions where they are safe: enable daily cadence on several brands at once (guarded by the daily spend cap).
- **G6.6** Verify performance with the narrow projections from D2 — the portfolio must not fetch full scan payloads.
- **Acceptance:** an operator sees all brands, their trends, and what needs attention on one screen.

## G7 — Trust surfaces

- **G7.1** **Methodology page** — score definitions (share-of-AI, SOV, sentiment 0/50/100, in-answer position), the 30-prompt unbranded set, the branded-query guardrail, engine weighting, and what "null" means. These live only in code today, so a buyer cannot self-serve "why is this 64?". Link it from the hero score.
- **G7.2** **Confidence/variance chip** on the hero — the prompt-set contract already tracks set continuity and flags "prompt set changed" (`DashboardShell.jsx:181-207`), but run-to-run variance is never shown. Surface it; it makes the number defensible.
- **G7.3** **Engine honesty** — the landing names three engines (`page.js:99,141`) while two run. Drive all such copy from `resolveEnabledEngines`.
- **G7.4** **Freshness** is already good (timestamp + relative time + scoring version) — keep it, and extend it to every panel that fetches independently.
- **Acceptance:** a skeptical CXO can answer "where does this number come from?" without asking.

## G8 — Topics

- **G8.1** Seed the `topics` table from the `brand_prompts.topic` text column already populated by prompt generation (migration 005 created the table; nothing seeds it).
- **G8.2** Reconcile the text column with `topic_id` (also already added by 005).
- **G8.3** Add topic grouping and per-topic rollups (visibility, sentiment, position, citation share) to Queries — this is plan.md's P2b.
- **G8.4** Add topic as a filter dimension across Answers, Sources, and Gaps.
- **Acceptance:** prompts roll up by topic, matching the incumbents' primary grouping unit.

---

# Phase H — Complete the analytics roadmap

*The remaining phases from `docs/plans/plan.md`, re-sequenced to follow the hardening work. These are features, not fixes.*

## H1 — P4: Sentiment UI and themes

- **H1.1** Sentiment is already **computed** per prompt for new scans (`detectSentimentScore`, P1.1) and stored — only the UI is missing.
- **H1.2** Add a sentiment trend line (positive-% over time) alongside the visibility trend.
- **H1.3** Add LLM-distilled positive/negative theme headlines plus a themes table (theme → sentiment → occurrences). Needs a `themes` table (migration) and a distillation step — use the free model first and only escalate if quality demands it, per the cost policy.
- **H1.4** Backfilled historical rows have null sentiment — the UI must show "from <date>" rather than implying a gap in the brand's performance.
- **H1.5** Add sentiment to the per-prompt drilldown (G5).

## H2 — P6: GSC integration and exports

- **H2.1** **Decide GSC's fate first** (see E1.6). `engines/gsc.js` (222 LOC, service-account, query-level) is imported only by a test script, yet `scan_jobs.gsc_queries` exists and `createScanJob` hardcodes `query_source: "hybrid"` (`db.js:300`) — implying a blend that does not happen. Either wire it or remove the implication.
- **H2.2** If wiring: add the date dimension it lacks, connect per brand, and add an organic-overlap column plus an AI-vs-organic view.
- **H2.3** **CSV exports** — answers, citations, prompt metrics, gaps. Today the only export is `window.print()` (`DashboardShell.jsx:558`). Stream them (the citation set is already thousands of rows) and respect the pagination work from D6.
- **H2.4** Add export buttons to each relevant view.

## H3 — P7: Typed opportunities and the action layer

- **H3.1** Replace the one-shot LLM string list (`/api/opportunities`) with typed opportunity cards carrying evidence chips: Content Optimization (specific URL + structural fix), Content Creation (net-new asset per gap), Outreach (a cited domain + its citation count).
- **H3.2** Derive them from data that now exists: gaps (`gaps.js`), citation typing (`citationEnrich.js`), prompt metrics, and competitor rosters — not from a free-form prompt.
- **H3.3** Feed each card into the Studio content pipeline as a pre-filled job (the `content_agents` base already exists).
- **H3.4** Outreach agent: author/journalist extraction from cited pages plus a human-in-the-loop pitch draft.
- **H3.5** Reddit agent: thread finder plus human-in-the-loop drafts.
- **H3.6** Keep every generated artifact human-approved before it leaves the system — the human-in-the-loop property is the product's positioning, not a limitation.

## H4 — Operator-facing metering (no billing)

- **H4.1** Aggregate `spend_events` (B5) into a per-brand, per-day usage rollup.
- **H4.2** Add a cost panel to `/ops` (C7.6): spend per brand, per engine, per day; scans consumed; the most expensive prompts.
- **H4.3** This answers "what does this customer cost me?" — necessary for pricing, and it becomes the billing meter in Phase Z without rework.

## H5 — Distribution surfaces that need no identity

- **H5.1** **Signed share links** — HMAC-signed, expiring URLs for a specific scan, so a client can view a report without the operator token. No user model required.
- **H5.2** **Branded PDF export** — a real deliverable beyond the print stylesheet; agencies resell this.
- **H5.3** **Embeddable score badge** — a signed SVG endpoint rendering a brand's current AI-visibility score, plus a "verified by Perceev" landing page. This is the growth loop unique to a visibility product: every customer site becomes a live demo and a backlink.
- **H5.4** All three are optional relative to the core plan; H5.3 has the highest upside per unit of effort.

---

# Phase Z — Deferred: authentication, tenancy, billing

**Not built in this plan.** Documented here so the seams left behind are deliberate and the later work is additive.

## Z1 — What we are deliberately leaving

| Deferred | Seam left for it |
|---|---|
| User accounts / sessions | `src/middleware.js` (B1) is the single choke point. Replacing the operator-token check with a session check touches one file; no route changes. |
| Per-tenant data isolation | Every table already keys on a normalized `brand_key` (D3). Adding `owner_id` is one column per table plus a backfill — no schema redesign. |
| Row-level security per tenant | B10 moves the server to the service-role key and removes the anon grants, so RLS policies can be written from scratch for owners rather than being loosened from `allow-all`. |
| Billing / plans / quotas | The tier axes already exist as knobs: `scan_schedules.prompt_target` (10–100), cadence, engine set, brand count. Entitlement checks attach at exactly two places: scan creation and schedule PUT. |
| Usage metering for invoicing | `spend_events` (B5) + the H4 rollup are already the meter. |
| Per-user notification preferences | `notify()` (G2) takes a recipient list; swapping its source from a brand column to user preferences is one function. |
| Public API keys / customer webhooks | The response envelope (D4) and rate limiter (B3) are the prerequisites, both built. |

## Z2 — Rules to keep the deferral honest

- **Z2.1** Never add a second access-control location. If a route needs protection, it goes in the middleware matcher — not an inline check.
- **Z2.2** Never key new data on a display name. Always `brand_key`.
- **Z2.3** Never write a new `FOR ALL TO anon` policy. New tables get no anon grant at all.
- **Z2.4** Any new spend path registers a `spend_events` row and respects the daily cap.
- **Z2.5** Keep the operator token out of client-side JavaScript (httpOnly cookie only), so introducing sessions is a server-side change.

## Z3 — Rough shape when it is time

1. Supabase Auth (or Clerk) with email login; sessions replace the operator cookie inside the existing middleware.
2. `owner_id uuid` on all 18 tables; backfill every existing row to the founding operator's id.
3. Owner-scoped RLS policies; service-role remains for worker writes.
4. A workspace concept above brands (agencies manage many clients).
5. Billing (Razorpay for India-first) mapped to `{prompt_target, cadence, engines, brand_count}`.
6. Convert the portfolio home (G6) into a workspace home.

---

# Execution order

The dependency-correct sequence. Each line is one focused working session or less; the numbering matches the packages above.

| # | Work | Package | Unblocks |
|---|---|---|---|
| 1 | Push `main`; `.gitattributes`; CI green | A0, A1, A2 | everything |
| 2 | Operator gate + cron gate + content-worker gate | B1, B2 | public exposure |
| 3 | `waitUntil` everywhere + 10-min cron pinger | C1, C2 | reliable scans |
| 4 | Finalize RPC + transient-failure retry | C3, C4 | data integrity |
| 5 | SSRF module + headers + `npm audit fix` | B4, B7, B9 | — |
| 6 | Spend ledger + caps + double-submit index | B5, B6 | safe recurring scans |
| 7 | Migration 006 (indexes, ledger, lease, failure_kind) | D1, A5, C5 | scale |
| 8 | Service-role key + drop anon grants | B10 | DB safety |
| 9 | Structured logs + Sentry + `/api/health` + `/ops` | C7 | operability |
| 10 | Error boundaries + URL state + post-scan redirect | F1, F2, F3 | product feel |
| 11 | Funnel fix (prefill, ETA, resume chip) | F4 | conversion |
| 12 | The great deletion (backend island, `ui/`, deps, debris) | E1, E2, A3 | velocity |
| 13 | Blob triplication + narrow projections | D2 | performance |
| 14 | Response envelope + `insertScan` cascade + fail-loud stragglers | D4, D5, D6 | correctness |
| 15 | Scheduling UI + notifications + trend backfill | G1, G2, G3 | **retention** |
| 16 | Citations + Gaps + matrix wiring | G4 | parity |
| 17 | Brand-key unification | D3 | data sanity |
| 18 | a11y + responsive + code-splitting | F7, F8 | reach |
| 19 | robots/sitemap/llms.txt + OG + methodology | F9, G7 | credibility |
| 20 | Drilldown, portfolio home, topics | G5, G6, G8 | depth |
| 21 | `checkJs` + route tests + live-DB smoke | E5, E6 | confidence |
| 22 | P4 / P6 / P7 | H1, H2, H3 | roadmap |

**Rule:** steps 1–4 before any public traffic. Steps 1–9 constitute "production-ready" in the operational sense; 10–16 constitute "product-ready" in the buyer's sense.

---

# Tracking

Mark packages as they land. A package is done when its acceptance criterion is demonstrably met — not when the code is written.

| Phase | Packages | Status |
|---|---|---|
| A — Ground control | A0 A1 A2 A3 A4 A5 | ☐ |
| B — Perimeter | B1 B2 B3 B4 B5 B6 B7 B8 B9 B10 | ☐ |
| C — Reliability | C1 C2 C3 C4 C5 C6 C7 | ☐ |
| D — Data layer | D1 D2 D3 D4 D5 D6 D7 | ☐ |
| E — Deletion | E1 E2 E3 E4 E5 E6 E7 | ☐ |
| F — Credibility | F1 F2 F3 F4 F5 F6 F7 F8 F9 F10 | ☐ |
| G — Loops | G1 G2 G3 G4 G5 G6 G7 G8 | ☐ |
| H — Roadmap | H1 H2 H3 H4 H5 | ☐ |
| Z — Deferred | not started by design | — |

## Definition of done (every package)

1. Acceptance criterion demonstrated, not assumed.
2. `npm test` green (and the count is honest — no dead-code coverage).
3. `next build` green.
4. `npm run typecheck` green (once E5 lands).
5. Manual pass on any view the change touches.
6. One commit per step where possible; the commit message names the package (e.g. `fix(scan): waitUntil on every kick (C1)`).
7. Anything discovered but not fixed is added to this document rather than left in a head.

---

*Derived from the 2026-07-25 production audit (77 findings). The audit report — with the full parity matrix, per-route exposure table, wedge scenarios, and dead-code inventory — is the companion document to this plan.*

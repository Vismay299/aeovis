# F28 — Operator console: workspaces, feature access, plans and client onboarding

> <!-- doc-status -->
> **Status: LIVE.** Implementation spec. Not built yet.

| Field | Value |
|---|---|
| ID | F28 |
| Wave | 6 |
| Comparison rows covered | None (Perceev-specific; OpenSEO is self-serve with billing, which the owner excluded) |
| Depends on | F01, F03, F04, F24, F26, F27 (all merged) |
| Blocks | Opening Perceev to real clients without hand-editing Vercel variables |
| Reserved migrations | 175–179 |
| Feature flag | `FEATURE_OPERATOR_CONSOLE` (environment only; see §6.2.3) |
| Spend features | none |
| OpenSEO reference | none |

## 1. Summary

Perceev is run as a managed service with no payments. The owner needs one place to see every workspace, decide which features each one gets (paid ones especially), set its spend limits, create a workspace for a client and invite them, and close public sign-up when needed. Today that work means editing `FEATURE_<NAME>_BRANDS` in Vercel, redeploying, and flipping allowlists on `/ops/costs` by hand. F28 moves feature access into the database, adds operator accounts (a real sign-in instead of a shared token), plans that bundle features and caps, and an operator console at `/ops`. Every operator change is written to an audit log.

## 2. What OpenSEO does (observed)

1. OpenSEO is self-serve with paid credits (Autumn/Stripe). Plans and entitlements come from billing, which the owner excluded (`features/README.md`, owner decisions).
2. No operator or admin console exists in the pinned reference. **(inferred)** from the absence of any admin route or role under `openseo:src/routes` and `openseo:src/server`.

Nothing is ported. F28 is Perceev-specific and follows Perceev's conventions only.

## 3. What Perceev has today

**Workspaces and members.**
- `customer_brands` (migration 023) is the workspace: `brand_key` (a UUID for self-serve workspaces), `display_name`, `website`, `website_host`, `aliases`, `is_active`, `idempotency_key` (024).
- `customer_brand_memberships (user_id, brand_key, role in ('owner','member'))`.
- `customer_team_invites` (024) holds pending invites; `accept_customer_team_invites()` turns them into memberships. It is called from `src/app/auth/callback/route.js:89` and `src/app/auth/accept/page.jsx:39`.
- `create_customer_workspace(...)` (026) creates a brand plus an owner membership. Only the service role may call it.
- Self-serve creation runs `/signup` → `/onboarding` → `src/server/onboarding/website.ts`. A user who already has a membership but no `user_onboarding` row gets `409 already_has_workspace` (`website.ts`, step 3).
- `src/shared/supabase/customerContext.js:11-13` loads only memberships whose brand has `is_active = true`, so setting `is_active = false` already hides a workspace from its members.

**Sign-up.**
- Anyone can sign up. F24's Auth hook `hook_before_user_created` (migration 155) refuses only disposable email domains, and it lets through any address that has a pending `customer_team_invites` row.
- The hook is a Supabase Auth setting the owner enables in the dashboard. It is not enforced in code.

**Feature flags.**
- `src/server/features/flags.ts` `isFeatureEnabled(name, brandKey?, deps?)` reads `FEATURE_<NAME>` = `on` | `off` | `allowlist` (+ `FEATURE_<NAME>_BRANDS`). An unset variable means off in production.
- For a feature whose `spend` list is non-empty (`src/server/features/names.ts`), it also requires each spend key's `paid_feature_controls` row to be `enabled` and to admit the brand (mode `all`, or `allowlist` with the brand in `brand_allowlist`).
- Answers are cached for 30 s per process. `invalidateFeatureFlagCache()` clears the cache.
- There are 55 call sites. `src/server/features/clientFeatures.ts` exposes `CLIENT_FEATURES` to the browser through `GET /api/customer/features`.
- Changing access means editing Vercel variables and redeploying.

**Operator surfaces.**
- `/ops/costs` (F03) shows costs by workspace and endpoint, estimate accuracy, open holds and the reconciliation queue. It edits `paid_feature_controls` (`/api/ops/spend/controls[/feature]`) and `workspace_spend_limits` (`/api/ops/spend/limits[/brandKey]`).
- `/ops/measurement` is the measurement console.
- `/api/ops/*` is gated by the shared `OPERATOR_TOKEN` (header or `operator_token` cookie) in `src/server/operatorPerimeter.js` + `src/middleware.js`. The pages render for anyone, and only their data calls are refused.
- `POST /api/customers/invite` creates a brand and invites an owner. It is token-gated, has no UI, and sets no plan or limits.

**Spend.**
- `workspace_spend_limits (brand_key, daily_cap_usd, monthly_cap_usd)`. A missing row uses env `SPEND_DEFAULT_DAILY_CAP_USD` / `SPEND_DEFAULT_MONTHLY_CAP_USD`, and unset means no cap.
- `paid_feature_controls.daily_cap_usd` is platform-wide.
- AI-visibility scans are not `metered()`. They dispatch through `claim_probe_dispatch` (migration 035), governed by the singleton `probe_dispatch_control` (`paused`, `canaries_allowed`, `brand_allowlist`). `set_probe_rollout` changes it, and safety rule 3 forbids calling it from code.

**Must not break.**
- Every existing env-flag behaviour when no database setting exists.
- `/ops/costs` and `/ops/measurement` with the operator token.
- The P0 dispatch controls. F28 reads them and never writes them.
- `requireWorkspace` semantics.
- F24's disposable-email refusal.
- F27 onboarding for self-serve users.

## 4. Target behaviour and acceptance criteria

**Operator identity and access**
- **F28-AC-01** An operator is a signed-in Supabase user with a row in `platform_operators` (role `owner`, `admin` or `viewer`). `requireOperator()` returns 401 `unauthenticated` without a session, 404 `not_found` for a signed-in non-operator (the console's existence is not disclosed), and 403 `operator_role_required` when the role is too low. *Route test.*
- **F28-AC-02** Every `/api/operator/*` route is self-gated by `requireOperator()`, refuses cross-site writes (403 `cross_site`) and answers with `Cache-Control: no-store`. The perimeter lists the namespace as self-gated, and a perimeter test asserts it. *Unit + route test.*
- **F28-AC-03** `/ops/*` pages render only for operators. Anyone else gets the app's 404, and a signed-out visitor is redirected to `/login?next=/ops`. The existing token-gated `/ops/costs` data routes keep working unchanged. *Route + browser test.*
- **F28-AC-04** Role rules:
  - `viewer` reads everything and changes nothing.
  - `admin` manages workspaces, feature access, plans, limits and clients.
  - Only `owner` changes sign-up mode, the default plan and the operator list.
  - The last `owner` cannot be removed or demoted (409 `last_owner`).

  *Route + DB test.*
- **F28-AC-05** The first operator is granted only by the owner-run script `scripts/ops/grant-operator.mjs --email <address> --role owner`. It refuses unknown users, prints only `granted`, `already_operator` or a refusal code, and never prints the address. No migration seeds an operator. *Script test.*
- **F28-AC-06** With `FEATURE_OPERATOR_CONSOLE` unset or `off` in production, every `/api/operator/*` route answers 404 and `/ops` (other than `/ops/costs` and `/ops/measurement`) is the 404 page. *Route test.*

**Feature access engine**
- **F28-AC-07** `isFeatureEnabled(name, brandKey)` keeps its signature. For brand-scoped evaluation it resolves in this exact order; the first rule that applies wins:
  1. env `FEATURE_<NAME>=off` → off (`env_kill`);
  2. global setting `off` → off (`global_off`);
  3. a workspace override → its state (`override`);
  4. global setting `on` → on (`global_on`);
  5. global setting `plans` → the workspace plan's state for the feature, where a missing plan or plan row means off (`plan` / `plan_missing`);
  6. no global setting row → the current env behaviour unchanged (`legacy_env`).

  After that, a paid feature also needs its `paid_feature_controls` row(s) to admit the brand (`spend_control`). *Unit test with every branch.*
- **F28-AC-08** Without a `brandKey`, only rules 1, 2, 4 and 6 apply. A global `plans` setting then evaluates as off, with source `plan_missing`. *Unit test.*
- **F28-AC-09** `jobs_tick` and `operator_console` are environment-only (`ENV_ONLY_FEATURES`). The database is never read for them, and the console shows them read-only. *Unit test.*
- **F28-AC-10** When the access tables cannot be read, a free feature falls back to `legacy_env` and a paid feature evaluates off. Neither answer is cached. *Unit test.*
- **F28-AC-11** An operator change takes effect on the same server process immediately (cache invalidated) and on every other process within 30 s. *Unit test (cache) + documented.*
- **F28-AC-12** With zero rows in the new tables, every feature answers exactly as before F28, across the full matrix of env values × paid controls. *Contract test against the pre-F28 truth table.*

**Plans and limits**
- **F28-AC-13** A plan has a key, name, description, daily and monthly caps (null = no cap) and a per-feature state (`on`/`off`). Three plans are seeded: `trial`, `client` and `internal` (§6.1.2). Operators can edit any plan and create new ones. A plan that a workspace uses cannot be deleted (409 `plan_in_use`). *DB + route test.*
- **F28-AC-14** Assigning a plan to a workspace writes `workspace_plans` and sets the workspace's spend limits to the plan's caps, with `source = 'plan'`, in one transaction. Editing a plan's caps updates every workspace on that plan whose limits come from the plan; workspaces with custom limits are left alone. *DB test.*
- **F28-AC-15** Setting custom limits on a workspace marks them `source = 'custom'`, and plan changes no longer move them. "Reset to plan" restores `source = 'plan'` and the plan's caps. *DB + route test.*
- **F28-AC-16** A workspace with no `workspace_plans` row uses `platform_settings.default_plan_key` for evaluation. Its limits stay as they are (row or env defaults) until a plan is explicitly assigned. *Unit + DB test.*

**Workspaces**
- **F28-AC-17** `GET /api/operator/workspaces` lists every workspace and is paginated (50 per page). It supports search by name, host or member email, and filters for plan, status (active/suspended) and creation source. Each row shows:
  - name, host, created date, creation source;
  - owner email(s), member count, plan;
  - status, last activity;
  - accounted spend for the last 7 and 30 days, and open holds.

  Denominators are honest: "n of N workspaces". *Route + DB test.*
- **F28-AC-18** `GET /api/operator/workspaces/[brandKey]` returns:
  - the profile, members and pending invites;
  - the plan and limits (with `source`);
  - the effective access of every feature, with its source and the rule that decided it;
  - spend by feature for 30 days;
  - the last 50 audit entries for the workspace.

  *Route test.*
- **F28-AC-19** Workspace actions (admin): assign plan; set or clear a per-feature override; set custom limits; reset limits to plan; suspend with a reason; reactivate; resend the owner invite; invite a member. Each action writes exactly one audit row with before/after. *Route + DB test.*
- **F28-AC-20** A suspended workspace (`is_active = false`) disappears from its members' workspace list (existing behaviour). Onboarding refuses to create a replacement workspace for a user whose only memberships are suspended (403 `workspace_suspended`, copy in §6.6). Jobs that already check `is_active` keep skipping it. *Route test.*

**Global feature access**
- **F28-AC-21** `/ops/features` lists every feature in `FEATURES` with:
  - its access mode (`off`, `plans`, `on`, or "not managed" = no row);
  - its env value (on/off/allowlist/unset, never the brand list contents);
  - whether it is paid, and for paid ones the spend control's enabled flag, mode, platform daily cap and max per call;
  - how many workspaces currently have it on.

  *Route + browser test.*
- **F28-AC-22** Setting a paid feature's access mode to `plans` or `on` also sets each of its spend controls to `mode = 'all'` in the same transaction, because access is now decided per workspace by F28. The old `brand_allowlist` is kept but no longer consulted. The UI says so before confirming. The spend control's `enabled` switch and caps stay separate controls on the same page. *DB + route test.*
- **F28-AC-23** The owner-run script `scripts/ops/import-env-flags.mjs` reads the production `FEATURE_<NAME>_BRANDS` values and writes them as workspace overrides plus a global `plans`/`on`/`off` row per feature. It defaults to `--dry-run` and prints feature names and counts only. *Script test.*

**Clients and sign-up**
- **F28-AC-24** `POST /api/operator/clients` takes company name, website, owner email, plan and an optional note. It creates the workspace (`created_via = 'operator'`, new UUID `brand_key`, no owner membership yet), assigns the plan with its limits, creates a pending owner invite, and sends the Supabase invite email. If the email already has an account, it adds the owner membership directly instead. It is idempotent on a client-supplied key. *Route + DB test.*
- **F28-AC-25** An invited owner of an operator-created workspace who opens `/onboarding` adopts that workspace and never gets `already_has_workspace` or a second workspace. Their website step is pre-filled, and the wizard continues from the next step. *Route test.*
- **F28-AC-26** `platform_settings.signup_mode` is `open` or `invite_only`. In `invite_only`, the Auth hook refuses creating an account for an address with no pending invite: 403 with the message in §6.6. The onboarding website step refuses too (403 `signup_closed`) as a second line of defence when the hook is not enabled. Invited addresses always pass. *DB test (hook function) + route test.*
- **F28-AC-27** `/signup` shows the invite-only notice and hides the form when the mode is `invite_only`. `/login` is unchanged. *Browser test.*
- **F28-AC-28** `POST /api/customers/invite` (token-gated, legacy) keeps its request and response shape but runs through the F28 client service, so it also gets a plan and an audit row (actor `token`). *Route test.*

**Visibility, audit and safety**
- **F28-AC-29** Every operator write appends one `operator_audit_log` row: actor, action, target, before, after, note. The table refuses `UPDATE` and `DELETE` for every role, including the service role. `/ops/audit` lists it with filters. *DB + route test.*
- **F28-AC-30** `/ops` (overview) shows:
  - workspace counts (total, active, suspended, created in the last 7 days);
  - spend today, for 7 days and for 30 days, platform-wide;
  - sign-up mode and default plan;
  - the dispatch control's state, read-only (paused, canaries allowed, number of allowlisted brands);
  - the 10 newest audit entries.

  Nothing on `/ops` writes `probe_dispatch_control` or calls `set_probe_rollout`, and a guard test greps the console code for both names. *Route + unit guard test.*
- **F28-AC-31** No customer role can read any F28 table. The UAT isolation block asserts zero rows for `authenticated` and `anon` on each one. *DB test (`tests/customer-uat.sql`).*
- **F28-AC-32** Operator email addresses and client emails never appear in logs, telemetry or audit `note` text written by the code. Audit rows store user ids. The console resolves ids to emails at read time. *Unit test on the audit writer + log guard.*

## 5. Scope

**In scope:**
- operator accounts and roles, and the bootstrap script;
- database-backed feature access with the precedence in AC-07, and the import script from env;
- plans with feature states and caps, plan-sourced vs custom limits;
- the workspaces list and detail with actions; suspend and reactivate;
- create client with invite; invite-only sign-up;
- the global feature access page that unifies flags and paid spend controls;
- the audit log;
- the operator shell and navigation: `/ops`, `/ops/workspaces`, `/ops/workspaces/new`, `/ops/workspaces/[brandKey]`, `/ops/features`, `/ops/plans`, `/ops/plans/[planKey]`, `/ops/settings`, `/ops/audit`, with the existing `/ops/costs` and `/ops/measurement` in the same nav;
- rewiring the legacy invite route.

**Out of scope:**
- **Billing and payments:** excluded by owner decision.
- **Deleting a workspace:** suspend only. Deletion stays a manual, owner-run operation.
- **Impersonating a customer ("view as"):** a separate decision; see §11.
- **Changing dispatch rollout:** safety rule 3. The console shows dispatch state read-only.
- **A separate subdomain:** `/ops` on the same deployment. A host alias (e.g. `ops.<domain>`) can point at the same paths later, with no code change.
- **Per-plan scan allowances (scans per month):** scans are governed by P0 dispatch controls; see §11.
- **MFA enrolment UI:** see §11.
- **PostHog events for operator actions:** the audit log is the record. `src/shared/telemetry/events.ts` is unchanged.
- **Moving `/ops/costs` data routes off the operator token:** they keep the token. The new console links to the page, and its own routes use sessions.

## 6. Design

### 6.1 Data model

All tables are operator-only: RLS enabled, no policy for `anon` or `authenticated`, `REVOKE ALL ... FROM PUBLIC, anon, authenticated`, `GRANT ALL ... TO service_role`. Feature names are validated in TypeScript (`FeatureName`) and by a test that every seeded name exists in `FEATURES`. SQL checks only the format.

#### 6.1.1 `175_f28_operator_identity.sql`

```sql
CREATE TABLE IF NOT EXISTS public.platform_operators (
  user_id    uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('owner','admin','viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,  -- null = bootstrap script
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.platform_operators IS
  'Perceev staff who may use /ops. Granted by scripts/ops/grant-operator.mjs or by an owner operator.';

CREATE TABLE IF NOT EXISTS public.platform_settings (
  singleton        boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  signup_mode      text NOT NULL DEFAULT 'open' CHECK (signup_mode IN ('open','invite_only')),
  default_plan_key text NOT NULL DEFAULT 'trial',   -- FK added in 176 once plans exist
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid REFERENCES auth.users(id) ON DELETE SET NULL
);
INSERT INTO public.platform_settings (singleton) VALUES (true) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS public.operator_audit_log (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at          timestamptz NOT NULL DEFAULT now(),
  actor_kind  text NOT NULL CHECK (actor_kind IN ('operator','token','script')),
  actor_id    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  action      text NOT NULL CHECK (action ~ '^[a-z_]+\.[a-z_]+$'),     -- e.g. workspace.suspend
  target_kind text NOT NULL CHECK (target_kind IN ('workspace','feature','plan','settings','operator','spend_control')),
  target_id   text NOT NULL CHECK (length(target_id) BETWEEN 1 AND 200),
  brand_key   text REFERENCES public.customer_brands(brand_key) ON DELETE SET NULL,
  before      jsonb,
  after       jsonb,
  note        text CHECK (note IS NULL OR length(note) <= 500)
);
CREATE INDEX IF NOT EXISTS operator_audit_log_at_idx    ON public.operator_audit_log (at DESC);
CREATE INDEX IF NOT EXISTS operator_audit_log_brand_idx ON public.operator_audit_log (brand_key, at DESC) WHERE brand_key IS NOT NULL;

CREATE OR REPLACE FUNCTION public.operator_audit_log_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'operator_audit_log is append-only' USING ERRCODE = '42501';
END;
$$;
DROP TRIGGER IF EXISTS operator_audit_log_no_change ON public.operator_audit_log;
CREATE TRIGGER operator_audit_log_no_change
  BEFORE UPDATE OR DELETE ON public.operator_audit_log
  FOR EACH ROW EXECUTE FUNCTION public.operator_audit_log_append_only();
-- ON DELETE SET NULL on brand_key/actor_id is an UPDATE, so the trigger must allow exactly that:
-- replaced in the same file by a version that permits UPDATE only when every column except
-- brand_key/actor_id is unchanged and those two go to NULL. Test both paths (AC-29).

CREATE OR REPLACE FUNCTION public.operator_role(p_user uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT role FROM public.platform_operators WHERE user_id = p_user;
$$;

CREATE OR REPLACE FUNCTION public.operator_owner_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Fires after DELETE or UPDATE OF role; refuses leaving zero owners.
  IF NOT EXISTS (SELECT 1 FROM public.platform_operators WHERE role = 'owner') THEN
    RAISE EXCEPTION 'last_owner' USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS platform_operators_last_owner ON public.platform_operators;
CREATE CONSTRAINT TRIGGER platform_operators_last_owner
  AFTER DELETE OR UPDATE OF role ON public.platform_operators
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION public.operator_owner_guard();
```

Grants: the three tables and `operator_role` are service-role only. `platform_settings` is also readable by `supabase_auth_admin` (needed by the hook in 178), guarded by `IF EXISTS (pg_roles ...)` exactly as migration 155 does.

#### 6.1.2 `176_f28_feature_access.sql`

```sql
CREATE TABLE IF NOT EXISTS public.operator_plans (
  key             text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_]{1,39}$'),
  name            text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 60),
  description     text CHECK (description IS NULL OR length(description) <= 300),
  daily_cap_usd   numeric(12,6) CHECK (daily_cap_usd IS NULL OR daily_cap_usd >= 0),
  monthly_cap_usd numeric(12,6) CHECK (monthly_cap_usd IS NULL OR monthly_cap_usd >= 0),
  sort_order      integer NOT NULL DEFAULT 100,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS public.operator_plan_features (
  plan_key text NOT NULL REFERENCES public.operator_plans(key) ON DELETE CASCADE,
  feature  text NOT NULL CHECK (feature ~ '^[a-z][a-z0-9_]*$'),
  state    text NOT NULL CHECK (state IN ('on','off')),
  PRIMARY KEY (plan_key, feature)
);

CREATE TABLE IF NOT EXISTS public.feature_access_settings (
  feature    text PRIMARY KEY CHECK (feature ~ '^[a-z][a-z0-9_]*$'),
  mode       text NOT NULL CHECK (mode IN ('off','plans','on')),
  note       text CHECK (note IS NULL OR length(note) <= 300),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL
);
COMMENT ON TABLE public.feature_access_settings IS
  'No row = the feature is not managed here and FEATURE_<NAME> env decides (pre-F28 behaviour).';

CREATE TABLE IF NOT EXISTS public.workspace_plans (
  brand_key   text PRIMARY KEY REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  plan_key    text NOT NULL REFERENCES public.operator_plans(key) ON DELETE RESTRICT,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  assigned_by uuid REFERENCES auth.users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS workspace_plans_plan_idx ON public.workspace_plans (plan_key);

CREATE TABLE IF NOT EXISTS public.workspace_feature_overrides (
  brand_key  text NOT NULL REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  feature    text NOT NULL CHECK (feature ~ '^[a-z][a-z0-9_]*$'),
  state      text NOT NULL CHECK (state IN ('on','off')),
  note       text CHECK (note IS NULL OR length(note) <= 300),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  PRIMARY KEY (brand_key, feature)
);

ALTER TABLE public.workspace_spend_limits
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'custom' CHECK (source IN ('plan','custom'));

-- Added with DEFAULT 'legacy' so every pre-F28 row is marked once, at the moment the column
-- appears; the default then switches to 'self_serve'. No UPDATE: setup-supabase.mjs re-runs every
-- migration, and an UPDATE here would re-tag rows created after F28 on every run.
ALTER TABLE public.customer_brands
  ADD COLUMN IF NOT EXISTS created_via text NOT NULL DEFAULT 'legacy'
    CHECK (created_via IN ('self_serve','operator','legacy')),
  ADD COLUMN IF NOT EXISTS suspended_at timestamptz,
  ADD COLUMN IF NOT EXISTS suspended_reason text CHECK (suspended_reason IS NULL OR length(suspended_reason) <= 300);
ALTER TABLE public.customer_brands ALTER COLUMN created_via SET DEFAULT 'self_serve';

INSERT INTO public.operator_plans (key, name, description, daily_cap_usd, monthly_cap_usd, sort_order) VALUES
  ('trial',    'Trial',    'Free features only. Small caps.',              1,    5,    10),
  ('client',   'Client',   'Every feature. Managed client caps.',          20,   200,  20),
  ('internal', 'Internal', 'Every feature. No caps. Perceev staff only.',   NULL, NULL, 30)
ON CONFLICT (key) DO NOTHING;
-- Feature rows for the seeds are inserted by the same file from a literal list that a test
-- compares to FEATURES (names.ts): trial = every feature whose spend list is empty, minus
-- ENV_ONLY_FEATURES; client and internal = every feature minus ENV_ONLY_FEATURES. ON CONFLICT DO NOTHING.

ALTER TABLE public.platform_settings
  DROP CONSTRAINT IF EXISTS platform_settings_default_plan_fk,
  ADD CONSTRAINT platform_settings_default_plan_fk
    FOREIGN KEY (default_plan_key) REFERENCES public.operator_plans(key) ON DELETE RESTRICT;
```

**The `created_via` backfill.** Every existing row is marked `legacy`, so the console can tell which workspaces predate F28. The QA DB group `access` re-runs the file and asserts a row created between the two runs keeps `self_serve`.

**Plan seeds are defaults, not policy.** The owner edits them in `/ops/plans`. A feature added to `FEATURES` after this migration is not in any plan until an operator adds it. The `/ops/plans/[planKey]` page lists missing features explicitly, so they read as "not in plan", never as silently off.

#### 6.1.3 `177_f28_operator_functions.sql`

All functions are `SECURITY DEFINER SET search_path = public, pg_temp`, executable by `service_role` only.

```sql
-- One page of the workspaces list. Reads auth.users for owner emails (service role only).
CREATE OR REPLACE FUNCTION public.operator_workspace_overview(
  p_search text DEFAULT NULL,          -- matches display_name, website_host, member email (ILIKE, escaped)
  p_status text DEFAULT NULL,          -- 'active' | 'suspended' | NULL
  p_plan   text DEFAULT NULL,          -- plan key, or '__default__' for "no plan row"
  p_source text DEFAULT NULL,          -- created_via
  p_limit  integer DEFAULT 50,         -- clamped 1..100
  p_offset integer DEFAULT 0
) RETURNS TABLE (
  brand_key text, display_name text, website_host text, is_active boolean,
  created_at timestamptz, created_via text, plan_key text, plan_is_default boolean,
  owner_emails text[], member_count integer, pending_invites integer,
  last_activity_at timestamptz,        -- greatest(max scan_jobs.created_at, max spend_ledger.created_at, max membership.created_at)
  spend_7d_usd numeric, spend_30d_usd numeric, open_holds integer,
  total_count bigint                   -- same value on every row: the filtered total, for "n of N"
) ...;

-- Everything the detail page needs except per-feature access (computed in TypeScript, §6.2.3).
CREATE OR REPLACE FUNCTION public.operator_workspace_detail(p_brand_key text) RETURNS jsonb ...;
--   { brand: {...customer_brands row}, members: [{user_id, email, role, created_at}],
--     invites: [{id, email, role, status, expires_at}], plan: {key, assigned_at} | null,
--     limits: {daily_cap_usd, monthly_cap_usd, source} | null,
--     overrides: [{feature, state, note, updated_at}],
--     spend_by_feature_30d: [{feature, accounted_usd, calls}] }

-- Atomic plan assignment: workspace_plans upsert + workspace_spend_limits upsert (source='plan').
CREATE OR REPLACE FUNCTION public.operator_assign_plan(p_brand_key text, p_plan_key text, p_actor uuid)
RETURNS jsonb ...;   -- returns {before:{plan_key, limits}, after:{plan_key, limits}} for the audit row

-- Plan cap edits propagate to plan-sourced limits only.
CREATE OR REPLACE FUNCTION public.operator_update_plan_caps(p_plan_key text, p_daily numeric, p_monthly numeric, p_actor uuid)
RETURNS integer ...; -- number of workspace_spend_limits rows updated

-- Platform totals for /ops.
CREATE OR REPLACE FUNCTION public.operator_platform_summary() RETURNS jsonb ...;
--   { workspaces: {total, active, suspended, created_7d},
--     spend: {today_usd, d7_usd, d30_usd}, holds_open: n }
```

`spend_*` read `spend_ledger.actual_usd`, falling back to the estimate for unknown actuals exactly as `operator_costs_by_workspace` does. A test compares the two for one workspace. Unknown amounts are reported separately and never counted as zero (safety rule 10). The page shows "includes $x unknown" when non-zero.

#### 6.1.4 `178_f28_clients_and_signup.sql`

```sql
-- Operator creates a workspace with no member yet, plus a pending owner invite.
CREATE OR REPLACE FUNCTION public.operator_create_workspace(
  p_brand_key text, p_display_name text, p_website text, p_website_host text,
  p_owner_email text, p_plan_key text, p_actor uuid, p_idempotency_key text
) RETURNS jsonb ...;
-- Steps, one transaction, advisory lock on hashtextextended(p_idempotency_key, 0):
--  1. if customer_brands.idempotency_key = 'operator:' || p_idempotency_key exists → return {brand_key, created:false}
--  2. INSERT customer_brands (..., created_via='operator', idempotency_key='operator:'||key)
--  3. PERFORM operator_assign_plan(brand, plan, actor)
--  4. INSERT customer_team_invites (brand_key, email=lower(btrim(p_owner_email)), role='owner', invited_by=p_actor)
--  5. return {brand_key, created:true, invite_id}

-- Sign-up gate. Replaces F24's function body, keeping its disposable-domain branch verbatim.
CREATE OR REPLACE FUNCTION public.hook_before_user_created(event jsonb) RETURNS jsonb ...;
--  v_email empty → '{}' (unchanged)
--  has pending, unexpired customer_team_invites for v_email → '{}'   (moved first: invites always pass)
--  platform_settings.signup_mode = 'invite_only' → error 403, message §6.6 "signup closed"
--  disposable domain → error 400 (unchanged copy)
--  else '{}'

CREATE OR REPLACE FUNCTION public.signup_allowed_for(p_email text) RETURNS boolean ...;
-- Same rule as the hook minus the disposable check, for the onboarding route's second line of defence.
```

`operator_create_workspace` needs `invited_by` to be a real user, and the actor always is one (an operator). For the legacy token route, the actor is the oldest `owner` operator and `actor_kind = 'token'` in the audit row. If no owner operator exists, the route answers 503 `operator_not_configured`.

Migration **179** is reserved and unused. Leave it free for a fix-forward.

### 6.2 Server modules

#### 6.2.1 Operator identity — `src/server/ops/requireOperator.ts`

```ts
export type OperatorRole = "owner" | "admin" | "viewer";
export type Operator = { userId: string; role: OperatorRole; admin: SupabaseClient };
export type RequireOperatorDeps = RequireUserDeps & { loadRole?: (admin: SupabaseClient, userId: string) => Promise<OperatorRole | null>; env?: Record<string, string | undefined> };
export async function requireOperator(request: Request, opts?: { role?: OperatorRole }, deps?: RequireOperatorDeps): Promise<Operator>;
// Order: FEATURE_OPERATOR_CONSOLE env (not on → AppError 404 not_found) → requireUser (401) →
// cross-site write check (same rule as requireWorkspace, 403 cross_site) → loadRole (null → 404 not_found) →
// role rank owner(3) > admin(2) > viewer(1); below opts.role → 403 operator_role_required.
export function roleAtLeast(actual: OperatorRole, needed: OperatorRole): boolean;
```

`src/server/ops/requireOperatorPage.ts` is the same check for server components. It returns `Operator`, `redirect("/login?next=" + path)` when signed out, or calls `notFound()`.

#### 6.2.2 Audit — `src/server/ops/audit.ts`

```ts
export type AuditAction =
  | "workspace.assign_plan" | "workspace.set_override" | "workspace.clear_override"
  | "workspace.set_limits" | "workspace.reset_limits" | "workspace.suspend" | "workspace.reactivate"
  | "workspace.resend_invite" | "workspace.invite_member" | "client.create"
  | "feature.set_mode" | "spend_control.update" | "plan.create" | "plan.update" | "plan.delete"
  | "settings.update" | "operator.grant" | "operator.change_role" | "operator.revoke";
export async function writeAudit(admin: SupabaseClient, entry: {
  actor: { kind: "operator" | "token" | "script"; userId: string | null };
  action: AuditAction; target: { kind: AuditTargetKind; id: string }; brandKey?: string;
  before?: unknown; after?: unknown; note?: string;
}): Promise<void>;   // throws AppError 503 audit_unavailable; callers do the write and the audit in one RPC where SQL allows, else write first then audit and surface 503 if audit fails
export function redactForAudit(value: unknown): unknown; // drops any key matching /email|token|secret|password/i
export async function listAudit(admin: SupabaseClient, q: { brandKey?: string; action?: string; actorId?: string; before?: number; limit: number }): Promise<AuditRow[]>;
```

#### 6.2.3 Feature access engine

- **`src/server/features/names.ts`.** Add `operator_console: { spend: [] as const }` and export `ENV_ONLY_FEATURES = ["jobs_tick", "operator_console"] as const satisfies readonly FeatureName[]`.
- **`src/server/features/access.ts`** (new):

```ts
export type AccessSource =
  | "env_kill" | "global_off" | "override" | "global_on" | "plan" | "plan_missing"
  | "legacy_env" | "spend_control" | "env_only" | "store_unavailable";
export type FeatureAccess = {
  name: FeatureName; enabled: boolean; source: AccessSource;
  planKey?: string; overrideState?: "on" | "off"; mode?: "off" | "plans" | "on" | null;
  spendBlockedBy?: string[];     // spend keys whose control refused
};
export type AccessSnapshot = {
  settings: Map<FeatureName, "off" | "plans" | "on">;
  overrides: Map<FeatureName, "on" | "off">;   // for the brand
  planKey: string | null;                       // workspace_plans or platform default
  planIsDefault: boolean;
  planFeatures: Map<FeatureName, "on" | "off">;
};
export async function loadAccessSnapshot(admin: SupabaseClient, brandKey: string | undefined): Promise<AccessSnapshot>;
export function decideAccess(name: FeatureName, env: Record<string, string | undefined>, snap: AccessSnapshot | null, brandKey?: string): FeatureAccess;  // pure; the AC-07 table
export async function resolveFeatureAccess(name: FeatureName, brandKey?: string, deps?: FeatureFlagDeps): Promise<FeatureAccess>;
export async function resolveAllFeatureAccess(brandKey: string, deps?: FeatureFlagDeps): Promise<FeatureAccess[]>;  // one snapshot, every feature
```

- **`flags.ts`.** `isFeatureEnabled` becomes `(await resolveFeatureAccess(name, brandKey, deps)).enabled`. The existing env parsing moves into `decideAccess` unchanged as the `legacy_env` branch. `spendControlsAllow` is unchanged and runs after `decideAccess` when the result is enabled. Caching:
  - the global settings map is cached 30 s per process;
  - each brand's overrides, plan and plan features are cached 30 s per brand (same size cap as today);
  - `invalidateFeatureFlagCache()` clears all of it;
  - a snapshot read error is not cached (AC-10).
- **Fail-closed rule.** If `loadAccessSnapshot` throws, a free feature uses `decideAccess(name, env, null)`, which gives `legacy_env`, and a paid feature returns `{ enabled: false, source: "store_unavailable" }`.

#### 6.2.4 Operator services — `src/server/ops/`

| File | Exports | Notes |
|---|---|---|
| `workspaces.ts` | `listWorkspaces(admin, query)`, `getWorkspaceDetail(admin, brandKey)` (adds `resolveAllFeatureAccess`), `suspendWorkspace(op, brandKey, reason)`, `reactivateWorkspace(op, brandKey)` | Suspend sets `is_active=false, suspended_at, suspended_reason`; refuses when already suspended (409 `already_suspended`) |
| `access.ts` | `setWorkspaceOverride(op, brandKey, feature, state, note)`, `clearWorkspaceOverride(op, brandKey, feature)`, `setFeatureMode(op, feature, mode, note)` | `setFeatureMode` on a paid feature with mode `plans`/`on` also sets its spend controls to `mode='all'` in one RPC (AC-22). Refuses `ENV_ONLY_FEATURES` (409 `env_only_feature`). Every write calls `invalidateFeatureFlagCache()` |
| `plans.ts` | `listPlans`, `getPlan`, `createPlan`, `updatePlan` (name, description, caps, feature states), `deletePlan` (409 `plan_in_use` or 409 `plan_is_default`), `assignPlan(op, brandKey, planKey)` | Cap changes call `operator_update_plan_caps` and report the count in the response |
| `limits.ts` | `setCustomLimits(op, brandKey, {dailyCapUsd, monthlyCapUsd})`, `resetLimitsToPlan(op, brandKey)` | Reuses the validation in `src/shared/spend/spend.contract.ts` |
| `clients.ts` | `createClient(actor, input)` | §6.2.5 |
| `settings.ts` | `getSettings`, `updateSettings(op, {signupMode?, defaultPlanKey?})` (owner only) | |
| `operators.ts` | `listOperators` (with emails), `grantOperator(op, email, role)`, `changeRole`, `revokeOperator` (owner only; last-owner guard maps to 409 `last_owner`) | |
| `summary.ts` | `getPlatformSummary(admin)` | Adds the dispatch control read: `select paused, canaries_allowed, cardinality(brand_allowlist)` from `probe_dispatch_control`. Read-only |

`op` is the `Operator` from `requireOperator`. Every write service checks the role itself as well (defence in depth), calls `writeAudit` and returns `{ before, after }`.

#### 6.2.5 Create client — `src/server/ops/clients.ts`

```ts
export type CreateClientInput = { companyName: string; website: string; ownerEmail: string; planKey: string; note?: string; idempotencyKey: string };
export async function createClient(actor: { kind: "operator" | "token"; userId: string | null; admin: SupabaseClient }, input: CreateClientInput, deps?: { sendInvite?: ...; appUrl?: string }):
  Promise<{ brandKey: string; created: boolean; invite: "sent" | "member_added" | "already_pending" }>;
```

1. Normalise with `normalizeCustomerBrand({ brandKey: crypto.randomUUID(), brandName, website })` from `src/server/customerProvisioning.js`. Map errors to 400 `company_name_invalid` / `website_invalid`.
2. Run `findCustomerBrandAliasConflict`. A conflict is 409 `brand_exists`, and the response includes the existing `brand_key` when the caller is an operator.
3. Call the RPC `operator_create_workspace`. If it returns `created:false`, return the stored result (idempotent).
4. If an auth user with that email exists, upsert the owner membership, mark the invite `accepted` and return `member_added`. Otherwise call `admin.auth.admin.inviteUserByEmail(email, { redirectTo: appUrl + "/auth/callback?next=/onboarding" })`, as `src/app/api/customer/team/route.js` does. If sending fails, keep the workspace, leave the invite pending, and return 502 `invite_send_failed` with recovery "Use Resend invite on the workspace page."
5. Write the audit row `client.create` with `{ brandKey, planKey, created_via: "operator" }`. The email is not stored in the audit row; the invite row holds it.

#### 6.2.6 Onboarding adoption and suspension — `src/server/onboarding/website.ts`

These are additions only. The self-serve paths stay as they are.

- **Step 1b (new, before step 3):** if `signup_allowed_for(email)` is false and the user has no membership, throw 403 `signup_closed`.
- **Step 3, new branch, before `already_has_workspace`:** no onboarding row, the user has exactly one membership, its brand has `created_via = 'operator'`, the role is `owner`, and the brand is active. Then adopt it:
  - set `brandKey` to that brand;
  - if the submitted website or name differ from what the operator entered, apply them only while the workspace has no scans, using the existing `website_locked` rule;
  - continue with step 4.
- **Step 3, new refusal:** the user has memberships but every one is in a suspended brand. Throw 403 `workspace_suspended`. This needs an extra query that includes inactive brands; the current one already does.

#### 6.2.7 Legacy route — `src/app/api/customers/invite/route.js`

The body schema and response keys stay the same. The handler calls `createClient({ kind: "token", userId: <oldest owner operator>, admin }, { ..., planKey: settings.defaultPlanKey, idempotencyKey: "legacy:" + sha256(email + brand_key) })`. The legacy request can carry a `brand_key`. If it does, the route uses it instead of a random UUID, as it does today.

### 6.3 Jobs

None. Audit rows are small and kept indefinitely; §11 revisits this if they grow.

### 6.4 Provider calls and cost

None. The console reads costs that F01/F03 already record. Sending an invite email uses Supabase Auth, which is not metered.

### 6.5 API routes

Shared rules for every route:
- the namespace is `/api/operator/`, self-gated (added to `SELF_GATED` in `src/server/operatorPerimeter.js` with a comment and a test);
- `requireOperator` runs first;
- bodies are parsed with zod `strictObject`, so unknown fields return 400 `invalid_request`;
- errors go through `toErrorResponse`, with `Cache-Control: no-store`;
- writes take an optional `note` (≤ 300 characters).

The minimum role is in brackets.

| Method & path | Role | Request | Response (200 unless noted) | Errors |
|---|---|---|---|---|
| `GET /api/operator/summary` | viewer | — | `{ workspaces:{total,active,suspended,created7d}, spend:{todayUsd,d7Usd,d30Usd,unknownUsd}, holdsOpen, signupMode, defaultPlanKey, dispatch:{paused,canariesAllowed,allowlistedBrands}, recentAudit:[…10] }` | 503 `storage_unavailable` |
| `GET /api/operator/workspaces?q=&status=&plan=&source=&page=` | viewer | query (page ≥ 1) | `{ items:[WorkspaceRow], page, pageSize:50, total }` | 400 `invalid_request` |
| `GET /api/operator/workspaces/[brandKey]` | viewer | — | `{ brand, members, invites, plan, limits, access:[FeatureAccess], spendByFeature30d, audit:[…50] }` | 404 `workspace_not_found` |
| `PUT /api/operator/workspaces/[brandKey]/plan` | admin | `{ planKey }` | `{ before, after }` | 404, 409 `plan_not_found` |
| `PUT /api/operator/workspaces/[brandKey]/features/[feature]` | admin | `{ state: "on" \| "off" }` | `{ before, after, access }` | 400 `unknown_feature`, 409 `env_only_feature` |
| `DELETE /api/operator/workspaces/[brandKey]/features/[feature]` | admin | — | `{ before, after:null, access }` | as above |
| `PUT /api/operator/workspaces/[brandKey]/limits` | admin | `{ dailyCapUsd: number\|null, monthlyCapUsd: number\|null }` | `{ before, after }` | 400 `invalid_cap` |
| `POST /api/operator/workspaces/[brandKey]/limits/reset` | admin | — | `{ before, after }` | 409 `no_plan` |
| `POST /api/operator/workspaces/[brandKey]/suspend` | admin | `{ reason }` (1–300) | `{ before, after }` | 409 `already_suspended` |
| `POST /api/operator/workspaces/[brandKey]/reactivate` | admin | — | `{ before, after }` | 409 `not_suspended` |
| `POST /api/operator/workspaces/[brandKey]/invites` | admin | `{ email, role: "owner"\|"member" }` | 201 `{ invite: "sent"\|"member_added"\|"already_pending" }` | 400 `email_invalid`, 502 `invite_send_failed` |
| `POST /api/operator/workspaces/[brandKey]/invites/[inviteId]/resend` | admin | — | `{ invite: "sent" }` | 404, 409 `invite_not_pending` |
| `POST /api/operator/clients` | admin | `{ companyName, website, ownerEmail, planKey, note?, idempotencyKey }` | 201 `{ brandKey, created, invite }` (200 when `created:false`) | 400, 409 `brand_exists`, 502 |
| `GET /api/operator/features` | viewer | — | `{ features:[{ name, paid, envOnly, envValue:"on"\|"off"\|"allowlist"\|"unset", mode:"off"\|"plans"\|"on"\|null, workspacesOn:number, spendControls:[SpendControl] }] }` | — |
| `PUT /api/operator/features/[feature]` | admin | `{ mode: "off"\|"plans"\|"on"\|null }` (null = stop managing, delete row) | `{ before, after, spendControlsChanged:string[] }` | 409 `env_only_feature` |
| `PUT /api/operator/spend-controls/[feature]` | admin | F03's `spendControlPutSchema` body | as F03 | as F03 |
| `GET /api/operator/plans` | viewer | — | `{ plans:[{ key, name, description, dailyCapUsd, monthlyCapUsd, workspaces:number, features:{[name]:"on"\|"off"}, missingFeatures:string[] }] }` | — |
| `POST /api/operator/plans` | admin | `{ key, name, description?, dailyCapUsd, monthlyCapUsd, features, copyFrom? }` | 201 plan | 409 `plan_exists` |
| `PUT /api/operator/plans/[planKey]` | admin | partial of the above minus `key` | `{ before, after, limitsUpdated:number }` | 404 |
| `DELETE /api/operator/plans/[planKey]` | admin | — | `{ deleted:true }` | 409 `plan_in_use`, 409 `plan_is_default` |
| `GET /api/operator/settings` | viewer | — | `{ signupMode, defaultPlanKey, hookCheck:"unknown" }` | — |
| `PUT /api/operator/settings` | owner | `{ signupMode?, defaultPlanKey? }` | `{ before, after }` | 409 `plan_not_found` |
| `GET /api/operator/operators` | owner | — | `{ operators:[{ userId, email, role, createdAt }] }` | — |
| `POST /api/operator/operators` | owner | `{ email, role }` | 201 | 404 `user_not_found` (the person must have signed up first), 409 `already_operator` |
| `PUT /api/operator/operators/[userId]` | owner | `{ role }` | `{ before, after }` | 409 `last_owner` |
| `DELETE /api/operator/operators/[userId]` | owner | — | `{ revoked:true }` | 409 `last_owner` |
| `GET /api/operator/audit?brandKey=&action=&actor=&before=` | viewer | query | `{ items:[AuditRow], nextBefore:number\|null }` (50 per page) | — |
| `GET /api/signup-mode` (public, added to `PUBLIC_EXACT`) | none | — | `{ mode:"open"\|"invite_only" }`, `Cache-Control: public, max-age=60` | 200 `{mode:"open"}` when the store is unavailable (the hook and route still enforce) |

`hookCheck` is always `"unknown"`, because the app cannot read Supabase Auth hook settings. The settings page explains that the dashboard toggle is the owner's step (§10).

### 6.6 UI

**Shell.**
- New console pages live in the route group `src/app/ops/(console)/`, whose server `layout.tsx` runs `requireOperatorPage`, then `OpsShell`. Route groups do not change URLs, so the pages are still `/ops`, `/ops/workspaces` and so on.
- `src/app/ops/layout.jsx` (`AppProviders` only) stays as it is, so `/ops/costs` and `/ops/measurement` keep working exactly as today with the operator token.
- `OpsShell` (`src/components/ops/shell/OpsShell.tsx`) is a left nav (Overview, Workspaces, Features, Plans, Costs, Measurement, Audit, Settings), a header with "Perceev operator" and the operator's role badge, and a "Back to app" link.
- It is light mode only and uses app tokens (convention §12), with no customer sidebar.
- At 390 px wide the nav collapses into a Sheet and the page never scrolls horizontally.
- The console nav links to `/ops/costs` and `/ops/measurement`. Those two pages render without the shell, because they sit outside the route group.

**Pages.** All use F04 primitives (`PageHeader`, `DataTable` from F06, `EmptyState`, `QueryState`, `Dialog`, `Sheet`, `Badge`, `Switch`, `Select`) and F05 query hooks under `src/components/ops/<area>/hooks/`.

1. **`/ops`, Overview.** Stat cards for workspaces (total, active, suspended, new in 7 days) and spend (today, 7 days, 30 days, plus "includes $x unknown" when non-zero).
   - Sign-up mode card: "Open" or "Invite only", with a link to Settings.
   - Dispatch card, read-only: "AI-visibility scans: Paused platform-wide", "Canary runs: allowed", "Brands allowed during pause: n". Help text: "Changed only through the owner's rollout procedure, not here."
   - A recent changes list.
   - States: skeleton while loading; ErrorState with retry; a partial state where any failed card shows "Unavailable" without hiding the others.
2. **`/ops/workspaces`, Workspaces.**
   - Search box (debounced 300 ms, stored as `?q=` in the URL); filters for plan, status and source.
   - Table columns: Name + host; Owner; Plan (badge, "Default (Trial)" when there's no row); Members; Status; Last activity (relative); Spend 7d; Spend 30d; Created.
   - "n of N workspaces" above the table.
   - Row click opens the detail page. A primary button, "Create client", goes to `/ops/workspaces/new`.
   - Empty: "No workspaces yet." Filtered-empty: "No workspaces match these filters." plus a "Clear filters" button.
3. **`/ops/workspaces/[brandKey]`, Workspace detail.** Tabs: Overview · Features · Limits · Members · Activity.
   - **Overview:** profile, created via, status, with Suspend / Reactivate actions. Suspend opens a confirm dialog with a required reason: "Members lose access immediately. Their data is kept."
   - **Features:** a table with one row per feature.
     - Columns: name (with label), Paid badge, effective state (On/Off), "Why" in plain words (e.g. "Plan: Client", "Workspace override", "Turned off for everyone", "Emergency switch in Vercel", "Not managed: Vercel variable", "Spend control off: keywords.research"), and a three-way control (Inherit · On · Off).
     - Environment-only features show a lock and "Set in Vercel".
     - Changing a paid feature to On while its spend control is disabled shows an inline warning: "Access is on, but spending for this feature is switched off platform-wide, so it will still be refused. Turn spending on in Features."
   - **Limits:**
     - shows daily and monthly caps with their source ("From plan Client" or "Custom");
     - an edit form, with empty meaning no cap;
     - "Reset to plan";
     - spend so far today and this month against each cap, as "x of y".
   - **Members:** members (email, role, joined) and pending invites (email, role, expires, Resend). "Invite member" opens a dialog with email and role.
   - **Activity:** the audit entries for this workspace.
4. **`/ops/workspaces/new`, Create client.**
   - Fields: company name, website, owner email, plan (default = platform default), note.
   - Primary button: "Create workspace and send invite".
   - Success screen: "Workspace created. Invite sent to the owner." (or "…added the existing account as owner."), with links "Open workspace" and "Create another".
   - `brand_exists` shows "A workspace for this website already exists." with a link to it.
   - `invite_send_failed` shows "Workspace created, but the invite email failed. Use Resend invite on the workspace page."
5. **`/ops/features`, Features.**
   - Grouped list (AI Visibility, Research, My Site, Content, AI Tools, Account, Platform), one row per feature: name + description (from a new `FEATURE_LABELS` map in `src/shared/features/labels.ts`), access mode selector (Not managed · Off · By plan · On for everyone), env value badge, "On for n workspaces".
   - For paid features, an expandable "Spending" panel reuses `PaidFeatureControls` row UI: enabled switch, mode, platform daily cap, max per call.
   - Selecting "By plan" or "On" for a paid feature opens a confirm dialog listing the spend keys that will switch to "all workspaces" mode (AC-22).
   - "Off" confirm copy: "Turns this feature off for every workspace, including overrides."
6. **`/ops/plans` and `/ops/plans/[planKey]`, Plans.**
   - List: cards with name, caps, number of workspaces and features on.
   - Detail:
     - name, description and caps (saving shows "Updated limits for n workspaces on this plan");
     - a feature checklist grouped as on `/ops/features`, with a "Not in this plan" section for features missing from the plan;
     - "Duplicate plan" and "Delete plan" (disabled with a tooltip while in use or default).
7. **`/ops/settings`, Settings (owner edits, others read).**
   - Sign-up mode radio: Open / Invite only. Copy for invite only: "New people can join only through an invite from a workspace owner or from Create client."
   - Default plan select.
   - Notice: "Invite-only is enforced by the Before User Created hook in Supabase Auth and again during onboarding. Make sure the hook is enabled in the Supabase dashboard."
   - Operators table with "Add operator" (email of someone who has already signed up, plus role), change role, revoke.
8. **`/ops/audit`, Audit.** A table with When, Who (email resolved at read time, or "Operator token" / "Script"), Action (plain words), Target (link), Note, and an expandable before/after JSON. Filters for action and workspace, with "Load older" pagination.

**Customer-facing copy (exact).**
- Sign-up closed (hook and `/signup` notice): "Perceev is invite-only right now. If you were invited, use the link in your invitation email."
- `workspace_suspended` (onboarding): "Your workspace is paused. Contact your Perceev contact to restore access."
- `signup_closed` (onboarding): the same text as the sign-up closed notice.

**Accessibility.** Every control has a label. Three-way controls are radio groups. Confirm dialogs trap focus. Status badges are never colour-only (each carries text).

### 6.7 Permissions, privacy, observability

- **Role matrix.** These are the canonical role rules, and §6.5's role column applies them:
  - `viewer`: every GET.
  - `admin`: viewer + workspace/feature/plan/limits/client/spend-control writes.
  - `owner`: admin + settings and operators.
- **Server logs.**
  - What is logged: `[ops] <action> <target_kind>` plus ids.
  - Never logged: emails, notes, invite links, tokens.
  - `writeAudit` redacts any `email|token|secret|password` key in `before`/`after` (AC-32).
- **PostHog:** nothing. The operator console is internal, and the F26 registry is unchanged.
- **Customer view.** Customers can see the effects of operator decisions (features on or off, caps in `/portal/usage`), never the operator data itself.
- **Public repository.** No seeded operator, email, domain or brand in migrations, tests or fixtures. Fixtures use `acme.example`-style values.

## 7. Code reuse map

| Source | Perceev target | Mode | Adaptation notes |
|---|---|---|---|
| `src/components/ops/costs/PaidFeatureControls.tsx` | `src/components/ops/features/SpendingPanel.tsx` | PATTERN | Same fields, embedded per feature; calls `/api/operator/spend-controls/[feature]` |
| `src/components/ops/costs/WorkspaceLimits.tsx` | `src/components/ops/workspaces/LimitsTab.tsx` | PATTERN | Adds `source` and reset-to-plan |
| `src/app/api/customer/team/route.js` (invite flow) | `src/server/ops/clients.ts`, `invites` route | PATTERN | Same `inviteUserByEmail` + `customer_team_invites` contract; redirect to `/onboarding` |
| `src/server/workspace/requireWorkspace.ts` (cross-site check) | `src/server/ops/requireOperator.ts` | PATTERN | Identical rule |
| `src/server/features/flags.ts` env parsing | `src/server/features/access.ts` `decideAccess` legacy branch | Move | Byte-for-byte behaviour, proven by the AC-12 contract test |
| F06 `DataTable`, F04 shell primitives | all `/ops` pages | Reuse | — |

No OpenSEO code is used, so `THIRD_PARTY_NOTICES.md` is unchanged.

## 8. Implementation plan

### Phase 1 — Operator identity, settings and audit

**Goal:** a signed-in operator can be recognised and every later write has somewhere to be audited.

- [ ] **P1.T1 Migration and paperwork**
  - [ ] **P1.T1.S1** *Files:* `supabase/migrations/175_f28_operator_identity.sql`. *Do:* §6.1.1 verbatim, including the append-only trigger that permits only the `ON DELETE SET NULL` updates and the last-owner constraint trigger. *Verify:* CI job `customer-database` applies it on a fresh database.
  - [ ] **P1.T1.S2** *Files:* `scripts/setup-supabase.mjs` (`EXPECTED_OBJECTS` gains the three tables and `operator_role`), `src/server/migrationsLedger.test.mjs` if its roster needs the file. *Verify:* `node --test src/server/migrationsLedger.test.mjs` → pass.
  - [ ] **P1.T1.S3** *Files:* `tests/customer-uat.sql`. *Do:* add isolation rows: `authenticated` and `anon` read zero rows from each new table, and their inserts are refused. *Verify:* CI `customer-database` → pass (F28-AC-31 part).
  - [ ] **P1.T1.S4** *Files:* `README.md` migration table, `docs/OPERATOR_LEDGER.md` § C, `docs/PROD_MIGRATIONS.md`. *Do:* the 175 entries, saying it is safe before any code (tables only). *Verify:* the paperwork guard test → pass.
  - [ ] **P1.T1.S5** *Files:* `scripts/qa/check-f28-db.mjs`. *Do:* loopback QA DB group:
    - the audit table refuses UPDATE/DELETE but allows the FK set-null;
    - the last-owner guard refuses delete and demote of the only owner;
    - `operator_role` returns null for strangers.

    *Verify:* `node scripts/qa/check-f28-db.mjs --group identity` → "identity: all checks passed".
- [ ] **P1.T2 Server**
  - [ ] **P1.T2.S1** *Files:* `src/server/features/names.ts` (add `operator_console`, export `ENV_ONLY_FEATURES`), `.env.example` (`FEATURE_OPERATOR_CONSOLE=` with comment). *Verify:* `node --test src/server/features/flags.test.ts` → pass.
  - [ ] **P1.T2.S2** *Files:* `src/server/ops/requireOperator.ts`, `requireOperatorPage.ts`, `requireOperator.test.ts`. *Do:* §6.2.1. Cases: flag off → 404; no session → 401; non-operator → 404; viewer on an admin route → 403; cross-site POST → 403; owner passes every level. *Verify:* `node --test src/server/ops/requireOperator.test.ts` → pass (F28-AC-01, 06).
  - [ ] **P1.T2.S3** *Files:* `src/server/ops/audit.ts`, `audit.test.ts`. *Do:* §6.2.2, including `redactForAudit` cases (nested email keys removed; ids kept). *Verify:* `node --test src/server/ops/audit.test.ts` → pass (F28-AC-32 part).
  - [ ] **P1.T2.S4** *Files:* `src/server/operatorPerimeter.js` (`SELF_GATED` gains `/^\/api\/operator(?:\/.*)?\/?$/` with a comment naming `requireOperator`), `src/server/operatorPerimeter.test.mjs`. *Do:*
    - `/api/operator/x` with no token is not refused by the perimeter;
    - `/api/ops/costs` still needs the token;
    - `/api/operatorx` is not matched (prefix boundary).

    *Verify:* `node --test src/server/operatorPerimeter.test.mjs` → pass (F28-AC-02 part).
  - [ ] **P1.T2.S5** *Files:* `scripts/ops/grant-operator.mjs`, `scripts/ops/grant-operator.test.mjs`. *Do:*
    - requires `--email` and `--role`;
    - looks the user up with the service role;
    - refuses `user_not_found`;
    - upserts the row and writes an audit row with `actor_kind='script'`;
    - prints only `granted`, `already_operator` or `refusing: <code>`;
    - exits 2 without flags.

    *Verify:* `node --test scripts/ops/grant-operator.test.mjs` → pass (F28-AC-05).

**Checkpoint:** full suite, build and `check-f28-db.mjs --group identity` green. Completes F28-AC-01, 05, 06; parts of 02, 31, 32.

### Phase 2 — Database-backed feature access

**Goal:** `isFeatureEnabled` follows the AC-07 order and, with empty tables, answers exactly as before.

- [ ] **P2.T1 Migration and paperwork**
  - [ ] **P2.T1.S1** *Files:* `supabase/migrations/176_f28_feature_access.sql`. *Do:* §6.1.2, with the plan feature seeds generated from a literal list in the file. *Verify:* CI `customer-database` → pass.
  - [ ] **P2.T1.S2** *Files:* `src/server/features/planSeeds.test.ts`. *Do:*
    - parse the seed literals from the migration file;
    - assert every name is in `FEATURES`;
    - assert `trial` = all features with empty `spend` minus `ENV_ONLY_FEATURES`;
    - assert `client` and `internal` = all features minus `ENV_ONLY_FEATURES`.

    *Verify:* `node --test src/server/features/planSeeds.test.ts` → pass.
  - [ ] **P2.T1.S3** *Files:* `scripts/setup-supabase.mjs`, `tests/customer-uat.sql`, `README.md`, `docs/OPERATOR_LEDGER.md` § C, `docs/PROD_MIGRATIONS.md`. *Do:* register the 176 tables, add the isolation rows and the paperwork. *Verify:* guard tests and CI → pass.
- [ ] **P2.T2 Engine**
  - [ ] **P2.T2.S1** *Files:* `src/server/features/access.ts`, `access.test.ts`. *Do:* §6.2.3 `decideAccess` (pure). Table-driven tests cover every row of the AC-07 order, no-brand evaluation (AC-08), env-only (AC-09), and a paid feature blocked by its spend control after access is on. *Verify:* `node --test src/server/features/access.test.ts` → pass (F28-AC-07, 08, 09).
  - [ ] **P2.T2.S2** *Files:* `src/server/features/flags.ts`, `flags.test.ts`. *Do:*
    - `isFeatureEnabled` delegates to `resolveFeatureAccess`;
    - the snapshot is cached as described (global 30 s, per-brand 30 s);
    - errors are never cached;
    - free features fail to `legacy_env` and paid features fail closed.

    *Verify:* `node --test src/server/features/flags.test.ts` → pass (F28-AC-10, 11).
  - [ ] **P2.T2.S3** *Files:* `src/server/features/legacyParity.test.ts`. *Do:*
    - for every feature in `FEATURES` × env value (`unset`, `on`, `off`, `allowlist` with the brand in, `allowlist` with it out) × NODE_ENV (production, development) × spend control (none, disabled, all, allowlist-in, allowlist-out);
    - assert the pre-F28 function (copied into the test file as `legacyIsFeatureEnabled`) equals the new one with an empty snapshot.

    *Verify:* `node --test src/server/features/legacyParity.test.ts` → pass (F28-AC-12).
  - [ ] **P2.T2.S4** *Files:* `scripts/qa/check-f28-db.mjs` (group `access`). *Do:*
    - seed settings, plans, overrides and limits in the QA DB;
    - re-apply 176 and assert a `customer_brands` row created between the two runs keeps `created_via='self_serve'`;
    - call `loadAccessSnapshot` through a service-role client;
    - assert the snapshot and three resolved features.

    *Verify:* `node scripts/qa/check-f28-db.mjs --group access` → "access: all checks passed".
- [ ] **P2.T3 Import from environment**
  - [ ] **P2.T3.S1** *Files:* `scripts/ops/import-env-flags.mjs`, `import-env-flags.test.mjs`. *Do:*
    - read `FEATURE_*` names and values from `process.env` (the owner runs it with `node --env-file=<a file pulled from Vercel production>`);
    - for each managed (non-env-only) feature, map env `on` to mode `on`, `off` to `off`, and `allowlist` to mode `plans` plus one `on` override per listed brand that exists in `customer_brands`;
    - skip unset features;
    - `--dry-run` is the default and prints `feature: mode, overrides=n, unknown_brands=n` only;
    - `--apply` writes rows and audit entries (`actor_kind='script'`) and calls nothing else.

    *Verify:* `node --test scripts/ops/import-env-flags.test.mjs` → pass (F28-AC-23).

**Checkpoint:** full suite, build and both QA DB groups green. Completes F28-AC-07–12, 23.

### Phase 3 — Operator API

**Goal:** every operator read and write exists as a tested route.

- [ ] **P3.T1 Migration and paperwork**
  - [ ] **P3.T1.S1** *Files:* `supabase/migrations/177_f28_operator_functions.sql`. *Do:* §6.1.3. *Verify:* CI → pass.
  - [ ] **P3.T1.S2** *Files:* `scripts/setup-supabase.mjs` (functions in `pg_proc`), `README.md`, `docs/OPERATOR_LEDGER.md` § C, `docs/PROD_MIGRATIONS.md`. *Verify:* guard tests → pass.
  - [ ] **P3.T1.S3** *Files:* `scripts/qa/check-f28-db.mjs` (group `functions`). *Do:*
    - overview paging and `total_count`, and search by member email;
    - `plan_is_default` for workspaces without a plan;
    - spend parity with `operator_costs_by_workspace` for one workspace;
    - `operator_assign_plan` writes the plan and limits with `source='plan'` atomically (fail the limits insert, then assert no plan row);
    - `operator_update_plan_caps` touches only plan-sourced rows.

    *Verify:* `node scripts/qa/check-f28-db.mjs --group functions` → pass (F28-AC-14, 16 DB parts, 17 DB part).
- [ ] **P3.T2 Services**
  - [ ] **P3.T2.S1** *Files:* `src/server/ops/{workspaces,access,plans,limits,settings,operators,summary}.ts` + `*.test.ts`. *Do:* §6.2.4. Each write asserts its audit row and cache invalidation. `setFeatureMode` covers the paid → `mode='all'` conversion and the env-only refusal. `summary` asserts the dispatch read uses `select` only. *Verify:* `node --test src/server/ops/` → pass (F28-AC-13, 15, 19 service parts, 22).
  - [ ] **P3.T2.S2** *Files:* `src/server/ops/dispatchGuard.test.mjs`. *Do:* `git grep`-style scan of `src/server/ops/`, `src/app/api/operator/`, `src/app/ops/` and `src/components/ops/`. It fails on `set_probe_rollout`, and on `probe_dispatch_control` outside `summary.ts`. Inside `summary.ts` it fails on any `update`/`upsert`/`insert`/`rpc(`. *Verify:* `node --test src/server/ops/dispatchGuard.test.mjs` → pass (F28-AC-30 guard).
- [ ] **P3.T3 Routes**
  - [ ] **P3.T3.S1** *Files:* every `src/app/api/operator/**/route.ts` in the §6.5 table except `clients` and `invites` (Phase 5), plus `src/server/ops/contracts.ts` (zod schemas). *Verify:* `npm run build` → pass.
  - [ ] **P3.T3.S2** *Files:* `src/server/ops/operatorRoutes.route.test.mjs` (customer hook pattern with an operator fixture). *Do:*
    - every route × {signed out → 401, non-operator → 404, viewer on a write → 403};
    - happy paths with the response shapes from §6.5;
    - `Cache-Control: no-store` on every response;
    - unknown body field → 400;
    - `last_owner`, `plan_in_use`, `plan_is_default`, `env_only_feature` and `already_suspended` mapped correctly.

    *Verify:* `node --import ./src/server/liveWriteGuardAuto.mjs --test src/server/ops/operatorRoutes.route.test.mjs` → pass (F28-AC-02, 04, 13, 15, 17, 18, 19, 21, 22, 29 route parts).

**Checkpoint:** full suite, build and QA DB groups green. Completes F28-AC-04, 13–19, 21, 22, 29 (route parts); 30 (guard).

### Phase 4 — Console UI

**Goal:** the owner can do everything in §6.6 from the browser.

- [ ] **P4.T1 Shell and access**
  - [ ] **P4.T1.S1** *Files:* `src/app/ops/(console)/layout.tsx` (server layout: `requireOperatorPage` + `OpsShell`; `src/app/ops/layout.jsx` unchanged), `src/components/ops/shell/{OpsShell,OpsNav}.tsx`, `src/app/ops/(console)/not-found.tsx`. *Verify:* `npm run build` → pass.
  - [ ] **P4.T1.S2** *Files:* `src/shared/features/labels.ts` (`FEATURE_LABELS`: label, description, group for every `FeatureName`), `labels.test.ts` (every name has a label; no extras). *Verify:* `node --test src/shared/features/labels.test.ts` → pass.
- [ ] **P4.T2 Pages**
  - [ ] **P4.T2.S1** *Files:* `src/app/ops/(console)/page.tsx`, `src/components/ops/overview/*`. *Do:* §6.6 page 1, every state. *Verify:* build → pass.
  - [ ] **P4.T2.S2** *Files:* `src/app/ops/(console)/workspaces/page.tsx`, `src/app/ops/(console)/workspaces/[brandKey]/page.tsx`, `src/components/ops/workspaces/{WorkspacesTable,WorkspaceHeader,FeaturesTab,LimitsTab,MembersTab,ActivityTab,SuspendDialog}.tsx`, `hooks/useWorkspaces.ts`, `hooks/useWorkspace.ts`. *Do:* §6.6 pages 2–3. *Verify:* build → pass.
  - [ ] **P4.T2.S3** *Files:* `src/app/ops/(console)/features/page.tsx`, `src/components/ops/features/{FeatureRow,SpendingPanel,ModeConfirmDialog}.tsx`, `hooks/useFeatures.ts`. *Do:* §6.6 page 5. *Verify:* build → pass.
  - [ ] **P4.T2.S4** *Files:* `src/app/ops/(console)/plans/page.tsx`, `src/app/ops/(console)/plans/[planKey]/page.tsx`, `src/components/ops/plans/*`. *Do:* §6.6 page 6. *Verify:* build → pass.
  - [ ] **P4.T2.S5** *Files:* `src/app/ops/(console)/settings/page.tsx`, `src/app/ops/(console)/audit/page.tsx`, `src/components/ops/{settings,audit}/*`. *Do:* §6.6 pages 7–8. *Verify:* build → pass.
  - [ ] **P4.T2.S6** *Files:* `features/00-CONVENTIONS.md` § 12. *Do:* add the `/ops/*` rows from §5, plus a note under § 5 that `isFeatureEnabled` now consults F28's tables (signature unchanged). *Verify:* the doc diff is in the PR.

**Checkpoint:** build and full suite green. UI behaviour is proven in Phase 6.

### Phase 5 — Create client, invites, invite-only sign-up, suspension handling

**Goal:** the owner can onboard a client end to end and close public sign-up.

- [ ] **P5.T1 Migration and paperwork**
  - [ ] **P5.T1.S1** *Files:* `supabase/migrations/178_f28_clients_and_signup.sql`. *Do:* §6.1.4. The hook keeps F24's disposable branch and copy byte-for-byte; invites are checked first. *Verify:* CI → pass.
  - [ ] **P5.T1.S2** *Files:* `scripts/setup-supabase.mjs`, `README.md`, `docs/OPERATOR_LEDGER.md` § C, `docs/PROD_MIGRATIONS.md` (state that the hook function changes and that the dashboard hook setting is unchanged). *Verify:* guard tests → pass.
  - [ ] **P5.T1.S3** *Files:* `scripts/qa/check-f28-db.mjs` (group `signup`). *Do:* for the hook function, call it directly with crafted events:
    - open + normal → allow; open + disposable → 400;
    - invite_only + no invite → 403 with the exact copy;
    - invite_only + pending invite → allow; invite_only + expired invite → 403.

    For `operator_create_workspace`: idempotent on the key, `created_via='operator'`, the plan and limits set, one pending owner invite. *Verify:* `node scripts/qa/check-f28-db.mjs --group signup` → pass (F28-AC-26 DB part, 24 DB part).
- [ ] **P5.T2 Services and routes**
  - [ ] **P5.T2.S1** *Files:* `src/server/ops/clients.ts`, `clients.test.ts`. *Do:* §6.2.5:
    - existing user → `member_added`;
    - new user → `sent`;
    - send failure → 502 with the workspace kept;
    - brand conflict → 409 with `brandKey`;
    - idempotent replay → `created:false`;
    - no email in the audit row.

    *Verify:* `node --test src/server/ops/clients.test.ts` → pass.
  - [ ] **P5.T2.S2** *Files:* `src/app/api/operator/clients/route.ts`, `src/app/api/operator/workspaces/[brandKey]/invites/route.ts`, `…/invites/[inviteId]/resend/route.ts`, `src/app/api/signup-mode/route.ts`, `src/server/operatorPerimeter.js` (`PUBLIC_EXACT` gains `GET /api/signup-mode`), tests in `operatorRoutes.route.test.mjs` and `operatorPerimeter.test.mjs`. *Verify:* route tests → pass (F28-AC-24, 19 invite parts).
  - [ ] **P5.T2.S3** *Files:* `src/app/api/customers/invite/route.js`, its existing tests. *Do:* §6.2.7. The existing response assertions stay as they are, with new assertions for the plan and the audit row. *Verify:* the existing invite route tests → pass (F28-AC-28).
  - [ ] **P5.T2.S4** *Files:* `src/server/onboarding/website.ts`, `src/server/onboarding/website.test.ts`. *Do:* §6.2.6, covering:
    - adoption of an operator-created workspace (no second workspace, no `already_has_workspace`);
    - `website_locked` still applies after scans exist;
    - all memberships suspended → 403 `workspace_suspended`;
    - invite-only without membership → 403 `signup_closed`;
    - self-serve paths unchanged (existing tests untouched).

    *Verify:* `node --test src/server/onboarding/website.test.ts` → pass (F28-AC-20, 25, 26 route part).
  - [ ] **P5.T2.S5** *Files:* `src/app/signup/page.jsx` and its client form component. *Do:* fetch `/api/signup-mode`; for `invite_only`, show the §6.6 notice and hide the form, with a link to `/login`. *Verify:* build → pass (AC-27 proven in Phase 6).
  - [ ] **P5.T2.S6** *Files:* `src/components/ops/workspaces/CreateClientForm.tsx`, `src/app/ops/(console)/workspaces/new/page.tsx`, and the Members tab invite/resend wiring. *Do:* §6.6 page 4. *Verify:* build → pass.

**Checkpoint:** full suite, build and QA DB groups green. Completes F28-AC-19, 20, 24–26, 28 (route/DB parts).

### Phase 6 — Browser acceptance and owner live check

**Goal:** the console works in a real browser, and the owner can run it once on production.

- [ ] **P6.T1.S1** *Files:* `scripts/qa/check-f28-browser.mjs`, fixtures `tests/fixtures/f28/api/{summary.json,workspaces.json,workspaces-filtered-empty.json,workspace-detail.json,features.json,plans.json,plan-detail.json,settings.json,operators.json,audit.json,client-created.json,client-brand-exists.json,signup-mode-open.json,signup-mode-invite-only.json}`. *Do:* Playwright (`worker/node_modules/playwright`) against `npm run dev`, with `page.route("**/api/operator/**")` and `**/api/signup-mode` serving fixtures. Cases:
  - a non-operator fixture (404 from `/api/operator/summary`) → the 404 page;
  - Overview shows every card, plus the dispatch card read-only (no buttons inside it);
  - Workspaces search updates `?q=` and filtered-empty shows "Clear filters";
  - detail Features tab: setting a paid feature On while its spend control is off shows the warning; Inherit/On/Off send the right method and path;
  - Limits shows "x of y" and Reset to plan;
  - Suspend requires a reason;
  - the Features page "By plan" confirm lists the spend keys;
  - Plans delete is disabled while the plan is in use;
  - Create client success, `brand_exists` and `invite_send_failed` states;
  - Settings radio is disabled for an admin fixture;
  - the Audit "Load older" passes `before`;
  - `/signup` with invite-only shows the notice and no form;
  - at 390×844, the nav is in a Sheet with no horizontal scroll;
  - the network log has zero requests outside `localhost`.

  *Verify:* `node scripts/qa/check-f28-browser.mjs` → "f28 browser: all cases passed" (F28-AC-03, 17, 18, 21, 27, 30 UI parts).
- [ ] **P6.T1.S2** *Files:* `scripts/qa/check-f28-live.mjs` (owner-run). *Do:* it refuses without `--confirm-read-only`. With it, it calls the production `/api/operator/summary`, `/api/operator/workspaces?page=1` and `/api/operator/features` using a session cookie the owner passes through `OPERATOR_SESSION_COOKIE` in the env file. It prints only status codes, counts and feature modes, and writes nothing. *Verify:* `node scripts/qa/check-f28-live.mjs` (no flags) → exits 2 with "refusing: --confirm-read-only is required".
- [ ] **P6.T1.S3** *Owner-run, only on the owner's instruction.* Apply 175–178 to production. Run `grant-operator.mjs` for the owner. Set `FEATURE_OPERATOR_CONSOLE=on` and redeploy. Run `import-env-flags.mjs` in dry-run, then with `--apply` if the counts look right. Run `check-f28-live.mjs --confirm-read-only`. *Verify:* summary 200; the workspace count equals the production count; the feature modes match the import dry-run. Record the printed lines in `docs/OPERATOR_LEDGER.md`.

**Checkpoint:** browser check passes; full suite and build green. Completes F28-AC-03, 27, 30 and the UI parts of 17, 18, 21.

## 9. Test plan

| Test file | Covers |
|---|---|
| `src/server/ops/requireOperator.test.ts` | AC-01, 06 |
| `src/server/operatorPerimeter.test.mjs` (additions) | AC-02 perimeter part; `/api/signup-mode` public |
| `src/server/ops/audit.test.ts` | AC-29 writer, AC-32 redaction |
| `scripts/ops/grant-operator.test.mjs` | AC-05 |
| `src/server/features/access.test.ts` | AC-07, 08, 09 |
| `src/server/features/flags.test.ts` (additions) | AC-10, 11 |
| `src/server/features/legacyParity.test.ts` | AC-12 |
| `src/server/features/planSeeds.test.ts` | AC-13 seeds |
| `scripts/ops/import-env-flags.test.mjs` | AC-23 |
| `src/server/ops/*.test.ts` | AC-13–16, 19, 22 service logic |
| `src/server/ops/dispatchGuard.test.mjs` | AC-30 guard |
| `src/server/ops/operatorRoutes.route.test.mjs` | AC-02, 04, 13–19, 21, 22, 24, 29 routes |
| `src/server/ops/clients.test.ts` | AC-24 |
| `src/server/onboarding/website.test.ts` (additions) | AC-20, 25, 26 |
| Existing `customers/invite` route tests (additions) | AC-28 |
| `src/shared/features/labels.test.ts` | label coverage |
| `scripts/qa/check-f28-db.mjs` groups `identity`, `access`, `functions`, `signup` | AC-04 DB, 14, 16, 17 DB, 24 DB, 26 DB, 29 DB |
| `tests/customer-uat.sql` (additions) | AC-31 |
| `scripts/qa/check-f28-browser.mjs` | AC-03, 17, 18, 21, 27, 30 UI |
| `scripts/qa/check-f28-live.mjs` (owner) | production smoke |

Fixtures use synthetic workspaces (`Acme Example`, `acme.example`), synthetic UUIDs and `person@acme.example`-style addresses only.

## 10. Rollout and rollback

**Environment (names only):**
- `FEATURE_OPERATOR_CONSOLE` (on/off; unset = off in production).
- Existing: `FEATURE_<NAME>` and `FEATURE_<NAME>_BRANDS` stay as the emergency `off` switch and as the fallback for unmanaged features.
- `SPEND_DEFAULT_DAILY_CAP_USD` and `SPEND_DEFAULT_MONTHLY_CAP_USD` still apply to workspaces with no limits row.

**Migration order:**
- 175 → 176 → 177 → 178, each with its phase.
- All are additive. 178 replaces the body of `hook_before_user_created`, and with `signup_mode='open'` (the default) behaviour is identical to F24.

**Owner enabling steps**, in this order:
1. Apply the migrations.
2. Grant yourself `owner` with `grant-operator.mjs`.
3. Set `FEATURE_OPERATOR_CONSOLE=on` and redeploy.
4. Open `/ops`, check the workspace list, then run the import dry-run.
5. Apply the import, so that each feature's current env behaviour becomes database rows.
6. Review `/ops/plans` and adjust the seeds.
7. Assign plans to existing workspaces.
8. Switch features from "Not managed" to "By plan" one at a time.
9. Decide on sign-up mode.
10. Make sure the Supabase Before User Created hook is enabled. F24 requires this too.

**Turning it off:**
- `FEATURE_OPERATOR_CONSOLE=off` hides the console. Feature access keeps following the database rows.
- To return a single feature to env control, set its mode to "Not managed" (deletes the row).
- Emergency: `FEATURE_<NAME>=off` in Vercel still beats everything.
- To return the whole platform to env-only flags, delete all `feature_access_settings` rows. This is documented in `docs/OPERATOR_LEDGER.md`.

**Data cleanup:** none needed. The audit log is append-only by design.

## 11. Risks and open questions

| # | Risk / question | Proposed default |
|---|---|---|
| 1 | Two places used to decide paid access (env allowlist and spend-control allowlist). | Once F28 manages a paid feature, its spend controls switch to `mode='all'`, and access is decided only by F28. The UI explains this before confirming (AC-22). |
| 2 | Operator account takeover gives control of every tenant. | v1: operators are few and named, every write is audited, and the console is hidden from non-operators (404). Follow-up decision: require Supabase MFA (`aal2`) for operator writes once an MFA enrolment screen exists. Not in F28. |
| 3 | Up to 30 s cache lag across server instances after a change. | Acceptable. The UI says "Takes effect within 30 seconds." |
| 4 | Invite-only depends on the Supabase hook being enabled. | The onboarding route enforces it as well (AC-26), so without the hook an uninvited person can create an account but not a workspace. |
| 5 | Should plans carry a scan allowance (scans per month)? | Not in F28. Scans are governed by the P0 dispatch controls, and changing that needs its own spec. |
| 6 | Should operators be able to "view as" a customer? | Not in F28. It needs consent copy and audit rules of its own. |
| 7 | A workspace with no plan row on default `trial`, once a feature switches to "By plan". | The import (P2.T3) creates overrides for every brand currently allowlisted, and the enabling steps say to assign plans before switching features. The workspace detail shows "Default (Trial)" visibly. |
| 8 | Hosting on a subdomain. | Not needed. `/ops` on the same deployment; a host alias can point at it later without code. |
| 9 | Audit log growth. | Small rows, a few hundred a month. Revisit retention at 1M rows. |
| 10 | `/ops/costs` keeps the shared token. | Yes for F28. A later change can move its data routes to `requireOperator` and retire the token for humans, keeping it for scripts. |

## 12. Definition of done

- [ ] Phases 1–6 merged, with subtasks ticked.
- [ ] F28-AC-01…32 covered by passing tests; browser check passed.
- [ ] `npm run build` and the full suite green; `check-f28-db.mjs` all groups passed; CI tenant RLS green.
- [ ] Migration paperwork (README, `docs/OPERATOR_LEDGER.md` § C, `docs/PROD_MIGRATIONS.md`) updated for 175–178.
- [ ] `features/00-CONVENTIONS.md` § 5 and § 12 updated.
- [ ] `features/README.md` status updated.
- [ ] Owner live check (P6.T1.S3) result recorded in `docs/OPERATOR_LEDGER.md`.

# F25 — Lifecycle email (Loops): milestones, onboarding drip, notifications, preferences

> <!-- doc-status -->
> **Status: LIVE.** Implementation spec. Not built yet.

| Field | Value |
|---|---|
| ID | F25 |
| Wave | 5 |
| Comparison rows covered | "Lifecycle email" (OpenSEO: onboarding drip triggered by milestones; Perceev: only Supabase auth emails) |
| Depends on | F24 (merged; the first-session branch of `/auth/callback` is where a new account is announced). Also F01 (jobs, `definePeriodic`, flags, spend errors), F04 (settings tabs, primitives), F05 (`fetchJson`, query keys). Reads F10, F18, F22 tables when they exist; works without them. |
| Blocks | F27 (Preferences step uses `ProductUpdatesSwitch` and `PUT /api/customer/email/preferences`) |
| Reserved migrations | 160–164 (160 `160_f25_email_tables.sql`, 161 `161_f25_email_functions.sql`; 162–164 deliberately unused) |
| Feature flag | `FEATURE_LIFECYCLE_EMAIL` (name `lifecycle_email`; in `CLIENT_FEATURES`) |
| Spend features | none (Loops is a flat subscription, not billed per call; see §6.8) |
| OpenSEO reference | `openseo:src/server/email/{loops-client,loops,onboarding-drip}.ts` (+ `onboarding-drip.test.ts`), `openseo:src/server/features/audit/services/firstAuditEmails.ts` (+ test), `openseo:src/server/auth/product-updates.ts`, `openseo:src/serverFunctions/product-updates.ts`, `openseo:src/shared/privacy-choices.ts:47-55`, `openseo:src/client/features/onboarding/AnalyticsOnboardingStep.tsx`, `openseo:src/client/features/settings/PrivacySettings.tsx`, `openseo:src/server/billing/loops-sync.ts:17-94` at `c5f8db1` |

## 1. Summary

Perceev starts talking to customers by email at the moments that matter: a scan finished, a scheduled scan was skipped (with the same reason the app shows), or a workspace hit its spend limit. New accounts also get a short onboarding drip run by Loops, which reads milestone properties we keep up to date (workspace created, first scan complete, schedule set, Search Console connected, audit run, first draft approved, assistant used). Every send is recorded in an outbox with a unique key and delivered by the F01 job runner, so a retry never sends twice; no email ever contains answer text; each user controls notification categories and product-update emails from Settings, the onboarding wizard (F27) or a signed unsubscribe link. Supabase Auth emails (confirm, reset, invite) stay exactly as they are.

## 2. What OpenSEO does (observed)

1. **Loops client.** `PUT https://app.loops.so/api/v1/contacts/update` for contact properties and `POST /api/v1/events/send` for events, `Authorization: Bearer <key>`, 10 s timeout (`openseo:src/server/email/loops-client.ts:1-2`, `:96-105`). Events carry an `Idempotency-Key`; Loops honours it for 24 hours and answers a replay with 409, treated as success and reported as `{ duplicate: true }` (`:49-75`). Failures log status, email, user id and Loops' error body, then throw (`:111-120`).
2. **Contact name parts** split a display name into `firstName`/`lastName` (`openseo:src/server/email/loops-client.ts:123-137`).
3. **Transactional sends** `POST /api/v1/transactional` with `{ transactionalId, email, addToAudience: false, dataVariables }` (`openseo:src/server/email/loops.ts:38-79`), used for verification, reset and invitation templates with ids from env (`:26-36`, `:159-226`).
4. **Sign-up contact.** After user creation: upsert with `source: "openseo-signup"`, `userGroup: "app-user"`, name parts and, when product updates are on, `mailingLists: { [LOOPS_PRODUCT_UPDATES_LIST_ID]: true }` (only ever adds) (`openseo:src/server/email/loops.ts:81-122`; caller `openseo:src/lib/auth.ts:274-276`, `:324-344`, failures logged and swallowed).
5. **Product updates.** Turning updates on sets the list membership and `subscribed: true`; turning them off removes list membership but leaves `subscribed` alone because lifecycle emails depend on it (`openseo:src/server/email/loops.ts:124-157`). Loops is updated first, then the database, so a failed sync leaves the old choice and the user can retry (`openseo:src/server/auth/product-updates.ts:4-18`). Default on signup: on outside opt-in regions and Canada, off inside them (`openseo:src/shared/privacy-choices.ts:47-55`).
6. **Milestones.** `markOnboardingMilestone(recipient, "auditStarted" | "gscConnected" | "rankTrackingSetUp" | "mcpConnected")` writes a boolean contact property; Loops owns timing, filters and copy; every send is best-effort and must never fail the triggering action (`openseo:src/server/email/onboarding-drip.ts:8-40`). Callers: audit start (`openseo:src/server/features/audit/services/AuditService.ts:166`), GSC property save (`openseo:src/serverFunctions/gsc.ts:111`), rank tracker creation (`openseo:src/serverFunctions/rank-tracking.ts:101`), MCP authorise (`openseo:src/server/mcp/oauth-provider.ts:336`).
7. **De-duplication** is per isolate (`sentKeys` set) because Loops rate-limits the whole team; without a request context the send is awaited instead of `waitUntil` (`openseo:src/server/email/onboarding-drip.ts:90-112`; test `onboarding-drip.test.ts:27-39`).
8. **System-run refusals** (scheduled checks run as user `"system"`) are emailed to the organisation owner; the credits-exhausted event is keyed per user per day (`openseo:src/server/email/onboarding-drip.ts:42-88`; test `:41-51`).
9. **First-audit email** is a 5-minute cron sweep with a 30-minute lookback so one failed tick loses nothing; per-audit idempotency key `first_audit:<auditId>`; event `first_audit_completed` or `first_audit_blocked` (half the pages blocked) with counts and top three issue titles, never page content (`openseo:src/server/features/audit/services/firstAuditEmails.ts:15-92`; tests `firstAuditEmails.test.ts:54-97`; cron `openseo:src/server.ts:255`).
10. **Lifecycle events from billing** set contact properties before events "so the contact must already read past_due/active when the event arrives", hash long idempotency keys to stay under Loops' 100-character limit, and count an email as sent only when Loops did not report a duplicate (`openseo:src/server/billing/loops-sync.ts:17-94`).
11. **UI.** The onboarding preferences step and Settings show "Product updates — Occasional emails about new features and tips. Unsubscribe anytime." (`openseo:src/client/features/onboarding/AnalyticsOnboardingStep.tsx:95-107`; `openseo:src/client/features/settings/PrivacySettings.tsx:42-59`); the onboarding save only sends the email choice when the switch was flipped and never traps the user on failure ("We couldn't save your email choice. You can change it in Settings.") (`AnalyticsOnboardingStep.tsx:33-56`).

## 3. What Perceev has today

- **Email:** only Supabase Auth's confirm, reset and invite emails (`src/app/signup/page.jsx:26-31`, `src/app/login/page.jsx:49-50`, `src/app/api/customer/team/route.js:126-128`). No email provider, contact store, preferences or unsubscribe.
- **Events that should trigger email already leave durable rows:**
  - finished scans are `scans` rows with `brand_key`, `created_at`, `prompts_tracked`, `prompts_mentioned`, `visibility_pct`, `raw_results.summary_stats.terminal_outcome` (`supabase/migrations/001_initial_schema.sql:5-25`, `026_customer_uat_repairs.sql:3`, `030_scan_finalize_identity.sql:2`);
  - skipped scheduled windows are `measurement_windows` rows with `disposition 'blocked'` and a `reason` (`supabase/migrations/032_durable_schedule_windows.sql:4-10`); F10 makes the reason a closed vocabulary with customer copy (`features/F10-customer-scheduling.md` §6.3 "Skip reasons");
  - spend-cap refusals are thrown as `SpendRefused { reason, scope, limitUsd }` by F01's `reserveSpend` and recorded nowhere (`features/F01-platform-foundations.md` §6.2 `src/lib/spend/`).
- **Milestone sources:** `customer_brands.created_at`; `scans`; `gsc_connections` (enabled OAuth connection); `scan_schedules` with F10's `managed_by = 'customer'` and `enabled`; `content_items.status IN ('approved','published')` (statuses in `src/app/api/customer/content/[id]/route.js:31`); F18 `site_audits.status IN ('completed','partial')` with `completed_at`; F22 `assistant_turns.status = 'completed'`.
- **Job runner** (F01): `definePeriodic`, `enqueueSystemJob`, step semantics and `jobs_dedupe_idx`; the tick runs every minute.
- **Public routes:** `src/lib/operatorPerimeter.js` treats `/api/customer/*` as self-gated; `src/lib/publicSite.js:57-67` lists private (noindexed) prefixes.
- **Must not break:** Supabase Auth emails and the invite flow (Mixed row "Teams"); scan, schedule and spend behaviour (F25 only reads their rows, plus one fire-and-forget call in the spend refusal branch).

## 4. Target behaviour and acceptance criteria

**Decisions**
- **Outbox + sweep, not inline sends.** Every email is first a row in `email_outbox` with a globally unique `dedupe_key`; a periodic F01 job delivers pending rows. Inline call sites only insert rows (never call Loops), so a Loops outage never fails a scan, a save or a sign-in (OpenSEO rule `onboarding-drip.ts:8-15`), and the unique key makes delivery idempotent for the row's lifetime, not just Loops' 24 hours.
- **Sweeps read existing rows** (scans, windows, milestones) on a 5-minute cadence with a 30-minute lookback, the pattern of `firstAuditEmails.ts:15-19`. No hooks are added inside the scan worker, the scheduler or the content pipeline.
- **Spend-cap refusals** are the one inline hook: `reserveSpend` fires a non-blocking notifier for workspace-scope `daily_cap`/`workspace_cap` refusals, because nothing durable records them.
- **Recipients.** Scan finished → every workspace member with `scan_results` on. Schedule skipped and spend cap → workspace owners with `schedule_alerts` / `spend_alerts` on. Drip and milestones → the person (contact properties apply to every member of the workspace that reached them).
- **Defaults.** Notification categories default **on** (service messages about the customer's own workspace, each with a one-click stop link). Product updates default **off** everywhere (opt-in), consistent with F26's consent decision for India's DPDP Act and the current privacy policy; OpenSEO's region default is not ported.

| ID | Criterion | Verified by |
|---|---|---|
| F25-AC-01 | `sendLoopsTransactional`, `sendLoopsEvent` and `updateLoopsContact` send the documented method, URL, headers (`Authorization`, `Content-Type`, `Idempotency-Key` where given) and body; treat 2xx and 409 as success (`duplicate: true` on 409); throw `LoopsError { status, code }` otherwise; time out at 10 s; never log an email address or body. | unit `src/lib/providers/loops/client.test.ts` |
| F25-AC-02 | `email_outbox.dedupe_key` is unique; inserting the same key twice leaves one row (`enqueueEmail` returns `{ created: false }`); `data` over 4 KB or a non-object is rejected by the table. | DB `scripts/qa/check-f25-db.mjs` group `outbox` |
| F25-AC-03 | `claim_email_outbox(25, owner)` claims only `pending` rows whose `next_attempt_at ≤ now()` (or `sending` rows past `claimed_until`), increments `attempts`, sets a 5-minute claim, and two concurrent claims never return the same row. | DB group `claim` |
| F25-AC-04 | The deliver job sends each claimed row once with `Idempotency-Key = <outbox id>`; success → `sent`; a thrown `LoopsError` with status 429/5xx/timeout → back to `pending` with `next_attempt_at = now + 2^attempts minutes`, and after the 5th attempt → `failed`; 4xx other than 409/429 → `failed` at once. | unit `src/lib/email/deliver.test.ts` |
| F25-AC-05 | Before sending, delivery re-checks and **skips** (status `skipped`, `skip_reason`): flag off (`flag_off`), no API key (`loops_not_configured`), no template id (`template_not_configured`), user deleted or email unconfirmed (`recipient_unavailable`), category preference now off (`preference_off`), user no longer a member or workspace inactive (`not_member`). | unit `deliver.test.ts` |
| F25-AC-06 | The scan sweep creates one `scan_finished` row per (scan, member with `scan_results` on) for `scans` with `brand_key` set and `created_at` within 30 minutes; a second sweep creates none; scans without `brand_key` (anonymous free scans) are ignored. | unit `src/lib/email/sweeps.test.ts`; DB group `sweep-scans` |
| F25-AC-07 | The window sweep creates one `schedule_skipped` row per (workspace, reason, UTC day, owner with `schedule_alerts` on) for `blocked` windows of customer-managed schedules; reasons `active_scan_overlap` and `bounded_catchup_elapsed` never email; `daily_cap` and `workspace_cap` become `spend_cap_reached` rows with the same keys as the inline notifier. | unit `sweeps.test.ts`; DB group `sweep-windows` |
| F25-AC-08 | A workspace-scope `SpendRefused` with reason `daily_cap` (or `workspace_cap`) from `reserveSpend` inserts one `spend_cap_reached` row per owner per UTC day (or UTC month); the refusal is still thrown unchanged, the notifier never throws and never delays it; feature-scope refusals and `feature_disabled`/`over_approved_max` insert nothing. | unit `src/lib/email/spendCap.test.ts`; existing `src/lib/spend/spend.test.ts` still passes |
| F25-AC-09 | `email_milestone_candidates(500)` returns (workspace, milestone, reached_at) for each of the seven milestones whose condition holds and which is not yet in `workspace_milestones`; optional sources (F10 columns, `site_audits`, `assistant_turns`) are skipped when their table or column is missing; recording a milestone inserts one `contact_milestones` outbox row per member and is idempotent. | DB group `milestones` (with and without the optional tables) |
| F25-AC-10 | The first session of a new account (F24 callback branch) inserts `contact_signup:<user>` (contact upsert: `userId`, `source: "perceev-signup"`, `userGroup: "app-user"`, `firstName` when known, milestone properties false, product-updates list only when opted in) and `event_signed_up:<user>` (event `signed_up`), plus a `user_email_preferences` row with defaults; a second callback inserts nothing. | route `src/lib/auth/callback.route.test.mjs` (F24 file, extended) |
| F25-AC-11 | Template data contains only the keys listed in §6.4 for that template; values are strings ≤ 200 characters matching the template's patterns; no question, answer, citation, competitor or URL other than our own app links is ever included. | unit `src/lib/email/templates.test.ts` (key allow-list and a property walk over fixture scans that contain answer text) |
| F25-AC-12 | `GET/PUT /api/customer/email/preferences` read and update the signed-in user's preferences; a `productUpdates` change calls Loops first (list on: `mailingLists[list]=true` and `subscribed=true`; off: `mailingLists[list]=false` only) and saves only after Loops succeeds; with Loops unconfigured the choice is saved and `loopsSynced: false` returned; unknown fields → 400. | route `src/lib/email/preferences.route.test.mjs` |
| F25-AC-13 | `/email/unsubscribe?u=&c=&t=` shows the category and a "Stop these emails" button; `POST /api/customer/email/unsubscribe` with a valid HMAC token turns that category off (`product_updates` also removes the list in Loops) and redirects to the page with `done=1`; an invalid or tampered token → 401 `invalid_link` and nothing changes; the page is noindexed. | route `src/lib/email/unsubscribe.route.test.mjs`; unit `src/lib/email/links.test.ts`; browser B4 |
| F25-AC-14 | Settings → Emails (`/portal/settings/notifications`, shown when `lifecycle_email` is on) shows four switches with the current values and saves each change; a failed save reverts the switch and toasts "We couldn't save your email choice." | browser `check-f25-browser.mjs` B1–B3 |
| F25-AC-15 | Retention: `email.retention` deletes outbox rows in `sent`, `skipped` or `failed` older than 90 days, in batches of 1,000. | DB group `retention` |
| F25-AC-16 | Owner-run live checks E1–E6 (§10) pass: each of the three transactional templates arrives with the documented content, the drip starts for a new sign-up only, product updates opt-in reaches the list, and an unsubscribe link works. | live, recorded in the phase-4 PR |

## 5. Scope

**In scope**
- Loops provider client (port), outbox, deliver and sweep jobs, retention.
- Three transactional notifications: scan finished, scheduled scan skipped, spend cap reached. Template content (§6.4) for the owner to build in Loops.
- Milestone contact properties (seven), sign-up contact and `signed_up` event, onboarding drip definition (§6.4) for the owner to build as a Loop.
- Per-user preferences (product updates, three notification categories), Settings tab, signed unsubscribe link and page, `ProductUpdatesSwitch` for F27.
- Privacy policy paragraph on email.

**Out of scope**
- Supabase Auth emails (confirm, reset, invite) — unchanged.
- Product-update campaigns themselves (owner writes them in Loops, sent to the list only).
- Billing emails (no billing), MCP/agent milestones (no MCP), rank-tracking emails (F15 may add a milestone later).
- Weekly digests or scheduled reports (no comparison row covers them).
- Webhooks from Loops back to Perceev (unsubscribes made inside Loops stay in Loops; §11 risk 3).
- Team invitation emails (Mixed row "Teams": unchanged).

## 6. Design

### 6.1 Data model

#### `supabase/migrations/160_f25_email_tables.sql`

```sql
-- F25: lifecycle email outbox, per-user preferences, workspace milestones.

CREATE TABLE IF NOT EXISTS public.user_email_preferences (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  product_updates boolean NOT NULL DEFAULT false,
  product_updates_changed_at timestamptz,
  product_updates_source text CHECK (product_updates_source IS NULL OR product_updates_source IN
    ('onboarding','settings','unsubscribe_link','signup_default')),
  scan_results boolean NOT NULL DEFAULT true,
  schedule_alerts boolean NOT NULL DEFAULT true,
  spend_alerts boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.user_email_preferences IS
  'Per user, across workspaces. A missing row means the defaults: product updates off, every notification category on.';
COMMENT ON COLUMN public.user_email_preferences.product_updates_changed_at IS 'Record of consent for product-update emails.';

ALTER TABLE public.user_email_preferences ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.user_email_preferences FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.user_email_preferences TO authenticated;
GRANT ALL ON public.user_email_preferences TO service_role;
DROP POLICY IF EXISTS user_email_preferences_read_own ON public.user_email_preferences;
CREATE POLICY user_email_preferences_read_own ON public.user_email_preferences
  FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));
DROP TRIGGER IF EXISTS user_email_preferences_touch ON public.user_email_preferences;
CREATE TRIGGER user_email_preferences_touch BEFORE UPDATE ON public.user_email_preferences
  FOR EACH ROW EXECUTE FUNCTION public.f01_touch_updated_at();

CREATE TABLE IF NOT EXISTS public.email_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('transactional','event','contact')),
  template text NOT NULL CHECK (template IN (
    'scan_finished','schedule_skipped','spend_cap_reached',       -- transactional
    'signed_up',                                                  -- event
    'contact_signup','contact_milestones')),                       -- contact
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  brand_key text REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  dedupe_key text NOT NULL CHECK (length(dedupe_key) BETWEEN 1 AND 200),
  data jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(data) = 'object' AND pg_column_size(data) < 4096),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','sent','skipped','failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  claimed_until timestamptz,
  claimed_by text CHECK (claimed_by IS NULL OR length(claimed_by) <= 80),
  skip_reason text CHECK (skip_reason IS NULL OR skip_reason ~ '^[a-z_]{1,40}$'),
  error_code text CHECK (error_code IS NULL OR error_code ~ '^[a-z0-9_]{1,40}$'),
  loops_duplicate boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  CONSTRAINT email_outbox_sent_has_time CHECK ((status = 'sent') = (sent_at IS NOT NULL))
);
COMMENT ON COLUMN public.email_outbox.dedupe_key IS
  'Globally unique business key, e.g. scan_finished:<scanId>:<userId>. The idempotency guarantee for the row''s lifetime.';
COMMENT ON COLUMN public.email_outbox.data IS
  'Template variables only (§6.4 allow-list). Never answer text, questions, citations or competitor names.';
CREATE UNIQUE INDEX IF NOT EXISTS email_outbox_dedupe_idx ON public.email_outbox (dedupe_key);
CREATE INDEX IF NOT EXISTS email_outbox_due_idx ON public.email_outbox (next_attempt_at)
  WHERE status IN ('pending','sending');
CREATE INDEX IF NOT EXISTS email_outbox_finished_idx ON public.email_outbox (updated_at)
  WHERE status IN ('sent','skipped','failed');
CREATE INDEX IF NOT EXISTS email_outbox_brand_idx ON public.email_outbox (brand_key, created_at DESC)
  WHERE brand_key IS NOT NULL;
ALTER TABLE public.email_outbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.email_outbox FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.email_outbox TO service_role;
DROP TRIGGER IF EXISTS email_outbox_touch ON public.email_outbox;
CREATE TRIGGER email_outbox_touch BEFORE UPDATE ON public.email_outbox
  FOR EACH ROW EXECUTE FUNCTION public.f01_touch_updated_at();

CREATE TABLE IF NOT EXISTS public.workspace_milestones (
  brand_key text NOT NULL REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  milestone text NOT NULL CHECK (milestone IN ('workspace_created','first_scan_completed','schedule_set',
    'gsc_connected','audit_run','draft_approved','assistant_used')),
  reached_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (brand_key, milestone)
);
ALTER TABLE public.workspace_milestones ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.workspace_milestones FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.workspace_milestones TO authenticated;
GRANT ALL ON public.workspace_milestones TO service_role;
DROP POLICY IF EXISTS workspace_milestones_member_read ON public.workspace_milestones;
CREATE POLICY workspace_milestones_member_read ON public.workspace_milestones
  FOR SELECT TO authenticated USING (public.customer_can_access_brand(brand_key));
```

`f01_touch_updated_at()` is F01's trigger function (migration 040).

#### `supabase/migrations/161_f25_email_functions.sql`

```sql
-- F25: outbox claim, milestone candidates (tolerant of optional tables), retention.

CREATE OR REPLACE FUNCTION public.claim_email_outbox(p_limit integer, p_owner text)
RETURNS SETOF public.email_outbox LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE public.email_outbox o
     SET status = 'sending', attempts = o.attempts + 1, claimed_by = p_owner,
         claimed_until = now() + interval '5 minutes'
   WHERE o.id IN (
     SELECT id FROM public.email_outbox
      WHERE ((status = 'pending' AND next_attempt_at <= now())
          OR (status = 'sending' AND claimed_until < now()))
        AND attempts < 5
      ORDER BY next_attempt_at, created_at
      LIMIT greatest(1, least(p_limit, 50))
      FOR UPDATE SKIP LOCKED)
  RETURNING o.*;
$$;

-- Rows stuck in 'sending' with 5 attempts used are closed as failed.
CREATE OR REPLACE FUNCTION public.close_exhausted_email_outbox()
RETURNS integer LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH done AS (
    UPDATE public.email_outbox SET status = 'failed', error_code = coalesce(error_code, 'attempts_exhausted'),
           claimed_until = NULL, claimed_by = NULL
     WHERE status IN ('pending','sending') AND attempts >= 5
       AND (status = 'pending' OR claimed_until < now())
    RETURNING 1)
  SELECT count(*)::integer FROM done;
$$;

CREATE OR REPLACE FUNCTION public.email_milestone_candidates(p_limit integer)
RETURNS TABLE (brand_key text, milestone text, reached_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  has_schedules boolean := to_regclass('public.scan_schedules') IS NOT NULL
    AND EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'scan_schedules' AND column_name = 'managed_by');
  has_audits boolean := to_regclass('public.site_audits') IS NOT NULL;
  has_turns boolean := to_regclass('public.assistant_turns') IS NOT NULL;
  q text;
BEGIN
  q := $q$
    WITH b AS (SELECT cb.brand_key, cb.created_at FROM public.customer_brands cb WHERE cb.is_active),
    c AS (
      SELECT b.brand_key, 'workspace_created'::text AS milestone, b.created_at AS reached_at FROM b
      UNION ALL
      SELECT s.brand_key, 'first_scan_completed', min(s.created_at) FROM public.scans s
        JOIN b ON b.brand_key = s.brand_key GROUP BY s.brand_key
      UNION ALL
      SELECT g.brand_key, 'gsc_connected', min(g.updated_at) FROM public.gsc_connections g
        JOIN b ON b.brand_key = g.brand_key WHERE g.enabled AND g.auth_mode = 'oauth' GROUP BY g.brand_key
      UNION ALL
      SELECT ci.brand, 'draft_approved', min(ci.updated_at) FROM public.content_items ci
        JOIN b ON b.brand_key = ci.brand WHERE ci.status IN ('approved','published') GROUP BY ci.brand
  $q$;
  IF has_schedules THEN
    q := q || $q$ UNION ALL
      SELECT ss.brand, 'schedule_set', coalesce(ss.customer_updated_at, ss.updated_at, now()) FROM public.scan_schedules ss
        JOIN b ON b.brand_key = ss.brand WHERE ss.managed_by = 'customer' AND ss.enabled $q$;
  END IF;
  IF has_audits THEN
    q := q || $q$ UNION ALL
      SELECT a.brand_key, 'audit_run', min(a.completed_at) FROM public.site_audits a
        JOIN b ON b.brand_key = a.brand_key WHERE a.status IN ('completed','partial') AND a.completed_at IS NOT NULL
        GROUP BY a.brand_key $q$;
  END IF;
  IF has_turns THEN
    q := q || $q$ UNION ALL
      SELECT t.brand_key, 'assistant_used', min(t.created_at) FROM public.assistant_turns t
        JOIN b ON b.brand_key = t.brand_key WHERE t.status = 'completed' GROUP BY t.brand_key $q$;
  END IF;
  q := q || $q$ )
    SELECT c.brand_key, c.milestone, c.reached_at FROM c
     WHERE NOT EXISTS (SELECT 1 FROM public.workspace_milestones m
                        WHERE m.brand_key = c.brand_key AND m.milestone = c.milestone)
     ORDER BY c.reached_at NULLS LAST
     LIMIT $1 $q$;
  RETURN QUERY EXECUTE q USING greatest(1, least(p_limit, 2000));
END;
$$;

CREATE OR REPLACE FUNCTION public.prune_email_outbox(p_before timestamptz, p_limit integer)
RETURNS integer LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH gone AS (
    DELETE FROM public.email_outbox WHERE id IN (
      SELECT id FROM public.email_outbox
       WHERE status IN ('sent','skipped','failed') AND updated_at < p_before
       LIMIT greatest(1, least(p_limit, 5000)))
    RETURNING 1)
  SELECT count(*)::integer FROM gone;
$$;

REVOKE ALL ON FUNCTION public.claim_email_outbox(integer, text), public.close_exhausted_email_outbox(),
  public.email_milestone_candidates(integer), public.prune_email_outbox(timestamptz, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_email_outbox(integer, text), public.close_exhausted_email_outbox(),
  public.email_milestone_candidates(integer), public.prune_email_outbox(timestamptz, integer) TO service_role;
```

Notes: `scan_schedules.brand` holds the workspace key for customer schedules (F10 upserts `brand = brandKey`); `customer_updated_at` is F10's column. If F10's column names differ when F25 is built, the `has_schedules` branch is the only place to adjust (P2.T1.S2 test fails loudly).

`scripts/setup-supabase.mjs` `EXPECTED_OBJECTS`: `"160_f25_email_tables.sql": [{kind:"table",name:"user_email_preferences"},{kind:"table",name:"email_outbox"},{kind:"table",name:"workspace_milestones"}]`, `"161_f25_email_functions.sql": [{kind:"function",name:"claim_email_outbox"},{kind:"function",name:"close_exhausted_email_outbox"},{kind:"function",name:"email_milestone_candidates"},{kind:"function",name:"prune_email_outbox"}]`. Tenant RLS (`tests/customer-uat.sql`): `workspace_milestones` gets one row per test workspace and each user reads only their own; `user_email_preferences` one row per test user, each reads only their own; `email_outbox` is not readable by `authenticated`.

### 6.2 Server modules

#### `src/lib/providers/loops/client.ts` (PORT of `openseo:src/server/email/loops-client.ts` + `loops.ts:38-79`)

```ts
export const LOOPS_BASE_URL = "https://app.loops.so/api/v1";
export class LoopsError extends Error { status: number; code: "timeout" | "network" | "rate_limited" | "server" | "rejected" }
export type LoopsDeps = { fetch?: typeof fetch; timeoutMs?: number };   // default fetch, 10_000 ms
export async function updateLoopsContact(i: { apiKey: string; payload: LoopsContactPayload }, deps?: LoopsDeps): Promise<void>;
export async function sendLoopsEvent(i: { apiKey: string; payload: { email: string; userId: string; eventName: string;
  eventProperties?: Record<string, string | number | boolean> }; idempotencyKey: string }, deps?: LoopsDeps): Promise<{ duplicate: boolean }>;
export async function sendLoopsTransactional(i: { apiKey: string; transactionalId: string; email: string;
  dataVariables: Record<string, string>; idempotencyKey: string }, deps?: LoopsDeps): Promise<{ duplicate: boolean }>;
export function getContactNameParts(name: string | null | undefined): { firstName?: string; lastName?: string }; // COPY
export function loopsIdempotencyKey(raw: string): string;  // raw if ≤ 100 chars, else "h:" + sha256hex(raw).slice(0, 64) (loops-sync.ts:21-24)
type LoopsContactPayload = { email: string; userId: string; firstName?: string; lastName?: string; source?: string;
  subscribed?: boolean; userGroup?: string; mailingLists?: Record<string, boolean> } & Record<string, string | number | boolean | undefined | Record<string, boolean>>;
```

Requests: contacts `PUT {base}/contacts/update`; events `POST {base}/events/send`; transactional `POST {base}/transactional` with body `{ transactionalId, email, addToAudience: false, dataVariables }`. Headers `Content-Type: application/json`, `Authorization: Bearer <apiKey>`, plus `Idempotency-Key` for events and transactional. Status handling: 2xx → ok; 409 → `{ duplicate: true }`; 429 → `LoopsError(429,"rate_limited")`; 5xx → `"server"`; other → `"rejected"`; abort → `"timeout"`; network error → `"network"`. Logging: one line `console.warn("[loops] request failed", { endpoint, status, code })` — no email, user id or body (deviation from OpenSEO `loops-client.ts:112-118`, which logs the email).

#### `src/lib/email/` (new)

| File | Exports and behaviour |
|---|---|
| `config.ts` | `readEmailConfig(env = process.env): { apiKey: string \| null; productUpdatesListId: string \| null; templateIds: Record<TransactionalTemplate, string \| null>; linkSecret: string \| null; appUrl: string }`. Env: `LOOPS_API_KEY`, `LOOPS_PRODUCT_UPDATES_LIST_ID`, `LOOPS_TX_SCAN_FINISHED_ID`, `LOOPS_TX_SCHEDULE_SKIPPED_ID`, `LOOPS_TX_SPEND_CAP_ID`, `EMAIL_LINK_SECRET` (null unless ≥ 32 chars), `NEXT_PUBLIC_APP_URL` (fallback `APP_URL`, else `https://perceev.com`). Blank strings are null. |
| `types.ts` | `TransactionalTemplate = "scan_finished" \| "schedule_skipped" \| "spend_cap_reached"`; `EmailCategory = "scan_results" \| "schedule_alerts" \| "spend_alerts" \| "product_updates"`; `TEMPLATE_CATEGORY: Record<TransactionalTemplate, EmailCategory>`; `MILESTONES` (seven names) and `MILESTONE_PROPERTY: Record<Milestone, string>` (`workspaceCreated`, `firstScanCompleted`, `scheduleSet`, `gscConnected`, `auditRun`, `draftApproved`, `assistantUsed`). |
| `outbox.ts` | `enqueueEmail(admin, row: { kind; template; userId; brandKey?: string \| null; dedupeKey: string; data?: Record<string,string \| number \| boolean> }): Promise<{ created: boolean }>` — `insert … on conflict (dedupe_key) do nothing` via `upsert(row, { onConflict: "dedupe_key", ignoreDuplicates: true })`; validates `data` through `validateTemplateData` (templates.ts) before insert; returns `created`. `enqueueMany(admin, rows)` batches 200. |
| `preferences.ts` | `readPreferences(admin, userId)` (defaults when no row); `readPreferencesMany(admin, userIds)`; `savePreferences(admin, userId, patch, source)`; `setProductUpdates(admin, user: { id; email }, optIn, source, deps)` — Loops first (`updateLoopsContact` with `mailingLists: { [listId]: optIn }` plus `subscribed: true` when `optIn`, OpenSEO `loops.ts:124-157`), then DB; returns `{ loopsSynced: boolean }` (false when Loops is not configured; a Loops error throws `AppError(502,"email_provider_unavailable","We couldn't save your email choice. Please try again.")` and the DB is untouched). |
| `recipients.ts` | `workspaceRecipients(admin, brandKey, i: { role: "owner" \| "any"; category: EmailCategory }): Promise<{ userId: string }[]>` — memberships of an active brand joined with preferences (missing row = defaults). |
| `templates.ts` | `TEMPLATE_KEYS` (§6.4 allow-lists), `validateTemplateData(template, data)` (throws `AppError(500,"email_data_invalid")` on an unknown key, a non-string, length > 200, or a value failing the key's pattern), `buildScanFinishedData(scan, brand, links)`, `buildScheduleSkippedData(window, brand, nextRunAt, links)`, `buildSpendCapData(i, brand, links)`. |
| `links.ts` | `unsubscribeUrl(cfg, userId, category)` → `${appUrl}/email/unsubscribe?u=<userId>&c=<category>&t=<sig>` with `sig = base64url(HMAC_SHA256(secret, "email-unsub:v1:" + userId + ":" + category)).slice(0, 43)`; `verifyUnsubscribe(cfg, u, c, t)` (constant-time compare; false when the secret is missing); `appLink(cfg, path)`. Without a secret, templates get `unsubscribeUrl = appUrl + "/portal/settings/notifications"`. |
| `sweeps.ts` | `sweepScans(admin, now, deps)`, `sweepWindows(admin, now, deps)`, `sweepMilestones(admin, now, deps)` (§6.3); each returns counts. |
| `spendCap.ts` | `notifySpendCapRefused(i: { brandKey: string; reason: "daily_cap" \| "workspace_cap"; limitUsd?: number; now?: Date }, deps?): Promise<void>` — never throws; owners with `spend_alerts`; dedupe `spend_cap_reached:<brandKey>:<reason>:<YYYY-MM-DD or YYYY-MM>:<userId>`; data from `buildSpendCapData`. |
| `signup.ts` | `enqueueSignupEmails(admin, user: { id; email; user_metadata?: { full_name?: string; name?: string } }): Promise<void>` — upserts default preferences (`on conflict do nothing`, `product_updates_source 'signup_default'`), enqueues `contact_signup:<id>` and `event_signed_up:<id>`; never throws (logs `[email] signup enqueue failed { userId }`). |
| `deliver.ts` | `deliverOutboxRow(row, ctx): Promise<"sent" \| "skipped" \| "retry" \| "failed">` (§6.3); `buildContactPayload(row, user, prefs, cfg)`. |
| `jobs.ts` | Registers job kinds and periodics (§6.3). |
| (shared) `src/lib/auth/requireUser.ts` | `requireUser(deps?): Promise<{ user: { id: string; email: string; emailConfirmed: boolean }; admin: SupabaseClient }>` — `getCustomerContext()` without a brand; throws `AppError(401,"unauthenticated","Please sign in.")`, `AppError(503,"auth_not_configured","Customer login is not configured.")`. **Identical file in F25 and F26; whichever PR lands second keeps it unchanged** (same rule as `src/shared/safe-url.ts`, conventions §5.4). |
| `telemetry.ts` | `trackEmailEvent(name, props)` — no-op sink until F26 wires it. |

#### Edits to existing modules

- `src/lib/spend/index.ts` (F01): in `reserveSpend`, where `granted:false` maps to `SpendRefused`, add before throwing:
  `if (err.scope === "workspace" && (err.reason === "daily_cap" || err.reason === "workspace_cap") && deps?.notifyCap !== false) keepAlive(import("../email/spendCap.ts").then((m) => m.notifySpendCapRefused({ brandKey: i.brandKey, reason: err.reason, limitUsd: err.limitUsd })).catch(() => {}), { label: "email:spend-cap" });`
  The dynamic import keeps the email module out of every caller's load path; the refusal is thrown exactly as before.
- `src/app/auth/callback/route.js` (F24 first-session branch): add `await enqueueSignupEmails(getSupabaseAdmin(), user)` guarded by `isFeatureEnabled("lifecycle_email")`; failures are swallowed inside the helper.
- `src/lib/features/names.ts`: `lifecycle_email: { spend: [] as const }`; `src/lib/features/clientFeatures.ts`: append `"lifecycle_email"`.
- `src/lib/publicSite.js`: append `"/email"` to `PRIVATE_ROUTE_PREFIXES` (noindex the unsubscribe page).

### 6.3 Jobs

Registered in `src/lib/email/jobs.ts`, imported from `src/lib/jobs/kinds.ts`. All system jobs (`enqueueSystemJob`, `brand_key` null).

| Periodic | Every | Enqueues |
|---|---|---|
| `email.deliver` | 60 s | `enqueueSystemJob("email.deliver", {}, { dedupeKey: "email.deliver:" + minute ISO (YYYY-MM-DDTHH:MM), singleActiveKey: "email.deliver" })` |
| `email.sweep` | 300 s | `enqueueSystemJob("email.sweep", {}, { dedupeKey: "email.sweep:" + 5-minute slot ISO, singleActiveKey: "email.sweep" })` |
| `email.retention` | 86,400 s | `enqueueSystemJob("email.retention", {}, { dedupeKey: "email.retention:" + YYYY-MM-DD })` |

Every periodic's `run` first checks `isFeatureEnabled("lifecycle_email")` and returns without enqueueing when off. A single-active conflict (`job_already_running`) is caught and ignored.

**`email.deliver`** (`deadlineSeconds: 240`, `pollAfterSeconds: 20`)
1. `close` — `DB_STEP`: `close_exhausted_email_outbox()`.
2. `claim` — `DB_STEP` with `retries: 0` (a claim mutates): `claim_email_outbox(25, "deliver:" + jobId)` → ids.
3. For each id, `send:<id>` — `{ timeoutMs: 20_000, retries: 0 }` (the outbox owns retries so every attempt is counted): `deliverOutboxRow(row)`:
   a. flag off → `skipped flag_off`; no API key → `skipped loops_not_configured`; transactional without a template id → `skipped template_not_configured`.
   b. `admin.auth.admin.getUserById(user_id)`: missing or `email_confirmed_at` null → `skipped recipient_unavailable`.
   c. Brand-bound rows: user still a member of an active workspace → else `skipped not_member`. Category preference (`TEMPLATE_CATEGORY`) off → `skipped preference_off`.
   d. Send: transactional → `sendLoopsTransactional({ transactionalId, email, dataVariables: { ...row.data, unsubscribeUrl }, idempotencyKey: row.id })`; event → `sendLoopsEvent({ payload: { email, userId, eventName: "signed_up" }, idempotencyKey: row.id })`; contact → `updateLoopsContact({ payload: buildContactPayload(...) })` (no idempotency header; the update is idempotent).
   e. Success → `status 'sent'`, `sent_at`, `loops_duplicate`, clear claim; `trackEmailEvent("email:sent", { template, kind, duplicate })`.
   f. `LoopsError` `rate_limited|server|timeout|network` → if `attempts < 5`: `status 'pending'`, `next_attempt_at = now + 2^attempts minutes`, `error_code`; else `failed`. `rejected` → `failed` with `error_code 'rejected_<status>'`. Any other exception → `failed`, `error_code 'internal_error'`, log `[email] deliver failed { outboxId, template }`.
4. Result `{ sent, skipped, retried, failed }`; `completed`.

**`email.sweep`** (`deadlineSeconds: 240`) — each step `DB_STEP` (free reads and idempotent inserts, so retries are safe):
1. `milestones` — `sweepMilestones`: `email_milestone_candidates(500)`; for each candidate insert `workspace_milestones` (`on conflict do nothing`); for each member of the workspace, upsert `contact_milestones:<userId>:<YYYY-MM-DDTHH:MM slot>` once per user per sweep with `data = { reason: "milestone" }` (the deliver step computes all properties fresh, so one row per user per sweep covers several milestones). Milestones never send email themselves; Loops filters on the properties.
2. `scans` — `sweepScans`: `scans` with `brand_key` not null and `created_at ≥ now − 30 min` (limit 200); per scan, recipients `workspaceRecipients(brand, { role: "any", category: "scan_results" })`; enqueue `scan_finished:<scanId>:<userId>` with `buildScanFinishedData`.
3. `windows` — `sweepWindows`: `measurement_windows` with `disposition = 'blocked'` and `recorded_at ≥ now − 30 min` joined to `scan_schedules` with `managed_by = 'customer'` (skipped entirely when F10's column is absent); reasons in `NO_EMAIL_REASONS = ["active_scan_overlap","bounded_catchup_elapsed"]` are ignored; `daily_cap`/`workspace_cap` → `spend_cap_reached:<brand>:<reason>:<period>:<userId>` (same key as `spendCap.ts`); others → `schedule_skipped:<brand>:<reason>:<YYYY-MM-DD>:<userId>` for owners with `schedule_alerts`.
4. Result counts; `completed`.

**`email.retention`** — step `prune-1` … `prune-20` (`DB_STEP`) `prune_email_outbox(now − 90 days, 1000)` while 1,000 rows were deleted.

Retention for `workspace_milestones` and `user_email_preferences`: none (one row per workspace milestone / per user; deleted by cascade).

### 6.4 Provider calls and cost

Loops endpoints are listed in §6.2. Cost: Loops bills a monthly plan by contact count, not per call, so calls are not metered (§6.8). Rate: Loops allows about 10 requests per second per team; the deliver job sends at most 25 rows per minute sequentially.

**Contact properties** (`buildContactPayload`): `email`, `userId`, `userGroup: "app-user"`, `source` (`"perceev-signup"` for `contact_signup`, `"perceev-app"` otherwise), `firstName`/`lastName` from `user_metadata.full_name ?? user_metadata.name` (Google sign-ins) when present, the seven milestone booleans computed fresh for the user (true when any of the user's active workspaces has the milestone in `workspace_milestones`), `workspaceCount` (number), and for `contact_signup` only `mailingLists: { [listId]: true }` when the user's `product_updates` is on.

**Event** `signed_up` (no properties) — the trigger of the "Perceev onboarding" Loop.

**Transactional templates** (built by the owner in Loops' editor; ids in env). Variables are strings; the allow-list per template is enforced by `validateTemplateData`.

1. **`scan_finished`** — category `scan_results`, to every member.
   - Variables (pattern): `brandName` (≤ 120, workspace display name), `scanDate` (`^\d{1,2} [A-Z][a-z]{2} \d{4}$`, e.g. "22 Oct 2026"), `questionsAsked` (`^\d{1,4}$` or `Not measured`), `questionsNamingYou` (same), `outcomeLabel` (`Complete` \| `Partial — some answers could not be collected`), `reportUrl` (`^https://…/portal/scans/<uuid>$` built from `appUrl`), `unsubscribeUrl`.
   - Subject: "Your Perceev scan for {{brandName}} is ready"; preview text: "{{questionsNamingYou}} of {{questionsAsked}} questions named {{brandName}}."
   - Body: "Hi, the AI visibility scan for {{brandName}} finished on {{scanDate}}." Then a two-row fact list: "Questions asked — {{questionsAsked}}", "Questions where an answer named {{brandName}} — {{questionsNamingYou}}", and "Collection: {{outcomeLabel}}". Button "Open the report" → `{{reportUrl}}`. Footer: "You're receiving this because you're a member of the {{brandName}} workspace on Perceev. Stop scan emails: {{unsubscribeUrl}}".
   - Data source: `scans.prompts_tracked`, `scans.prompts_mentioned` (null → "Not measured"; zero stays "0"), `raw_results.summary_stats.terminal_outcome.outcome` (`complete` → Complete; anything else → Partial…).
2. **`schedule_skipped`** — category `schedule_alerts`, to owners.
   - Variables: `brandName`, `windowTime` (`^\d{1,2} [A-Z][a-z]{2} \d{4}, \d{2}:\d{2} UTC$`), `reasonMessage` (exactly one of F10's skip-reason messages, `SKIP_REASON_MESSAGES` from `src/shared/schedule.ts`), `actionLabel` and `actionUrl` (from the table below), `nextRunTime` (same pattern as `windowTime`, or `Not scheduled`), `unsubscribeUrl`.
   - Subject: "A scheduled scan for {{brandName}} was skipped"; preview: "{{reasonMessage}}"
   - Body: "The scan scheduled for {{windowTime}} didn't run. Reason: {{reasonMessage}}" then "Next scheduled scan: {{nextRunTime}}." Button "{{actionLabel}}" → `{{actionUrl}}`. Footer: "You're receiving this because you own the {{brandName}} workspace. Stop schedule emails: {{unsubscribeUrl}}".

   | Reason(s) | `actionLabel` | `actionUrl` path |
   |---|---|---|
   | `panel_not_approved` | Approve your questions | `/portal/measurement` |
   | `price_changed`, `over_scan_limit` | Review the price | `/portal/settings/schedule` |
   | `scheduling_disabled`, `feature_disabled`, `brand_not_allowlisted`, `dispatch_paused`, `no_engines`, `daily_capacity_reached`, `workspace_inactive`, `start_failed` | View schedule | `/portal/settings/schedule` |

3. **`spend_cap_reached`** — category `spend_alerts`, to owners.
   - Variables: `brandName`, `periodLabel` (`daily` \| `monthly`), `limitUsd` (`^\$\d{1,6}\.\d{2}$`, or `your limit` when unknown), `resumesOn` (date pattern; next UTC day for daily, first day of next UTC month for monthly), `usageUrl` (`/portal/usage` when `usage_page` is on for the workspace at enqueue time, else `/portal`), `unsubscribeUrl`.
   - Subject: "{{brandName}} reached its {{periodLabel}} spend limit"; preview: "Paid work is paused until {{resumesOn}}."
   - Body: "Paid work for {{brandName}} is paused because the {{periodLabel}} spend limit of {{limitUsd}} was reached. Scans, research and other paid actions are refused until {{resumesOn}} (UTC). Work already running finishes and is charged only for what it collected." Button "View usage" → `{{usageUrl}}`. Line: "Need a higher limit? Reply to this email and we'll help." Footer: "You're receiving this because you own the {{brandName}} workspace. Stop spend-limit emails: {{unsubscribeUrl}}".

**Onboarding drip** — a Loop named "Perceev onboarding" triggered by event `signed_up`, built by the owner. Each email has a Loops audience filter evaluated at send time; Loops adds its own unsubscribe footer.

| # | Delay after trigger | Send only if | Subject | Body (one short paragraph + button) | Button → |
|---|---|---|---|---|---|
| D1 | 1 day | `workspaceCreated` is false | "Finish setting up Perceev" | "Add your website and we'll start checking how AI assistants talk about your brand. It takes two minutes." | "Finish setup" → `/onboarding` |
| D2 | 2 days | `workspaceCreated` true and `firstScanCompleted` false | "Approve your questions and run your first scan" | "Your first scan asks ChatGPT, Gemini, Perplexity and Google's AI Overviews the questions your buyers ask, and shows which brands they name. You see the price before it runs." | "Review questions" → `/portal/measurement` |
| D3 | 4 days | `gscConnected` false | "See which Google searches bring people to your site" | "Connect Google Search Console to compare what people search for with what AI assistants answer." | "Connect Search Console" → `/portal/search-console` |
| D4 | 6 days | `firstScanCompleted` true and `scheduleSet` false | "Track your AI visibility every week" | "Schedule scans so you can see whether you're gaining or losing ground. You approve the monthly cost once." | "Schedule scans" → `/portal/settings/schedule` |
| D5 | 8 days | `auditRun` false | "Check whether AI crawlers can read your site" | "A site audit finds blocked AI crawlers, missing llms.txt and structured-data problems that keep you out of answers." | "Audit your site" → `/portal/audit` |
| D6 | 11 days | `draftApproved` false | "Turn a question you're losing into content" | "Content Studio drafts an article for a question where competitors get named and you don't." | "Open Content Studio" → `/portal/content` |
| D7 | 14 days | `assistantUsed` false | "Ask Perceev's assistant" | "Ask about your scans, competitors and site in plain language. It shows a price before any paid step." | "Open the assistant" → `/portal/assistant` |

D5 and D7 point to pages behind F18/F22 flags; the owner enables those emails only when the features are on for most workspaces (§10).

**Fixtures** (`tests/fixtures/f25/`): `loops-ok.json`, `loops-409.json`, `loops-429.json`, `loops-400.json` (bodies `{ "success": true }` / `{ "success": false, "message": "…" }`), `scan-row.json` (a `scans` row whose `raw_results` contains answer text "ACME is the best" and competitor names, used to prove they never reach `data`), `window-rows.json`, `milestone-candidates.json`. No real addresses; `example.test` only.

### 6.5 API routes

All under `src/app/api/customer/email/` (self-gated namespace), `dynamic = "force-dynamic"`, `Cache-Control: no-store`, errors via `toErrorResponse`, contracts in `src/lib/email/email.contract.ts`. Flag off → 404 `feature_unavailable` "This page is not available yet." (except unsubscribe, which always works so a link in an old email never dead-ends).

**`GET /api/customer/email/preferences`** — auth `requireUser()`; no query fields (unknown → 400 `invalid_request`).

```json
{ "productUpdates": false, "scanResults": true, "scheduleAlerts": true, "spendAlerts": true,
  "productUpdatesChangedAt": null, "loopsConfigured": true }
```

**`PUT /api/customer/email/preferences`** — auth `requireUser()`; body:

```ts
z.strictObject({
  productUpdates: z.boolean().optional(),
  scanResults: z.boolean().optional(),
  scheduleAlerts: z.boolean().optional(),
  spendAlerts: z.boolean().optional(),
  source: z.enum(["onboarding", "settings"]).default("settings"),
}).refine((b) => Object.keys(b).some((k) => k !== "source"), "Nothing to change")
```

Example `{ "productUpdates": true, "source": "onboarding" }` → 200 `{ …GET shape, "loopsSynced": true }`. Order: validate → when `productUpdates` is present and differs, `setProductUpdates` (Loops first) → upsert the other fields → `trackEmailEvent("email:preferences_changed", { product_updates, scan_results, schedule_alerts, spend_alerts, source })`. Errors: 400 `invalid_request`; 401 `unauthenticated`; 502 `email_provider_unavailable` "We couldn't save your email choice. Please try again." (nothing saved); 503 `preferences_unavailable` "Email settings are unavailable right now. Please retry."

**`POST /api/customer/email/unsubscribe`** — **no session**; authenticates by signed token (self-gated: refuses any request without a valid signature). Body (form-encoded from the page, or JSON) `z.strictObject({ u: z.uuid(), c: z.enum(["scan_results","schedule_alerts","spend_alerts","product_updates"]), t: z.string().min(20).max(64) })`. Same-origin `Origin` required (middleware already rejects cross-site writes under `/api/customer/`). Valid → set the category false with source `unsubscribe_link` (for `product_updates` also Loops list off; a Loops failure still saves locally and returns `loopsSynced: false`) → 303 to `/email/unsubscribe?u=…&c=…&t=…&done=1` (form post) or 200 `{ "unsubscribed": true, "category": "scan_results" }` (JSON). Invalid → 401 `invalid_link` "This link is not valid. Sign in to change your email settings." Errors: 400 `invalid_request`; 503 `preferences_unavailable`. Idempotent: repeating is a no-op.

### 6.6 UI

**Settings → Emails** — `src/app/portal/settings/notifications/page.tsx` renders `src/components/portal/email/EmailSettings.tsx`. Registry: append `{ href: "/portal/settings/notifications", label: "Emails", flag: "lifecycle_email" }` to `SETTINGS_TABS` in `src/components/portal/settings/tabs.ts`. Hidden flag → F04 `NotFound`. Query key `emailKeys.preferences()` = `["emailPreferences"]` in `src/lib/query/keys.ts` (user-level, not workspace-scoped; documented exception to F05's `[domain, brandKey]` rule because the data is per user).

| State | What shows |
|---|---|
| Loading | `CardShell` with three `Skeleton h-6` rows |
| Error | `QueryState` error "Email settings could not be loaded." + "Retry" |
| Ready | `CardShell title="Email notifications" description="These settings apply to your account in every workspace."` with three rows (label left, description below, `Switch` right): "Scan results" — "An email when a scan finishes, with the headline numbers."; "Skipped scheduled scans" — "Sent to workspace owners when a scheduled scan doesn't run, with the reason."; "Spend limits" — "Sent to workspace owners when a workspace reaches its daily or monthly spend limit." Then `CardShell title="Product updates"` with `ProductUpdatesSwitch` |
| Loops not configured | muted line under Product updates: "Product update emails aren't set up yet. Your choice is saved." |
| Saving | the switch shows its new value, disabled until the response; F05 `useOptimisticMutation` |
| Save failed | switch reverts; toast "We couldn't save your email choice." |

`ProductUpdatesSwitch({ source, value, onChange, disabled })` (`src/components/portal/email/ProductUpdatesSwitch.tsx`): label "Product updates", description "Occasional emails about new features and tips. Unsubscribe anytime." (OpenSEO copy), `Switch aria-label="Get product update emails"`. Controlled; F27 passes `source="onboarding"` and saves on "Continue".

**Unsubscribe page** — `src/app/email/unsubscribe/page.jsx` (server component; app surface not required; public light styles via F04 `AuthLayout` for a single-column card). Reads `u`, `c`, `t`, `done`; verifies with `verifyUnsubscribe`.

| State | Title | Body |
|---|---|---|
| Valid, not done | "Stop {label} emails?" | "We'll stop sending {label} emails to this account. You can turn them back on in Settings → Emails." + form `method="post" action="/api/customer/email/unsubscribe"` with hidden `u`, `c`, `t` and `Button` "Stop these emails" |
| Done | "You're unsubscribed" | "You won't get {label} emails any more." + link "Email settings" (`/portal/settings/notifications`) |
| Invalid | "This link is not valid" | "Sign in to change your email settings." + link "Sign in" (`/login?next=/portal/settings/notifications`) |

Labels: `scan_results` "scan result", `schedule_alerts` "scheduled-scan", `spend_alerts` "spend-limit", `product_updates` "product update".

**Accessibility:** each `Switch` has a visible label tied by `aria-labelledby`; the unsubscribe page has one `h1` and works without JavaScript (plain form post). **Phone:** rows stack label above switch below 640 px; no horizontal scroll.

### 6.7 Permissions, privacy, observability

- **Who:** each user reads and changes only their own preferences. Workspace data reaches only members (scan emails) or owners (schedule and spend emails), re-checked at send time.
- **Never in emails or logs:** answer text, questions, citations, competitor names, provider payloads, page content, tokens, email addresses in logs. Template data passes `validateTemplateData`; the outbox `data` column is limited to 4 KB.
- **Logs:** `[loops] request failed { endpoint, status, code }`, `[email] deliver failed { outboxId, template }`, `[email] signup enqueue failed { userId }`, `[email] sweep { milestones, scans, windows }`.
- **Privacy policy** (`src/app/privacy/page.jsx`) gains: "We use Loops to send account emails: notifications about your workspace (for example when a scan finishes), a short series of setup tips after you sign up, and product updates only if you opt in. Loops receives your email address, name if you provided one, and which setup steps you've completed — never your questions, AI answers or website data. Every notification email has a link to stop it, and you can change all email settings in Settings → Emails."
- **Telemetry (F26 names; sink `src/lib/email/telemetry.ts` (exports `setEmailEventTracker(fn)`; no-op until F26 wires it, F26 §6.2.7) until F26):** server `email:sent { template, kind, duplicate }`, `email:skipped { template, reason }`, `email:failed { template, error_code }`, `email:unsubscribed { category }`, `email:preferences_changed { product_updates, scan_results, schedule_alerts, spend_alerts, source }`.

### 6.8 Deviations from conventions

1. **User-scoped tables without `brand_key`** (`user_email_preferences`) and an outbox whose `brand_key` is nullable: preferences and contact rows belong to a person, not a workspace. RLS is on; preferences are readable only by their owner; the outbox is service-only.
2. **Loops calls are not wrapped in `metered()`.** Conventions §6.2 covers paid per-call providers; Loops is billed per month by contacts, so a hold per call would be meaningless. The outbox, single-active deliver job and 25-row batch bound the call rate instead.
3. **Unsubscribe route without a session** under `/api/customer/`: authenticated by an HMAC token instead (still self-gated; `src/lib/operatorPerimeter.js` unchanged).
4. **Query key `["emailPreferences"]`** is user-level (§6.6).

## 7. Code reuse map

| OpenSEO source | Perceev target | Mode | Adaptation notes |
|---|---|---|---|
| `openseo:src/server/email/loops-client.ts:1-137` | `src/lib/providers/loops/client.ts` | PORT | Injected `fetch`; typed `LoopsError`; no email in logs; `Idempotency-Key` also on transactional. |
| `openseo:src/server/email/loops.ts:38-79` (transactional), `:81-122` (signup contact), `:124-157` (product updates) | `client.ts` `sendLoopsTransactional`; `src/lib/email/signup.ts`; `src/lib/email/preferences.ts` `setProductUpdates` | PORT | Env names ours; `source: "perceev-signup"`; product updates opt-in by default off. |
| `openseo:src/server/email/onboarding-drip.ts:17-40` (milestones), `:42-67` (refusal events), `:90-112` (`sendOnce`) | `src/lib/email/sweeps.ts` `sweepMilestones`, `spendCap.ts`, outbox | PORT | Per-isolate `sentKeys` → durable unique `dedupe_key`; `waitUntil` → outbox + F01 jobs; milestones derived from data instead of call-site hooks. |
| `openseo:src/server/email/onboarding-drip.test.ts:27-51` | `src/lib/email/spendCap.test.ts` | PORT | "Still sends without a request context" → "notifier never throws and never delays the refusal"; "system runs go to the owner" → owners only. |
| `openseo:src/server/features/audit/services/firstAuditEmails.ts:15-92` (+ test `:54-97`) | `src/lib/email/sweeps.ts` `sweepScans`, `sweepWindows`; tests | PORT | 30-minute lookback over durable rows, per-item key; scans and skipped windows instead of audits. |
| `openseo:src/server/billing/loops-sync.ts:17-94` | `deliver.ts` (properties before events), `loopsIdempotencyKey` | PATTERN | Hash keys over 100 characters; count a send only when not a duplicate. |
| `openseo:src/server/auth/product-updates.ts:4-18`, `openseo:src/serverFunctions/product-updates.ts:6-15` | `src/lib/email/preferences.ts`, `PUT /api/customer/email/preferences` | PORT | Loops first, then the database. |
| `openseo:src/shared/privacy-choices.ts:47-55` | none | PATTERN | Region default not ported: product updates off for everyone (§4 decision). |
| `openseo:src/client/features/settings/PrivacySettings.tsx:12-62` | `src/components/portal/email/EmailSettings.tsx`, `ProductUpdatesSwitch.tsx` | PORT | Adds three notification categories; analytics switch lives in F26. |
| `openseo:src/client/features/onboarding/AnalyticsOnboardingStep.tsx:33-56`, `:95-107` | `ProductUpdatesSwitch.tsx` (used by F27) | PORT | Copy kept; save-on-continue behaviour implemented by F27. |
| `openseo:src/server.ts:255` (cron) | `email.sweep` / `email.deliver` periodics | PATTERN | Cloudflare cron → F01 `definePeriodic`. |

## 8. Implementation plan

Branches `feat/f25-lifecycle-email-p1` … `-p4`. `NT` = `node --import ./src/lib/liveWriteGuardAuto.mjs --test`.

### Phase 1 — Tables, Loops client, outbox and delivery (nothing is enqueued yet)

**Goal:** a row in `email_outbox` is delivered exactly once, with retries, when the flag and keys are set.

- [x] **P1.T1 Migrations**
  - [x] **P1.T1.S1** *Files:* `supabase/migrations/160_f25_email_tables.sql`, `supabase/migrations/161_f25_email_functions.sql`. *Do:* §6.1 verbatim. *Verify:* `NT src/lib/migrationsRunner.test.mjs src/lib/migrationsLedger.test.mjs` → pass.
  - [x] **P1.T1.S2** *Files:* `scripts/setup-supabase.mjs`, `tests/customer-uat.sql`. *Do:* `EXPECTED_OBJECTS` entries (§6.1); in `customer-uat.sql`, insert one `workspace_milestones` row for each test workspace and one `user_email_preferences` row for each test user, then assert as `authenticated` with each user's `request.jwt.claim.sub` that they see only their own rows and that `SELECT count(*) FROM email_outbox` raises `permission denied`. *Verify:* CI `customer-database` job passes.
  - [x] **P1.T1.S3** *Files:* `README.md` (rows `160_f25_email_tables` "Lifecycle email: per-user preferences, outbox with unique send keys, workspace milestones." and `161_f25_email_functions` "Lifecycle email: outbox claim and retention, milestone candidates tolerant of optional F10/F18/F22 tables."), `docs/OPERATOR_LEDGER.md` § C ("apply 160 then 161; no data backfill"), `docs/PROD_MIGRATIONS.md` (two bullets). *Verify:* `NT src/lib/docStatus.test.mjs src/lib/migrationsLedger.test.mjs` → pass.
- [x] **P1.T2 Loops client**
  - [x] **P1.T2.S1** *Files:* `src/lib/providers/loops/client.ts`, `client.test.ts`, fixtures `tests/fixtures/f25/loops-*.json`. *Do:* §6.2; tests with an injected `fetch` recorder: contact PUT URL, headers and body; event with `Idempotency-Key`; transactional body has `addToAudience: false`; 409 → `{ duplicate: true }`; 429/500/400 → `LoopsError` codes; abort after `timeoutMs: 5` → `timeout`; `console.warn` spy never receives an `@` character; `loopsIdempotencyKey("x".repeat(150))` starts `h:` and is 66 chars; `getContactNameParts` cases from OpenSEO. *Verify:* `NT src/lib/providers/loops/client.test.ts` → pass (F25-AC-01).
- [x] **P1.T3 Email library**
  - [x] **P1.T3.S1** *Files:* `src/lib/email/{config,types,templates,links,outbox,preferences,recipients,telemetry}.ts`, `src/lib/auth/requireUser.ts` (shared with F26; skip if already present with the §6.2 content), `templates.test.ts`, `links.test.ts`. *Do:* §6.2, §6.4. Template tests: each builder with `tests/fixtures/f25/scan-row.json` produces exactly the allowed keys; a JSON walk of every produced value contains none of the fixture's answer text, competitor names or question strings; `prompts_mentioned: null` → "Not measured", `0` → "0"; unknown key → `email_data_invalid`. Link tests: sign/verify round trip; a changed category, user or one character of the token fails; missing secret → verify false and `unsubscribeUrl` falls back to the settings URL. *Verify:* `NT src/lib/email/templates.test.ts src/lib/email/links.test.ts` → pass (F25-AC-11; AC-13 unit half).
  - [x] **P1.T3.S2** *Files:* `src/lib/email/deliver.ts`, `deliver.test.ts`. *Do:* §6.3 deliver semantics with injected admin fake, config, flag and Loops client. Cases: each skip reason of AC-05; success sets `sent`; 429 at attempts 1 → `pending` with `next_attempt_at = now + 2 min`; 500 at attempts 5 → `failed`; 400 → `failed rejected_400`; transactional passes `idempotencyKey === row.id` and `unsubscribeUrl` for the row's category; contact payload has the seven milestone booleans and `mailingLists` only for `contact_signup` with product updates on. *Verify:* `NT src/lib/email/deliver.test.ts` → pass (F25-AC-04, AC-05).
  - [x] **P1.T3.S3** *Files:* `src/lib/email/jobs.ts`, `src/lib/jobs/kinds.ts`. *Do:* register `email.deliver` and `email.retention` with their periodics (§6.3); `email.sweep` is registered in phase 2. *Verify:* `NT src/lib/jobs/*.test.ts` → pass.
- [x] **P1.T4 Database checks**
  - [x] **P1.T4.S1** *Files:* `scripts/qa/check-f25-db.mjs`. *Do:* loopback `_qa` guard; groups `outbox` (duplicate key → one row; 5 KB `data` → check violation), `claim` (two pool clients call `claim_email_outbox(10, …)` concurrently over 15 due rows → disjoint sets totalling 15; a future `next_attempt_at` is not claimed; an expired `sending` claim is re-claimed; `attempts` increments), `retention` (back-dated sent rows deleted, pending kept). *Verify:* `PGHOST=localhost PGDATABASE=perceev_qa node scripts/qa/check-f25-db.mjs --only outbox,claim,retention` → `PASS` ×3 (F25-AC-02, 03, 15).
- [x] **P1.T5 Registration**
  - [x] **P1.T5.S1** *Files:* `src/lib/features/names.ts`, `src/lib/features/clientFeatures.ts`, `.env.example`. *Do:* `lifecycle_email: { spend: [] as const }`; append `"lifecycle_email"` to `CLIENT_FEATURES`; `.env.example` names: `FEATURE_LIFECYCLE_EMAIL=`, `LOOPS_API_KEY=`, `LOOPS_PRODUCT_UPDATES_LIST_ID=`, `LOOPS_TX_SCAN_FINISHED_ID=`, `LOOPS_TX_SCHEDULE_SKIPPED_ID=`, `LOOPS_TX_SPEND_CAP_ID=`, `EMAIL_LINK_SECRET=` (comment "32+ random characters; signs unsubscribe links"). *Verify:* `NT src/lib/features/flags.test.ts` → pass; `grep -c "^LOOPS_API_KEY=$" .env.example` → 1.

- [x] **Checkpoint:** suite, typecheck, build, `check-f25-db.mjs` three groups. Completes F25-AC-01 to 05, 11, 15.

### Phase 2 — Sources: sweeps, spend-cap notifier, sign-up contact

**Goal:** the three notifications and milestone contact updates are enqueued from real events.

- [x] **P2.T1 Sweeps**
  - [x] **P2.T1.S1** *Files:* `src/lib/email/sweeps.ts`, `sweeps.test.ts`, fixtures `window-rows.json`, `milestone-candidates.json`. *Do:* §6.3 sweep steps with injected admin fake and clock. Cases: AC-06 (two members with scan_results on/off → one row; repeat → zero; anonymous scan ignored); AC-07 (overlap and catch-up ignored; `price_changed` → `schedule_skipped` to owners only; `daily_cap` → `spend_cap_reached` with the notifier's key; two windows same reason same day → one row per owner); milestones (three candidates for a two-member workspace → three `workspace_milestones` inserts and two contact rows). *Verify:* `NT src/lib/email/sweeps.test.ts` → pass (F25-AC-06, 07 unit).
  - [x] **P2.T1.S2** *Files:* `scripts/qa/check-f25-db.mjs`. *Do:* add groups `milestones` (seed brands with a scan, an enabled OAuth GSC connection and an approved draft → candidates returned for `workspace_created`, `first_scan_completed`, `gsc_connected`, `draft_approved`; after inserting them, none returned; create stub tables `scan_schedules(brand text, managed_by text, enabled boolean, customer_updated_at timestamptz, updated_at timestamptz)`, `site_audits(brand_key text, status text, completed_at timestamptz)`, `assistant_turns(brand_key text, status text, created_at timestamptz)` **only when absent** and seed one row each → `schedule_set`, `audit_run`, `assistant_used` returned; run once with those stubs dropped to prove the function tolerates their absence), `sweep-scans` and `sweep-windows` (call `sweepScans`/`sweepWindows` against the QA database with a service client; assert outbox rows). *Verify:* `node scripts/qa/check-f25-db.mjs --only milestones,sweep-scans,sweep-windows` → `PASS` ×3 (F25-AC-06, 07 DB, 09).
  - [x] **P2.T1.S3** *Files:* `src/lib/email/jobs.ts`. *Do:* register `email.sweep` and its periodic. *Verify:* `NT src/lib/jobs/*.test.ts src/lib/email/*.test.ts` → pass.
- [x] **P2.T2 Spend-cap notifier**
  - [x] **P2.T2.S1** *Files:* `src/lib/email/spendCap.ts`, `spendCap.test.ts`, `src/lib/spend/index.ts`. *Do:* §6.2 helper and the one-line hook in `reserveSpend`. Tests: a memory spend store refusing with `daily_cap` scope `workspace` → `SpendRefused` thrown with the same fields as before, and (after awaiting the recorded `keepAlive` promise) one outbox row per owner keyed by UTC day; `workspace_cap` keyed by UTC month; scope `feature` or reason `feature_disabled` → no rows; an admin fake that throws → refusal still thrown, no unhandled rejection; `deps.notifyCap: false` → no import. *Verify:* `NT src/lib/email/spendCap.test.ts src/lib/spend/spend.test.ts` → pass (F25-AC-08).
- [x] **P2.T3 Sign-up contact**
  - [x] **P2.T3.S1** *Files:* `src/lib/email/signup.ts`, `src/app/auth/callback/route.js`, `src/lib/auth/callback.route.test.mjs`. *Do:* §6.2; extend F24's route test: first session with the flag on → preferences row upserted with defaults and two outbox rows (`contact_signup:<id>`, `event_signed_up:<id>`); second call → `created: false` for both; flag off → none; the redirect is unchanged in every case. *Verify:* `NT src/lib/auth/callback.route.test.mjs` → pass (F25-AC-10).

- [x] **Checkpoint:** suite, `check-f25-db.mjs` all groups. Completes F25-AC-06 to 10.

### Phase 3 — Preferences routes, Settings tab, unsubscribe page

**Goal:** people control every category, from Settings or an email link.

- [ ] **P3.T1 Routes**
  - [ ] **P3.T1.S1** *Files:* `src/app/api/customer/email/preferences/route.ts`, `src/lib/email/email.contract.ts`, `src/lib/email/preferences.route.test.mjs`. *Do:* §6.5; route-hook pattern of `src/lib/customerRoutes.test.hooks.mjs` with an injected Loops fake. Cases: GET defaults without a row; PUT `{ scanResults: false }` → saved; PUT `{ productUpdates: true }` → Loops called first with `mailingLists[list] = true` and `subscribed: true`, then saved; Loops 500 → 502 and DB unchanged; Loops unconfigured → saved with `loopsSynced: false`; `{}` → 400; unknown field → 400; no session → 401. *Verify:* `NT src/lib/email/preferences.route.test.mjs` → pass; `NT src/lib/http/routeContract.test.ts` → pass (F25-AC-12).
  - [ ] **P3.T1.S2** *Files:* `src/app/api/customer/email/unsubscribe/route.ts`, `src/lib/email/unsubscribe.route.test.mjs`. *Do:* §6.5. Cases: valid form post → 303 with `done=1` and the category false; JSON → 200; tampered token → 401 `invalid_link` and no write; cross-site `Origin` → 403 (middleware); `product_updates` → Loops list off. *Verify:* `NT src/lib/email/unsubscribe.route.test.mjs src/lib/operatorPerimeter.test.mjs` → pass (F25-AC-13 route half).
- [ ] **P3.T2 UI**
  - [ ] **P3.T2.S1** *Files:* `src/components/portal/email/{EmailSettings,ProductUpdatesSwitch}.tsx`, `src/components/portal/email/hooks/useEmailPreferences.ts`, `src/app/portal/settings/notifications/page.tsx`, `src/components/portal/settings/tabs.ts`, `src/lib/query/keys.ts`. *Do:* §6.6. *Verify:* `npm run typecheck` and `npm run build` → exit 0.
  - [ ] **P3.T2.S2** *Files:* `src/app/email/unsubscribe/page.jsx`, `src/lib/publicSite.js`, `src/lib/repairs/r20-public-site.test.mjs`. *Do:* §6.6 page; append `"/email"` to `PRIVATE_ROUTE_PREFIXES`; if `r20-public-site.test.mjs` asserts the exact prefix list, add `"/email"` to its expected list (reason: new private page). *Verify:* `NT src/lib/repairs/r20-public-site.test.mjs` → pass; build → exit 0.
  - [ ] **P3.T2.S3** *Files:* `src/app/privacy/page.jsx`, `src/app/privacy/privacyCopy.test.mjs` (F24 file). *Do:* add the §6.7 paragraph under "How information is used and shared"; extend the test with its first sentence. *Verify:* `NT src/app/privacy/privacyCopy.test.mjs` → pass.
- [ ] **P3.T3 Browser checks**
  - [ ] **P3.T3.S1** *Files:* `scripts/qa/check-f25-browser.mjs`, `tests/fixtures/portal/email-preferences.json`. *Do:* F04 harness (`openPortal`) with fixture `features-acme.json` extended by `lifecycle_email: true`; route `GET/PUT /api/customer/email/preferences`. B1 tab "Emails" visible, four switches with fixture values; B2 toggling "Scan results" sends `PUT { scanResults: false, source: "settings" }`; B3 a 502 response reverts the switch and shows the toast; B4 `/email/unsubscribe` with a token built by `links.ts` and a test secret shows "Stop scan result emails?", submitting posts to the route (intercepted → 303) and the page shows "You're unsubscribed"; a tampered token shows "This link is not valid"; B5 390 px no overflow; B6 with `lifecycle_email: false` the tab is absent. *Verify:* `node scripts/qa/check-f25-browser.mjs http://127.0.0.1:3328` → `ok 6 scenarios` (F25-AC-13 browser half, AC-14).

**Checkpoint:** suite, typecheck, build, browser checks. Completes F25-AC-12 to 14.

### Phase 4 — Loops setup and owner-run live checks

**Goal:** templates and the Loop exist in Loops, and each email is confirmed on the deployment.

- [ ] **P4.T1 Runbook**
  - [ ] **P4.T1.S1** *Files:* `docs/OPERATOR_LEDGER.md` § C ("F25 lifecycle email" with the §10 enabling steps and the §6.4 template table copied verbatim), `scripts/qa/check-f25-live.md` (E1–E6 checklist). *Verify:* `NT src/lib/docStatus.test.mjs` → pass.
  - [ ] **P4.T1.S2** *Files:* `scripts/qa/send-f25-test-email.mjs`. *Do:* owner-only script: refuses unless `--to <address>`, `--template <scan_finished|schedule_skipped|spend_cap_reached>` and `--confirm` are passed; inserts one outbox row for the signed-in owner's user id with fixture data from `tests/fixtures/f25/` (dedupe key `manual-test:<template>:<uuid>`) and prints only the row id; delivery happens on the next `email.deliver` tick. *Verify:* `node scripts/qa/send-f25-test-email.mjs` (no args) → exit 1 "Refusing: pass --to, --template and --confirm".
- [ ] **P4.T2 Owner-run live checks (only on the owner's instruction)**
  - [ ] **P4.T2.S1** *Do:* the owner runs E1–E6 and records pass/fail and date in the phase-4 PR. *Verify:* six passes (F25-AC-16).

**Checkpoint:** runbook merged; live results recorded. Completes F25-AC-16.

## 9. Test plan

| Test file | Cases | ACs |
|---|---|---|
| `src/lib/providers/loops/client.test.ts` | URLs, headers, bodies, 409, errors, timeout, no email in logs, key hashing | 01 |
| `scripts/qa/check-f25-db.mjs` | `outbox`, `claim`, `retention`, `milestones`, `sweep-scans`, `sweep-windows` | 02, 03, 06, 07, 09, 15 |
| `src/lib/email/deliver.test.ts` | success, retry schedule, exhaustion, skips, idempotency key, contact payload | 04, 05 |
| `src/lib/email/sweeps.test.ts` | scans, windows, reason mapping, milestones fan-out | 06, 07 |
| `src/lib/email/spendCap.test.ts` + existing `src/lib/spend/spend.test.ts` | workspace caps notify, others not, refusal unchanged | 08 |
| `src/lib/auth/callback.route.test.mjs` (extended) | sign-up rows once, flag off | 10 |
| `src/lib/email/templates.test.ts` | key allow-list, no answer text, honest numbers | 11 |
| `src/lib/email/preferences.route.test.mjs` | GET/PUT, Loops first, unconfigured | 12 |
| `src/lib/email/links.test.ts`, `unsubscribe.route.test.mjs` | token sign/verify, unsubscribe | 13 |
| `scripts/qa/check-f25-browser.mjs` | B1–B6 | 13, 14 |
| `scripts/qa/check-f25-live.md` | E1–E6 (owner) | 16 |

Fixtures are recorded by hand from Loops' public API documentation shapes, with `example.test` addresses; no request ever reaches Loops in tests (injected `fetch`).

## 10. Rollout and rollback

**Env names:** `FEATURE_LIFECYCLE_EMAIL`, `LOOPS_API_KEY`, `LOOPS_PRODUCT_UPDATES_LIST_ID`, `LOOPS_TX_SCAN_FINISHED_ID`, `LOOPS_TX_SCHEDULE_SKIPPED_ID`, `LOOPS_TX_SPEND_CAP_ID`, `EMAIL_LINK_SECRET`. Values go into Vercel by piping from the owner's local file (CLAUDE.md), never printed.

**Defaults:** flag off in production; periodics enqueue nothing while off; existing users have no preferences row (defaults apply); no backfill emails (sweeps look back 30 minutes only; milestone sweeps update contact properties for existing members but never send a drip, which starts only from `signed_up`).

**Owner steps:**
1. Apply migrations 160 and 161.
2. In Loops: verify the sending domain; create the mailing list "Product updates" (id → `LOOPS_PRODUCT_UPDATES_LIST_ID`); create the three transactional templates from §6.4 with exactly those variable names (ids → `LOOPS_TX_*`); create contact properties `workspaceCreated`, `firstScanCompleted`, `scheduleSet`, `gscConnected`, `auditRun`, `draftApproved`, `assistantUsed` (boolean) and `workspaceCount` (number); create the Loop "Perceev onboarding" triggered by event `signed_up` with D1–D7 (leave D5/D7 paused until F18/F22 are enabled for most workspaces); create an API key.
3. Set the env vars in Vercel (Production), generate `EMAIL_LINK_SECRET` with `openssl rand -base64 48 | tr -d '\n' | vercel env add EMAIL_LINK_SECRET production` (the value is never shown).
4. `FEATURE_LIFECYCLE_EMAIL=on` → redeploy.
5. Run E1–E6.

**Live checklist (`scripts/qa/check-f25-live.md`):** E1 `send-f25-test-email.mjs --template scan_finished` to the owner's address → email with the documented subject, numbers, "Open the report" link and a working unsubscribe link; E2 same for `schedule_skipped`; E3 same for `spend_cap_reached`; E4 a new Google or email sign-up on production → contact appears in Loops with `userGroup app-user`, event `signed_up` recorded, D1 scheduled; E5 Settings → Emails → turn Product updates on → the contact is on the list; off → removed from the list and still `subscribed`; E6 click an unsubscribe link from E1 → "You're unsubscribed", and the preference shows off in Settings. Record only pass/fail and dates.

**Rollback:** `FEATURE_LIFECYCLE_EMAIL=off` stops enqueueing and delivery immediately (pending rows are skipped as `flag_off` if the flag is off at send time; to keep them for later, pause by removing `LOOPS_API_KEY` instead, which leaves them `skipped loops_not_configured` — prefer the flag). Pause the Loop in Loops to stop drip emails already scheduled. Data cleanup: `DELETE FROM email_outbox WHERE status = 'pending';` (operator). Tables can stay; dropping them requires removing the spend hook first (P2.T2.S1 line).

## 11. Risks and open questions

1. **Loops `Idempotency-Key` on transactional sends.** OpenSEO uses it on events (`loops-client.ts:49-75`); if Loops ignores it for transactional calls, a lost response could send twice within one attempt window. *Default:* the outbox claims each row once per attempt and only retries on 429/5xx/timeout, so duplicates need a timeout after success; accepted. E1 checks that a replayed send returns 409.
2. **F10 column names** (`managed_by`, `customer_updated_at`) are read dynamically; if they differ, `schedule_set` and window emails are skipped (no failure). *Default:* the DB test stubs those exact names; the P2 PR adjusts them to F10's merged migration if needed.
3. **Unsubscribes made inside Loops** (drip footer) are not mirrored to `user_email_preferences`. *Default:* Loops enforces them for its own Loops and campaigns; our transactional notifications use our own categories. No webhook.
4. **New members don't receive past milestones** until the next milestone of their workspace triggers a contact update. *Default:* acceptable; the drip targets new sign-ups, not invitees.
5. **Times are shown in UTC** because F10 does not store the customer's timezone (`features/F10-customer-scheduling.md` §2 item 4). *Default:* "… UTC" suffix in emails.
6. **Notification defaults are on** without explicit consent. *Default:* they are service messages about the person's own workspace with a stop link in each; product updates stay opt-in. Owner may flip defaults in migration 160 before applying it.
7. **Workspace display names** go to Loops in template variables. *Default:* acceptable (it is the customer's brand, needed for the subject line); no question, answer or domain beyond the app's own links.

## 12. Definition of done

- [ ] Phases 1–4 merged; subtasks ticked.
- [ ] F25-AC-01 to 15 covered by passing tests; AC-16 live results recorded.
- [ ] Typecheck, build, suite, `check-f25-db.mjs` (6 groups), `check-f25-browser.mjs` green.
- [ ] Migration paperwork for 160 and 161 done in P1; `THIRD_PARTY_NOTICES.md` lists the §7 COPY/PORT paths.
- [ ] Privacy policy paragraph live; `features/README.md` status updated.

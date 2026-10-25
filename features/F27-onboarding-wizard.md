# F27 — Onboarding wizard and setup checklist

> <!-- doc-status -->
> **Status: LIVE.** Implementation spec. Not built yet.

| Field | Value |
|---|---|
| ID | F27 |
| Wave | 5 |
| Comparison rows covered | "Onboarding" (OpenSEO: website, then Search Console, then preferences, then connect an agent; saving the website starts a 50-page audit so results are waiting; Perceev: brand name and website, then an empty overview and a blank question panel). Teardown patterns "Onboarding that finishes itself" and "Free tool to sign-up hand-off". |
| Depends on | F07, F08, F18, F20, F24 (README). Also uses F09 (`CostReviewDialog`, `usePriceQuote`, scan route with `maxUsd`), F25 (`ProductUpdatesSwitch`, email preferences route), F26 (`AnalyticsConsentSwitch`, privacy route, telemetry identity), F14 (`buildDomainResearchHref`), F10 and F03 flags for checklist rows. **README should add F09, F25 and F26 to F27's "Depends on"** (requested in the report). |
| Blocks | none |
| Reserved migrations | 170–174 (170 `170_f27_onboarding.sql`; 171–174 deliberately unused) |
| Feature flag | `FEATURE_ONBOARDING_WIZARD` (name `onboarding_wizard`; in `CLIENT_FEATURES` for the Overview checklist). Off → today's `/onboarding` form and `GettingStarted` stay in place. |
| Spend features | none of its own. Question research (`questions.setup`) and the first scan (`ai_visibility.scan`) are priced and approved through F09; the 50-page audit is free (F18). |
| OpenSEO reference | `openseo:src/client/features/onboarding/{onboardingModel,PostSignupOnboarding,OnboardingCard,WizardFooter,WebsiteOnboardingStep,SearchConsoleOnboardingStep,AnalyticsOnboardingStep,useOnboardingRedirect}.ts(x)`, `openseo:src/routes/_authenticated.onboarding.index.tsx`, `openseo:src/serverFunctions/onboarding.ts`, `openseo:src/serverFunctions/projects.ts:67-81`, `openseo:src/server/features/dashboard/services/{DashboardFirstAuditService,DashboardService}.ts`, `openseo:src/client/features/dashboard/{dashboardSteps,DashboardOnboarding}.ts(x)` (+ tests), `openseo:src/serverFunctions/dashboard.ts:55-66`, `openseo:src/types/schemas/dashboard.ts`, `openseo:src/db/pg/app.schema.ts:31-55,385-447`, `openseo:src/routes/_app/route.tsx`, `openseo:src/routes/_app/index.tsx`, `openseo:src/routes/_auth.sign-up.tsx:39-58` at `c5f8db1` |

## 1. Summary

A new customer goes from sign-up to a working workspace in five skippable steps: website and market, Google Search Console, optional Google Analytics, preferences, and finally "Review your questions and run your first scan". Saving the website creates the workspace, starts a free 50-page site audit in the background and offers paid question research at a shown price, so results are waiting by the last step. Visitors who arrive from the free AI scan bring their domain, brand and the scan's buyer questions with them as suggestions. After onboarding, the Overview's "Get started" checklist (OpenSEO's skip-and-restore model) replaces today's `GettingStarted` card. Existing workspaces and invited members never see the wizard.

## 2. What OpenSEO does (observed)

1. **Step model.** `ONBOARDING_STEPS = ["website","search_console","analytics","agent_setup"]`; website and Search Console come first because Google's OAuth return lands on the step in the URL; agent setup is last "so leaving to paste the prompt into an agent doesn't skip a step" (`openseo:src/client/features/onboarding/onboardingModel.ts:4-13`). Labels "Website", "Google Search Console", "Preferences", "Agent setup" (`PostSignupOnboarding.tsx:36-44`); the "analytics" step is the privacy/product-updates preferences step (`:60-61`).
2. **Route.** Client-only; `?step=` (clamped integer), `?domain=` (from the marketing free tool) and `?redirect=` (the page the user asked for) in the URL so refresh and back/forward work; users who already completed onboarding are sent home before render (`openseo:src/routes/_authenticated.onboarding.index.tsx:21-55`).
3. **Tracking.** `onboarding:step_viewed { step, step_name }` on every step change because pageviews drop the query; `onboarding:step_skipped` on skip (`_authenticated.onboarding.index.tsx:69-92`).
4. **Finish.** Saves `completed`, refetches the cached completion, then lands free-tool sign-ups on the project's domain page with `minRank 4, maxRank 20, sort volume`, otherwise on `redirect ?? "/"` (`:94-136`). Completion is stored with `COALESCE` so an earlier completion is kept, and `onboarding:completed { via: "wizard" }` is captured once (`openseo:src/serverFunctions/onboarding.ts:77-136`); table `user_onboarding_answers` keyed by user (`openseo:src/db/pg/app.schema.ts:31-55`).
5. **Card.** Logo and name, a card, step bars as buttons with tooltips and `aria-current="step"` that jump between steps; the whole step is a `fieldset` disabled while saving (`OnboardingCard.tsx:8-51`; `PostSignupOnboarding.tsx:45-66`). Footer: ghost "Back" with arrow, ghost "Skip", primary "Continue" with arrow (`WizardFooter.tsx:6-72`).
6. **Website step.** "What's your website?" / "We'll start a site audit for you."; field "Website" (placeholder "example.com"), collapsible "Choose default country & language"; "Save and continue" (spinner, keeps width) and "Skip for now"; prefilled from the project or the free-tool domain; a validation error shows "Enter a valid domain, like acme.com."; events `onboarding:website_saved` / `onboarding:website_save_failed { error_code }` (`WebsiteOnboardingStep.tsx:28-211`).
7. **Background audit.** Saving renames the "Default" project to the domain and starts the first audit with `waitUntil` (`openseo:src/serverFunctions/projects.ts:67-81`): only when no audit exists, de-duplicated by a claim, 50 pages, no Lighthouse, event `site_audit:start { source: "first_audit" }`, claim released after 5 minutes on failure (`DashboardFirstAuditService.ts:11-90`).
8. **Search Console step.** "Connect Google Search Console" / "See which Google searches bring people to your site."; "Connect with Google" ("Opening Google…") returns to the same URL; then a property picker with "Save and continue"; connected shows "Connected to {property}." and "Continue"; events `onboarding:gsc_connect_clicked`, `gsc_no_properties`, `gsc_property_select_failed` (`SearchConsoleOnboardingStep.tsx:35-246`).
9. **Preferences step.** "Help make OpenSEO better" / "You can change these anytime in Settings. See our Privacy Policy."; switches "Usage analytics" and "Product updates"; Continue saves both and moves on even if the email save fails ("We couldn't save your email choice. You can change it in Settings.") (`AnalyticsOnboardingStep.tsx:17-129`).
10. **Finishes itself.** The agent step completes the wizard without a click once an agent connects (teardown pattern, `ai-mcp/AgentSetup.tsx`; `_authenticated.onboarding.index.tsx:94-97`).
11. **Redirect into onboarding.** `useOnboardingRedirect` sends a verified, signed-in user without a completion to `/onboarding?step=0&redirect=<requested page>`, and treats a failed check as "show the app" (`useOnboardingRedirect.ts:12-61`); the app layout shows a spinner until this is known so the dashboard never flashes (`openseo:src/routes/_app/route.tsx:34-39`).
12. **First landing.** `/` opens the remembered project or the first one (`openseo:src/routes/_app/index.tsx:20-38`).
13. **Setup checklist.** Steps `competitor`, `keywords`, `audit`, `mcp`, `team`, `project` with label, detail and icon (`dashboardSteps.ts:12-55`); status `done` from product state always wins over a dismissal, else `skipped` if dismissed, else `todo` (`:57-79`; tests `dashboardSteps.test.ts:18-44`). The card "Get started" shows remaining steps as an accordion with an action panel and "Skip for now" ("I only need one project" for projects), a collapsible "{n} saved for later" with "Restore", a collapsible "{n} completed", and renders nothing when nothing is left (`DashboardOnboarding.tsx:24-180`; tests `DashboardOnboarding.test.ts:42-63`). Dismissals are per user per project (`openseo:src/db/pg/app.schema.ts:432-447`; `openseo:src/serverFunctions/dashboard.ts:55-66`).
14. **Free-tool hand-off.** Sign-up carries `?domain=` to `/onboarding?domain=…` for email and Google (`openseo:src/routes/_auth.sign-up.tsx:39-58`).

## 3. What Perceev has today

- **`/onboarding`** (`src/app/onboarding/page.jsx`): client page; signed-out → `/login?next=/onboarding`; `GET /api/customer/onboard` → `has_workspace` → `/portal`; form "Company or brand name" + "Website" (`https://` prefilled) → `POST /api/customer/onboard` → `/portal` (`:10-118`).
- **`/api/customer/onboard`** (`src/app/api/customer/onboard/route.js`): needs a confirmed email (`:18-20`), one workspace per account (`:37`), `normalizeCustomerBrand` (UUID key, HTTPS website, `src/lib/customerProvisioning.js:3-25`), RPC `create_customer_workspace` with an idempotency key scoped per user (`supabase/migrations/026_customer_uat_repairs.sql:161-…`). `planCustomerOnboarding` is unit-tested (`src/lib/customerAuth.test.mjs:116-149`); the route is listed in `src/lib/operatorPerimeter.test.mjs:263`.
- **Portal without a workspace:** `PortalShell` shows "Your account is ready" with "Set up my workspace" → `/onboarding` (`src/components/portal/PortalShell.jsx:222-238`; F04 keeps this as a `StatusScreen`).
- **Getting started:** `src/components/portal/overview/GettingStarted.jsx` on `main` (4 rows: workspace, scan, GSC, draft; hidden when all done) and on `fix/portal-measurement-ui` (adds "Review and approve your question panel" read from `GET /api/customer/repairs/panel`). `portalRegressions.test.mjs` on the fix branch renders `GettingStarted`/`buildChecklist` (`features/F04-design-system-and-app-shell.md` §3 item 4).
- **Free scan:** `/scan` collects brand, website, industry and competitors and runs an anonymous scan (`src/app/scan/page.js:59-160`); results are `scans` rows with `brand_key IS NULL`; `/dashboard/[brand]/[scanId]` reads them publicly by id (`src/app/api/scans/by-id/[scanId]/route.js:14-50`; perimeter `src/lib/operatorPerimeter.js:43-49`). Rows in `raw_results.results[]` carry `query`, `is_branded_query`, `is_control`, `source` (`src/services/api.js:82-123`). There is no sign-up link on the result.
- **Search Console OAuth** always returns to `/portal/search-console` (`src/app/api/customer/gsc/callback/route.js:15-56`); attempts live in `gsc_oauth_attempts` (`supabase/migrations/025_gsc_customer_oauth.sql:6-18`); `PropertyPicker({ brandKey, attemptId, website, onConnected, onCancel, onRestart, redirectToLogin })` binds the property (`src/components/portal/gsc/PropertyPicker.jsx:18`).
- **Building blocks from other specs:** F08 `POST /api/customer/questions/setup` (202 job, priced `questions.setup.run`), `getQuestionsState`, `addWorkspaceQuestion`, `saveQuestionPatch` (`features/F08-ai-question-setup.md` §6.2.1, §6.2.5, §6.5); F18 `startSiteAudit(ws, { maxPages: 50, lighthouse: false, renderJavaScript: false, trigger: "baseline" })` (`features/F18-site-audit.md` §6.2.7); F20 `Ga4ConnectionCard` and `GET /api/customer/ga4` with `returnTo "/onboarding"` (`features/F20-ga4-and-opportunities.md` §6.5); F14 `buildDomainResearchHref`; F09 `CostReviewDialog`, `usePriceQuote`, `POST /api/customer/scan { maxUsd }`; F24 `buildOnboardingPath` (`?domain`, `?scan`, `?redirect`); F25 `ProductUpdatesSwitch`; F26 `AnalyticsConsentSwitch`, `setTelemetryIdentity`.
- **Deferred Mixed rows touched:** "Free tools" (F27 adds only a sign-up link to the free scan result; the scan itself, its caps and storage are unchanged), "Search Console" (F27 adds an optional return path; the default flow is unchanged), "Stable question set" (free-scan questions arrive **paused** and never enter a panel until approved through F08).

## 4. Target behaviour and acceptance criteria

**Decision — replace "Connect your agent" with "Review your questions and run your first scan".** OpenSEO's last step connects the product's main loop (an agent using its tools); MCP is excluded for Perceev. Perceev's main loop is *approved questions → a priced scan → a report*. Putting it last keeps the OpenSEO properties that matter: the background work started in step 1 (audit and research) has time to finish while the user connects Google, and the wizard "finishes itself" the moment a scan starts. The scan is never started automatically: it needs an approved panel (F08) and an F09 price approval, and runs through the P0 dispatch path.

**Decision — step names in the URL** (`?step=search_console`), not indices: steps can be hidden (Google Analytics off, preferences off), and OAuth returns name their step.

**Decision — who is sent to onboarding.** `needsOnboarding = flag on ∧ user_onboarding.completed_at is null ∧ (the user has no workspace ∨ the user has a user_onboarding row whose workspace has no scans)`. Users with a workspace and no row (every existing customer and every invitee) are never redirected.

| ID | Criterion | Verified by |
|---|---|---|
| F27-AC-01 | `needsOnboarding` follows the rule above: no row + no workspace → true; no row + a workspace → false; row incomplete + its workspace has no scans → true; row incomplete + a scan exists → false and the row is completed with `completed_via = 'first_scan'`; flag off → false. | unit `src/lib/onboarding/state.test.ts` |
| F27-AC-02 | `visibleSteps` is `website, search_console, analytics, preferences, first_scan` minus `analytics` when `ga4` is off or not configured and minus `preferences` when both `lifecycle_email` and `product_analytics` are off; `resolveStep(param, state)` returns the named step if visible, else the first visible step not `done`, else `first_scan`; a `ga4`/`ga4_error` query with no step resolves to `analytics`. | unit `src/shared/onboarding.test.ts` |
| F27-AC-03 | `POST /api/customer/onboarding/website` for a confirmed user without a workspace creates one through `create_customer_workspace` (owner membership, UUID key), stores the market in F08 settings, upserts `user_onboarding` (`brand_key`, `steps.website = done`), starts the free 50-page audit once (no second audit on retry), and returns the onboarding state; the same `idempotencyKey` twice creates one workspace. | route `src/lib/onboarding/website.route.test.mjs`; DB `check-f27-db.mjs` group `website` |
| F27-AC-04 | The same route for a user who already owns the onboarding workspace updates its name and website only while the workspace has no scans (else `409 website_locked`) and never creates a second workspace; a user with another workspace and no onboarding row gets `409 already_has_workspace`; an unconfirmed email → `403 email_unverified`; an invalid website → `400 website_invalid` "Enter a valid website, like acme.com." | route test |
| F27-AC-05 | Audit start failures never fail the save: `site_audit` off → `audit.status = "unavailable"`; any `startSiteAudit` error → logged code, `audit.status = "not_started"`, response 200. | route test |
| F27-AC-06 | Free-scan hand-off imports, once, up to 30 distinct non-branded, non-control questions (8–300 characters) from an anonymous `scans` row created in the last 30 days whose website host equals the workspace host, as F08 questions with `status 'paused'`, `origin 'promptgen'`, `topic 'From your free scan'`, `source_ref { kind: "free_scan", id }`; a scan with `brand_key` set, a host mismatch, an older scan or an unknown id imports nothing and the save still succeeds. No question text is logged or sent to telemetry. | unit `src/lib/onboarding/freeScanHandoff.test.ts`; DB group `handoff` |
| F27-AC-07 | `GET /api/customer/onboarding?scan=<id>&domain=<d>` returns `prefill { website, brandName, questionCount }` from a matching anonymous scan (domain alone → `{ website: "https://<d>", brandName: null, questionCount: 0 }`), and never returns question text. | route `src/lib/onboarding/state.route.test.mjs` |
| F27-AC-08 | `POST /api/customer/onboarding/step` records `done`/`skipped` for a visible step; `POST /api/customer/onboarding/complete` sets `completed_at` once (a second call keeps the first time and `via`) and captures `onboarding:completed` once. | route tests |
| F27-AC-09 | Search Console OAuth started from onboarding (`return_to: "/onboarding"`) returns to `/onboarding?step=search_console&gsc_connected=true&brand_key=…&gsc_attempt=…`; started anywhere else it returns to `/portal/search-console` exactly as today; `oauthFlow.test.mjs` passes with its old cases unchanged. | unit `src/lib/gsc/oauthFlow.test.mjs` (extended); route test `src/lib/gsc/connect.route.test.mjs` |
| F27-AC-10 | The wizard renders each step's states and copy from §6.6, every step has a working "Skip for now" (website skip completes onboarding with `via = 'skipped'` and lands on the portal's "Your account is ready" screen), Back returns to the previous visible step, the step bars jump between steps, and `?step=` survives reload. | browser `check-f27-browser.mjs` W1–W8 |
| F27-AC-11 | After the website is saved and `question_setup` is on, the research price dialog (F09 `CostReviewDialog`, action `questions.setup.run`) opens; confirming sends `POST /api/customer/questions/setup { brand_key, maxUsd }`; "Skip research" sends nothing; a blocked quote (`feature_disabled`) offers only "Skip research". | browser W3 |
| F27-AC-12 | Step 5 never starts a scan without a click: with an approved panel it shows the scan price and "Run first scan" opens `CostReviewDialog` (`ai_visibility.scan.run`); confirm → `POST /api/customer/scan { brand_key, maxUsd }` → onboarding completes (`via 'first_scan'`) and the user lands on `/portal`; without an approved panel, "Review questions" completes onboarding and opens `/portal/measurement`. | browser W6 |
| F27-AC-13 | `PortalShell` sends a user with `needsOnboarding` to `/onboarding?redirect=<requested path>` before rendering any portal content, keeps the requested path through the wizard, and lands there on finish; a failed check renders the portal (OpenSEO rule). | browser W9; unit `useOnboardingRedirect.test.ts` |
| F27-AC-14 | Finish destination: a safe `redirect` first; else, for a `domain` hand-off without a scan when `domain_overview` is on, `buildDomainResearchHref({ domain: workspace host, preset: "striking_distance" })` (cache-only, never spends); else `/portal`. | unit `src/shared/onboarding.test.ts` |
| F27-AC-15 | `getSetupStepStatus` returns `done` whenever product state shows the step complete (even if dismissed), `skipped` when dismissed and not done, else `todo`; rows are filtered by flags and role (team: owners only). | unit `src/shared/setup-steps.test.ts` (port of `dashboardSteps.test.ts`) |
| F27-AC-16 | `GET /api/customer/setup` computes each row from data (approved panel, scans, GSC, audits, customer schedule, GA4, drafts, members/invites); `POST /api/customer/setup/dismiss` adds or removes the caller's dismissal for that workspace only. | route `src/lib/onboarding/setup.route.test.mjs`; DB group `dismissals` |
| F27-AC-17 | With `onboarding_wizard` on, Overview shows "Get started" (`SetupChecklist`) instead of `GettingStarted`: remaining steps as an accordion with an action and "Skip for now", "{n} saved for later" with Restore, "{n} completed"; nothing renders when no step remains; with the flag off, `GettingStarted` renders exactly as before. | browser W10; render test `src/components/portal/overview/setupChecklist.test.mjs` (port of `DashboardOnboarding.test.ts`) |
| F27-AC-18 | Existing workspaces are untouched: a user with memberships and no onboarding row is never redirected; `/api/customer/onboard`, `planCustomerOnboarding` and their tests are unchanged; the free scan's behaviour is unchanged except for the sign-up link on a real (non-sample) result. | browser W9; CI suite; `git diff --stat` on `src/app/api/customer/onboard/route.js`, `src/lib/customerOnboarding.js` empty |
| F27-AC-19 | Owner-run live checks O1–O5 (§10) pass on the deployment. | live, recorded in the phase-4 PR |

## 5. Scope

**In scope**
- Migration 170: `user_onboarding`, `workspace_setup_dismissals`, `gsc_oauth_attempts.return_path`.
- Onboarding state, website, step and complete routes; free-scan hand-off; GSC return path; setup checklist routes.
- Wizard UI (`/onboarding`) with five steps; redirect hook in `PortalShell`; legacy form kept behind the flag.
- Sign-up link on the free-scan result; `?domain`/`?scan` prefill.
- `SetupChecklist` replacing `GettingStarted` (main and fix-branch versions) behind the flag; removal of `GettingStarted` after the owner turns the flag on (P5).

**Out of scope**
- Question research itself, its review screen and approval (F08); pricing (F09); the audit engine (F18); GA4 OAuth (F20); email and analytics preferences storage (F25, F26); sign-up forms (F24).
- Multiple workspaces per account or workspace creation outside onboarding (unchanged: one self-service workspace per account, `src/app/api/customer/onboard/route.js:37`).
- Agent/MCP setup (excluded by decision).
- Onboarding questionnaires (OpenSEO's `interestedFeatures`, `workFor`, `foundVia` columns): not asked.
- Changes to the free scan's questions, caps, storage or report (Mixed row "Free tools").

## 6. Design

### 6.1 Data model

#### `supabase/migrations/170_f27_onboarding.sql`

```sql
-- F27: per-user onboarding progress, per-user checklist dismissals, Search Console return path.

CREATE TABLE IF NOT EXISTS public.user_onboarding (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  brand_key text REFERENCES public.customer_brands(brand_key) ON DELETE SET NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  completed_via text CHECK (completed_via IS NULL OR completed_via IN ('wizard','first_scan','skipped')),
  steps jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(steps) = 'object' AND pg_column_size(steps) < 2048),
  handoff jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(handoff) = 'object' AND pg_column_size(handoff) < 1024),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_onboarding_completed_via CHECK ((completed_at IS NULL) = (completed_via IS NULL))
);
COMMENT ON COLUMN public.user_onboarding.brand_key IS 'Workspace created (or first used) in onboarding.';
COMMENT ON COLUMN public.user_onboarding.steps IS
  '{ "<step>": { "status": "done"|"skipped", "at": ISO } } for website, search_console, analytics, preferences, first_scan.';
COMMENT ON COLUMN public.user_onboarding.handoff IS
  '{ "domain": host|null, "scanId": uuid|null, "importedQuestions": int, "importedAt": ISO|null }. Never question text.';

ALTER TABLE public.user_onboarding ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.user_onboarding FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.user_onboarding TO authenticated;
GRANT ALL ON public.user_onboarding TO service_role;
DROP POLICY IF EXISTS user_onboarding_read_own ON public.user_onboarding;
CREATE POLICY user_onboarding_read_own ON public.user_onboarding
  FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));
DROP TRIGGER IF EXISTS user_onboarding_touch ON public.user_onboarding;
CREATE TRIGGER user_onboarding_touch BEFORE UPDATE ON public.user_onboarding
  FOR EACH ROW EXECUTE FUNCTION public.f01_touch_updated_at();

CREATE TABLE IF NOT EXISTS public.workspace_setup_dismissals (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  brand_key text NOT NULL REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  step text NOT NULL CHECK (step IN ('questions','scan','gsc','audit','schedule','ga4','draft','team')),
  dismissed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, brand_key, step)
);
CREATE INDEX IF NOT EXISTS workspace_setup_dismissals_brand_idx ON public.workspace_setup_dismissals (brand_key);
ALTER TABLE public.workspace_setup_dismissals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.workspace_setup_dismissals FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.workspace_setup_dismissals TO authenticated;
GRANT ALL ON public.workspace_setup_dismissals TO service_role;
DROP POLICY IF EXISTS workspace_setup_dismissals_read_own ON public.workspace_setup_dismissals;
CREATE POLICY workspace_setup_dismissals_read_own ON public.workspace_setup_dismissals
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()) AND public.customer_can_access_brand(brand_key));

-- Search Console OAuth can return to onboarding. Default keeps today's behaviour.
ALTER TABLE public.gsc_oauth_attempts
  ADD COLUMN IF NOT EXISTS return_path text NOT NULL DEFAULT '/portal/search-console';
ALTER TABLE public.gsc_oauth_attempts DROP CONSTRAINT IF EXISTS gsc_oauth_attempts_return_path_ck;
ALTER TABLE public.gsc_oauth_attempts ADD CONSTRAINT gsc_oauth_attempts_return_path_ck
  CHECK (return_path IN ('/portal/search-console', '/onboarding'));
```

`scripts/setup-supabase.mjs` `EXPECTED_OBJECTS`: `"170_f27_onboarding.sql": [{kind:"table",name:"user_onboarding"},{kind:"table",name:"workspace_setup_dismissals"},{kind:"column",name:"gsc_oauth_attempts.return_path"}]`. `tests/customer-uat.sql`: one `user_onboarding` row per test user and one dismissal per user per workspace; each user reads only their own rows, and a dismissal for a workspace the user left is not readable. No retention needed (one row per user; dismissals bounded by 8 × workspaces).

**Deviation:** `user_onboarding` is user-scoped with a nullable `brand_key` (the user may have no workspace yet); RLS read-own.

### 6.2 Server modules

#### `src/shared/onboarding.ts` (pure; client and server)

```ts
export const ONBOARDING_STEPS = ["website", "search_console", "analytics", "preferences", "first_scan"] as const;
export type OnboardingStep = typeof ONBOARDING_STEPS[number];
export const ONBOARDING_STEP_LABELS: Record<OnboardingStep, string> = {
  website: "Website", search_console: "Google Search Console", analytics: "Google Analytics",
  preferences: "Preferences", first_scan: "Questions and first scan" };
export type StepStatus = "todo" | "done" | "skipped";
export function visibleSteps(f: { ga4Available: boolean; preferencesAvailable: boolean }): OnboardingStep[];
export function resolveStep(param: string | null, i: { visible: OnboardingStep[]; statuses: Partial<Record<OnboardingStep, StepStatus>>;
  hasGa4Return: boolean }): OnboardingStep;
export function nextStep(current: OnboardingStep, visible: OnboardingStep[]): OnboardingStep | null;
export function previousStep(current: OnboardingStep, visible: OnboardingStep[]): OnboardingStep | null;
export function onboardingHref(step: OnboardingStep, keep: { domain?: string | null; scan?: string | null; redirect?: string | null }): string;
export function finishDestination(i: { redirect: string | null; handoffDomain: string | null; handoffScan: string | null;
  workspaceHost: string | null; domainOverviewOn: boolean }): string;   // F27-AC-14; uses F14 buildDomainResearchHref and F24 normalizeAuthRedirect
```

#### `src/shared/setup-steps.ts` (PORT of `openseo:src/client/features/dashboard/dashboardSteps.ts`)

```ts
export const SETUP_STEPS: readonly { id: SetupStep; label: string; detail: string; icon: "ListChecks" | "Radar" | "Search" | "ClipboardCheck" | "CalendarClock" | "ChartLine" | "PenLine" | "Users";
  flag?: "site_audit" | "customer_scheduling" | "ga4"; ownerOnly?: boolean }[];
export type SetupStep = "questions" | "scan" | "gsc" | "audit" | "schedule" | "ga4" | "draft" | "team";
export type SetupActivation = { completed: Record<SetupStep, boolean>; dismissed: SetupStep[] };
export function getSetupStepStatus(a: SetupActivation, step: SetupStep): "done" | "skipped" | "todo";
export function visibleSetupSteps(features: Record<string, boolean>, role: "owner" | "member"): SetupStep[];
```

Rows (order, label, detail):

| id | Label | Detail | Done when |
|---|---|---|---|
| `questions` | Approve your questions | Choose the buyer questions every scan asks. Scans start once they're approved. | the workspace has an approved panel |
| `scan` | Run your first AI visibility scan | See whether ChatGPT, Gemini, Perplexity and Google's AI Overviews name you. | any `scans` row for the workspace |
| `gsc` | Connect Google Search Console | Import the searches and pages that already bring people to your site. | an enabled OAuth `gsc_connections` row |
| `audit` (flag `site_audit`) | Audit your site | Find blocked AI crawlers, broken links and missing structured data. | any `site_audits` row |
| `schedule` (flag `customer_scheduling`) | Schedule scans | Track changes weekly; you approve the monthly cost once. | `scan_schedules` customer-managed and enabled |
| `ga4` (flag `ga4`) | Connect Google Analytics | See which pages bring engaged visitors. | a `ga4_connections` row |
| `draft` | Create your first content draft | Turn a question you're losing into an article AI engines can cite. | any `content_items` row for the workspace |
| `team` (owners only) | Invite a teammate | Share the work, or keep things solo for now. | more than one membership or a pending invite |

#### `src/lib/onboarding/` (new)

| File | Exports and behaviour |
|---|---|
| `state.ts` | `getOnboardingState(admin, user, i: { scanId?: string \| null; domain?: string \| null }, deps): Promise<OnboardingState>` (§6.5 shape); `needsOnboarding(...)` (AC-01). Reads `isFeatureEnabled("onboarding_wizard")` (no brand), memberships, `user_onboarding`, `scans` existence for the onboarding workspace (if a scan exists and the row is incomplete, completes it with `via 'first_scan'` and captures `onboarding:completed`), the workspace's flags (`ga4`, `question_setup`, `question_curation`, `site_audit`, `price_review`, `lifecycle_email`, `product_analytics`, `domain_overview`), F20 `getGa4ConnectionState` (`configured`), latest `site_audits` row, F08 `getQuestionsState` (`setup.status`, `approved`), `gsc_connections`. |
| `website.ts` | `saveOnboardingWebsite(request, user, body, deps): Promise<OnboardingState>` (§6.5 order). |
| `freeScanHandoff.ts` | `readFreeScanPrefill(admin, scanId, domain): Promise<Prefill \| null>`; `importFreeScanQuestions(admin, ws, scanId, userId): Promise<{ imported: number; reason: "ok" \| "not_found" \| "not_anonymous" \| "host_mismatch" \| "too_old" \| "already_imported" \| "question_limit" }>` (AC-06). Extraction: `raw_results.results ?? raw_results` rows where `!(r.is_control)`, `!(r.is_branded_query ?? r.isBrandedQuery)`, `r.source !== "branded_seed"`, `typeof r.query === "string"`; `canonicalQuestionText`; length 8–300; distinct by `normalizeQuestionText`; first 30 in stored order; each through `addWorkspaceQuestion(admin, { brandKey, text, origin: "promptgen", createdBy: userId, status: "paused", topic: "From your free scan", sourceRef: { kind: "free_scan", id: scanId } })` sequentially; `question_limit` stops the loop. Host comparison: `normalizeHandoffDomain(scan.url)` (F24) vs `brand.website_host`. |
| `steps.ts` | `recordStep(admin, userId, step, status)` (jsonb merge `steps \|\| jsonb_build_object(step, {status, at})`); `completeOnboarding(admin, userId, via)` (`UPDATE … SET completed_at = coalesce(completed_at, now()), completed_via = coalesce(completed_via, via)`; upsert when no row; returns `{ completedNow: boolean }`). |
| `setup.ts` | `getSetupActivation(admin, ws, features): Promise<SetupActivation & { visible: SetupStep[] }>` (one query per row, run in parallel; optional tables checked with `to_regclass` through an RPC-free `select … limit 1` that maps `42P01` to "not done"); `setDismissed(admin, userId, brandKey, step, dismissed)`. |
| `telemetry.ts` | `trackOnboardingServerEvent(name, props, userId?)`, `setOnboardingServerTracker(fn)` — no-op until F26 wires it. |
| `onboarding.contract.ts` | Route contracts (§6.5). |

`src/components/portal/onboarding/telemetry.ts`: `trackOnboardingEvent(name, props)`, `setOnboardingEventTracker(fn)` (client sink).

#### Edits to existing modules

- `src/lib/gsc/oauthFlow.js`: `createOAuthAttempt({ userId, brandKey, sessionTokenHash, admin, returnPath = "/portal/search-console" })` validates `returnPath ∈ {"/portal/search-console","/onboarding"}` (else throws `Error("invalid return path")`) and inserts it; `handleOAuthCallback` returns `{ brandKey, userId, attemptId, returnPath: attempt.return_path ?? "/portal/search-console" }`.
- `src/app/api/customer/gsc/connect/route.js`: reads optional `body.return_to` (`"/onboarding"` only; anything else ignored) and passes `returnPath`.
- `src/app/api/customer/gsc/callback/route.js`: success and error redirects use `returnPath` when the attempt is found: `/onboarding?step=search_console&gsc_connected=true&brand_key=…&gsc_attempt=…` / `/onboarding?step=search_console&gsc_error=…`; with no attempt (state missing) the existing `/portal/search-console` URLs are used.
- `src/lib/features/names.ts`: `onboarding_wizard: { spend: [] as const }`; `src/lib/features/clientFeatures.ts`: append `"onboarding_wizard"`.

### 6.3 Jobs

None of its own. Background work started by onboarding runs on other specs' jobs: F18 `site_audit.run` (baseline) and F08 `questions.setup` (after price approval). The wizard polls their state through `GET /api/customer/onboarding` while on step 5 (server `pollAfterSeconds`: 5 while either is running, `null` otherwise).

### 6.4 Provider calls and cost

None directly. Costs reachable from the wizard, all shown before they happen:

| Action | Price source | Approval |
|---|---|---|
| 50-page audit, no Lighthouse, no rendering | F18 `site_audit.run` quote = 0 | none needed (`requireApproval: false`) |
| Question research | F09 quote `questions.setup.run` (F08 §6.2.10) | `CostReviewDialog`, `maxUsd` sent |
| First scan | F09 quote `ai_visibility.scan.run` | `CostReviewDialog`, `maxUsd` sent; dispatch through `claim_probe_dispatch` (P0) |

Fixtures (`tests/fixtures/f27/`): `free-scan-row.json` (anonymous scan of `acme.example` with 34 result rows: 4 controls, 3 branded, 2 duplicates differing only in case and spaces, 1 under 8 characters, 24 valid), `free-scan-other-host.json`, `free-scan-claimed.json` (`brand_key` set), `onboarding-state-*.json` for the browser check.

### 6.5 API routes

All under `src/app/api/customer/onboarding/` and `src/app/api/customer/setup/`; `dynamic = "force-dynamic"`, `maxDuration = 60`, `Cache-Control: no-store`, errors via `toErrorResponse`, contracts in `src/lib/onboarding/onboarding.contract.ts`. Onboarding routes use `requireUser()` (shared `src/lib/auth/requireUser.ts`, F25/F26); setup routes use `requireWorkspace`. Flag off → onboarding routes return 404 `feature_unavailable` except `GET` (which returns `enabled: false`).

**`GET /api/customer/onboarding`** query `z.strictObject({ scan: z.string().optional(), domain: z.string().optional() })` (normalised with F24's `normalizeScanId` / `normalizeHandoffDomain`; invalid values are ignored, not errors) → 200:

```json
{
  "enabled": true, "needsOnboarding": true, "completedAt": null,
  "workspace": { "brandKey": "6d1f…", "displayName": "Acme", "website": "https://acme.example", "websiteHost": "acme.example",
                 "role": "owner", "telemetryId": "9a7c…", "hasScans": false },
  "visibleSteps": ["website", "search_console", "analytics", "preferences", "first_scan"],
  "steps": { "website": "done", "search_console": "todo", "analytics": "todo", "preferences": "todo", "first_scan": "todo" },
  "market": { "country": "in", "language": "en" },
  "prefill": { "website": "https://acme.example", "brandName": "Acme", "questionCount": 24 },
  "handoff": { "domain": "acme.example", "scanId": "0c2a…", "importedQuestions": 24 },
  "audit": { "available": true, "auditId": "5b8f…", "status": "running", "pagesCrawled": 12, "pagesTotal": 50 },
  "research": { "available": true, "status": "running", "jobId": "77e1…" },
  "questions": { "curation": true, "approvedVersion": null, "active": 0, "paused": 24 },
  "gsc": { "connected": false, "property": null },
  "ga4": { "available": true, "connected": false },
  "preferences": { "productUpdatesAvailable": true, "analyticsAvailable": true },
  "domainOverview": true,
  "pollAfterSeconds": 5
}
```

`workspace` is `null` before step 1; `prefill` is `null` without `scan`/`domain`; `research.status` mirrors F08 `setup.status` (`none | running | review | failed | saved`) or `unavailable` when `question_setup` is off; `audit.status` is the latest `site_audits.status`, `unavailable` (flag off) or `not_started`. Errors: 401, 503 `onboarding_unavailable` "Setup is unavailable right now. Please retry."

**`POST /api/customer/onboarding/website`** body:

```ts
z.strictObject({
  website: z.string().trim().min(3).max(255),
  brandName: z.string().trim().min(1).max(120),
  country: z.enum(SUPPORTED_COUNTRIES),                 // F08
  language: z.string().regex(/^[a-z]{2,3}(-[a-z0-9]{2,8})?$/),
  handoff: z.strictObject({ domain: z.string().max(253).nullable(), scanId: z.string().max(64).nullable() }).optional(),
  idempotencyKey: z.uuid(),
})
```

Example `{ "website": "acme.example", "brandName": "Acme", "country": "in", "language": "en", "handoff": { "domain": "acme.example", "scanId": "0c2a…" }, "idempotencyKey": "1f0e…" }`.

Order:
1. `requireUser()`; email not confirmed → 403 `email_unverified` "Verify your email before setting up a workspace."
2. Website: prefix `https://` when no scheme; `normalizeCustomerBrand({ brandName, website })` (existing) → error → 400 `website_invalid` "Enter a valid website, like acme.com." (or `brand_name_invalid` "Enter your company or brand name.").
3. Workspace: if `user_onboarding.brand_key` names a workspace the user owns → if it has `scans` → website/name changes → 409 `website_locked` "This workspace already has scan results for its website. Change it in Settings."; else update `display_name`, `website`, `website_host` (service role). Else if the user has any membership → 409 `already_has_workspace` "Your account already has a workspace." Else `create_customer_workspace` RPC with `p_idempotency_key = "onboarding:" + idempotencyKey` (unique violation `23505` → 409 `workspace_exists` with the existing copy "This brand already has a workspace. Ask your Perceev contact to assign your account."; other errors → 500 `internal_error`).
4. `ws = await requireWorkspace(request, { brandKey })` (the membership now exists).
5. Upsert `user_onboarding` (`brand_key`, `steps.website = { status: "done", at }`, `handoff.domain`, `handoff.scanId`).
6. Market: F08 `saveQuestionSettings(admin, { brandKey, settings: { country, language }, actor: user.id })` (it reads the revision and retries once on `revision_conflict`); other errors are logged `[onboarding] market save failed { brandKey }` and do not fail the request.
7. Free-scan import when `handoff.scanId` is valid and `handoff.importedAt` is unset: `importFreeScanQuestions`; result stored in `handoff` (`importedQuestions`, `importedAt`); `trackOnboardingServerEvent("onboarding:free_scan_imported", { questions })` when > 0.
8. Audit: skip when the workspace already has a `site_audits` row; else `startSiteAudit(ws, { maxPages: 50, lighthouse: false, renderJavaScript: false, trigger: "baseline" })`; `feature_unavailable` → `unavailable`; any other error → `not_started`, logged `[onboarding] audit start failed { brandKey, code }`; event `onboarding:audit_started { started, reason }`.
9. Return `getOnboardingState(...)` (200).

Idempotency: the RPC key makes workspace creation retry-safe; steps 5–8 are idempotent (upsert, settings write, `addWorkspaceQuestion` returns existing rows, audit skipped when present).

**`POST /api/customer/onboarding/step`** body `z.strictObject({ step: z.enum(ONBOARDING_STEPS), status: z.enum(["done","skipped"]) })` → 200 `{ "steps": { … } }`. A step not in `visibleSteps` → 400 `step_hidden`. Upserts the row when missing (a user skipping the website step has no row yet).

**`POST /api/customer/onboarding/complete`** body `z.strictObject({ via: z.enum(["wizard","first_scan","skipped"]) })` → 200 `{ "completedAt": "2026-10-23T09:12:00.000Z", "via": "wizard", "destination": "/portal" }` (`destination` from `finishDestination`; the client may still prefer its `redirect`). When `completedNow`: `trackOnboardingServerEvent("onboarding:completed", { via, steps_done, steps_skipped })`.

**`GET /api/customer/setup?brand_key=`** (`requireWorkspace`, members) → 200:

```json
{ "brandKey": "6d1f…",
  "steps": [ { "id": "questions", "status": "todo" }, { "id": "scan", "status": "todo" }, { "id": "gsc", "status": "done" },
             { "id": "audit", "status": "done" }, { "id": "draft", "status": "skipped" }, { "id": "team", "status": "todo" } ] }
```

Only `visibleSetupSteps(features, role)` are returned. Errors: workspace errors; 404 `feature_unavailable` when `onboarding_wizard` is off; 503 `setup_unavailable` "Setup progress is unavailable right now."

**`POST /api/customer/setup/dismiss`** body `z.strictObject({ brand_key: z.string().min(1).max(200).optional(), step: z.enum(SETUP_STEP_IDS), dismissed: z.boolean() })` → 200 same shape as GET. Insert (`on conflict do nothing`) or delete the caller's row.

**Edited:** `POST /api/customer/gsc/connect` accepts optional `return_to: "/onboarding"` (other values ignored); response unchanged.

### 6.6 UI

#### 6.6.1 Route and shell

- `src/app/onboarding/page.jsx` becomes a server component: `isFeatureEnabled("onboarding_wizard")` off → renders `LegacyOnboardingForm` (`src/components/portal/onboarding/LegacyOnboardingForm.jsx`: today's page body moved verbatim, still calling `/api/customer/onboard`); on → `<OnboardingWizard />`. `src/app/onboarding/layout.jsx` (F04) stays.
- `OnboardingWizard.tsx` (`src/components/portal/onboarding/`): checks the Supabase session (none → `location.replace("/login?next=" + encodeURIComponent(current path + search))`; unconfirmed → `/auth/verify?email=…&next=…`), loads `GET /api/customer/onboarding` with `scan`/`domain` from the URL, and: `completedAt` set and a workspace exists → `location.replace(redirect ?? "/portal")` (OpenSEO `beforeLoad`); otherwise renders. Calls `setTelemetryIdentity({ userId, workspaceTelemetryId: workspace?.telemetryId ?? null })` (F26). Query key `onboardingKeys.state(scan, domain)` = `["onboarding", scan ?? "", domain ?? ""]` (user-level).
- `OnboardingShell.tsx` (PORT `OnboardingCard.tsx`): page `min-h-[100dvh] bg-background flex flex-col items-center px-4`; top bar with `PerceevLogo size="sm"` left and an account menu right (email, "Sign out" → `resetTelemetry()`, `auth.signOut()`, `/login`); `main` card `w-full max-w-xl rounded-2xl border bg-card p-6 md:p-10 shadow-sm mt-8 md:mt-12`; step bars: one `button` per visible step (`aria-label="Step {i}: {label}"`, `aria-current="step"` on the current one, `Tooltip` with the label, `h-1 rounded-full`, `bg-primary` current else `bg-border`) inside `nav aria-label="Onboarding steps"`; children inside `fieldset disabled={saving}`.
- `WizardFooter.tsx` — COPY of OpenSEO's (`Back` ghost with `ArrowLeft`, optional `Skip` ghost, primary continue with `ArrowRight`).
- URL state: `/onboarding?step=<name>&domain=&scan=&redirect=` via `router.replace`; every step change tracks `onboarding:step_viewed { step: index + 1, step_name }`; Skip tracks `onboarding:step_skipped`, then `POST …/step { status: "skipped" }`, then next step.

#### 6.6.2 Step 1 — Website and market (`WebsiteStep.tsx`)

- Heading "What's your website?"; body "We'll create your workspace, start a free site audit and get your buyer questions ready."
- Fields: "Website" (`Input`, placeholder "acme.com", prefilled `prefill.website` → `workspace.website` → `?domain`), "Company or brand name" (`Input`, hint "The brand AI assistants should name.", prefilled `prefill.brandName` → `workspace.displayName` → the host's first label capitalised). `Collapsible` "Choose country & language" (`ChevronDown`): `Select` "Country" over F08 `SUPPORTED_COUNTRIES` (labels India, United States, United Kingdom, Singapore, United Arab Emirates, Canada, Australia; default `market.country` → `x-vercel-ip-country` passed by the server when supported → `in`), `Input` "Language" (default `en`, hint "Language code, e.g. en").
- Free-scan banner when `prefill.questionCount > 0`: `Alert variant="info"` "We'll bring the {n} questions from your free scan into your workspace as suggestions. Nothing is tracked until you approve it."
- Footer: Skip "Skip for now"; primary "Save and continue" (disabled while the website is empty; spinner keeps the width).
- Save → `POST …/website` with a per-mount `idempotencyKey`. Errors: `website_invalid` / `brand_name_invalid` → inline field error; `website_locked`, `already_has_workspace`, `workspace_exists` → `Alert variant="destructive"` with the message; others → toast `describeError`. Event `onboarding:website_saved { created_workspace, country, research }` or `onboarding:website_save_failed { error_code }`.
- After a successful save, research: if `research.status === "unavailable"` → next step (`research: "unavailable"`); if `research.status` is `running|review|saved` → next step; else open F09 `CostReviewDialog` (title "Research your questions", confirm "Start research", pending "Starting…", action `questions.setup.run`, input `{}`, `detail` = "We'll read your website, find who you compete with and draft the buyer questions to track. You review them before anything is measured.") with an extra ghost button "Skip research". Confirm → `POST /api/customer/questions/setup { brand_key, maxUsd }` → 202 → next step; `409 price_changed` → the dialog's price-changed state; `409 setup_running`/`job_already_running` → next step; blocked quotes show the blocked message and only "Skip research".
- Skip "Skip for now" on this step (no workspace yet) → `POST …/complete { via: "skipped" }` → `/portal` (F04 "Your account is ready" screen, whose "Set up my workspace" links to `/onboarding?step=website`).

#### 6.6.3 Step 2 — Search Console (`SearchConsoleStep.tsx`, PORT `SearchConsoleOnboardingStep.tsx`)

| State | What shows |
|---|---|
| No workspace | "Add your website first." + Back |
| Not connected | Heading "Connect Google Search Console"; body "See which Google searches bring people to your site."; `Button variant="outline"` with the Google glyph "Connect with Google" ("Opening Google…") → `POST /api/customer/gsc/connect { brand_key, return_to: "/onboarding" }` → `location.assign(authorization_url)`; event `onboarding:gsc_connect_clicked`. Footer: Back, "Skip for now" |
| Returned with `gsc_attempt` | existing `PropertyPicker` with `brandKey`, `attemptId`, `website`, `onConnected` (→ `POST …/step done`, event `onboarding:gsc_property_selected`, next step), `onCancel` (→ clears the query, back to "Not connected"), `onRestart` (→ connect again), `redirectToLogin` |
| `gsc_error` | `Alert variant="destructive"` with the error text and "Try again" |
| Connected | success row "Connected to {property}." + footer Back, "Continue" |
| Not owner | "Only workspace owners can connect Google Search Console." + Continue |

#### 6.6.4 Step 3 — Google Analytics (`AnalyticsStep.tsx`; only when `ga4.available`)

Heading "Connect Google Analytics"; body "Optional. See which pages bring engaged visitors and where AI-driven traffic lands." Renders F20 `Ga4ConnectionCard` with `brandKey` and `returnTo="/onboarding"` (the card owns connect, property picker and errors; returning from Google lands on `/onboarding?ga4=linked`, which `resolveStep` maps here). Event `onboarding:ga4_connect_clicked` through the card's `onConnectClick` callback. Footer: Back, "Skip for now", "Continue" (enabled once `ga4.connected`; marks `done`).

#### 6.6.5 Step 4 — Preferences (`PreferencesStep.tsx`, PORT `AnalyticsOnboardingStep.tsx`; only when at least one switch is available)

Heading "Help make Perceev better"; body "You can change these any time in Settings. See our Privacy Policy." (link `/privacy`). Rows: F26 `AnalyticsConsentSwitch source="onboarding"` (when `analyticsAvailable`; starts **off**, the default), F25 `ProductUpdatesSwitch source="onboarding"` (when `productUpdatesAvailable`; starts from the saved value, off by default). "Continue" saves in parallel: `PUT /api/customer/privacy { analytics, source: "onboarding" }` always (an explicit "off" is a recorded decision, so the F26 banner never asks again) and `PUT /api/customer/email/preferences { productUpdates, source: "onboarding" }` only when the switch was flipped (OpenSEO rule); then `POST …/step done` and the next step regardless of errors; a failure toasts "We couldn't save your choices. You can change them in Settings." Event `onboarding:preferences_saved { product_updates }` (sent only if analytics was turned on, by F26's consent rule).

#### 6.6.6 Step 5 — Review your questions and run your first scan (`FirstScanStep.tsx`)

Heading "Review your questions and run your first scan"; body "Your first scan asks AI assistants the questions your buyers ask and shows which brands they name. You approve the questions and the price first."

Status list (three rows, icon + text, `aria-live="polite"`), refreshed at `pollAfterSeconds` while research or the audit runs:

| Row | States and copy |
|---|---|
| Questions | research `running` → spinner "Researching your website and competitors…"; `review` → "Research is ready: review the proposed questions."; `failed` → "Research couldn't finish. You can add questions yourself."; free-scan only → "{n} questions from your free scan are waiting for review."; approved → check "Approved · version {v} · {active} questions"; nothing → "No questions yet." |
| Site audit | `running`/`queued` → spinner "Auditing {host}: {pagesCrawled} of {pagesTotal} pages"; `completed`/`partial` → check "Audit finished. Open it from Site Audit."; `failed` → "The audit couldn't finish."; `unavailable`/`not_started` → row hidden |
| First scan | approved → "Up to {formatUsd(quote.totalUsd)}" from `usePriceQuote({ action: "ai_visibility.scan.run", input: { panelKey: "default" } })` (loading `Skeleton h-4 w-24`; blocked → the quote's blocked message); not approved → "Starts after you approve your questions." |

Actions (footer: Back, then):
- Not approved → primary "Review questions" → `POST …/complete { via: "wizard" }` → `location.assign("/portal/measurement")` (F08's review and its post-approve "Run your first scan" dialog take over).
- Approved and the quote is not blocked → primary "Run first scan" → `CostReviewDialog` (title "Run your first scan", confirm "Run first scan", pending "Starting…") → `POST /api/customer/scan { brand_key, maxUsd }` → 201 → event `onboarding:first_scan_started` → `POST …/complete { via: "first_scan" }` → `location.assign(destination)`; `409 price_changed` → price-changed state; `409 panel_not_approved` → refetch state; `409 scan_already_running` → complete and go to `/portal`.
- Always: ghost "Finish" → `POST …/complete { via: "wizard" }` → `location.assign(redirect ?? destination)`.

The wizard also finishes itself: if `GET` reports `hasScans` (a scan started elsewhere), the step shows "Your first scan is running." and completes with `via "first_scan"` without a click.

#### 6.6.7 Redirect into onboarding (`src/components/app/onboarding/useOnboardingRedirect.ts`, PORT)

`PortalShell.jsx` boot, after memberships load: read `user_onboarding` with the browser client (`select("completed_at, brand_key").eq("user_id", id).maybeSingle()`). Call `GET /api/customer/onboarding` only when there are no memberships or the row exists with `completed_at` null. When `needsOnboarding` → `router.replace("/onboarding?redirect=" + encodeURIComponent(pathname + search))` (omit when it normalises to `/portal`); while deciding, the existing loading screen stays (no portal flash). A failed check renders the portal. With the flag off nothing changes.

#### 6.6.8 Free-scan sign-up link

`src/components/dashboard/DashboardShell.jsx`, next to the brand chip (`:832-833`), only when `!result.isSample` and `scanId` is a UUID: `Link` "Track these questions in a workspace →" to `/signup?domain=<host of result.website>&scan=<scanId>` (class `tag tag--brand`, the public site's styles). No other change to the free scan.

#### 6.6.9 Overview checklist (`src/components/portal/overview/SetupChecklist.tsx`, PORT `DashboardOnboarding.tsx`)

`src/app/portal/page.jsx` (fix-branch version) renders `<SetupChecklist />` instead of `<GettingStarted steps={checklist} />` when `useWorkspace()?.features?.onboarding_wizard === true`; otherwise unchanged.

| State | What shows |
|---|---|
| Loading | nothing (the card appears when data arrives; no layout jump because it sits above the KPI row) |
| Error | nothing; logged once (the checklist is optional) |
| Remaining or deferred steps | `section aria-label="Setup checklist"` card: header "Get started" / "Approve your questions, run a scan and connect your tools."; `Accordion` of `todo` rows (icon tile, label, detail hidden below `sm`); expanded panel: the action (`Button` "Review questions" → `/portal/measurement`; "Run scan" → `scan.start()`; "Connect" → `/portal/search-console`; "Audit your site" → `/portal/audit`; "Schedule scans" → `/portal/settings/schedule`; "Connect" → `/portal/settings/integrations`; "New draft" → `/portal/content?new=1`; "Invite" → `/portal/team`), then a divider and ghost "Skip for now" (→ `POST /api/customer/setup/dismiss`). Collapsible "{n} saved for later" with each row and a ghost "Restore" (`RotateCcw`, `aria-label="Restore {label}"`). Collapsible "{n} completed" with check icons |
| Everything done, nothing deferred | renders nothing |

Members see `gsc`, `schedule` and `ga4` rows with the detail line "Ask a workspace owner to set this up." and no action. Events `dashboard:setup_step_click { step }`, `dashboard:setup_step_defer { step, dismissed }`. Query key `setupKeys.activation(brandKey)` = `["setup", brandKey]`; invalidated after a scan starts and after dismiss.

**Accessibility (all F27 UI):** one `h1` per step; step bars are buttons with labels; status rows use text, not colour alone; dialogs return focus. **Phone (390 px):** the card is full width with `p-6`; footer buttons wrap with the primary last; the checklist hides details below `sm`; no horizontal scroll.

### 6.7 Permissions, privacy, observability

- Onboarding routes act only for the signed-in user and only on the workspace they own through onboarding; setup routes are member-scoped by `requireWorkspace`; dismissals are personal.
- Free-scan import reads only anonymous scans (already public by id) whose host matches the user's own workspace; question text goes only into F08's table; it is never logged or sent to telemetry.
- Logs: `[onboarding] market save failed { brandKey }`, `[onboarding] audit start failed { brandKey, code }`, `[onboarding] import skipped { reason }`.
- Telemetry (F26 registry names; sinks `src/components/portal/onboarding/telemetry.ts` and `src/lib/onboarding/telemetry.ts`): client `onboarding:step_viewed`, `onboarding:step_skipped`, `onboarding:website_saved`, `onboarding:website_save_failed`, `onboarding:gsc_connect_clicked`, `onboarding:gsc_property_selected`, `onboarding:ga4_connect_clicked`, `onboarding:preferences_saved`, `onboarding:first_scan_started`, `dashboard:setup_step_click`, `dashboard:setup_step_defer`; server `onboarding:audit_started`, `onboarding:free_scan_imported`, `onboarding:completed` (anonymous-eligible).

## 7. Code reuse map

| OpenSEO source | Perceev target | Mode | Adaptation notes |
|---|---|---|---|
| `openseo:src/client/features/onboarding/onboardingModel.ts:4-19` | `src/shared/onboarding.ts` | PORT | Named steps; five steps with `first_scan` replacing `agent_setup`; visibility rules. |
| `openseo:src/routes/_authenticated.onboarding.index.tsx:18-151` | `src/components/portal/onboarding/OnboardingWizard.tsx`, `src/app/onboarding/page.jsx` | PORT | TanStack route → Next page; `beforeLoad` redirect → client check; free-tool landing → `finishDestination`. |
| `openseo:src/client/features/onboarding/PostSignupOnboarding.tsx:22-69`, `OnboardingCard.tsx:8-51` | `OnboardingShell.tsx` | PORT | Perceev logo; account menu with sign-out. |
| `openseo:src/client/features/onboarding/WizardFooter.tsx:6-72` | `WizardFooter.tsx` | COPY | Import paths only. |
| `openseo:src/client/features/onboarding/WebsiteOnboardingStep.tsx:28-211` | `WebsiteStep.tsx` | PORT | Adds brand name and free-scan banner; research dialog after save. |
| `openseo:src/serverFunctions/projects.ts:67-81`, `openseo:src/server/features/dashboard/services/DashboardFirstAuditService.ts:11-90` | `src/lib/onboarding/website.ts` | PORT | Workspace creation via our RPC; audit through F18 `startSiteAudit` (skip when one exists; failures never fail the save). |
| `openseo:src/client/features/onboarding/SearchConsoleOnboardingStep.tsx:35-246` | `SearchConsoleStep.tsx` | PORT | Our GSC routes and `PropertyPicker`; return path column. |
| `openseo:src/client/features/onboarding/AnalyticsOnboardingStep.tsx:17-129` | `PreferencesStep.tsx` | PORT | F26 and F25 switches; analytics decision always recorded. |
| `openseo:src/client/features/onboarding/useOnboardingRedirect.ts:12-61`, `openseo:src/routes/_app/route.tsx:34-39` | `src/components/app/onboarding/useOnboardingRedirect.ts`, `PortalShell.jsx` | PORT | Rule widened so existing workspaces and invitees are never redirected. |
| `openseo:src/serverFunctions/onboarding.ts:77-136`, `openseo:src/db/pg/app.schema.ts:31-55` | `src/lib/onboarding/steps.ts`, `user_onboarding` | PORT | `COALESCE` completion; per-step status; no questionnaire columns. |
| `openseo:src/client/features/dashboard/dashboardSteps.ts:1-79` (+ test) | `src/shared/setup-steps.ts` (+ test) | PORT | Perceev rows; same done/skipped/todo precedence. |
| `openseo:src/client/features/dashboard/DashboardOnboarding.tsx:24-180` (+ test) | `src/components/portal/overview/SetupChecklist.tsx` (+ render test) | PORT | Our actions and copy; members see guidance rows. |
| `openseo:src/server/features/dashboard/services/DashboardService.ts:52-98`, `openseo:src/serverFunctions/dashboard.ts:55-66`, `openseo:src/db/pg/app.schema.ts:432-447` | `src/lib/onboarding/setup.ts`, setup routes, `workspace_setup_dismissals` | PORT | Activation from our tables; dismissals per user per workspace. |
| `openseo:src/routes/_auth.sign-up.tsx:39-58`, `openseo:web/src/lib/free-tools/upsell-card.tsx:4-33` | `DashboardShell.jsx` link; F24 `buildOnboardingPath` | PATTERN | Domain plus scan id; questions arrive as paused suggestions. |
| `openseo:src/routes/_app/index.tsx:20-38` | `finishDestination` | PATTERN | One workspace per account; land on `redirect` or `/portal`. |

## 8. Implementation plan

Branches `feat/f27-onboarding-wizard-p1` … `-p5`. `NT` = `node --import ./src/lib/liveWriteGuardAuto.mjs --test`. Requires F08 phase 3, F09 phase 3, F18 phase 3, F20 phase 2, F24 phase 2, F25 phase 3 and F26 phase 2 merged.

### Phase 1 — Data, state model, server routes, free-scan hand-off, GSC return path

**Goal:** the server can run onboarding end to end; nothing in the UI changes yet.

- [ ] **P1.T1 Migration**
  - [ ] **P1.T1.S1** *Files:* `supabase/migrations/170_f27_onboarding.sql`. *Do:* §6.1. *Verify:* `NT src/lib/migrationsRunner.test.mjs src/lib/migrationsLedger.test.mjs` → pass.
  - [ ] **P1.T1.S2** *Files:* `scripts/setup-supabase.mjs`, `tests/customer-uat.sql`. *Do:* §6.1 entries and RLS assertions. *Verify:* CI `customer-database` job passes.
  - [ ] **P1.T1.S3** *Files:* `README.md` (row `170_f27_onboarding` "Onboarding progress per user, setup-checklist dismissals per user and workspace, and an optional Search Console return path to onboarding."), `docs/OPERATOR_LEDGER.md` § C ("apply 170; existing users get no row and are never redirected"), `docs/PROD_MIGRATIONS.md`. *Verify:* `NT src/lib/docStatus.test.mjs src/lib/migrationsLedger.test.mjs` → pass.
- [ ] **P1.T2 Shared models**
  - [ ] **P1.T2.S1** *Files:* `src/shared/onboarding.ts`, `src/shared/onboarding.test.ts`. *Do:* §6.2. Tests: AC-02 (all visibility combinations; `resolveStep("bogus")` → first not-done; `ga4` return → `analytics`; hidden `analytics` + `?step=analytics` → next visible), AC-14 (redirect wins; `//evil` ignored; domain without scan + domain overview on → `/portal/domain?domain=acme.example&minRank=4&maxRank=20&sort=volume&order=desc`; with scan → `/portal`; overview off → `/portal`). *Verify:* `NT src/shared/onboarding.test.ts` → pass.
  - [ ] **P1.T2.S2** *Files:* `src/shared/setup-steps.ts`, `src/shared/setup-steps.test.ts`. *Do:* §6.2; port both OpenSEO cases (skipped is not completed; completion wins over dismissal) plus flag and role filtering. *Verify:* `NT src/shared/setup-steps.test.ts` → pass (F27-AC-15).
- [ ] **P1.T3 Server**
  - [ ] **P1.T3.S1** *Files:* `src/lib/onboarding/{freeScanHandoff,steps,telemetry}.ts`, `freeScanHandoff.test.ts`, fixtures `tests/fixtures/f27/free-scan-*.json`. *Do:* §6.2; tests with an admin fake and a recording `addWorkspaceQuestion`: 24 imported in order from `free-scan-row.json`, every call `status "paused"`, `origin "promptgen"`, topic and `sourceRef`; claimed scan, other host, 31-day-old scan, unknown id → 0 with the matching reason; `question_limit` thrown at the 10th → 9 imported, reason `question_limit`; a `console` spy never sees any fixture question text. *Verify:* `NT src/lib/onboarding/freeScanHandoff.test.ts` → pass (F27-AC-06 unit).
  - [ ] **P1.T3.S2** *Files:* `src/lib/onboarding/state.ts`, `state.test.ts`. *Do:* §6.2 and AC-01 cases with injected dependencies. *Verify:* `NT src/lib/onboarding/state.test.ts` → pass (F27-AC-01).
  - [ ] **P1.T3.S3** *Files:* `src/lib/onboarding/website.ts`, `src/lib/onboarding/onboarding.contract.ts`, `src/app/api/customer/onboarding/route.ts`, `src/app/api/customer/onboarding/website/route.ts`, `src/app/api/customer/onboarding/step/route.ts`, `src/app/api/customer/onboarding/complete/route.ts`, `src/lib/onboarding/website.route.test.mjs`, `src/lib/onboarding/state.route.test.mjs`. *Do:* §6.5; route-hook pattern of `src/lib/customerRoutes.test.hooks.mjs` with fakes for the RPC, `requireWorkspace`, `getQuestionsState`/`saveQuestionPatch`, `startSiteAudit` and `addWorkspaceQuestion`. Cases: AC-03 (new user → RPC called with `p_idempotency_key "onboarding:<key>"`, settings saved, row upserted, audit started once; repeat → RPC returns `created:false`, audit not started again), AC-04 (each 4xx with code and message), AC-05 (feature off and thrown error → 200 with the right `audit.status`), AC-07 (prefill shapes; no `text` field anywhere in the JSON), AC-08 (step hidden → 400; complete twice keeps the first time; event once). *Verify:* `NT src/lib/onboarding/*.route.test.mjs src/lib/http/routeContract.test.ts` → pass (F27-AC-03, 04, 05, 07, 08).
  - [ ] **P1.T3.S4** *Files:* `src/lib/onboarding/setup.ts`, `src/app/api/customer/setup/route.ts`, `src/app/api/customer/setup/dismiss/route.ts`, `src/lib/onboarding/setup.route.test.mjs`. *Do:* §6.5; cases: each row's completion source; a member's response omits `team`; flag off → 404; dismiss inserts then restore deletes; dismissing in workspace A leaves B untouched; a missing optional table (`site_audits` absent → `42P01`) → `audit` not done. *Verify:* `NT src/lib/onboarding/setup.route.test.mjs` → pass (F27-AC-16 route half).
- [ ] **P1.T4 GSC return path**
  - [ ] **P1.T4.S1** *Files:* `src/lib/gsc/oauthFlow.js`, `src/lib/gsc/oauthFlow.test.mjs`, `src/app/api/customer/gsc/connect/route.js`, `src/app/api/customer/gsc/callback/route.js`, `src/lib/gsc/connect.route.test.mjs`. *Do:* §6.2 edits; append test cases only: default return path stored when omitted; `/onboarding` stored; other value throws; callback result includes `returnPath`; route: `return_to: "/onboarding"` → attempt insert has it, `return_to: "/x"` ignored; callback success with an onboarding attempt → `Location` `/onboarding?step=search_console&gsc_connected=true&brand_key=…&gsc_attempt=…`; default attempt → unchanged `/portal/search-console?...`. *Verify:* `NT src/lib/gsc/oauthFlow.test.mjs src/lib/gsc/connect.route.test.mjs` → pass with the old cases untouched (F27-AC-09).
- [ ] **P1.T5 Database checks**
  - [ ] **P1.T5.S1** *Files:* `scripts/qa/check-f27-db.mjs`. *Do:* loopback `_qa` guard; groups `website` (call `saveOnboardingWebsite` twice with one key against the QA DB using a service client and a stubbed `requireWorkspace` → one workspace, one membership, one row), `handoff` (insert the fixture scan as an anonymous `scans` row; run the import → 24 paused `workspace_questions`; run again → still 24), `dismissals` (RLS: user A cannot read B's rows; leaving a workspace hides its rows). *Verify:* `PGHOST=localhost PGDATABASE=perceev_qa node scripts/qa/check-f27-db.mjs` → `PASS` ×3 (F27-AC-03 DB, 06 DB, 16 DB).
- [ ] **P1.T6 Registration**
  - [ ] **P1.T6.S1** *Files:* `src/lib/features/names.ts`, `src/lib/features/clientFeatures.ts`, `.env.example`, `src/lib/query/keys.ts`. *Do:* flag entries; `FEATURE_ONBOARDING_WIZARD=` in `.env.example`; `onboardingKeys`, `setupKeys`. *Verify:* `NT src/lib/features/flags.test.ts src/lib/query/keys.test.ts` → pass.

**Checkpoint:** suite, typecheck, build, `check-f27-db.mjs`. Completes F27-AC-01 to 09, 15, 16 (route and DB).

### Phase 2 — The wizard

**Goal:** new accounts go through the five steps; existing users never see them.

- [ ] **P2.T1 Shell and steps**
  - [ ] **P2.T1.S1** *Files:* `src/components/portal/onboarding/{OnboardingWizard,OnboardingShell,WizardFooter,WebsiteStep,SearchConsoleStep,AnalyticsStep,PreferencesStep,FirstScanStep}.tsx`, `src/components/portal/onboarding/hooks/useOnboardingState.ts`, `src/components/portal/onboarding/telemetry.ts`. *Do:* §6.6.1–6.6.6 (licence headers on PORT/COPY files). *Verify:* `npm run typecheck`, `npm run build` → exit 0.
  - [ ] **P2.T1.S2** *Files:* `src/app/onboarding/page.jsx`, `src/components/portal/onboarding/LegacyOnboardingForm.jsx`. *Do:* §6.6.1 (legacy body moved verbatim). *Verify:* build → exit 0; `check-f04-browser.mjs` F04-B07 on `/onboarding` (flag off) → pass.
- [ ] **P2.T2 Redirect**
  - [ ] **P2.T2.S1** *Files:* `src/components/app/onboarding/useOnboardingRedirect.ts`, `useOnboardingRedirect.test.ts`, `src/components/portal/PortalShell.jsx`, `src/components/portal/portalRegressions.test.mjs`, `src/components/portal/portalProgress.test.mjs`. *Do:* §6.6.7; the hook's decision is a pure function `decideOnboardingRedirect({ flagKnown, memberships, row, state, pathname, search })` tested for: existing customer (memberships, no row) → stay; new user → redirect with `redirect` param; check failed → stay; `/portal` → no `redirect` param. Harness maps add `@/components/app/onboarding/useOnboardingRedirect` → `() => "ready"` (reason: new import; assertions unchanged). *Verify:* `NT src/components/app/onboarding/useOnboardingRedirect.test.ts src/components/portal/*.test.mjs` → pass (F27-AC-13 unit).
- [ ] **P2.T3 Free-scan link**
  - [ ] **P2.T3.S1** *Files:* `src/components/dashboard/DashboardShell.jsx`. *Do:* §6.6.8. *Verify:* `NT 'src/components/dashboard/*.test.mjs'` → pass; `check-public-browser.mjs` (F04) → pass with the link added to its allowlist note if it diffs the dashboard layout.
- [ ] **P2.T4 Browser checks**
  - [ ] **P2.T4.S1** *Files:* `scripts/qa/check-f27-browser.mjs`, `tests/fixtures/f27/onboarding-state-*.json`. *Do:* F04 harness plus routes for every onboarding, questions, price, scan, GSC, GA4, privacy and email endpoint (fixtures; all writes recorded, nothing leaves `127.0.0.1`). Scenarios: W1 new user lands on step 1 with `?domain=acme.example&scan=<id>` prefilled website, brand "Acme" and the free-scan banner "…the 24 questions…"; W2 invalid website → inline error; W3 save → research dialog with the fixture price; "Start research" sends `maxUsd` equal to the shown amount; a second run with a `feature_disabled` quote shows only "Skip research" (AC-11); W4 Search Console: connect posts `return_to: "/onboarding"`; return URL with `gsc_attempt` shows the picker; choosing a property moves to step 3; W5 Analytics step hidden when `ga4.available` is false (bars show four steps); W6 preferences: Continue sends privacy PUT `{ analytics: false, source: "onboarding" }` and no email PUT when untouched; step 5 not approved → "Review questions" completes and opens `/portal/measurement`; approved → "Run first scan" dialog → scan POST with `maxUsd` → `/portal` (AC-12); W7 every step's "Skip for now" works; website skip → `/portal` status screen; W8 reload keeps `?step=`; step bars jump; Back works; 390 px no overflow; W9 an existing customer (memberships, no row) opening `/portal/scans` stays there; a new user opening `/portal/scans` lands on `/onboarding?redirect=%2Fportal%2Fscans` and, after Finish, on `/portal/scans` (AC-13, AC-18). *Verify:* `node scripts/qa/check-f27-browser.mjs http://127.0.0.1:3328` → `ok 9 scenarios`, `0 external requests` (F27-AC-10 to 14, 18).

**Checkpoint:** suite, typecheck, build, browser W1–W9, F04 browser check. Completes F27-AC-10 to 14, 18.

### Phase 3 — Setup checklist on Overview

**Goal:** "Get started" replaces `GettingStarted` when the flag is on.

- [ ] **P3.T1 Component**
  - [ ] **P3.T1.S1** *Files:* `src/components/portal/overview/SetupChecklist.tsx`, `src/components/portal/overview/hooks/useSetupActivation.ts`, `src/app/portal/page.jsx`. *Do:* §6.6.9. *Verify:* build → exit 0.
  - [ ] **P3.T1.S2** *Files:* `src/components/portal/overview/setupChecklist.test.mjs`. *Do:* render-harness test (F04 rule 2, `renderToStaticMarkup` with a fake query client) porting OpenSEO's two cases: all dismissed → markup contains "saved for later"; all done → empty string; plus a member render without actions on owner rows. *Verify:* `NT src/components/portal/overview/setupChecklist.test.mjs` → pass (F27-AC-17 unit).
  - [ ] **P3.T1.S3** *Files:* `src/components/portal/portalRegressions.test.mjs`. *Do:* add `SetupChecklist` to the Overview module map as `autoNull` and keep the existing `GettingStarted`/`buildChecklist` assertions (reason: Overview now imports the checklist; the flag-off path is unchanged). *Verify:* `NT src/components/portal/portalRegressions.test.mjs` → pass.
- [ ] **P3.T2 Browser**
  - [ ] **P3.T2.S1** *Files:* `scripts/qa/check-f27-browser.mjs`. *Do:* W10: flag on → "Get started" with the fixture rows; "Skip for now" moves a row into "1 saved for later"; "Restore" brings it back; all-done fixture → no card; flag off → "Getting started" (the old card) renders. *Verify:* `ok 10 scenarios` (F27-AC-17).

**Checkpoint:** suite, build, browser W10. Completes F27-AC-17.

### Phase 4 — Owner live checks

- [ ] **P4.T1 Runbook**
  - [ ] **P4.T1.S1** *Files:* `docs/OPERATOR_LEDGER.md` § C ("F27 onboarding": §10 steps), `scripts/qa/check-f27-live.md` (O1–O5). *Verify:* `NT src/lib/docStatus.test.mjs` → pass.
- [ ] **P4.T2 Owner-run live checks (only on the owner's instruction)**
  - [ ] **P4.T2.S1** *Do:* the owner runs O1–O5 and records pass/fail and dates in the phase-4 PR. *Verify:* five passes (F27-AC-19).

### Phase 5 — Retire `GettingStarted` (only after the owner turns the flag on in production and confirms for one week)

- [ ] **P5.T1** *Files:* `src/components/portal/overview/GettingStarted.jsx` (deleted), `src/app/portal/page.jsx` (render `SetupChecklist` unconditionally when the flag is on; nothing when off), `src/components/portal/portalRegressions.test.mjs` (remove the `GettingStarted`/`buildChecklist` assertions; reason: component retired by the owner's decision), `src/components/portal/onboarding/LegacyOnboardingForm.jsx` (kept: it is the flag-off fallback). *Verify:* `NT src/components/portal/*.test.mjs` → pass; `git grep -n "GettingStarted" src` → no matches.

## 9. Test plan

| Test file | Cases | ACs |
|---|---|---|
| `src/lib/onboarding/state.test.ts` | redirect rule, auto-completion on a scan | 01 |
| `src/shared/onboarding.test.ts` | visible steps, step resolution, finish destination | 02, 14 |
| `src/lib/onboarding/website.route.test.mjs` | create, update, lock, conflicts, audit start/skip/failure, idempotency | 03, 04, 05 |
| `src/lib/onboarding/freeScanHandoff.test.ts` | extraction rules, reasons, limits, no text in logs | 06 |
| `src/lib/onboarding/state.route.test.mjs` | prefill, step, complete | 07, 08 |
| `src/lib/gsc/oauthFlow.test.mjs`, `src/lib/gsc/connect.route.test.mjs` | return path | 09 |
| `scripts/qa/check-f27-browser.mjs` | W1–W10 | 10–14, 17, 18 |
| `src/components/app/onboarding/useOnboardingRedirect.test.ts` | redirect decisions | 13 |
| `src/shared/setup-steps.test.ts` | status precedence, filters | 15 |
| `src/lib/onboarding/setup.route.test.mjs`, `check-f27-db.mjs` `dismissals` | activation, dismissals | 16 |
| `src/components/portal/overview/setupChecklist.test.mjs` | render states | 17 |
| `scripts/qa/check-f27-db.mjs` | `website`, `handoff`, `dismissals` | 03, 06, 16 |
| existing `customerAuth`, `customerRoutes`, `operatorPerimeter`, portal tests | unchanged behaviour | 18 |
| `scripts/qa/check-f27-live.md` | O1–O5 (owner) | 19 |

## 10. Rollout and rollback

**Env names:** `FEATURE_ONBOARDING_WIZARD`. **Default:** off in production → legacy `/onboarding` form and `GettingStarted`.

**Owner steps:** apply migration 170; make sure F18 `site_audit` is on (else the audit row simply hides) and decide whether `questions_setup` paid control is enabled (else research is offered as unavailable and free-scan suggestions carry the questions); set `FEATURE_ONBOARDING_WIZARD=on` on a preview, run O1–O5, then production.

**Live checklist (`scripts/qa/check-f27-live.md`):** O1 run the free scan for a site you control, click "Track these questions in a workspace", sign up → onboarding shows the domain, brand and "…questions from your free scan…"; O2 save → workspace created, the audit starts (Site Audit shows it running), research price shown; approve research only if the paid control is on for this workspace; O3 connect Search Console and return to step 2's picker; O4 preferences saved (Settings → Privacy and Emails show the choices); O5 approve questions (via "Review questions") and run the first scan from the price dialog; an existing customer account logging in is never shown onboarding.

**Rollback:** `FEATURE_ONBOARDING_WIZARD=off` restores the legacy form, the old checklist and today's portal behaviour immediately; GSC attempts with `return_path '/onboarding'` still complete (the callback honours the stored path). Data: `user_onboarding` and `workspace_setup_dismissals` can stay; to remove, drop both tables and the `return_path` column after the flag is off.

## 11. Risks and open questions

1. **F08 settings write.** `saveQuestionPatch` needs the current revision; onboarding reads it from `getQuestionsState`. *Resolved:* F08 exports `saveQuestionSettings(admin, { brandKey, settings, actor })`, which reads the revision and retries once on `revision_conflict`; onboarding uses it.
2. **F20 `Ga4ConnectionCard` props** (`brandKey`, `returnTo`, `onConnectClick`). *Resolved:* F20 §6.6 freezes these props.
3. **Paused free-scan questions** count toward F08's 100-question cap. *Default:* at most 30 are imported; the banner says they are suggestions.
4. **Website changes after research started** (step 1 revisited with a new website) leave research based on the old site. *Default:* allowed only before any scan (409 after); the Questions page lets the customer rerun research.
5. **Free-scan host matching** ignores `www.` but not other subdomains (`shop.acme.com` vs `acme.com`). *Default:* exact host after `www.` removal; a mismatch imports nothing and the save still succeeds.
6. **Country from IP** (`x-vercel-ip-country`) may be wrong behind VPNs. *Default:* it is only a prefill; the customer can change it in the collapsible.
7. **Members who create no workspace** (invitees) never see onboarding, so they never get the Preferences step. *Default:* F26's banner and F25's Settings tab cover them.

## 12. Definition of done

- [ ] Phases 1–4 merged; phase 5 merged after the owner's go-ahead; subtasks ticked.
- [ ] F27-AC-01 to 18 covered by passing tests; AC-19 recorded.
- [ ] Typecheck, build, suite, `check-f27-db.mjs`, `check-f27-browser.mjs` (10 scenarios) and F04's browser check green.
- [ ] Migration paperwork for 170 done; `THIRD_PARTY_NOTICES.md` lists the §7 COPY/PORT paths.
- [ ] `features/README.md` status updated; README "Depends on" for F27 includes F09, F25, F26.

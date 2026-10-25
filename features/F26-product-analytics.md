# F26 — Product analytics and error tracking (PostHog)

> <!-- doc-status -->
> **Status: LIVE.** Implementation spec. Not built yet.

| Field | Value |
|---|---|
| ID | F26 |
| Wave | 5 |
| Comparison rows covered | "Product analytics" (OpenSEO: PostHog events, errors and source maps; Perceev: operational telemetry only) |
| Depends on | none in the README graph. Built on F01 (flags, `toErrorResponse`, job runner, `requireWorkspace`), F04 (`AppProviders`, `APP_SURFACES`, settings tabs, `WorkspaceBanners`), F05 (`fetchJson`, query keys). Wires the telemetry sinks of every merged feature (§6.2.7). |
| Blocks | F27 (Preferences step uses `AnalyticsConsentSwitch` and `PUT /api/customer/privacy`) |
| Reserved migrations | 165–169 (165 `165_f26_privacy_and_telemetry_ids.sql`; 166–169 deliberately unused) |
| Feature flag | `FEATURE_PRODUCT_ANALYTICS` (name `product_analytics`; in `CLIENT_FEATURES`). Hard kill switches: `TELEMETRY_DISABLED=1` (server) and `NEXT_PUBLIC_TELEMETRY_DISABLED=1` (browser). Nothing is sent while `NEXT_PUBLIC_POSTHOG_KEY` is unset. |
| Spend features | none |
| OpenSEO reference | `openseo:src/server/lib/posthog.ts` (+ test), `openseo:src/client/lib/posthog.ts` (+ test), `openseo:src/client/lib/posthog-sanitize.ts` (+ test), `openseo:src/client/components/PrivacyChoices.tsx`, `openseo:src/shared/privacy-choices.ts` (+ test), `openseo:src/routes/api/privacy-region.ts`, `openseo:src/client/features/settings/PrivacySettings.tsx`, `openseo:src/client/features/onboarding/AnalyticsOnboardingStep.tsx`, `openseo:src/server/mcp/instrumentation.ts` (+ test), `openseo:src/shared/error-codes.ts`, `openseo:src/server/auth/sign-up-analytics.ts`, `openseo:package.json:23`, `openseo:vite.config.ts:47-71`, `openseo:src/router.tsx` at `c5f8db1` |

## 1. Summary

Perceev learns which features customers use and where they fail, without ever collecting their questions, AI answers, website data or contact details. Product analytics is **off until each person agrees** (onboarding step, Settings or a one-time banner); errors are reported with their type, code and stack frames only, never their messages. One typed event registry, `src/lib/telemetry/events.ts`, lists every event of F01–F27 with a strict property schema, and a test refuses free-text properties. PostHog runs on its EU cloud behind a first-party `/ingest` proxy, events group by an opaque workspace id, source maps are uploaded at build time and then deleted from the deployment, and every tool run in the F22 tool registry is measured.

## 2. What OpenSEO does (observed)

1. **Server client.** A one-shot `posthog-node` client per call with `flushAt: 1, flushInterval: 0`, shut down after use; null when the key or host is missing (`openseo:src/server/lib/posthog.ts:6-18`).
2. **Server errors without messages.** `withoutMessage(error)` keeps the error's type, its `AppError` code and real stack frames only, recursing into `cause` up to depth 4, because messages can quote customer content (`openseo:src/server/lib/posthog.ts:20-43`); test: a message quoting a keyword and a domain never reaches PostHog (`openseo:src/server/lib/posthog.test.ts:21-36`). `distinctId` must be the user id so errors attach to the person; omitting it inflates "users affected" (`:45-73`).
3. **Server events honour the user's choice** by reading `analyticsOptedOut` on every event and group by `organization` (`openseo:src/server/lib/posthog.ts:75-116`).
4. **Browser client** is imported lazily and initialised with `capture_exceptions`, `capture_pageview: "history_change"`, `mask_all_text`, `mask_all_element_attributes`, `mask_personal_data_properties`, `respect_dnt`, `opt_out_persistence_by_default`, session recording disabled at init and console logs never recorded (`openseo:src/client/lib/posthog.ts:67-151`). A `before_send` hook drops unactionable exceptions ("Script error.", ResizeObserver loop, aborted signals, `CancelledError`, PostHog timeouts, stackless synthetic "undefined") and sanitises the rest (`:30-65`, `:91-100`).
5. **Nothing is captured before the privacy choice is known.** Up to 50 events are buffered, sent if analytics starts and dropped if it does not (`openseo:src/client/lib/posthog.ts:13-21`, `:176-186`, `:208-231`; test `posthog.test.ts:22-49`). Identify by user id and group by organisation (`:188-199`); reset on sign-out (`:201-206`); client errors stop after a stale-build reload starts (`:233-250`; `openseo:src/router.tsx:5`).
6. **Sanitiser.** Only `utm_*`, `tab` and `view` query parameters survive; hashes are dropped; nested URLs (web vitals) and heatmap keys are cleaned; autocaptured link targets and `$external_click_url` are removed; exception messages are blanked unless they are a bare error code (`openseo:src/client/lib/posthog-sanitize.ts:3-114`; tests `posthog-sanitize.test.ts:7-77`).
7. **Privacy choices.** A first-party cookie `a1.d0.m1` (180 days) shared by site and app; opt-in by default in the EEA, UK, Switzerland and unknown locations, opt-out elsewhere; Global Privacy Control turns off advertising and referrals (`openseo:src/shared/privacy-choices.ts:24-112`). A region route answers `{ optIn }` from Cloudflare's country header (`openseo:src/routes/api/privacy-region.ts:7-17`). The account mirrors the analytics choice so server events follow it, and a browser without a cookie honours an account opt-out (`openseo:src/client/components/PrivacyChoices.tsx:55-143`).
8. **Choices in the product.** Onboarding "Help make OpenSEO better" step with "Usage analytics — Share usage analytics and session replays to help improve OpenSEO." and the product-updates switch (`openseo:src/client/features/onboarding/AnalyticsOnboardingStep.tsx:63-128`); the same switches in Settings → "Privacy and emails" (`openseo:src/client/features/settings/PrivacySettings.tsx:24-60`). Session replay starts only after terms acceptance (`PrivacyChoices.tsx:110-131`).
9. **Source maps.** `sourcemaps:upload` builds with `POSTHOG_SOURCEMAPS=true` into a separate output directory, then runs `@posthog/cli sourcemap inject` and `sourcemap upload` on it (`openseo:package.json:23`; `openseo:vite.config.ts:47`, `:69-71`).
10. **Tool instrumentation.** Every MCP tool handler is wrapped: an event `mcp:tool_call { tool, success, error_code, client_id, source, turn_id, duration_ms, project_id, row_count, quota_remaining }`; exceptions reported when their code is reportable; output-schema mismatches re-validated and reported with issue paths only, because the SDK would otherwise hide them (`openseo:src/server/mcp/instrumentation.ts:30-204`; test `instrumentation.test.ts`). Expected codes (unauthenticated, rate limited, validation, not found, credits, upstream outages) are not reported (`openseo:src/shared/error-codes.ts:31-61`).
11. **Event naming** is `area:action` with snake_case (`auth:sign_in_submit`, `onboarding:step_viewed`, `site_audit:start`, `report:public_view`); sign-up completion is a server event because Google sign-ups end in a full-page redirect (`openseo:src/server/auth/sign-up-analytics.ts:9-46`).

## 3. What Perceev has today

- **No product analytics or error tracking.** `src/lib/analytics/` holds AI-visibility metrics, not product telemetry (conventions §12). There is no `src/instrumentation.ts`; `next.config.mjs` has headers, a redirect and file tracing only, no rewrites and no CSP (`next.config.mjs:4-29`).
- **Privacy policy** (`src/app/privacy/page.jsx:52-65`) mentions hosting, authentication and database providers and AI model providers; nothing about analytics, cookies for analytics or error reporting.
- **App surfaces** are `/portal`, `/onboarding`, `/login`, `/signup`, `/auth`, `/ops` (F04 `APP_SURFACES`); the public website and free scan are separate and stay untouched.
- **Workspace keys** are opaque UUIDs for new workspaces but customer domains for older ones (`src/lib/customerProvisioning.js:12-13`; e.g. `snitch.com` in `src/lib/customerAuth.test.mjs:46`), so `brand_key` must never reach PostHog.
- **Telemetry sinks already promised** by F03, F06–F25: each spec lists event names in its §6.7 and most ship a no-op sink module for F26 to wire (§6.2.7). F11 and F12 name their events without the `area:` prefix (`prompt_explorer_run_started`, `question_history_viewed`); the registry uses the colon form (§6.2.2, request in the report).
- **Tool registry** (F22): `runTool(reg, ctx, rawInput, opts)` in `src/lib/tools/run.ts` is the single execution path for assistant, approval and future MCP calls (`features/F22-in-app-assistant.md` §6.2.3).

## 4. Target behaviour and acceptance criteria

**Decision — consent default: off until the person agrees, everywhere.**
- *India.* Most Perceev customers are Indian businesses. The Digital Personal Data Protection Act 2023, with its Rules notified in November 2025, requires consent that is free, specific, informed, unconditional and unambiguous, given by a clear affirmative action, for processing personal data outside narrow "legitimate uses"; product analytics tied to a user id is not one of them. A pre-switched-on default would not be "clear affirmative action".
- *Our own policy.* `src/app/privacy` promises nothing about analytics today; turning tracking on by default would contradict the published text until the policy changes, and the honest change is to describe an opt-in.
- *Simplicity.* One global default needs no IP-country lookup (OpenSEO's `/api/privacy-region` and Cloudflare header have no reliable Vercel equivalent behind VPNs) and no public route.
- *Cost.* Fewer measured users. Mitigations: the onboarding Preferences step asks every new account (F27), a one-time banner asks existing users, and three **anonymous counters** (§6.2.2 `consent: "anonymous"`) count sign-ups, onboarding completions and public report views with no identity, no person profile and closed-vocabulary properties.

**Decision — error reports** are always sent, without identity unless the person consented: type, code and stack frames only (OpenSEO `withoutMessage`), the route template, and no request data. These are not personal data and are needed to keep the service working; the privacy policy says so.

**Decision — no autocapture and no session replay.** Only registry events and `$pageview` are sent. This removes the masking problems OpenSEO solves with selectors (`posthog.ts:114-140`) and keeps every property reviewable in one file.

**Decision — EU cloud behind `/ingest`.** PostHog has no Indian region; the EU cloud (`eu.i.posthog.com`) is hosted under GDPR. A Next.js rewrite proxies `/ingest/*`, so browsers talk only to our origin and PostHog never sees the visitor's IP from the browser (the owner also enables "Discard client IP data").

| ID | Criterion | Verified by |
|---|---|---|
| F26-AC-01 | Every registry event name matches `^[a-z][a-z0-9_]*:[a-z][a-z0-9_]*$`; every props schema is a strict object; every string leaf is an enum, a literal or the `code` type; no property is named `brand_key`, `brand`, `domain`, `url`, `email`, `name`, `title`, `text`, `query`, `question`, `answer`, `prompt`, `keyword`, `message` or `website`; the registry contains exactly the names in §6.2.2. | unit `src/lib/telemetry/events.test.ts` |
| F26-AC-02 | `validateEventProps` rejects unknown names, extra keys, wrong types and `code` values that look like a hostname or an email (`snitch.com`, `a@b.test`) while accepting `anthropic/claude-sonnet-4.5`, `site_audit.run` and `1.2`. | unit `events.test.ts` |
| F26-AC-03 | `captureServerEvent` sends nothing when the key is missing, `TELEMETRY_DISABLED=1`, the flag is off, the props are invalid, or the user has not consented (except `anonymous` events); a consented event uses `distinctId = userId` and `groups.workspace = customer_brands.telemetry_id` (never the brand key); an anonymous event uses a random distinct id, `$process_person_profile: false` and no groups. | unit `src/lib/telemetry/server.test.ts` |
| F26-AC-04 | `captureServerError` reports type, code and stack frames only (port of OpenSEO's test: a message quoting a keyword and a domain never appears, `cause` messages blanked), skips non-reportable codes (§6.2.4), attaches the user only with consent, and never throws. | unit `server.test.ts` |
| F26-AC-05 | The browser client loads `posthog-js` only after consent, initialises with `api_host: "/ingest"`, `autocapture: false`, `disable_session_recording: true`, `opt_out_capturing_by_default: true`, `opt_out_persistence_by_default: true`, `respect_dnt: false`, `person_profiles: "identified_only"`, `capture_pageview: "history_change"`; events reported before the choice is known are sent if consent arrives and dropped otherwise (port of OpenSEO's test); **after consent, `startAnalyticsCapture` calls `opt_in_capturing` once and a queued event then reaches `capture`**. | unit `src/lib/telemetry/client.test.ts` |
| F26-AC-06 | The sanitiser keeps only `utm_*`, `tab`, `view`, `step` and `range` query parameters, drops hashes, cleans nested URLs, blanks exception messages that are not codes, and removes `brand_key`, `domain`, `scan`, `next`, `redirect` and `code` parameters. | unit `src/lib/telemetry/sanitize.test.ts` |
| F26-AC-07 | `effectiveAnalyticsChoice` returns the account decision when signed in and decided, else the cookie, else `false`; Global Privacy Control with no explicit decision → `false` and the banner is not offered; the cookie is `perceev_privacy=a1` / `a0`, 180 days, `SameSite=Lax`, `Secure` on https. | unit `src/shared/privacy-choices.test.ts` |
| F26-AC-08 | `GET/PUT /api/customer/privacy` read and record the signed-in user's decision (`analytics`, `decided_at`, `source`, `policy_version`); undecided reads `analytics: null`; unknown fields → 400; no session → 401. | route `src/lib/telemetry/privacy.route.test.mjs` |
| F26-AC-09 | In the browser with a key configured: before consent no request goes to `/ingest`; the banner appears once for an undecided user; "Share analytics" records the choice, starts capture, identifies by user id and groups by the workspace telemetry id; no captured payload contains the fixture email, workspace name, website host or brand key; "No thanks" sends nothing and hides the banner; Settings → Privacy toggles the same choice. | browser `check-f26-browser.mjs` B1–B6 |
| F26-AC-10 | `src/instrumentation.ts` reports unhandled route errors through `onRequestError` with the route template; `toErrorResponse` reports 5xx unknown errors; the F01 job runner reports `job_failed` errors with the job kind; the portal error boundary reports client errors; none of them sends a message or request data. | unit `src/lib/telemetry/reporters.test.ts`; route test `src/lib/http/errors.test.ts` (extended) |
| F26-AC-11 | `scripts/telemetry/upload-sourcemaps.mjs` does nothing when `POSTHOG_SOURCEMAPS` is not `true`; when enabled it runs `posthog-cli sourcemap inject` then `upload` on `.next/static/chunks` with the commit SHA as release, deletes every `.map` file under `.next/static` afterwards (also when upload fails), and exits 0 on upload failure with one warning line. | unit `scripts/telemetry/upload-sourcemaps.test.mjs` |
| F26-AC-12 | `runTool` emits `tool:call { tool, source, success, error_code, duration_ms, output_invalid, truncated }` for every source except `test`, reports handler exceptions with reportable codes and output-schema mismatches (issue paths only, no values) through `captureServerError`, and its existing behaviour and tests are unchanged. | unit `src/lib/tools/run.test.ts` (extended) |
| F26-AC-13 | Every sink listed in §6.2.7 that exists in the tree is wired: calling it with a registry event reaches the F26 capture function (client sinks to `trackEvent`, server sinks to `captureServerEvent` with the request's telemetry context). | unit `src/lib/telemetry/wiring.test.ts` |
| F26-AC-14 | Migration 165 gives every existing and new workspace a unique `telemetry_id`; `user_privacy_choices` is readable only by its owner. | DB `scripts/qa/check-f26-db.mjs` groups `telemetry-id`, `rls` |
| F26-AC-15 | The privacy policy has a "Product analytics and error reports" section matching §6.7. | unit `src/app/privacy/privacyCopy.test.mjs` (extended) |
| F26-AC-16 | Owner-run live checks T1–T5 (§10) pass on a preview deployment. | live, recorded in the phase-5 PR |

## 5. Scope

**In scope**
- Event registry with typed properties for F01–F27 and existing Perceev surfaces; validation guard.
- Server capture (`posthog-node`), browser capture (`posthog-js`), sanitiser, consent model (cookie + account), banner, Settings → Privacy, `AnalyticsConsentSwitch` for F27.
- Error capture: `onRequestError`, `toErrorResponse` and job-runner reporters, portal error boundary, client exceptions after consent, stale-build suppression.
- Source-map upload for browser chunks on Vercel builds.
- Tool-registry instrumentation (`tool:call`, error and output-mismatch reports).
- Wiring every feature's no-op sink; emitting the events of F03, F07–F12 and existing pages that have no sink.
- `/ingest` rewrite, migration 165, privacy policy section, env names, owner runbook.

**Out of scope**
- Session replay, heatmaps, autocapture, surveys, PostHog feature flags or experiments (flags stay in F01).
- Analytics on the public website, free scan or public share **browser** pages (`/`, `/scan`, `/dashboard/*`, `/s/*`). Exception: server-side anonymous `report:public_view` (no browser SDK on `/s/*`) is in scope for F23's public-view counter only.
- Advertising or referral tracking (OpenSEO's Dub and Meta choices): Perceev has none.
- Region-based defaults and `/api/privacy-region` (decision above).
- Server-side source maps (Next.js server bundles; §11 risk 4).
- Operator `/ops` pages (never instrumented).
- `ui:theme_changed` (F04) and `ui:search_tab_opened` (F05): both specs left them optional; not registered.

## 6. Design

### 6.1 Data model

#### `supabase/migrations/165_f26_privacy_and_telemetry_ids.sql`

```sql
-- F26: opaque workspace ids for analytics groups, and each user's analytics consent.

-- Older workspaces use their domain as brand_key; analytics groups must never carry it.
ALTER TABLE public.customer_brands
  ADD COLUMN IF NOT EXISTS telemetry_id uuid NOT NULL DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX IF NOT EXISTS customer_brands_telemetry_id_idx ON public.customer_brands (telemetry_id);
COMMENT ON COLUMN public.customer_brands.telemetry_id IS
  'Opaque id used as the PostHog "workspace" group key. Never derive it from brand_key; never send brand_key.';

CREATE TABLE IF NOT EXISTS public.user_privacy_choices (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  analytics boolean NOT NULL,
  decided_at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL CHECK (source IN ('onboarding','settings','banner')),
  policy_version text NOT NULL CHECK (policy_version ~ '^\d{4}-\d{2}-\d{2}$'),
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.user_privacy_choices IS
  'Record of consent for product analytics. No row = not decided = analytics off.';

ALTER TABLE public.user_privacy_choices ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.user_privacy_choices FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.user_privacy_choices TO authenticated;
GRANT ALL ON public.user_privacy_choices TO service_role;
DROP POLICY IF EXISTS user_privacy_choices_read_own ON public.user_privacy_choices;
CREATE POLICY user_privacy_choices_read_own ON public.user_privacy_choices
  FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));
DROP TRIGGER IF EXISTS user_privacy_choices_touch ON public.user_privacy_choices;
CREATE TRIGGER user_privacy_choices_touch BEFORE UPDATE ON public.user_privacy_choices
  FOR EACH ROW EXECUTE FUNCTION public.f01_touch_updated_at();
```

`customer_brands` is already readable by members (`supabase/migrations/023_customer_auth_and_tenant_rls.sql:108-113`), so `telemetry_id` needs no new grant. `scripts/setup-supabase.mjs` `EXPECTED_OBJECTS`: `"165_f26_privacy_and_telemetry_ids.sql": [{kind:"column",name:"customer_brands.telemetry_id"},{kind:"table",name:"user_privacy_choices"}]`. `tests/customer-uat.sql`: one `user_privacy_choices` row per test user; each user reads only their own.

### 6.2 Server modules

All under `src/lib/telemetry/` unless stated; relative imports with `.ts` extensions (conventions §5.4).

#### 6.2.1 `props.ts` — property types

```ts
export const count = z.int().min(0).max(10_000_000);
export const usd = z.number().min(0).max(100_000);
export const flag = z.boolean();
export const durationMs = z.int().min(0).max(3_600_000);
export const code = z.string().regex(/^[A-Za-z0-9_.:\/-]{1,64}$/)
  .refine((v) => !/@/.test(v) && !/^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/i.test(v), "looks like an email or hostname");
export const codes = z.array(code).max(20);
export const oneOf = <T extends readonly [string, ...string[]]>(v: T) => z.enum(v);
export const FORBIDDEN_PROP_KEYS: readonly string[];   // the fifteen names of F26-AC-01
```

#### 6.2.2 `events.ts` — the registry

```ts
export type EventSpec = { side: "client" | "server"; owner: `F${number}` | "existing";
  consent: "required" | "anonymous"; props: z.ZodObject };  // always z.strictObject
export const EVENTS = { /* table below */ } as const satisfies Record<string, EventSpec>;
export type EventName = keyof typeof EVENTS;
export type ClientEventName = { [K in EventName]: (typeof EVENTS)[K]["side"] extends "client" ? K : never }[EventName];
export type ServerEventName = Exclude<EventName, ClientEventName>;
export type EventProps<N extends EventName> = z.infer<(typeof EVENTS)[N]["props"]>;
export function validateEventProps(name: string, props: unknown): { ok: true; name: EventName; props: Record<string, unknown> } | { ok: false; reason: "unknown_event" | "invalid_props" };
export const POLICY_VERSION = "2026-10-22";   // placeholder until P2; P2 sets to the privacy-policy merge date and privacyCopy.test asserts equality
```

Legend for the table: `n` count, `usd`, `b` flag, `ms` durationMs, `c` code, `c[]` codes, `E(a|b)` enum. Side `C` client, `S` server. Consent is `required` unless marked **anon**. `{}` = no properties.

| Owner | Event | Side | Properties |
|---|---|---|---|
| F03 | `usage:page_viewed` | C | `{ range: E(7d\|30d\|90d) }` |
| F03 | `usage:range_changed` | C | `{ from: E(7d\|30d\|90d), to: E(7d\|30d\|90d) }` |
| F03 | `scan_report:cost_expanded` | C | `{}` |
| F06 | `data:export` | C | `{ source_feature: c, format: E(csv\|excel\|json\|copy-json\|sheets), result_count: n, scope: E(all\|selection) }` |
| F06 | `data:export_sheets` | C | `{ source_feature: c, result_count: n }` |
| F06 | `data:export_server` | C | `{ kind: c, format: c, row_count: n }` |
| F07 | `project_context:viewed` | C | `{}` |
| F07 | `project_context:updated` | S | `{ ops: n, kinds: c[] }` |
| F08 | `questions:setup_started` | S | `{}` |
| F08 | `questions:setup_saved` | S | `{ questions: n, competitors: n, approved: b }` |
| F08 | `questions:approved` | S | `{ version: n, count: n }` |
| F08 | `questions:added` | S | `{ origin: E(ai_setup\|ai_generate\|prompt_research\|promptgen\|manual\|import), count: n }` |
| F08 | `questions:generated` | S | `{ count: n }` |
| F08 | `questions:researched` | S | `{ results: n, cached: b }` |
| F09 | `price:quote_shown` | C | `{ action: c, total_usd: usd, blocked_code: c.nullable() }` |
| F09 | `price:approved` | C | `{ action: c, approved_usd: usd, source: E(dialog\|implicit\|schedule) }` |
| F09 | `price:changed` | C | `{ action: c, old_usd: usd, new_usd: usd }` |
| F10 | `schedule:enabled` | S | `{ interval: E(daily\|weekly\|monthly), approved_usd: usd }` |
| F10 | `schedule:paused` | S | `{}` |
| F10 | `schedule:changed` | S | `{ interval: E(daily\|weekly\|monthly) }` |
| F10 | `schedule:skipped` | S | `{ reason: c }` |
| F11 | `prompt_explorer:run_started` | S | `{ models: n, reused: b, web_search: b, has_country: b }` |
| F11 | `prompt_explorer:run_finished` | S | `{ status: c, answered: n, failed: n, reused: b }` |
| F11 | `prompt_explorer:question_tracked` | C | `{}` |
| F12 | `question_history:viewed` | C | `{ executions: n, range: c }` |
| F12 | `question_history:answer_opened` | C | `{ engine: E(chatgpt\|gemini\|perplexity\|aio), source: c }` |
| F13 | `keyword_research:search_complete` | C | `{ location_code: n, search_mode: c, clickstream: b, local: b, result_count: n, cached: b }` |
| F13 | `keyword_research:serp_open` | C | `{}` |
| F13, F14 | `keyword:save` | C | `{ source_feature: E(keyword_research\|domain_overview\|rank_tracking), keyword_count: n }` |
| F13 | `saved_keywords:bulk_remove` | C | `{ count: n }` |
| F13 | `saved_keywords:bulk_tag` | C | `{ count: n }` |
| F13 | `saved_keywords:refresh_start` | C | `{ stale: n }` |
| F13 | `keywords:cluster_apply` | C | `{ topics: n, keywords: n }` |
| F13 | `keywords:track_question` | C | `{ created: n }` |
| F14 | `domain_overview:lookup` | C | `{ scope: c, cached: b, has_data: b }` |
| F14 | `domain_overview:tab` | C | `{ tab: c }` |
| F14 | `domain_overview:competitors` | C | `{ keyword_count: n, result_count: n }` |
| F14 | `domain_overview:add_competitor` | C | `{}` |
| F15 | `rank_tracking:config_create` | C | `{ devices: c, schedule: c, local: b }` |
| F15 | `rank_tracking:keywords_add` | C | `{ count: n, source: c }` |
| F15 | `rank_tracking:check_trigger` | C | `{ keywords: n, subset: b }` |
| F15 | `rank_tracking:check_complete` | S | `{ status: c, trigger: c, keywords_checked: n }` |
| F15 | `rank_tracking:pin` | C | `{ pinned: b }` |
| F15 | `rank_tracking:metrics_refresh` | C | `{ bought: n, from_cache: n }` |
| F15 | `rank_tracking:suggestions_open` | C | `{ cached: b, count: n }` |
| F15 | `rank_tracking:export_csv` | C | `{ scope: c }` |
| F15 | `rank_tracking:track_question` | C | `{ created: n }` |
| F16 | `backlinks:lookup` | C | `{ scope: c, cached: b }` |
| F16 | `backlinks:tab` | C | `{ tab: c }` |
| F16 | `backlinks:expand_domain` | C | `{}` |
| F16 | `backlinks:ahrefs_dr` | C | `{ count: n }` |
| F16 | `backlinks:track_history` | C | `{ interval: c }` |
| F17 | `local:business_saved` | C | `{ role: c }` |
| F17 | `local:profile_lookup` | C | `{ found: b }` |
| F17 | `local:listings_search` | C | `{ count: n, cached: b }` |
| F17 | `local:reviews_collect` | C | `{ depth: n, other_sources: b, reused: b }` |
| F17 | `local:updates_collect` | C | `{ reused: b }` |
| F17 | `local:questions_collect` | C | `{ reused: b }` |
| F17 | `local:serp_search` | C | `{ type: c, cached: b, own_ranked: b }` |
| F17 | `local:grid_run` | C | `{ size: n, reused: b, points_found: n }` |
| F18 | `site_audit:launch_open` | C | `{}` |
| F18 | `site_audit:large_confirm` | C | `{ pages: n }` |
| F18 | `site_audit:cancel` | C | `{}` |
| F18 | `site_audit:delete` | C | `{}` |
| F18 | `site_audit:lighthouse_open` | C | `{ strategy: c }` |
| F18 | `site_audit:compare_open` | C | `{}` |
| F18 | `site_audit:view_change` | C | `{ view: c }` |
| F18 | `site_audit:start` | S | `{ max_pages: n, lighthouse: b, render_js: b, trigger: E(manual\|baseline\|tool) }` |
| F18 | `site_audit:complete` | S | `{ status: c, pages_crawled: n, pages_total: n, crawl_completed: b, pages_blocked: n, pages_rate_limited: n, pages_abandoned: n, lighthouse: b, render_js: b, error_code: c.nullable(), failed_phase: c.nullable() }` |
| F19 | `indexnow:setup` | C | `{ created: b }` |
| F19 | `indexnow:check` | C | `{ hosts: n, found: n, cached: b }` |
| F19 | `indexnow:submit` | C | `{ source: c, url_count: n, hosts: n, submitted_hosts: n, skipped: n }` |
| F19 | `indexnow:offer_shown` | C | `{ state: c }` |
| F19 | `indexnow:offer_dismissed` | C | `{}` |
| F20 | `ga4:link_start` | C | `{ return_path: E(/portal/settings/integrations\|/portal/analytics\|/onboarding) }` |
| F20 | `ga4:property_select` | C | `{}` |
| F20 | `ga4:disconnect` | C | `{}` |
| F20 | `ga4:account_remove` | C | `{ workspaces: n }` |
| F20 | `ga4:tab_view` | C | `{ tab: c }` |
| F20 | `ga4:range_change` | C | `{ range: c }` |
| F20 | `ga4:link_complete` | S | `{ outcome: c }` |
| F20 | `ga4:report_view` | S | `{ kind: c, cached: b, limited: b }` |
| F20 | `ga4:opportunities_view` | S | `{ rows: n, matched: n, engagement_fallback: b, cached: b }` |
| F22 | `assistant:session_create` | C | `{}` |
| F22 | `assistant:session_archive` | C | `{}` |
| F22 | `assistant:turn` | S | `{ status: c, stop_reason: c.nullable(), steps: n, tool_calls: n, cost_usd: usd.nullable(), cost_known: b, model: c, compacted: b, error_code: c.nullable() }` |
| F22 | `assistant:tool_call` | S | `{ tool: c, effect: c, success: b, error_code: c.nullable(), duration_ms: ms, awaiting_approval: b }` |
| F22 | `assistant:approval` | S | `{ tool: c, kind: c, decision: c, quoted_usd: usd, approved_max_usd: usd.nullable(), outcome: c, error_code: c.nullable() }` |
| F22 | `assistant:skill_activate` | S | `{ skill: c, version: c }` |
| F22 | `assistant:message_send` | C | `{ source: c, chars: n }` |
| F22 | `assistant:rewind` | C | `{ kind: E(undo\|edit\|retry) }` |
| F22 | `assistant:stop` | C | `{}` |
| F22 | `assistant:client_error` | C | `{ kind: E(turn\|network\|resume) }` |
| F22 (registry) | `tool:call` | S | `{ tool: c, source: E(assistant\|approval\|mcp), success: b, error_code: c.nullable(), duration_ms: ms, output_invalid: b, truncated: b }` |
| F23 | `report:saved` | S | `{ skill: c, used_template: b, size_bytes: n, is_update: b, sanitized_changed: b, source: E(assistant) }` |
| F23 | `report:opened` | C | `{ skill: c }` |
| F23 | `report:exported_pdf` | C | `{}` |
| F23 | `report:shared` | S | `{ skill: c }` |
| F23 | `report:unshared` | S | `{ skill: c }` |
| F23 | `report:deleted` | C | `{}` |
| F23 | `report:public_view` | S **anon** | `{ from_browser: b }` |
| F23 | `report_template:saved` | C | `{ is_update: b }` |
| F23 | `report_template:deleted` | C | `{}` |
| F23 | `report:generate_start` | S | `{}` |
| F24 | `auth:sign_in_submit` | C | `{ method: E(email) }` |
| F24 | `auth:sign_in_success` | C | `{ method: E(email) }` |
| F24 | `auth:sign_in_block_unverified` | C | `{}` |
| F24 | `auth:sign_up_submit` | C | `{}` |
| F24 | `auth:sign_up_success` | C | `{ needs_verification: b }` |
| F24 | `auth:google_start` | C | `{ intent: E(sign_in\|sign_up) }` |
| F24 | `auth:signup_blocked` | C | `{ reason: E(disposable_email\|captcha) }` |
| F24 | `auth:verification_resend` | C | `{}` |
| F24 | `auth:verification_issue` | C | `{ issue_type: E(link_expired\|unknown) }` |
| F24 | `auth:password_reset_requested` | C | `{}` |
| F24 | `auth:sign_up_completed` | S **anon** | `{ method: E(email\|google), from_free_scan: b, from_domain: b }` |
| F25 | `email:sent` | S | `{ template: c, kind: E(transactional\|event\|contact), duplicate: b }` |
| F25 | `email:skipped` | S | `{ template: c, reason: c }` |
| F25 | `email:failed` | S | `{ template: c, error_code: c }` |
| F25 | `email:unsubscribed` | S | `{ category: E(scan_results\|schedule_alerts\|spend_alerts\|product_updates) }` |
| F25 | `email:preferences_changed` | S | `{ product_updates: b, scan_results: b, schedule_alerts: b, spend_alerts: b, source: E(onboarding\|settings) }` |
| F26 | `privacy:analytics_enabled` | C | `{ source: E(onboarding\|settings\|banner) }` |
| F27 | `onboarding:step_viewed` | C | `{ step: n, step_name: E(website\|search_console\|analytics\|preferences\|first_scan) }` |
| F27 | `onboarding:step_skipped` | C | `{ step: n, step_name: E(website\|search_console\|analytics\|preferences\|first_scan) }` |
| F27 | `onboarding:website_saved` | C | `{ created_workspace: b, country: c, research: E(started\|skipped\|unavailable) }` |
| F27 | `onboarding:website_save_failed` | C | `{ error_code: c }` |
| F27 | `onboarding:gsc_connect_clicked` | C | `{}` |
| F27 | `onboarding:gsc_property_selected` | C | `{}` |
| F27 | `onboarding:ga4_connect_clicked` | C | `{}` |
| F27 | `onboarding:preferences_saved` | C | `{ product_updates: b }` |
| F27 | `onboarding:first_scan_started` | C | `{}` |
| F27 | `onboarding:audit_started` | S | `{ started: b, reason: c.nullable() }` |
| F27 | `onboarding:free_scan_imported` | S | `{ questions: n }` |
| F27 | `onboarding:completed` | S **anon** | `{ via: E(wizard\|first_scan), steps_done: n, steps_skipped: n }` |
| F27 | `dashboard:setup_step_click` | C | `{ step: c }` |
| F27 | `dashboard:setup_step_defer` | C | `{ step: c, dismissed: b }` |
| existing | `scan:start_clicked` | C | `{}` |
| existing | `scan:started` | S | `{ approved_usd: usd.nullable() }` |
| existing | `content:draft_requested` | C | `{}` |
| existing | `content:review_submitted` | C | `{ verdict: c }` |
| existing | `team:invite_sent` | C | `{ role: E(owner\|member), user_exists: b }` |
| existing | `gsc:connect_start` | C | `{}` |
| existing | `gsc:property_select` | C | `{}` |
| existing | `gsc:disconnect` | C | `{}` |

F01, F02, F04, F05 and F21 register no events (their specs say so). When a later spec adds an event, it appends a row here and to `EVENTS` in the same PR; the registry test's expected count changes with it.

#### 6.2.3 `context.ts` — request identity for server events

```ts
export type TelemetryContext = { userId: string | null; brandKey: string | null };
export function enterTelemetryContext(ctx: TelemetryContext): void;          // AsyncLocalStorage.enterWith — fallback only
export function runWithTelemetryContext<T>(ctx: TelemetryContext, fn: () => Promise<T>): Promise<T>; // preferred
export function currentTelemetryContext(): TelemetryContext;                // { null, null } outside a context
```

**Identity rule (privacy):** `AsyncLocalStorage.enterWith` mutates the current async scope; concurrent work that shares a scope can attach user A's id to user B's event. Therefore:

1. **Preferred:** pass explicit `userId` / `brandKey` into every `captureServerEvent` / `captureServerError` call when the handler already has them (route `requireWorkspace` / `requireUser` return values, job payload).
2. **Jobs and long handlers:** wrap with `runWithTelemetryContext({ userId, brandKey }, …)` so the scope is isolated.
3. **`enterTelemetryContext`:** fallback only; do not call it from `requireUser` or `requireWorkspace` as the sole identity path.
4. **Test:** `context.test.ts` interleaves two concurrent `runWithTelemetryContext` calls with different identities and asserts no crossover; nested run restores the outer identity.

Edits: F01 `src/lib/jobs/runner.ts` runs the handler inside `runWithTelemetryContext({ userId: job.created_by, brandKey: job.brand_key }, …)`; F01 `requireWorkspace` and route handlers that emit events pass explicit `userId`/`brandKey` to capture (context is fallback only). `requireUser` does **not** call `enterTelemetryContext`.

#### 6.2.4 `server.ts` — PORT of `openseo:src/server/lib/posthog.ts`

```ts
export function serverTelemetryEnabled(env?: NodeJS.ProcessEnv): boolean;   // key present && TELEMETRY_DISABLED !== "1"
export async function captureServerEvent<N extends ServerEventName>(i: { name: N; props: EventProps<N>;
  userId?: string | null; brandKey?: string | null }, deps?: ServerDeps): Promise<void>;   // never throws; keepAlive
export async function captureServerError(error: unknown, props?: { route?: string; job_kind?: string; tool?: string;
  error_code?: string; issues?: string }, userId?: string | null, deps?: ServerDeps): Promise<void>;
export function withoutMessage(error: unknown, depth?: number): Error;                       // COPY of :26-43
export function isReportableErrorCode(code: string | null | undefined): boolean;
type ServerDeps = { env?: NodeJS.ProcessEnv; admin?: SupabaseClient | null; client?: (key: string, host: string) => PostHogLike;
  isFeatureEnabled?: typeof isFeatureEnabled; keepAlive?: typeof keepAlive; now?: () => number };
```

`captureServerEvent` order: enabled and `isFeatureEnabled("product_analytics", brandKey ?? undefined)` (no brand → the global value) → `validateEventProps` (invalid → `console.warn("[telemetry] invalid event", { name, reason })`, drop) → identity: **prefer explicit** `userId` / `brandKey` on the call; fall back to `currentTelemetryContext()` only when omitted → consent: `hasConsent(userId)` reads `user_privacy_choices.analytics` (cached in process 60 s per user; read error → false) → if consented: `distinctId = userId`, `groups = { workspace: telemetryIdFor(brandKey) }` (lookup `customer_brands.telemetry_id`, cached 10 min; missing → no groups); else if the spec is `anonymous`: `distinctId = "anon:" + crypto.randomUUID()`, `properties.$process_person_profile = false`, no groups; else drop → `client.capture({ distinctId, event: name, properties: { ...props, $lib_custom: "perceev-server" }, groups })` → `await client.shutdown()` (errors logged `[telemetry] capture failed` without details). The client is `new PostHog(POSTHOG_PROJECT_KEY, { host: POSTHOG_HOST, flushAt: 1, flushInterval: 0, disableGeoip: true })`, created per call (OpenSEO `:8-18`).

`captureServerError` order: enabled → `isReportableErrorCode(code)` where `code = props.error_code ?? (error as AppError).code` → `distinctId = consented user ? userId : "server"`, `$process_person_profile: false` when not consented → `client.captureExceptionImmediate(withoutMessage(error), distinctId, { source: "server", ...props })`. Non-reportable codes (PORT of `openseo:src/shared/error-codes.ts:31-51`, our codes): `unauthenticated`, `auth_not_configured`, `workspace_not_found`, `forbidden`, `owner_required`, `feature_unavailable`, `feature_disabled`, `invalid_request`, `invalid_input`, `approval_required`, `price_changed`, `daily_cap`, `workspace_cap`, `over_approved_max`, `job_already_running`, `rate_limited`, `upstream_unavailable`, `not_found`, `cancelled`.

#### 6.2.5 `reporters.ts` — hooks into F01

```ts
export function setServerErrorReporter(fn: ((err: unknown, props: Record<string, string>) => void) | null): void;
export function reportServerError(err: unknown, props: Record<string, string>): void;   // no-op until set; never throws
```

Edits: F01 `src/lib/http/errors.ts` `toErrorResponse` calls `reportServerError(err, { error_code })` when the response status is ≥ 500; F01 `src/lib/jobs/runner.ts` calls `reportServerError(err, { job_kind: kind, error_code: code })` when a job finishes `failed` from a thrown error. `src/lib/telemetry/wireServerSinks.ts` sets the reporter to `captureServerError`.

#### 6.2.6 `src/instrumentation.ts` (new, Next.js)

```ts
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { wireServerSinks } = await import("./lib/telemetry/wireServerSinks.ts");
  wireServerSinks();
}
export async function onRequestError(error: unknown, _request: unknown, context: { routePath: string; routeType: string; routerKind: string }) {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { captureServerError } = await import("./lib/telemetry/server.ts");
  await captureServerError(error, { route: context.routePath.slice(0, 64) });   // route template, e.g. "/api/customer/scan/route"
}
```

The request (path, headers) is never read.

#### 6.2.7 Sink wiring — `src/lib/telemetry/wireServerSinks.ts`, `src/components/app/telemetry/wireClientSinks.ts`

Every sink module exports `set<Name>Tracker(fn)`. Where a spec named only the `track…` function, F26 adds the setter in that same file (a two-line change). F26 wires every sink present in the tree when it lands; a feature merged later adds its own line to the wiring file in its PR.

| Sink file (owner) | Side | Setter | Wired to |
|---|---|---|---|
| `src/lib/export/telemetry.ts` (F06) | client | `setExportTracker` | `trackEvent` |
| `src/components/portal/keywords/telemetry.ts` (F13) | client | `setKeywordEventTracker` | `trackEvent` |
| `src/components/portal/domain/telemetry.ts` (F14) | client | `setDomainEventTracker` | `trackEvent` |
| `src/components/portal/rank-tracking/telemetry.ts` (F15) | client | `setRankEventTracker` | `trackEvent` |
| `src/components/portal/backlinks/telemetry.ts` (F16) | client | `setBacklinksEventTracker` | `trackEvent` |
| `src/components/portal/local/telemetry.ts` (F17) | client | `setLocalEventTracker` | `trackEvent` |
| `src/components/portal/audit/telemetry.ts` (F18) | client | `setAuditEventTracker` | `trackEvent` |
| `src/lib/audit/telemetry.ts` (F18) | server | `setAuditServerTracker` | `captureServerEvent` |
| `src/components/portal/indexnow/telemetry.ts` (F19) | client | `setIndexNowEventTracker` | `trackEvent` |
| `src/components/portal/analytics/telemetry.ts` (F20) | client | `setGa4EventTracker` | `trackEvent` |
| `src/lib/ga4/telemetry.ts` (F20) | server | `setGa4ServerTracker` | `captureServerEvent` |
| `src/lib/assistant/telemetry.ts` (F22) | both | `setAssistantEventTracker` | client file → `trackEvent`; server file → `captureServerEvent` |
| `src/lib/reports/telemetry.ts` (F23) | both | `setReportEventTracker` | as F22 |
| `src/components/auth/telemetry.ts` (F24) | client | `setAuthEventTracker` | `trackEvent` |
| `src/lib/auth/telemetry.ts` (F24) | server | `setAuthServerTracker` | `captureServerEvent` (the callback passes the new user's id) |
| `src/lib/email/telemetry.ts` (F25) | server | `setEmailEventTracker` | `captureServerEvent` |
| `src/components/portal/onboarding/telemetry.ts`, `src/lib/onboarding/telemetry.ts` (F27) | client / server | `setOnboardingEventTracker`, `setOnboardingServerTracker` | `trackEvent` / `captureServerEvent` |

Server trackers receive `(name, props)` and pass identity from `currentTelemetryContext()`; a tracker may pass an explicit `userId`/`brandKey` third argument (F24 callback, F25 deliver job).

Features whose specs named events but no sink (F03, F07, F08, F09, F10, F11, F12) get direct calls in phase 4 (§8 P4.T3), at these places:

| Events | File | Where |
|---|---|---|
| `usage:*`, `scan_report:cost_expanded` | `src/components/portal/usage/UsagePage.tsx`; the scan report cost section of `src/app/portal/scans/[scanId]/page.jsx` | mount; range change; expand toggle |
| `project_context:viewed` / `updated` | `src/components/portal/context/ProjectContextPage.tsx`; `src/app/api/customer/context/route.ts` (PATCH success) | mount; after apply |
| `questions:*` | `src/app/api/customer/questions/{setup,setup/save,approve,generate,research}/route.ts`, `src/app/api/customer/questions/route.ts` (PATCH) | after success |
| `price:*` | `src/components/app/cost/CostReviewDialog.tsx` | quote ready (once per open), confirm, price-changed state |
| `schedule:enabled/paused/changed` | `src/app/api/customer/schedule/route.ts` | after save |
| `schedule:skipped` | `src/lib/schedules/aiVisibilitySchedules.ts` `block()` adapter | after recording the skip |
| `prompt_explorer:run_started/finished` | `src/app/api/customer/explore/route.ts`; F11's run finaliser in `src/lib/explore/` | after enqueue; at finish |
| `prompt_explorer:question_tracked` | `src/components/portal/explore/ExploreResults.tsx` | after track success |
| `question_history:*` | `src/components/portal/questions/history/QuestionHistoryPage.tsx` | data loaded; answer opened |

Existing pages (owner "existing"): `scan:start_clicked` in `src/components/portal/useScanTracker.js` `start()`; `scan:started` in `src/app/api/customer/scan/route.js` after a 201; `content:draft_requested` in `src/components/portal/content/ComposerCard.jsx` after a successful submit; `content:review_submitted` in `src/components/portal/content/DraftEditor.jsx` after a review is saved; `team:invite_sent` in `src/components/portal/team/TeamPage.jsx` after a 201; `gsc:connect_start`, `gsc:disconnect` in `src/components/portal/gsc/GscPage.jsx`; `gsc:property_select` in `src/components/portal/gsc/PropertyPicker.jsx` `onConnected`. These are telemetry-only additions; no behaviour changes (Mixed rows "Teams" and "Search Console" untouched).

#### 6.2.8 Tool-registry instrumentation — edit `src/lib/tools/run.ts` (F22), PORT of `openseo:src/server/mcp/instrumentation.ts:36-204`

At the end of `runTool` (success or error envelope), when `ctx.source !== "test"`: `captureServerEvent({ name: "tool:call", props: { tool: reg.def.name, source: ctx.source, success: outcome.ok, error_code: outcome.ok ? null : outcome.error.code, duration_ms, output_invalid, truncated: outcome.ok && outcome.truncated !== null }, userId: ctx.userId, brandKey: ctx.brand.brandKey })`. On a handler exception whose code `isReportableErrorCode`: `captureServerError(err, { tool: reg.def.name, error_code }, ctx.userId)`. On output-schema failure (step 3 of `runTool`): `captureServerError(new Error("tool output invalid"), { tool, error_code: "tool_output_invalid", issues: zodIssuePaths(err).slice(0, 300) }, ctx.userId)` where `zodIssuePaths` joins issue paths with `;` and never includes values or messages. All calls are fire-and-forget (`keepAlive`) and cannot change the returned outcome.

#### 6.2.9 Privacy routes

`src/app/api/customer/privacy/route.ts` (§6.5) on `src/lib/telemetry/privacy.ts`: `readPrivacyChoice(admin, userId)`, `savePrivacyChoice(admin, userId, analytics, source)` (upsert; clears the consent cache for that user).

#### 6.2.10 Flags and env

`src/lib/features/names.ts`: `product_analytics: { spend: [] as const }`; `src/lib/features/clientFeatures.ts`: append `"product_analytics"`. Env names: `NEXT_PUBLIC_POSTHOG_KEY` (project key; public by design), `NEXT_PUBLIC_POSTHOG_UI_HOST` (default `https://eu.posthog.com`), `POSTHOG_PROJECT_KEY` (same value, server), `POSTHOG_HOST` (default `https://eu.i.posthog.com`), `POSTHOG_INGEST_ORIGIN` (default `https://eu.i.posthog.com`; used by the rewrite), `POSTHOG_ASSETS_ORIGIN` (default `https://eu-assets.i.posthog.com`), `TELEMETRY_DISABLED`, `NEXT_PUBLIC_TELEMETRY_DISABLED`, `POSTHOG_SOURCEMAPS`, `POSTHOG_CLI_TOKEN`, `POSTHOG_CLI_ENV_ID`, `POSTHOG_CLI_HOST`.

### 6.3 Jobs

None. Capture is fire-and-forget through `keepAlive`. The F01 job runner gains the telemetry context and error reporter (§6.2.3, §6.2.5).

### 6.4 Provider calls and cost

| Call | Endpoint | Notes |
|---|---|---|
| Browser events | `POST /ingest/i/v0/e/` (and `/ingest/flags` is never called: no feature flags) → rewritten to `POSTHOG_INGEST_ORIGIN` | batched by `posthog-js` |
| Browser library | `GET /ingest/static/array.js` and lazy chunks → `POSTHOG_ASSETS_ORIGIN` | only after consent |
| Server events | `posthog-node` `capture` + `shutdown` → `POSTHOG_HOST` | **one client + TLS per event** (OpenSEO shape; fine on serverless; do not treat the latency as a bug) |
| Server exceptions | `captureExceptionImmediate` → `POSTHOG_HOST` | one request per error |
| Source maps | `posthog-cli sourcemap inject/upload` at build | build time only |

Cost: PostHog's free tier (one million events and 100,000 exceptions per month at the time of writing); no per-call metering (§6.8). Fixtures: `tests/fixtures/f26/posthog-capture-batch.json` (a recorded-shape batch with fictional values), `tests/fixtures/f26/error-with-content.json` (an error whose message quotes "running shoes" and "acme.test").

`next.config.mjs` additions:

```js
async rewrites() {
  const ingest = process.env.POSTHOG_INGEST_ORIGIN || "https://eu.i.posthog.com";
  const assets = process.env.POSTHOG_ASSETS_ORIGIN || "https://eu-assets.i.posthog.com";
  return [
    { source: "/ingest/static/:path*", destination: `${assets}/static/:path*` },
    { source: "/ingest/:path*", destination: `${ingest}/:path*` },
  ];
},
skipTrailingSlashRedirect: true, // required for PostHog ingest trailing-slash paths; global — see §11 risk
productionBrowserSourceMaps: process.env.POSTHOG_SOURCEMAPS === "true",
```

`skipTrailingSlashRedirect: true` is app-wide (including the marketing site). Phase 2 must keep or add a public-site test that a trailing-slash marketing URL still resolves as before this flag.

### 6.5 API routes

**`GET /api/customer/privacy`** (`src/app/api/customer/privacy/route.ts`; auth `requireUser()`; `Cache-Control: no-store`; no query fields) → 200:

```json
{ "analytics": null, "decidedAt": null, "source": null, "policyVersion": "2026-10-22", "telemetryAvailable": true }
```

`analytics` is `true`, `false` or `null` (undecided). `telemetryAvailable` = `serverTelemetryEnabled() && isFeatureEnabled("product_analytics")`.

**`PUT /api/customer/privacy`** body `z.strictObject({ analytics: z.boolean(), source: z.enum(["onboarding","settings","banner"]) })` → 200 `{ "analytics": true, "decidedAt": "2026-10-22T10:00:00.000Z", "source": "banner", "policyVersion": "2026-10-22", "telemetryAvailable": true }`. Idempotent (upsert). Errors: 400 `invalid_request`; 401 `unauthenticated`; 503 `privacy_unavailable` "Your privacy settings couldn't be saved. Please retry." Contracts in `src/lib/telemetry/privacy.contract.ts`.

### 6.6 UI

**Client modules**

- `src/lib/telemetry/client.ts` — PORT of `openseo:src/client/lib/posthog.ts`: `trackEvent<N extends ClientEventName>(name, props)` (validates, buffers ≤ 50 before the choice is known), `startAnalyticsCapture()`, `stopAnalyticsCapture()`, `setTelemetryIdentity({ userId, workspaceTelemetryId })`, `resetTelemetry()`, `captureClientError(error, props)`, `stopClientErrorCapture()`. Init options: `api_host: "/ingest"`, `ui_host: NEXT_PUBLIC_POSTHOG_UI_HOST`, `defaults: "2026-01-30"`, `autocapture: false`, `capture_pageview: "history_change"`, `capture_pageleave: false`, `capture_exceptions: true`, `disable_session_recording: true`, `disable_surveys: true`, `person_profiles: "identified_only"`, `opt_out_capturing_by_default: true`, `opt_out_persistence_by_default: true`, **`respect_dnt: false`** (our consent gate is the authority; DNT must not silently override an explicit Settings/onboarding opt-in — GPC is handled separately in `effectiveAnalyticsChoice`), `mask_all_text: true`, `mask_all_element_attributes: true`, `mask_personal_data_properties: true`, `before_send` = drop ignorable exceptions (OpenSEO list) then `sanitizeEvent`. Disabled entirely when `NEXT_PUBLIC_POSTHOG_KEY` is unset or `NEXT_PUBLIC_TELEMETRY_DISABLED === "1"`. **`startAnalyticsCapture()` must call `posthog.opt_in_capturing()` once** after init (and after identity is set when known), then flush the pre-consent buffer; without `opt_in_capturing`, `opt_out_capturing_by_default` leaves consented users sending zero events and persistence memory-only. **`stopAnalyticsCapture()` calls `opt_out_capturing()`.**
- `src/lib/telemetry/sanitize.ts` — PORT of `posthog-sanitize.ts` with allowed parameters `utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, `utm_term`, `tab`, `view`, `step`, `range`; `isErrorCode` = our `code` pattern without dots or slashes.
- `src/shared/privacy-choices.ts` — PORT (analytics only): `PRIVACY_COOKIE = "perceev_privacy"`, `readPrivacyCookie(header)` → `boolean | null` (`a1`/`a0`), `writePrivacyCookie(analytics)`, `effectiveAnalyticsChoice({ account: boolean | null; cookie: boolean | null; gpc: boolean })`, `hasGlobalPrivacyControl()`, `PRIVACY_CHOICES_CHANGED_EVENT = "perceev:privacy-choices-changed"`. The cookie has no `Domain` attribute (app only).
- `src/components/app/telemetry/TelemetryBootstrap.tsx` — PORT of `PrivacyBootstrap` (`PrivacyChoices.tsx:101-143`): mounted once in F04's `src/components/app/providers/AppProviders.tsx`; returns `null`; **only runs on paths in `APP_SURFACES`** (never public marketing, free scan, or `/s/*`; also excludes `/ops`); reads the cookie (subscribed to the change event and window focus), fetches `GET /api/customer/privacy` when a Supabase session exists, computes `effectiveAnalyticsChoice`, then `startAnalyticsCapture()` or `stopAnalyticsCapture()`; writes the cookie to match the account decision; calls `wireClientSinks()` once.
- `src/components/app/telemetry/useAnalyticsConsent.ts` — `{ choice: boolean | null; available: boolean; save(analytics, source): Promise<void> }` (PUT, then cookie, then start/stop, then `privacy:analytics_enabled` when turned on).
- `AnalyticsConsentSwitch({ source, value, onChange, disabled })` (`src/components/app/telemetry/AnalyticsConsentSwitch.tsx`): label "Usage analytics", description "Share which pages and features you use to help improve Perceev. We never record your questions, AI answers, website data or screen.", `Switch aria-label="Share usage analytics"`, link "Privacy Policy" (`/privacy`). Controlled; F27 uses it with `source="onboarding"`.

**Identity wiring.** `src/components/portal/PortalShell.jsx`: the memberships select adds `telemetry_id` to `customer_brands!inner(…)`; after boot and on every workspace switch call `setTelemetryIdentity({ userId: user.id, workspaceTelemetryId: brand.telemetry_id })`; `signOut()` calls `resetTelemetry()` before `auth.signOut()`. F27's onboarding page calls `setTelemetryIdentity({ userId, workspaceTelemetryId: workspace?.telemetryId ?? null })` (workspace exists after the website step; F27 owns the call).

**Consent banner** (`src/components/app/telemetry/ConsentBanner.tsx`, rendered by `WorkspaceBanners` in `PortalShell.jsx`): shown when `available && choice === null && !gpc && features.product_analytics === true && pathname !== "/onboarding"`.

| State | What shows |
|---|---|
| Shown | F04 `AppBanner variant="info"`: "Help improve Perceev? Share which pages and features you use. We never record your questions, AI answers or website data." Buttons `size="xs"`: "Share analytics" (default), "No thanks" (ghost); link "Privacy Policy" |
| Saving | both buttons disabled, the clicked one `pending` |
| Saved | banner disappears; "Share analytics" toasts "Thanks — usage analytics is on. Change it any time in Settings → Privacy." |
| Error | toast "Your privacy settings couldn't be saved. Please retry."; banner stays |

**Settings → Privacy** (`src/app/portal/settings/privacy/page.tsx` → `src/components/portal/privacy/PrivacySettings.tsx`). Registry: append `{ href: "/portal/settings/privacy", label: "Privacy", flag: "product_analytics" }` to `SETTINGS_TABS`. Query key `privacyKeys.choice()` = `["privacyChoice"]` (user-level).

| State | What shows |
|---|---|
| Loading | `CardShell` with one `Skeleton h-6` |
| Error | `QueryState` "Privacy settings could not be loaded." + "Retry" |
| Ready | `CardShell title="Usage analytics" description="This setting applies to your account in every workspace."` with `AnalyticsConsentSwitch source="settings"`; muted line "You chose this on {formatDate(decidedAt)}." when decided; when `telemetryAvailable` is false: muted line "Usage analytics isn't collected on this deployment." and the switch disabled |
| Global Privacy Control on | muted line "Your browser asks sites not to track you, so analytics stays off unless you turn it on here." |

**Error boundary.** F04's `src/app/portal/error.tsx` calls `captureClientError(error, { boundary: "portal" })` in an effect. F05's stale-chunk reload path (if present) calls `stopClientErrorCapture()` first; otherwise the `ChunkLoadError` name is added to the ignorable list.

**Accessibility:** banner buttons have text labels; the banner is `role="region" aria-label="Analytics choice"`; switches are labelled. **Phone:** banner wraps buttons under the text at 390 px; no horizontal scroll.

### 6.7 Permissions, privacy, observability

- **Never sent:** emails, names, workspace names, brand keys, domains, URLs other than our sanitised paths, query strings outside the allow-list, questions, AI answers, citations, keywords, page content, error messages, request headers or bodies, IP addresses (the proxy hides browser IPs; server capture uses `disableGeoip`; the owner turns on "Discard client IP data").
- **Who decides:** each person, for their account; the decision is stored with date, source and policy version. Turning analytics off stops capture at once and calls `opt_out_capturing` (which clears PostHog's stored identifiers).
- **Logs:** `[telemetry] invalid event { name, reason }`, `[telemetry] capture failed`, `[sourcemaps] skipped|uploaded|upload failed`. No payloads.
- **Privacy policy** (`src/app/privacy/page.jsx`) gains `<h2 id="analytics">Product analytics and error reports</h2>`: "If you turn on usage analytics (it is off until you do), Perceev uses PostHog, hosted in the European Union, to record which pages and features of the customer workspace you use, linked to a random account identifier. We never record your questions, AI answers, website or Search Console data, keywords, or screen recordings, and we do not use analytics for advertising. You can turn it off at any time in Settings → Privacy. We also send error reports (the type of error and where in our code it happened, never its content) so we can fix problems; they are linked to your account only if you turned on usage analytics. We count a few anonymous events, such as an account being created, without linking them to anyone." — plus a cookie sentence: "When usage analytics is on, PostHog stores an identifier in your browser; a small Perceev cookie remembers your choice."

### 6.8 Deviations from conventions

1. **PostHog calls are not metered** (free/flat plan; no spend feature) — like F25's Loops.
2. **User-level table without `brand_key`** (`user_privacy_choices`), RLS read-own.
3. **`src/lib/telemetry/client.ts` is browser code under `src/lib/`** because conventions §12 fixes `src/lib/telemetry/` as the home; it imports nothing server-only and is excluded from `node --test` except through its injected-module test.
4. **Query key `["privacyChoice"]`** is user-level, not `[domain, brandKey]`.

## 7. Code reuse map

| OpenSEO source | Perceev target | Mode | Adaptation notes |
|---|---|---|---|
| `openseo:src/server/lib/posthog.ts:1-116` | `src/lib/telemetry/server.ts` | PORT | Env via `process.env`; consent from `user_privacy_choices` (cached); group `workspace` = `telemetry_id`; anonymous events; `keepAlive` instead of `waitUntil`; `isHostedServerAuthMode` → kill switch + flag. |
| `openseo:src/server/lib/posthog.test.ts:21-36` | `src/lib/telemetry/server.test.ts` | PORT | Same message-stripping case with `node:test`. |
| `openseo:src/client/lib/posthog.ts:1-250` | `src/lib/telemetry/client.ts` | PORT | `/ingest` host; autocapture and replay off; buffer and start/stop semantics kept; registry validation added. |
| `openseo:src/client/lib/posthog.test.ts:22-49` | `src/lib/telemetry/client.test.ts` | PORT | Injected fake `posthog-js`. |
| `openseo:src/client/lib/posthog-sanitize.ts:1-114` (+ test `:7-77`) | `src/lib/telemetry/sanitize.ts` (+ test) | PORT | Allow-list adds `step`, `range`; tests add our parameters. |
| `openseo:src/shared/privacy-choices.ts:24-157` (+ test) | `src/shared/privacy-choices.ts` (+ test) | PORT | Analytics only; no region table; default off; no shared domain cookie. |
| `openseo:src/client/components/PrivacyChoices.tsx:26-143` | `TelemetryBootstrap.tsx`, `useAnalyticsConsent.ts` | PORT | Account choice via our route; no region query; replay logic removed. |
| `openseo:src/routes/api/privacy-region.ts:7-17` | none | PATTERN | Not ported (global default). |
| `openseo:src/client/features/settings/PrivacySettings.tsx:12-62` | `src/components/portal/privacy/PrivacySettings.tsx` | PORT | Analytics switch only (emails are F25's tab). |
| `openseo:src/client/features/onboarding/AnalyticsOnboardingStep.tsx:63-94` | `AnalyticsConsentSwitch.tsx` (used by F27) | PORT | Copy without session replays. |
| `openseo:src/server/mcp/instrumentation.ts:36-204` (+ test) | `src/lib/tools/run.ts` edits, `run.test.ts` cases | PORT | `mcp:tool_call` → `tool:call`; no client id; same output re-validation report with paths only. |
| `openseo:src/shared/error-codes.ts:31-61` | `server.ts` `isReportableErrorCode` | PORT | Our error codes. |
| `openseo:src/server/auth/sign-up-analytics.ts:15-46` | `auth:sign_up_completed` anonymous event (F24 callback) | PATTERN | Counts without identity when not consented. |
| `openseo:package.json:23`, `openseo:vite.config.ts:47`, `:69-71` | `scripts/telemetry/upload-sourcemaps.mjs`, `next.config.mjs` | PORT | Vite → Next `productionBrowserSourceMaps`; maps deleted after upload. |
| `openseo:src/router.tsx:5` (stale reload) | `stopClientErrorCapture` call site | PATTERN | Same rule. |

## 8. Implementation plan

Branches `feat/f26-product-analytics-p1` … `-p5`. `NT` = `node --import ./src/lib/liveWriteGuardAuto.mjs --test`.

### Phase 1 — Registry, consent store, server capture (nothing leaves the server without keys)

**Goal:** typed events and consent exist; server events and errors can be captured once keys are set.

- [x] **P1.T1 Dependencies and registry**
  - [x] **P1.T1.S1** *Files:* `package.json`, `package-lock.json`. *Do:* `npm install posthog-js@^1.395.0 posthog-node@^5.38.6` (OpenSEO's versions, `openseo:package.json:111-112`). *Verify:* `node -e "require.resolve('posthog-node'); require.resolve('posthog-js')"` → exit 0.
  - [x] **P1.T1.S2** *Files:* `src/lib/telemetry/props.ts`, `src/lib/telemetry/events.ts`, `src/lib/telemetry/events.test.ts`. *Do:* §6.2.1–6.2.2 with every row of the table. If `src/lib/telemetry/events.ts` already exists (created as a name list by F11 or F12), replace it with the registry, keeping every name it listed in colon form. Tests: AC-01 (name regex, strict objects, schema walk that fails on any `ZodString` leaf not created by `code`, forbidden keys, total count equals the table's row count), AC-02 cases. *Verify:* `NT src/lib/telemetry/events.test.ts` → pass (F26-AC-01, 02).
- [x] **P1.T2 Migration**
  - [x] **P1.T2.S1** *Files:* `supabase/migrations/165_f26_privacy_and_telemetry_ids.sql`. *Do:* §6.1. *Verify:* `NT src/lib/migrationsRunner.test.mjs src/lib/migrationsLedger.test.mjs` → pass.
  - [x] **P1.T2.S2** *Files:* `scripts/setup-supabase.mjs`, `tests/customer-uat.sql`, `scripts/qa/check-f26-db.mjs`. *Do:* `EXPECTED_OBJECTS` entry; UAT read-own assertions; DB check groups `telemetry-id` (pre-existing rows get distinct non-null ids after the migration; `create_customer_workspace` rows get one; re-applying 165 changes no id) and `rls` (each user reads only their own `user_privacy_choices`). *Verify:* `PGHOST=localhost PGDATABASE=perceev_qa node scripts/qa/check-f26-db.mjs` → `PASS telemetry-id`, `PASS rls` (F26-AC-14).
  - [x] **P1.T2.S3** *Files:* `README.md` (row `165_f26_privacy_and_telemetry_ids` "Opaque workspace ids for analytics groups; per-user analytics consent."), `docs/OPERATOR_LEDGER.md` § C ("apply 165; no backfill needed: the column default fills existing rows"), `docs/PROD_MIGRATIONS.md`. *Verify:* `NT src/lib/docStatus.test.mjs src/lib/migrationsLedger.test.mjs` → pass.
- [x] **P1.T3 Server capture**
  - [x] **P1.T3.S1** *Files:* `src/lib/telemetry/context.ts`, `server.ts`, `server.test.ts`, `privacy.ts`, `src/lib/auth/requireUser.ts` (shared with F25; skip if present). *Do:* §6.2.3–6.2.4. Tests with a fake PostHog client and admin: AC-03 (each "sends nothing" case; consented event's `distinctId` and `groups.workspace` equal the fixture `telemetry_id`, not the brand key; anonymous event has `anon:` id, `$process_person_profile: false`, no groups; context identity used when none passed), AC-04 (port of OpenSEO's message test with `tests/fixtures/f26/error-with-content.json`; non-reportable code skipped; client `shutdown` throwing does not throw). *Verify:* `NT src/lib/telemetry/server.test.ts src/lib/telemetry/context.test.ts` → pass (F26-AC-03, 04; concurrent identity isolation).
  - [x] **P1.T3.S2** *Files:* `src/app/api/customer/privacy/route.ts`, `src/lib/telemetry/privacy.contract.ts`, `src/lib/telemetry/privacy.route.test.mjs`. *Do:* §6.5; route-hook pattern. Cases: undecided → `analytics: null`; PUT true → upsert with `policy_version = POLICY_VERSION`; repeat → same row; unknown field → 400; no session → 401; DB error → 503. *Verify:* `NT src/lib/telemetry/privacy.route.test.mjs src/lib/http/routeContract.test.ts` → pass (F26-AC-08).
  - [x] **P1.T3.S3** *Files:* `src/lib/features/names.ts`, `src/lib/features/clientFeatures.ts`, `.env.example`. *Do:* §6.2.10 (names only). *Verify:* `NT src/lib/features/flags.test.ts` → pass; `grep -c "^NEXT_PUBLIC_POSTHOG_KEY=$" .env.example` → 1.

**Checkpoint:** suite, typecheck, build, `check-f26-db.mjs`. Completes F26-AC-01 to 04, 08, 14.

### Phase 2 — Browser capture, consent UI, identity, proxy, policy

**Goal:** consenting users are measured in the app; everyone else sends nothing.

- [ ] **P2.T1 Client library**
  - [ ] **P2.T1.S1** *Files:* `src/lib/telemetry/sanitize.ts`, `sanitize.test.ts`. *Do:* §6.6; port OpenSEO's three test groups plus `/portal/scans?brand_key=acme.test&tab=answers` → `/portal/scans?tab=answers`, `/onboarding?step=2&domain=acme.com&scan=x` → `/onboarding?step=2`, `/auth/callback?code=abc&next=%2F` → `/auth/callback`. *Verify:* `NT src/lib/telemetry/sanitize.test.ts` → pass (F26-AC-06).
  - [ ] **P2.T1.S2** *Files:* `src/shared/privacy-choices.ts`, `privacy-choices.test.ts`. *Do:* §6.6; AC-07 cases (GPC only — DNT is not treated as GPC; explicit account consent wins over DNT because the client sets `respect_dnt: false`). *Verify:* `NT src/shared/privacy-choices.test.ts` → pass (F26-AC-07).
  - [ ] **P2.T1.S3** *Files:* `src/lib/telemetry/client.ts`, `client.test.ts`. *Do:* §6.6; tests load the module with an injected fake `posthog-js` (dependency parameter `loadPostHog`), assert the init options object (AC-05 keys), buffered-then-sent and buffered-then-dropped (OpenSEO's two cases), invalid props dropped with no capture, `resetTelemetry` calls `reset`, `stopAnalyticsCapture` calls `opt_out_capturing`. *Verify:* `NT src/lib/telemetry/client.test.ts` → pass (F26-AC-05), including **opt_in_capturing called once after consent then a buffered event reaches capture**, and init has `respect_dnt: false`.
- [ ] **P2.T2 Bootstrap, consent UI, identity**
  - [ ] **P2.T2.S1** *Files:* `src/components/app/telemetry/{TelemetryBootstrap,ConsentBanner,AnalyticsConsentSwitch}.tsx`, `useAnalyticsConsent.ts`, `wireClientSinks.ts`, `src/components/app/providers/AppProviders.tsx`. *Do:* §6.6. *Verify:* `npm run typecheck`, `npm run build` → exit 0.
  - [ ] **P2.T2.S2** *Files:* `src/components/portal/PortalShell.jsx`, `src/components/portal/portalRegressions.test.mjs`, `src/components/portal/portalProgress.test.mjs`. *Do:* identity calls and `telemetry_id` select (§6.6); `ConsentBanner` inside `WorkspaceBanners`. Test harness module maps get `@/lib/telemetry/client` → `{ setTelemetryIdentity() {}, resetTelemetry() {} }` and `@/components/app/telemetry/ConsentBanner` → `autoNull` (reason: new imports in a tested module; assertions unchanged). *Verify:* `NT src/components/portal/*.test.mjs` → pass.
  - [ ] **P2.T2.S3** *Files:* `src/app/portal/settings/privacy/page.tsx`, `src/components/portal/privacy/PrivacySettings.tsx`, `src/components/portal/settings/tabs.ts`, `src/lib/query/keys.ts`. *Do:* §6.6. *Verify:* build → exit 0.
- [ ] **P2.T3 Proxy and policy**
  - [ ] **P2.T3.S1** *Files:* `next.config.mjs`. *Do:* §6.4 rewrites and flags. *Verify:* `npm run build` → exit 0; `node -e "import('./next.config.mjs').then(async m=>console.log(JSON.stringify(await m.default.rewrites())))"` → two rules with `/ingest/static/:path*` first.
  - [ ] **P2.T3.S2** *Files:* `src/app/privacy/page.jsx`, `src/app/privacy/privacyCopy.test.mjs`. *Do:* §6.7 section; set `POLICY_VERSION` in `events.ts` to this PR's merge date (YYYY-MM-DD of the policy text); test asserts the first sentence, "it is off until you do", and **the policy page's effective date equals `POLICY_VERSION`**. *Verify:* `NT src/app/privacy/privacyCopy.test.mjs` → pass (F26-AC-15).
- [ ] **P2.T4 Browser checks**
  - [ ] **P2.T4.S1** *Files:* `scripts/qa/check-f26-browser.mjs`. *Do:* F04 harness; app started with `NEXT_PUBLIC_POSTHOG_KEY=phc_qa_placeholder`; route-intercept `**/ingest/**` (record request bodies, fulfil `{ "status": 1 }`), `GET/PUT /api/customer/privacy`, features with `product_analytics: true`. B1 undecided: no `/ingest` request after 3 s on `/portal`, banner visible; B2 click "Share analytics" → PUT `{ analytics: true, source: "banner" }`, `/ingest` requests appear, a decoded batch contains `$identify` with the fixture user id and a `$groupidentify`/`$groups.workspace` equal to the fixture `telemetry_id`; B3 every recorded body (decoded from base64/gzip as sent) contains none of: the fixture email, workspace name, website host, `brand_key` value; no `$pathname` segment contains a `.` (host-like brand path); B4 fresh context, "No thanks" → zero `/ingest` requests over a navigation; banner gone after reload; B5 Settings → Privacy shows the switch on (after B2 state) and toggling off sends PUT false and stops further `/ingest` requests; B6 `/login` with no cookie sends nothing; 390 px banner has no horizontal overflow. *Verify:* `node scripts/qa/check-f26-browser.mjs http://127.0.0.1:3328` → `ok 6 scenarios`, `0 requests outside 127.0.0.1` (F26-AC-09).

**Checkpoint:** suite, typecheck, build, browser check. Completes F26-AC-05, 06, 07, 09, 15.

### Phase 3 — Error reporting and source maps

**Goal:** server and client errors reach PostHog without content; browser stack traces are readable.

- [ ] **P3.T1 Reporters**
  - [ ] **P3.T1.S1** *Files:* `src/lib/telemetry/reporters.ts`, `src/lib/telemetry/wireServerSinks.ts`, `src/instrumentation.ts`, `src/lib/http/errors.ts`, `src/lib/http/errors.test.ts`, `src/lib/jobs/runner.ts`, `src/lib/workspace/requireWorkspace.ts`, `src/lib/telemetry/reporters.test.ts`. *Do:* §6.2.3, §6.2.5, §6.2.6. Tests: `toErrorResponse(new Error("boom"))` → 500 and the reporter called once with `{ error_code: "internal_error" }`; an `AppError(404, …)` → no report; a job handler throwing → reporter called with `job_kind`; `onRequestError` passes only `routePath`; `requireWorkspace` success path that emits telemetry passes explicit identity (or runs inside `runWithTelemetryContext`); isolation test still green. *Verify:* `NT src/lib/telemetry/reporters.test.ts src/lib/http/errors.test.ts src/lib/jobs/*.test.ts` → pass (F26-AC-10 server half).
  - [ ] **P3.T1.S2** *Files:* `src/app/portal/error.tsx` (F04 file), `src/app/portal/telemetry-check/page.tsx` (new). *Do:* in `error.tsx`, `useEffect(() => captureClientError(error, { boundary: "portal" }), [error])`. The check page is a client component that throws `new Error("telemetry check: secret-content")` when its button "Throw test error" is clicked; its server wrapper calls `notFound()` unless `process.env.VERCEL_ENV === "preview"` or `process.env.NODE_ENV !== "production"`. *Verify:* build → exit 0; browser B7 added to `check-f26-browser.mjs` (consented user clicks "Throw test error" → exactly one `$exception` whose `$exception_list[0].value` is `""` and whose body does not contain `secret-content`) → pass (F26-AC-10 client half).
- [ ] **P3.T2 Source maps**
  - [ ] **P3.T2.S1** *Files:* `package.json` (devDependency `@posthog/cli` pinned to the exact version `npm view @posthog/cli version` prints on the day, recorded in the PR; script `"sourcemaps:upload": "node scripts/telemetry/upload-sourcemaps.mjs"`; `"build": "next build && node scripts/telemetry/upload-sourcemaps.mjs"`), `scripts/telemetry/upload-sourcemaps.mjs`, `scripts/telemetry/upload-sourcemaps.test.mjs`. *Do:* script reads env; `POSTHOG_SOURCEMAPS !== "true"` → print `[sourcemaps] skipped` and exit 0; missing `POSTHOG_CLI_TOKEN` or `POSTHOG_CLI_ENV_ID` → `[sourcemaps] skipped (no credentials)`, delete maps, exit 0; else spawn `posthog-cli sourcemap inject --directory .next/static/chunks`, then `posthog-cli sourcemap upload --directory .next/static/chunks --release-version $VERCEL_GIT_COMMIT_SHA` (fallback `git rev-parse HEAD`), then delete every `*.map` under `.next/static` (in `finally`); a non-zero CLI exit prints `[sourcemaps] upload failed (exit N)` and the script still exits 0. Credentials are passed through the environment, never on the command line, never printed. Test with an injected `spawn` and a temp directory of fake `.js`/`.map` files: skip path, credential-less path, success order (inject before upload), failure path (maps still deleted, exit 0). *Verify:* `NT scripts/telemetry/upload-sourcemaps.test.mjs` → pass; `POSTHOG_SOURCEMAPS= npm run build` → exit 0 and prints `[sourcemaps] skipped` (F26-AC-11).

**Checkpoint:** suite, build, browser B7. Completes F26-AC-10, 11.

### Phase 4 — Wire every sink, instrument the tool registry, emit the remaining events

**Goal:** every registry event has a live emitter and every tool run is measured.

- [ ] **P4.T1 Sinks**
  - [ ] **P4.T1.S1** *Files:* each sink file of §6.2.7 that exists (add the setter where missing), `src/lib/telemetry/wireServerSinks.ts`, `src/components/app/telemetry/wireClientSinks.ts`, `src/lib/telemetry/wiring.test.ts`. *Do:* wire per the table. The test imports each existing sink, installs recording trackers through the wiring functions with injected `trackEvent`/`captureServerEvent`, calls each sink with one of its registry events, and asserts one recorded call with the same name and props. **Additionally:** every `EVENTS` name is either (a) reached by a live emitter/wiring call in the tree, or (b) listed in an explicit `PENDING_EMITTERS` set in the test (owner feature id + reason); dropping a feature's wiring requires deleting a PENDING line. Sinks whose files are absent go in PENDING, not silent skip. *Verify:* `NT src/lib/telemetry/wiring.test.ts` → pass (F26-AC-13).
- [ ] **P4.T2 Tool registry**
  - [ ] **P4.T2.S1** *Files:* `src/lib/tools/run.ts`, `src/lib/tools/run.test.ts`. *Do:* §6.2.8. New cases appended (existing cases unchanged): success → one `tool:call` with `success: true`; handler throwing `AppError(500,"internal_error")` → `tool:call` `success: false` and one error report with `tool`; `AppError(409,"price_changed")` → no error report; output mismatch → error report whose `issues` is `"data.rows.0.score"`-style paths and contains no value from the output; `source: "test"` → nothing captured; a capture function that throws does not change the returned outcome. *Verify:* `NT src/lib/tools/run.test.ts` → pass (F26-AC-12).
- [ ] **P4.T3 Remaining emitters**
  - [ ] **P4.T3.S1** *Files:* the files in §6.2.7's second table for features merged when F26 lands. *Do:* one `trackEvent` / `captureServerEvent` call per row, after the success path, with the registry's props. *Verify:* `npm run typecheck` → exit 0 (the registry types reject wrong props); `NT 'src/**/*.test.mjs' 'src/**/*.test.ts'` → pass.
  - [ ] **P4.T3.S2** *Files:* `src/components/portal/useScanTracker.js`, `src/app/api/customer/scan/route.js`, `src/components/portal/content/ComposerCard.jsx`, `src/components/portal/content/DraftEditor.jsx`, `src/components/portal/team/TeamPage.jsx`, `src/components/portal/gsc/GscPage.jsx`, `src/components/portal/gsc/PropertyPicker.jsx`, the render-harness module maps in `src/components/portal/portalRegressions.test.mjs` and `portalProgress.test.mjs`. *Do:* the "existing" events of §6.2.7; harness maps get `@/lib/telemetry/client` → `{ trackEvent() {} }` (reason: new import; assertions unchanged). *Verify:* `NT src/lib/customerRoutes.test.mjs src/components/portal/*.test.mjs` → pass.

**Checkpoint:** suite, typecheck, build. Completes F26-AC-12, 13.

### Phase 5 — Owner setup and live checks

- [ ] **P5.T1 Runbook**
  - [ ] **P5.T1.S1** *Files:* `docs/OPERATOR_LEDGER.md` § C ("F26 product analytics": the §10 steps verbatim), `scripts/qa/check-f26-live.md` (T1–T5). *Verify:* `NT src/lib/docStatus.test.mjs` → pass.
- [ ] **P5.T2 Owner-run live checks (only on the owner's instruction)**
  - [ ] **P5.T2.S1** *Do:* the owner runs T1–T5 on a preview deployment and records results in the phase-5 PR. *Verify:* five passes (F26-AC-16).

## 9. Test plan

| Test file | Cases | ACs |
|---|---|---|
| `src/lib/telemetry/events.test.ts` | naming, strict schemas, string-leaf walk, forbidden keys, count, code refinements | 01, 02 |
| `src/lib/telemetry/server.test.ts` | gates, consent, anonymous, groups, message stripping, non-reportable codes | 03, 04 |
| `src/lib/telemetry/client.test.ts` | init options, buffering, start/stop, validation | 05 |
| `src/lib/telemetry/sanitize.test.ts` | allow-list, nested, heatmaps, exception messages, our params | 06 |
| `src/shared/privacy-choices.test.ts` | cookie, precedence, GPC | 07 |
| `src/lib/telemetry/privacy.route.test.mjs` | GET/PUT, errors | 08 |
| `scripts/qa/check-f26-browser.mjs` | B1–B7 | 09, 10 |
| `src/lib/telemetry/reporters.test.ts`, `src/lib/http/errors.test.ts` | reporters, context | 10 |
| `scripts/telemetry/upload-sourcemaps.test.mjs` | skip, credentials, order, failure, map deletion | 11 |
| `src/lib/tools/run.test.ts` (extended) | `tool:call`, error and mismatch reports | 12 |
| `src/lib/telemetry/wiring.test.ts` | every present sink reaches capture | 13 |
| `scripts/qa/check-f26-db.mjs` | `telemetry-id`, `rls` | 14 |
| `src/app/privacy/privacyCopy.test.mjs` | policy section | 15 |
| `scripts/qa/check-f26-live.md` | T1–T5 (owner) | 16 |

Fixtures contain fictional values (`acme.test`, `owner@example.test`, `phc_qa_placeholder`); no request leaves `127.0.0.1` in browser checks.

## 10. Rollout and rollback

**Env names:** §6.2.10. `NEXT_PUBLIC_POSTHOG_KEY` and `POSTHOG_PROJECT_KEY` are PostHog's public project key; `POSTHOG_CLI_TOKEN` is a personal API key with source-map write scope (secret; Vercel only, piped, never printed).

**Defaults:** flag off in production; no key → nothing loads; every user undecided → nothing identified is sent.

**Owner steps:**
1. Apply migration 165.
2. Create a PostHog project in the **EU cloud**; Project settings → turn on "Discard client IP data"; disable session replay, surveys, heatmaps and autocapture in project settings (belt and braces; the client also disables them).
3. Vercel Production env: `NEXT_PUBLIC_POSTHOG_KEY`, `POSTHOG_PROJECT_KEY`, `POSTHOG_HOST=https://eu.i.posthog.com`; for source maps `POSTHOG_SOURCEMAPS=true`, `POSTHOG_CLI_TOKEN`, `POSTHOG_CLI_ENV_ID`, `POSTHOG_CLI_HOST=https://eu.posthog.com`.
4. `FEATURE_PRODUCT_ANALYTICS=on` on a **preview** first; run T1–T5; then production.

**Live checklist (`scripts/qa/check-f26-live.md`):** T1 an undecided account sends no events (PostHog Live events empty for 2 minutes of browsing); T2 after "Share analytics", `$pageview` and one registry event appear with the user id as distinct id and a `workspace` group whose key is a UUID, and the event's `$current_url` has no `brand_key`; T3 Persons view shows no email or name property; T4 on the preview, `/portal/telemetry-check` → "Throw test error" appears in Error tracking with a de-minified stack (source maps) and an empty message (the page returns 404 in production); T5 turning analytics off in Settings stops events within one page view.

**Rollback:**
- **Product events (client + `captureServerEvent`):** `FEATURE_PRODUCT_ANALYTICS=off` stops them; the Privacy tab and banner hide. Browser also stops when `NEXT_PUBLIC_TELEMETRY_DISABLED=1` + redeploy or keys removed.
- **Error reports (`captureServerError`):** gated only on `serverTelemetryEnabled` (key + `TELEMETRY_DISABLED`), **not** on `FEATURE_PRODUCT_ANALYTICS`, matching the product decision that errors always send (without identity unless consented). To stop error reports: `TELEMETRY_DISABLED=1` and/or remove `POSTHOG_PROJECT_KEY`.
- **Erasure (DPDP):** account deletion must call PostHog person deletion (`$delete_person` / project API with the user's distinct id) in the same flow that removes the auth user, **or** the owner runbook must include a manual PostHog person-delete step keyed by user id. Deleting only `user_privacy_choices` or the whole PostHog project is not enough for a single-user erasure request. `user_privacy_choices` may remain as the consent record until the account row is removed.

## 11. Risks and open questions

1. **Fewer measured users** under opt-in. *Default:* accept; anonymous counters cover the sign-up and onboarding funnel heads. The owner may later choose region-based defaults outside India (would need the region lookup OpenSEO has).
2. **AsyncLocalStorage identity bleed** if `enterWith` is used as the sole path. *Default:* prefer explicit `userId`/`brandKey` and `runWithTelemetryContext`; isolation test required; Edge routes are not instrumented.
3. **`posthog-js` option names** (`defaults`, `disable_surveys`, `person_profiles`) depend on the installed version. *Default:* pin OpenSEO's `^1.395.0`, which supports all listed options; the init-options test fails loudly if an option is renamed. **`opt_in_capturing` after consent is mandatory** — omitting it leaves consented users silent.
4. **Server stack traces are minified** (no server source maps). *Default:* accept; route templates and job kinds locate most errors.
5. **`@posthog/cli` command and env names** (`sourcemap inject/upload`, `POSTHOG_CLI_TOKEN`, `POSTHOG_CLI_ENV_ID`, `POSTHOG_CLI_HOST`) are taken from OpenSEO's script and PostHog's CLI conventions. *Default:* the script fails soft (exit 0, maps deleted), so a mismatch never breaks deploys; T4 detects it.
6. **Build time** grows by the inject/upload step when enabled. *Default:* only on Vercel production builds with `POSTHOG_SOURCEMAPS=true`.
7. **F11/F12 event names** change from underscores to the colon form. *Default:* registry uses `prompt_explorer:*` and `question_history:*`; those features emit nothing before F26, so no history is lost.
8. **`skipTrailingSlashRedirect: true` is global** (marketing site included). *Default:* keep for PostHog ingest; guard with a public-site trailing-slash regression test in Phase 2.
9. **DPDP erasure:** consent design invokes DPDP 2023; person deletion in PostHog must ride account deletion or an owner runbook step (§10). *Default:* implement `$delete_person` (or CLI equivalent) when account deletion ships; until then document the manual step.
10. **Onboarding client events buffer in memory only** across wizard steps before Preferences consent. A full navigation drops earlier `onboarding:step_*` events; funnel heads can under-count. *Default:* accept; anonymous `onboarding:completed` covers the completion head — do not read pre-consent step counts as drop-off.
11. **One PostHog server client + `shutdown` per event** means a fresh TLS connection per `tool:call` / `email:sent` / `assistant:turn`. *Default:* match OpenSEO; acceptable on serverless (§6.4).
12. **Path segments can carry brand-like hosts** (e.g. `/dashboard/[brand]`). *Default:* TelemetryBootstrap only on `APP_SURFACES`; browser B3 rejects dotted `$pathname` segments.
13. **`POLICY_VERSION` must match the live privacy-policy date.** Phase 1 seeds a placeholder; Phase 2 sets it to the merge date of the policy section and locks it with `privacyCopy.test.mjs`.

## 12. Definition of done

- [ ] Phases 1–5 merged; subtasks ticked.
- [ ] F26-AC-01 to 15 covered by passing tests; AC-16 recorded.
- [ ] Typecheck, build, suite, DB and browser checks green; `npm run build` with source maps disabled prints `[sourcemaps] skipped`.
- [ ] Migration paperwork for 165 done; `THIRD_PARTY_NOTICES.md` lists the §7 COPY/PORT paths.
- [ ] Privacy policy section live; `features/README.md` status updated.

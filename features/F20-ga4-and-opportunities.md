# F20 — Google Analytics 4 and search opportunities

> <!-- doc-status -->
> **Status: LIVE.** Implementation spec. Not built yet.

| Field | Value |
|---|---|
| ID | F20 |
| Wave | 3 |
| Comparison rows covered | "Google Analytics 4" (OpenSEO: seven report types plus a GSC × GA4 page-opportunity score. Perceev: none). "Search Console" is a deferred **Mixed** row: this spec does not change Search Console behaviour (§3, F20-AC-10). |
| Depends on | **F01** (merged): `requireWorkspace`, `AppError`/`toErrorResponse`/`jsonOk`, `cached` (`provider_cache`), `definePeriodic`/`enqueueSystemJob`/`defineJob`, step presets, `isFeatureEnabled`, `f01_touch_updated_at()`, route-contract harness. **F04** (settings layout and `src/components/portal/settings/tabs.ts`, `CardShell`, `Badge`, `Alert`, `Dialog`, `ConfirmDialog`, `PermissionHint`, `MetricsTable`, `chart`, `Tabs`, `Select`, `Skeleton`, `EmptyState`, `QueryError`, `NotFound`). **F05** (`fetchJson`, `useWorkspace`, `keys`, `useUrlSearchState`). **F06** (`DataTable`, `DataTableTabs`, `ExportMenu`, `useExportRows`). Existing (unchanged): `src/lib/gsc/oauthCrypto.js`, `src/lib/engines/gsc.js` `gscFetchForBrand`, `src/lib/supabase/sessionBinding.js`, `gsc_connections`. |
| Blocks | F22 (analytics tools), F23 (analytics sections in reports), F27 (onboarding "Connect Google Analytics" step uses `Ga4ConnectionCard` and `getGa4ConnectionState`) |
| Reserved migrations | 135–139. **135** `135_f20_ga4.sql` (P1). **136** `136_f20_ga4_functions.sql` (P1). 137–139 unused. |
| Feature flag | `FEATURE_GA4` (name `ga4`, spend `[]`): settings tab, `/portal/analytics`, sidebar item, all routes. In `CLIENT_FEATURES`; off in production by default (F01 flag semantics). |
| Spend features | none. Google Analytics and Search Console APIs are free; `src/shared/spend-features.ts` is **not** changed. |
| OpenSEO reference | `openseo:src/server/features/google/{googleOAuth,googleOAuthState,oauth-config,googleIdToken,googleDataRetention,GoogleAccountService,GoogleAccountRepository}.ts`, `openseo:src/server/features/ga4/**`, `openseo:src/server/lib/{ga4Client,ga4Errors}.ts`, `openseo:src/db/{ga4.schema,pg/ga4.schema}.ts`, `openseo:drizzle/pg/0017_ga4_connections.sql`, `openseo:src/serverFunctions/{ga4,googleAccounts}.ts`, `openseo:src/shared/{ga4,google-link}.ts`, `openseo:src/routes/api/ga4/oauth/callback.ts`, `openseo:src/client/features/{integrations,dashboard/Ga4Card,dashboard/Ga4ConnectCard,search-performance}/**`, `openseo:src/server/mcp/tools/google-analytics-tools.ts` at `c5f8db1` |

## 1. Summary

A workspace owner links a Google account with read-only Analytics access, picks a GA4 property, and every member sees organic traffic and conversions at `/portal/analytics`: an organic overview with period comparison, seven reports (landing pages, pages, key events, acquisition, e-commerce, site search, audience), a measurement-health check, and OpenSEO's search-opportunity score that joins Search Console pages ranking 4–20 with GA4 landing-page engagement. The Analytics grant is separate from the Search Console grant (its own OAuth client and tables), so nothing about Search Console changes.

## 2. What OpenSEO does (observed)

1. **Own OAuth flow, not the auth library's.** Search Console and Analytics grants are linked by a custom module because Better Auth "refuses to link one Google account to a second user, which blocked agencies and multi-member orgs from each connecting the same client Google account"; grants are keyed per user so the same Google identity may back several users (`openseo:src/server/features/google/googleOAuth.ts:37-49`). Two integrations share one Google OAuth client (`GOOGLE_CLIENT_ID`, `oauth-config.ts:9-15`) with separate callback paths and provider ids `google-search-console` / `google-analytics` (`googleOAuth.ts:67-83`, `shared/ga4.ts:1-12`).
2. **Consent URL.** Scopes `openid email profile https://www.googleapis.com/auth/analytics.readonly`, `access_type=offline`, `prompt=select_account consent`, PKCE S256 (`googleOAuth.ts:190-231`). State is a random nonce stored in the verification table for 10 minutes and **deleted by the first callback** (single use, replay-proof); the PKCE verifier is an HMAC of the nonce keyed by the client secret; expired states are swept when a new flow starts (`googleOAuthState.ts:15-124`).
3. **Callback.** The state is consumed before the user check so a state presented by the wrong session is burned; Google errors and failures go back to the starting page with `error=<code>` and `google_link_error=ga4`; a consent where the user unticked the Analytics box is refused with `scope_not_granted` and **not saved**; the Google account id is the verified `id_token` `sub` (JWKS, issuer, audience, RS256; `googleIdToken.ts:1-20`); the grant upsert keeps the stored refresh token when Google omits a new one (`googleOAuth.ts:134-177`, `:243-329`).
4. **Tokens.** Encrypted with the auth secret; refreshed when within 5 s of expiry; a grant without a refresh token fails and asks for reconnection; a rotated refresh token is kept (`googleOAuth.ts:117-132`, `:337-404`).
5. **Revocation scope.** "Google revokes the whole grant the token belongs to (every scope this OAuth client holds for that Google account), so callers must make sure no other stored grant still needs it" (`googleOAuth.ts:406-423`). Removal revokes only when no other stored data grant — any user, **either integration** — exists for that Google account (`GoogleAccountService.ts:26-39`, `GoogleAccountRepository.ts:151-163`). Because Search Console and Analytics share the client, revoking an Analytics token would otherwise kill the Search Console grant for the same Google account.
6. **"Revoke grants unused for more than 24 h" — what it really is.** `purgeUnusedGoogleData` (`googleDataRetention.ts:1-21`) runs in the daily `17 3 * * *` cron, hosted mode only (`openseo:src/server.ts:196-230`). It lists data grants (Search Console or Analytics) that **no project connection references** and whose row `updatedAt` is older than 24 hours (`GoogleAccountRepository.ts:82-140`), at most 1,000 per run and within an 8-minute budget; for each it mints a token, deletes the grant only if still unused (`:142-149`), and revokes at Google only if no other grant exists for that Google account (`GoogleAccountService.ts:62-82`). So "unused" means **"linked but not bound to any project"** — typically a user who linked Google and never picked a property, or whose projects were all disconnected — **not** "no API call for 24 hours". The 24 hours is a grace period for picking a property; because a token refresh updates `updatedAt` (`googleOAuth.ts:389-402`), the clock restarts on refresh. A grant that a project uses is kept indefinitely, however rarely reports are viewed. Their comment ties it to the privacy policy (`googleDataRetention.ts:10-14`); cached Google reports expire separately after 7 days in the bucket.
7. **Account removal.** Removing a Google account deletes the grant and every connection that relies on it, atomically, scoped to the caller (`GoogleAccountRepository.ts:61-70`); the dialog shows how many projects it disconnects (`client/features/integrations/GoogleAccountRemovalDialog.tsx:78-134`). Disconnecting a project only deletes the connection (`Ga4Service.ts:136-138`); the grant is left for the daily purge.
8. **Connection table.** `ga4_connections`: one per project; property id, display name, time zone, currency, connector user, Google account id, connector email (`db/pg/ga4.schema.ts:9-37`, `drizzle/pg/0017_ga4_connections.sql:1-21`). Setting a property checks the grant belongs to the user and the property is in the account's list, then reads the property's time zone and currency (`Ga4Service.ts:86-134`).
9. **Client.** Admin API v1beta `accountSummaries` (200 per page, ≤ 100 pages), `properties/{id}`, v1alpha data streams and enhanced measurement, key events, custom dimensions and metrics; Data API v1beta `properties/{id}:runReport` with `returnPropertyQuota: true`; one token per client, memoised; error bodies cut to 8,000 chars and reduced to Google's `reason`; `Retry-After` ≤ 86,400 kept (`server/lib/ga4Client.ts:12-474`, `ga4Errors.ts:1-59`).
10. **Seven report kinds** (`Ga4ReportDefinitions.ts:28-97`): `landing_pages` (hostName, landingPage; sessions, activeUsers, engagedSessions, engagementRate, keyEvents, sessionKeyEventRate, transactions, purchaseRevenue), `page_performance` (hostName, pagePath; screenPageViews, activeUsers, userEngagementDuration, keyEvents; optional date), `key_events` (eventName; keyEvents, totalUsers; key events > 0; optional landing-page breakdown), `traffic_acquisition` (channel group / source-medium / campaign), `ecommerce_performance` (items, or landing pages with transactions), `site_search` (`view_search_results` events with a search term), `audience_breakdown` (device / country / new vs returning). Organic channel filter `sessionDefaultChannelGroup = "Organic Search"` by default (`:109-116`, `:167-194`).
11. **Dates.** Default 28 days ending on the last complete day in the **property's** time zone; a future end date is clamped with warning `end_date_clamped`; half ranges and reversed dates are refused before calling Google (`Ga4ReportingService.ts:58-107`, `Ga4Dates.ts:1-27`).
12. **Normalisation.** Response headers must equal the requested ones; restricted metrics become `null`; a header-less empty response (range before the property existed) is an empty report, not malformed; `hasLimitedData` = sampling, thresholding, `(other)` row loss or restricted metrics (`Ga4ReportNormalization.ts:45-119`).
13. **Enhancements.** Previous-period comparison only for unambiguous low-cardinality breakdowns, with coverage flags (`Ga4ReportEnhancements.ts:10-137`); attribution diagnostics (≥ 5 % `(not set)`, internal referrers, case variants) only on complete, unlimited data (`:158-234`); e-commerce and site-search activity `detected`/`none`/`unknown` (`:236-307`).
14. **Organic overview.** Current, previous equal-length period and a daily or weekly trend in three parallel requests; `key_events_sharp_decline` when key events fell ≥ 50 % from ≥ 5 (`Ga4OrganicOverviewService.ts:34-155`); the dashboard zero-fills missing days (`serverFunctions/ga4.ts:65-89`).
15. **Measurement health.** Read-only inventory of web streams, enhanced measurement, key events, custom definitions, with issues `no_web_stream`, `enhanced_measurement_disabled`, `site_search_measurement_disabled`, `no_key_events_configured` (`Ga4MeasurementHealthService.ts:6-94`).
16. **Search opportunities** (`SearchOpportunityService.ts:44-291`): default range = 28 days ending 3 days before today in the GA4 property's time zone (Search Console lag); Search Console `page` rows (≤ 1,000, `type: web`, `dataState: final`) joined to GA4 organic `landing_pages` (≤ 1,000) on `normalizePageKey` = lowercase host (non-default port kept) + path without trailing slash, `(not set)` dropped (`:59-77`); candidates are pages at **position 4–20** (`:162-163`); only joined pages are scored: percentile ranks of `log1p(impressions)` (demand), `sessionKeyEventRate` — or `engagementRate` when every joined page has zero key events (business value) — and `20 − position` (reachability); `score = round(100 × (0.5·demand + 0.3·businessValue + 0.2·reachability))` (`:207-236`); unscored `gsc_only` pages sort last; the response reports coverage, truncation and a `source_time_zones_differ` warning against Search Console's `America/Los_Angeles` (`:243-290`).
17. **Where it shows.** In the app, only the dashboard "Organic traffic" card (`client/features/dashboard/Ga4Card.tsx:43-180`) and the integrations card and picker (`client/features/integrations/GoogleConnectionCard.tsx:31-281`, `googleProviders.ts:147-179`). The seven reports, health and opportunities are exposed **only as MCP tools** (`server/mcp/tools/google-analytics-tools.ts:514-839`). There is no GA4 report page; Search Console has a full page with tabs (`client/features/search-performance/SearchPerformancePage.tsx:217-354`).
18. **Errors.** `ga4_not_connected`, `ga4_reconnect_required` (token error or 401), `ga4_property_inaccessible` (403/404), `ga4_report_incompatible` (400), `ga4_quota_exhausted` (429, with retry), `ga4_upstream_unavailable` (5xx, network, Data API disabled), `ga4_malformed_response` (`Ga4ReportingService.ts:131-198`). The dashboard treats quota exhaustion as `RATE_LIMITED` (`serverFunctions/ga4.ts:128-136`).
19. **Caching.** GA4 reports are queried live per request; Google reports cached for the dashboard expire after 7 days (`googleDataRetention.ts:13-14`).

## 3. What Perceev has today

- **Search Console (unchanged by this spec):** customer OAuth with PKCE, session binding, owner-only connect, encrypted tokens (AES-256-GCM, `GSC_TOKEN_ENCRYPTION_KEY`, AAD per workspace and user, `src/lib/gsc/oauthCrypto.js:1-97`), a pending grant held on the attempt until property selection (`src/lib/gsc/oauthFlow.js:38-182`), `activate_customer_gsc`/`disconnect_customer_gsc` (`supabase/migrations/026_customer_uat_repairs.sql:42-102`), one credential per workspace (`025_gsc_customer_oauth.sql:32-46`), daily sync of **query-level** rows into `gsc_daily` (`018_gsc_daily.sql:34-45`, `src/lib/gsc/ingest.js:1-45`), connect/callback/property/sync/data routes under `src/app/api/customer/gsc/`, page `/portal/search-console` (`src/components/portal/gsc/GscPage`). Scope `webmasters.readonly`, OAuth client `GSC_GOOGLE_CLIENT_ID`. `gscFetchForBrand(siteUrl, opts, { brandKey, admin, authMode: "oauth" })` performs one authorised Search Analytics call with the workspace's token (`src/lib/engines/gsc.js:284-322`).
- **No page-level Search Console data is stored** (`gsc_daily` is per date × query), so the opportunity join needs a live `page`-dimension query.
- No Google Analytics code, table, route or page. No `/portal/settings` sections yet (F04 shell).
- **Must not change:** every file under `src/lib/gsc/`, `src/app/api/customer/gsc/`, `src/components/portal/gsc/`, `src/app/portal/search-console/`, `src/lib/engines/gsc.js`, migrations 018/025/026, the GSC sync worker and its tests (`src/lib/gsc/*.test.mjs`).

**Design decision — a separate grant with its own OAuth client.** Because Google revokes every scope a client holds for a Google account (§2 fact 5), and our GSC credentials do not record the Google account id, an Analytics revocation through the GSC client could silently kill a workspace's Search Console grant. F20 therefore uses a **second OAuth client in the same Google Cloud project** (`GA4_GOOGLE_CLIENT_ID`/`GA4_GOOGLE_CLIENT_SECRET`, redirect `GA4_OAUTH_REDIRECT_URI`), its own attempts, grants and connections tables, and never calls a GSC write function. Revoking an Analytics token can then only ever affect Analytics grants. Tokens reuse `encryptToken`/`decryptToken` from `src/lib/gsc/oauthCrypto.js` (key `GSC_TOKEN_ENCRYPTION_KEY`) with an `ga4:` AAD prefix, which reads that module without changing it.

## 4. Target behaviour and acceptance criteria

| ID | Statement | Verified by |
|---|---|---|
| F20-AC-01 | `POST /api/customer/ga4/connect` (owner, flag on, client configured) creates a `ga4_oauth_attempts` row (SHA-256 state hash, session-binding hash, encrypted PKCE verifier, return path, 10-minute expiry) and returns an authorization URL with exactly: GA4 client id, `GA4_OAUTH_REDIRECT_URI`, `response_type=code`, `scope=openid email https://www.googleapis.com/auth/analytics.readonly`, `access_type=offline`, `prompt=select_account consent`, `code_challenge_method=S256`, and **no** `include_granted_scopes`. Members → 403; unconfigured → 503. | unit `src/lib/ga4/oauth.test.ts`; route `src/lib/ga4/oauth.route.test.mjs` |
| F20-AC-02 | The callback consumes the attempt once (compare-and-set; a replay redirects with `ga4_error=state_mismatch`), checks the session binding and owner role, exchanges the code with the PKCE verifier, refuses a grant without `analytics.readonly` (`scope_not_granted`, nothing stored), validates `id_token` claims (`aud` = GA4 client id, `iss`, `exp`, `sub`), upserts the grant keeping an existing refresh token, and redirects to the return path with `ga4=linked`. | unit `oauth.test.ts` (port of `googleOAuth.test.ts:188-400`) |
| F20-AC-03 | Two Perceev users linking the same Google account get two grant rows (`user_id`, `google_sub`); each workspace connection references one grant. | unit `src/lib/ga4/grants.test.ts`; DB `scripts/qa/check-f20-db.mjs` |
| F20-AC-04 | Access tokens refresh within 60 s of expiry; `invalid_grant` marks the grant `error` and reports return `ga4_reconnect_required`; a concurrent refresh never overwrites a newer token; a grant without a refresh token past expiry asks for reconnection. | unit `src/lib/ga4/tokens.test.ts` |
| F20-AC-05 | `GET /api/customer/ga4/properties` lists, for each of the caller's grants, the email, properties (`properties/<n>`, display name, account name, `isSelected`) and `requiresReconnect`/`propertiesUnavailable`, paginating `accountSummaries` up to 100 pages. | unit `src/lib/ga4/client.test.ts` (port of `ga4Client.test.ts:36-121`); route test |
| F20-AC-06 | `POST /api/customer/ga4/property` (owner) succeeds only for a grant of the caller and a property in that grant's list; it stores display name, time zone and currency from `properties/{id}` and purges the workspace's `ga4.*` cache. | unit `src/lib/ga4/connection.test.ts`; route test |
| F20-AC-07 | `DELETE /api/customer/ga4` (owner) deletes the connection and every `provider_cache` row (and Storage body) of the workspace in `ga4.*` namespaces; the grant remains. | route test; DB `check-f20-db.mjs` |
| F20-AC-08 | Removing a linked Google account shows the number of workspaces it disconnects, deletes the grant and its connections atomically (own grants only), purges their caches, and revokes at Google only when no grant for that Google account remains; a revoke failure does not fail the removal. | unit `src/lib/ga4/accounts.test.ts` (port of `GoogleAccountService.test.ts:154-304`) |
| F20-AC-09 | The daily purge deletes grants that no connection references and whose `updated_at` is older than 24 hours (≤ 50 per step, ≤ 10 steps), skips a grant that became used between listing and deleting, and revokes only when it was the last grant for that Google account. | unit `accounts.test.ts`; DB `check-f20-db.mjs` |
| F20-AC-10 | **Search Console unchanged:** the PR diff touches no GSC file listed in §3; `src/lib/ga4/**` imports from `../gsc/oauthCrypto.js` only `encryptToken`, `decryptToken`, `hashValue`, `generateSecureRandom`, `isEncryptionConfigured`, and from `../engines/gsc.js` only `gscFetchForBrand`; it never reads `gsc_oauth_credentials` directly; GSC tests pass unchanged. | unit `src/lib/ga4/gscUntouched.test.ts`; diff check in every phase checkpoint |
| F20-AC-11 | The seven report kinds produce OpenSEO's request bodies (dimensions, metrics, filters, metric filters, ordering, `keepEmptyRows: false`, `returnPropertyQuota: true`). | unit `src/lib/ga4/reportDefinitions.test.ts` |
| F20-AC-12 | Date ranges resolve in the property's time zone to the last complete day, clamp future end dates with `end_date_clamped`, and refuse half ranges and reversed dates before any Google call. | unit `src/lib/ga4/reporting.test.ts` (port of `Ga4ReportingService.test.ts:77-340`) |
| F20-AC-13 | Normalisation matches OpenSEO (header check, restricted metrics → `null`, header-less empty, `hasLimitedData`). | unit `src/lib/ga4/normalization.test.ts` |
| F20-AC-14 | Comparison, attribution diagnostics and activity states match OpenSEO's tests. | unit `src/lib/ga4/enhancements.test.ts` (port of `Ga4ReportEnhancements.test.ts:26-182`) |
| F20-AC-15 | The organic overview returns current, previous and trend with `key_events_sharp_decline`; the trend is zero-filled only when the report is complete and not limited, otherwise days without rows stay missing (never drawn as zero). | unit `src/lib/ga4/overview.test.ts` |
| F20-AC-16 | Measurement health reports the four issues from Admin API data. | unit `src/lib/ga4/measurementHealth.test.ts` |
| F20-AC-17 | Opportunities reproduce OpenSEO's join, 4–20 filter, percentile score and engagement fallback, leave `gsc_only` pages unscored and last, and report coverage, truncation and the time-zone warning; Search Console pages come from one live `gscFetchForBrand` call with `dimensions: ["page"]`, `rowLimit: 1000`, `type: "web"`, `dataState: "final"`. | unit `src/lib/ga4/opportunities.test.ts` (port of `SearchOpportunityService.test.ts:68-202`) |
| F20-AC-18 | Errors map to statuses and copy of §6.5.2; a quota error returns 429 with `Retry-After` when Google gave one; no Google request is retried after a 429 or a 4xx; 5xx and network failures are retried once after 500 ms. | unit `client.test.ts`; route tests |
| F20-AC-19 | Report, overview, health and opportunity results are cached with F01 `cached()` (`scope: "workspace"`, 900 s; health 3,600 s); a repeat request within the TTL makes no Google call and returns the same `dataAsOf`; changing the property changes the key; errors are not cached. | unit `src/lib/ga4/cache.test.ts` |
| F20-AC-20 | At most 4 concurrent Data API requests per property per process; `quota_low` warning when `tokensPerHour.remaining` < 10 % of the hourly total. | unit `client.test.ts` |
| F20-AC-21 | When the connecting user is no longer a member of the workspace, reports return `ga4_reconnect_required` with the "no longer in this workspace" message, and the connection card says so. | unit `connection.test.ts`; browser F20-B05 |
| F20-AC-22 | Routes: flag off → 404 `feature_unavailable`; members read reports; owners connect, choose, disconnect; any member removes only their own linked accounts; responses `Cache-Control: no-store`; contracts registered. | route `src/lib/ga4/*.route.test.mjs`; contract test |
| F20-AC-23 | Settings → Integrations shows every connection state of §6.6.2 with exact copy, including link errors from `?ga4_error=`. | browser `scripts/qa/check-f20-browser.mjs` F20-B01–B05 |
| F20-AC-24 | `/portal/analytics` shows the overview and the nine tabs of §6.6.3 with their states (loading, empty, limited data, quota, reconnect, inaccessible, Search Console not connected) and works at 375 px without horizontal page scroll. | browser F20-B06–B12 |
| F20-AC-25 | RLS: `ga4_connections` readable only by workspace members; `ga4_grants` and `ga4_oauth_attempts` service-only. | DB `check-f20-db.mjs`; CI tenant RLS test |
| F20-AC-26 | `src/lib/ga4/tools.ts` exports ten read-only tools with closed inputs and outputs that parse handler results. | unit `src/lib/ga4/tools.test.ts` |
| F20-AC-27 | No log line contains a token, authorization code, state, verifier, report row, property name or Google email; tokens are stored encrypted with AAD `ga4:<userId>:<googleSub>:refresh|access`. | unit `src/lib/ga4/privacy.test.ts` (log spy) |
| F20-AC-28 | Expired or consumed OAuth attempts older than 1 day are pruned daily. | DB `check-f20-db.mjs` |

## 5. Scope

**In scope:** a separate Analytics OAuth grant (connect, callback, multiple users per Google account, refresh, removal, unused-grant purge), the workspace connection and property picker in Settings → Integrations, live reports with short caching, organic overview, seven reports, measurement health, search opportunities, `/portal/analytics`, F22 tool definitions, `Ga4ConnectionCard` and `getGa4ConnectionState` for F27.

**Out of scope:** any change to Search Console (deferred Mixed row): its OAuth, sync, storage, pages and routes stay as they are; storing GA4 history (live with a 15-minute cache, like OpenSEO); GA4 write access or configuration changes (read-only scope); Google sign-in (F24); dashboard cards on `/portal` (F04 restyles the overview; a card can be added later by importing `OrganicOverviewCard`); reports and sharing (F23); MCP server (excluded).

## 6. Design

### 6.1 Data model

#### `supabase/migrations/135_f20_ga4.sql`

```sql
-- 135: F20 Google Analytics 4 — OAuth attempts, per-user Analytics grants, workspace connections.
-- Port of openseo ga4.schema.ts and its per-user grant rows. Separate from every gsc_* table. Safe to re-run.

CREATE TABLE IF NOT EXISTS public.ga4_oauth_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  brand_key text NOT NULL REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  state_hash text NOT NULL CHECK (state_hash ~ '^[0-9a-f]{64}$'),
  session_token_hash text NOT NULL CHECK (session_token_hash ~ '^[0-9a-f]{64}$'),
  encrypted_code_verifier text NOT NULL,
  return_path text NOT NULL DEFAULT '/portal/settings/integrations'
    CHECK (return_path IN ('/portal/settings/integrations', '/portal/analytics', '/onboarding')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '10 minutes'),
  consumed_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS ga4_oauth_attempts_state_idx ON public.ga4_oauth_attempts (state_hash);
CREATE INDEX IF NOT EXISTS ga4_oauth_attempts_expiry_idx ON public.ga4_oauth_attempts (expires_at);

-- A grant belongs to a person, not a workspace (OpenSEO keys grants per user, googleOAuth.ts:37-49), so it has
-- no brand_key (deviation from conventions §6.8); it is service-only. The workspace link is ga4_connections.
CREATE TABLE IF NOT EXISTS public.ga4_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  google_sub text NOT NULL CHECK (google_sub ~ '^[0-9A-Za-z_-]{1,255}$'),
  google_email text CHECK (google_email IS NULL OR length(google_email) <= 320),
  encrypted_refresh_token text,
  encrypted_access_token text,
  access_token_expires_at timestamptz,
  scopes text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','error')),
  last_error text CHECK (last_error IS NULL OR length(last_error) <= 300),
  key_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ga4_grants_user_sub_key UNIQUE (user_id, google_sub)
);
COMMENT ON COLUMN public.ga4_grants.updated_at IS 'Touched on link, re-consent, token refresh and property selection. Grants with no connection and updated_at older than 24 h are purged and revoked (port of googleDataRetention.ts).';
CREATE INDEX IF NOT EXISTS ga4_grants_sub_idx ON public.ga4_grants (google_sub);
CREATE INDEX IF NOT EXISTS ga4_grants_updated_idx ON public.ga4_grants (updated_at);
DROP TRIGGER IF EXISTS ga4_grants_touch ON public.ga4_grants;
CREATE TRIGGER ga4_grants_touch BEFORE UPDATE ON public.ga4_grants
  FOR EACH ROW EXECUTE FUNCTION public.f01_touch_updated_at();

CREATE TABLE IF NOT EXISTS public.ga4_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_key text NOT NULL REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  grant_id uuid NOT NULL REFERENCES public.ga4_grants(id) ON DELETE CASCADE,
  connected_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  google_sub text NOT NULL,
  connected_account_email text,
  property_id text NOT NULL CHECK (property_id ~ '^properties/[0-9]{1,20}$'),
  property_display_name text NOT NULL CHECK (length(property_display_name) <= 200),
  property_time_zone text NOT NULL CHECK (length(property_time_zone) <= 64),
  property_currency_code text NOT NULL CHECK (property_currency_code ~ '^[A-Z]{3}$'),
  account_display_name text CHECK (account_display_name IS NULL OR length(account_display_name) <= 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ga4_connections_brand_key UNIQUE (brand_key)
);
CREATE INDEX IF NOT EXISTS ga4_connections_grant_idx ON public.ga4_connections (grant_id);
DROP TRIGGER IF EXISTS ga4_connections_touch ON public.ga4_connections;
CREATE TRIGGER ga4_connections_touch BEFORE UPDATE ON public.ga4_connections
  FOR EACH ROW EXECUTE FUNCTION public.f01_touch_updated_at();

ALTER TABLE public.ga4_oauth_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ga4_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ga4_connections ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ga4_oauth_attempts, public.ga4_grants FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.ga4_oauth_attempts, public.ga4_grants TO service_role;
DROP POLICY IF EXISTS ga4_connections_read ON public.ga4_connections;
CREATE POLICY ga4_connections_read ON public.ga4_connections FOR SELECT TO authenticated
  USING (public.customer_can_access_brand(brand_key));
REVOKE INSERT, UPDATE, DELETE ON public.ga4_connections FROM anon, authenticated;
GRANT SELECT ON public.ga4_connections TO authenticated;
GRANT ALL ON public.ga4_connections TO service_role;
NOTIFY pgrst, 'reload schema';
```

#### `supabase/migrations/136_f20_ga4_functions.sql`

```sql
-- 136: F20 GA4 functions — grant upsert, connection set/disconnect, account removal, unused-grant purge,
-- cache purge, attempt pruning. Service-role only. Safe to re-run.

-- Port of upsertGrant (googleOAuth.ts:134-177): one grant per (user, Google account); keep the stored
-- refresh token when Google omits a new one.
CREATE OR REPLACE FUNCTION public.ga4_upsert_grant(p_user_id uuid, p_google_sub text, p_google_email text,
  p_encrypted_refresh_token text, p_encrypted_access_token text, p_access_token_expires_at timestamptz, p_scopes text[])
RETURNS uuid LANGUAGE sql SET search_path = public AS $$
  INSERT INTO ga4_grants (user_id, google_sub, google_email, encrypted_refresh_token, encrypted_access_token,
                          access_token_expires_at, scopes, status, last_error)
  VALUES (p_user_id, p_google_sub, p_google_email, p_encrypted_refresh_token, p_encrypted_access_token,
          p_access_token_expires_at, p_scopes, 'active', NULL)
  ON CONFLICT (user_id, google_sub) DO UPDATE SET
    google_email = coalesce(excluded.google_email, ga4_grants.google_email),
    encrypted_refresh_token = coalesce(excluded.encrypted_refresh_token, ga4_grants.encrypted_refresh_token),
    encrypted_access_token = excluded.encrypted_access_token,
    access_token_expires_at = excluded.access_token_expires_at,
    scopes = excluded.scopes, status = 'active', last_error = NULL
  RETURNING id
$$;

-- Deletes the workspace's cached GA4 reports; returns Storage paths of large bodies for removal.
CREATE OR REPLACE FUNCTION public.ga4_purge_cache(p_brand_key text)
RETURNS SETOF text LANGUAGE sql SET search_path = public AS $$
  DELETE FROM provider_cache WHERE brand_key = p_brand_key AND namespace LIKE 'ga4.%' RETURNING storage_path
$$;

-- Port of Ga4Service.setProperty + Ga4ConnectionRepository.upsert (Ga4Service.ts:86-134, Ga4ConnectionRepository.ts:18-54).
CREATE OR REPLACE FUNCTION public.ga4_set_connection(p_brand_key text, p_user_id uuid, p_grant_id uuid,
  p_property_id text, p_property_display_name text, p_property_time_zone text, p_property_currency_code text,
  p_account_display_name text)
RETURNS uuid LANGUAGE plpgsql SET search_path = public AS $$
DECLARE g ga4_grants; v_id uuid;
BEGIN
  PERFORM 1 FROM customer_brands WHERE brand_key = p_brand_key AND is_active FOR UPDATE;
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM customer_brand_memberships
      WHERE brand_key = p_brand_key AND user_id = p_user_id AND role = 'owner') THEN
    RAISE EXCEPTION 'owner_required' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO g FROM ga4_grants WHERE id = p_grant_id AND user_id = p_user_id AND status = 'active';
  IF NOT FOUND THEN RAISE EXCEPTION 'ga4_grant_not_found' USING ERRCODE = 'P0002'; END IF;
  INSERT INTO ga4_connections (brand_key, grant_id, connected_by, google_sub, connected_account_email, property_id,
                               property_display_name, property_time_zone, property_currency_code, account_display_name)
  VALUES (p_brand_key, g.id, p_user_id, g.google_sub, g.google_email, p_property_id, p_property_display_name,
          p_property_time_zone, p_property_currency_code, p_account_display_name)
  ON CONFLICT (brand_key) DO UPDATE SET grant_id = excluded.grant_id, connected_by = excluded.connected_by,
    google_sub = excluded.google_sub, connected_account_email = excluded.connected_account_email,
    property_id = excluded.property_id, property_display_name = excluded.property_display_name,
    property_time_zone = excluded.property_time_zone, property_currency_code = excluded.property_currency_code,
    account_display_name = excluded.account_display_name
  RETURNING id INTO v_id;
  UPDATE ga4_grants SET updated_at = now() WHERE id = g.id;
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION public.ga4_disconnect(p_brand_key text, p_user_id uuid)
RETURNS boolean LANGUAGE plpgsql SET search_path = public AS $$
DECLARE n integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM customer_brand_memberships
      WHERE brand_key = p_brand_key AND user_id = p_user_id AND role = 'owner') THEN
    RAISE EXCEPTION 'owner_required' USING ERRCODE = '42501';
  END IF;
  DELETE FROM ga4_connections WHERE brand_key = p_brand_key;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n > 0;
END $$;

-- Port of GoogleAccountRepository.getRemovalImpact / remove (:52-70): own grants only, atomic.
CREATE OR REPLACE FUNCTION public.ga4_grant_impact(p_user_id uuid, p_grant_id uuid)
RETURNS integer LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT count(*)::integer FROM ga4_connections c JOIN ga4_grants g ON g.id = c.grant_id
   WHERE g.id = p_grant_id AND g.user_id = p_user_id
$$;

CREATE OR REPLACE FUNCTION public.ga4_remove_grant(p_user_id uuid, p_grant_id uuid)
RETURNS jsonb LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_sub text; v_brands text[]; v_remaining integer;
BEGIN
  SELECT google_sub INTO v_sub FROM ga4_grants WHERE id = p_grant_id AND user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('removed', false); END IF;
  SELECT coalesce(array_agg(brand_key), '{}') INTO v_brands FROM ga4_connections WHERE grant_id = p_grant_id;
  DELETE FROM ga4_grants WHERE id = p_grant_id;                     -- cascades to ga4_connections
  SELECT count(*) INTO v_remaining FROM ga4_grants WHERE google_sub = v_sub;
  RETURN jsonb_build_object('removed', true, 'googleSub', v_sub, 'brands', to_jsonb(v_brands),
                            'remainingForGoogleAccount', v_remaining);
END $$;

-- Port of listUnusedGrants / deleteUnusedGrant (GoogleAccountRepository.ts:122-149).
CREATE OR REPLACE FUNCTION public.ga4_list_unused_grants(p_updated_before timestamptz, p_limit integer)
RETURNS TABLE (id uuid, user_id uuid, google_sub text)
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT g.id, g.user_id, g.google_sub FROM ga4_grants g
   WHERE g.updated_at < p_updated_before
     AND NOT EXISTS (SELECT 1 FROM ga4_connections c WHERE c.grant_id = g.id)
   ORDER BY g.updated_at LIMIT p_limit
$$;

CREATE OR REPLACE FUNCTION public.ga4_delete_unused_grant(p_id uuid, p_updated_before timestamptz)
RETURNS jsonb LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_sub text; v_remaining integer;
BEGIN
  DELETE FROM ga4_grants g WHERE g.id = p_id AND g.updated_at < p_updated_before
     AND NOT EXISTS (SELECT 1 FROM ga4_connections c WHERE c.grant_id = g.id)
  RETURNING g.google_sub INTO v_sub;
  IF v_sub IS NULL THEN RETURN jsonb_build_object('deleted', false); END IF;
  SELECT count(*) INTO v_remaining FROM ga4_grants WHERE google_sub = v_sub;
  RETURN jsonb_build_object('deleted', true, 'remainingForGoogleAccount', v_remaining);
END $$;

CREATE OR REPLACE FUNCTION public.prune_ga4_oauth_attempts()
RETURNS integer LANGUAGE sql SET search_path = public AS $$
  WITH d AS (
    DELETE FROM ga4_oauth_attempts
     WHERE expires_at < now() - interval '1 day'
        OR (consumed_at IS NOT NULL AND consumed_at < now() - interval '1 day')
    RETURNING 1)
  SELECT count(*)::integer FROM d
$$;

REVOKE ALL ON FUNCTION
  public.ga4_upsert_grant(uuid,text,text,text,text,timestamptz,text[]), public.ga4_purge_cache(text),
  public.ga4_set_connection(text,uuid,uuid,text,text,text,text,text), public.ga4_disconnect(text,uuid),
  public.ga4_grant_impact(uuid,uuid), public.ga4_remove_grant(uuid,uuid),
  public.ga4_list_unused_grants(timestamptz,integer), public.ga4_delete_unused_grant(uuid,timestamptz),
  public.prune_ga4_oauth_attempts()
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.ga4_upsert_grant(uuid,text,text,text,text,timestamptz,text[]), public.ga4_purge_cache(text),
  public.ga4_set_connection(text,uuid,uuid,text,text,text,text,text), public.ga4_disconnect(text,uuid),
  public.ga4_grant_impact(uuid,uuid), public.ga4_remove_grant(uuid,uuid),
  public.ga4_list_unused_grants(timestamptz,integer), public.ga4_delete_unused_grant(uuid,timestamptz),
  public.prune_ga4_oauth_attempts()
TO service_role;
NOTIFY pgrst, 'reload schema';
```

`scripts/setup-supabase.mjs` required objects gain the three tables and nine functions. The CI tenant RLS test gains `ga4_connections` (member reads own workspace only) and asserts `ga4_grants`/`ga4_oauth_attempts` deny `authenticated`.

### 6.2 Server modules

All TypeScript under `src/lib/ga4/`, relative imports with extensions, erasable syntax only; COPY/PORT files carry the licence header.

| File | Mode | Exports and behaviour |
|---|---|---|
| `src/shared/ga4.ts` | PORT `shared/ga4.ts`, `shared/google-link.ts` | `GA4_DATA_SCOPE`, `GA4_OAUTH_SCOPES = ["openid","email",GA4_DATA_SCOPE]` (no `profile`: we use only `sub` and `email`), `GA4_REPORT_KINDS` (7), `GA4_RANGE_PRESETS = ["last_7_days","last_28_days","last_90_days"]`, `GA4_LINK_ERROR_PARAM = "ga4_error"`, `GA4_RETURN_PATHS`, labels for kinds, breakdowns and health issues, `ga4AuthErrorCopy(code)` (§6.6.2). |
| `config.ts` | PORT `oauth-config.ts` | `getGa4OAuthConfig(env)` → `{ clientId, clientSecret, redirectUri } \| null` from `GA4_GOOGLE_CLIENT_ID`, `GA4_GOOGLE_CLIENT_SECRET`, `GA4_OAUTH_REDIRECT_URI` (trimmed); `isGa4Configured(env)` = config present and `isEncryptionConfigured()` (`../gsc/oauthCrypto.js`). Never falls back to the GSC client. |
| `oauth.ts` | PORT `googleOAuth.ts`, PATTERN `src/lib/gsc/oauthFlow.js` | `createGa4AuthorizationUrl({ admin, userId, brandKey, sessionTokenHash, returnPath })` → `{ authorizationUrl }`; `handleGa4Callback({ admin, url, userId, sessionTokenHash, fetchImpl? })` → `{ redirect: string; outcome: "linked" \| Ga4LinkErrorCode }`; `exchangeCode`, `fetchTokens` (zod `googleTokenResponseSchema`, `googleOAuth.ts:85-91`); state = `generateSecureRandom(32)`, stored as `hashValue(state)`; verifier = `generateSecureRandom(32)` encrypted with AAD `ga4:<brandKey>:verifier`; challenge = base64url SHA-256. |
| `idToken.ts` | PATTERN `googleIdToken.ts` | `readIdTokenClaims(idToken, clientId, now)` → `{ sub, email \| null }`: decodes the payload and validates `iss ∈ {"https://accounts.google.com","accounts.google.com"}`, `aud === clientId` (string or array containing it), `exp > now`, `sub` non-empty. Signature verification is skipped because the token comes straight from Google's token endpoint over TLS (OpenID Connect Core 1.0 §3.1.3.7), which avoids adding `jose`. |
| `tokens.ts` | PORT `googleOAuth.ts:337-423` | `getGa4AccessToken(admin, grant, deps)` (refresh when ≤ 60 s from expiry; `invalid_grant` → `status = 'error'`, `last_error = "Authorization revoked. Please reconnect."`, throw `Ga4TokenError`; the update is conditioned on `updated_at` so a concurrent refresh never overwrites a newer token); `revokeGoogleToken(token, fetchImpl)` (`POST https://oauth2.googleapis.com/revoke`, 10 s; 400 counts as already revoked); AAD `ga4:<userId>:<googleSub>:refresh` / `:access`. |
| `grants.ts` | PORT `GoogleAccountRepository.ts` | `upsertGrant`, `listGrantsForUser`, `getGrant`, `grantImpact`, `removeGrant`, `listUnusedGrants`, `deleteUnusedGrant`, `purgeCache(admin, brandKey)` (RPC then removes returned paths from bucket `provider-cache`). |
| `accounts.ts` | PORT `GoogleAccountService.ts`, `googleDataRetention.ts` | `getRemovalImpact`, `removeGoogleAccount(admin, userId, grantId)`, `purgeUnusedGrants(admin, { updatedBefore, limit, deadline })`, constants `UNUSED_GRANT_GRACE_MS = 86_400_000`. Token for revocation minted before deletion (`GoogleAccountService.ts:17-24`); revoke only when `remainingForGoogleAccount === 0`; revoke failures logged as `[ga4] revoke failed` (status only). |
| `client.ts` | PORT `ga4Client.ts` | `createGa4AdminClient({ getToken, fetchImpl })` (`getUserInfoEmail`, `listProperties`, `getProperty`, `listDataStreams`, `getEnhancedMeasurementSettings`, `listKeyEvents`, `listCustomDimensions`, `listCustomMetrics`), `createGa4DataClient({ getToken, propertyId, fetchImpl })` (`runReport`). Zod schemas copied. Added: per-property in-process semaphore (4); one retry after 500 ms on 5xx/network (free reads); `AbortSignal.timeout(30_000)`; quota-low detection. |
| `errors.ts` | COPY `ga4Errors.ts` + new | Classes as theirs (constructor parameter properties rewritten as fields for erasable syntax); `ga4ErrorToAppError(err)` (§6.5.2). |
| `dates.ts` | COPY `Ga4Dates.ts` | `shiftGa4Date`, `ga4DateInTimeZone`, `inclusiveGa4Days`; new `presetRange(preset, timeZone, now)`. |
| `reportDefinitions.ts` | COPY `Ga4ReportDefinitions.ts` | `buildGa4ReportRequest`, `getGa4ReportConfiguration`, `buildGa4OverviewRequest`, `OVERVIEW_METRICS`. |
| `normalization.ts` | COPY `Ga4ReportNormalization.ts` | `normalizeGa4Response`. |
| `enhancements.ts` | COPY `Ga4ReportEnhancements.ts` | `previousPeriod`, `supportsComparison`, `needsCompleteReport`, `buildReportComparison`, `buildReportSpecificEnhancements`, `comparisonValue`, `COMPLETE_REPORT_LIMIT`. |
| `connection.ts` | PORT `Ga4Service.ts`, `Ga4ConnectionRepository.ts` | `getConnection(admin, brandKey)`, `getGa4ConnectionState(admin, ws)` (for F27 and the status route), `listPropertiesForUser(admin, userId)`, `setProperty(admin, ws, { grantId, propertyId })`, `disconnect(admin, ws)`, `requireUsableConnection(admin, brandKey)` (throws `ga4_not_connected`, or `ga4_reconnect_required` when the connector is no longer a member or the grant is in `error`). |
| `reporting.ts` | PORT `Ga4ReportingService.ts` | `resolveGa4DateRange`, `mapGa4ReportError`, `runReport(admin, ws, input)` wrapped in `cached()` (§6.4). |
| `overview.ts` | PORT `Ga4OrganicOverviewService.ts` + `serverFunctions/ga4.ts:57-89` | `getOrganicOverview(admin, ws, input)`; `fillDailySessions` applied only when complete and not limited. |
| `measurementHealth.ts` | PORT `Ga4MeasurementHealthService.ts` | `getMeasurementHealth(admin, ws)`. |
| `gscPages.ts` | new | `fetchGscPageRows(admin, brandKey, { startDate, endDate })`: reads `gsc_connections` (`brand_key`, `enabled`, `auth_mode`, `site_url`, `connection_generation`); not enabled or `auth_mode !== 'oauth'` → `AppError(409,"gsc_not_connected")`; one `gscFetchForBrand(site_url, { method: "POST", body: JSON.stringify({ startDate, endDate, dimensions: ["page"], rowLimit: 1000, startRow: 0, type: "web", dataState: "final" }) }, { brandKey, admin, authMode: "oauth" })`; rows parsed with `z.looseObject({ keys: z.array(z.string()), clicks, impressions, ctr, position })`; errors whose message contains "access denied" → `gsc_reconnect_required`, "HTTP 429" → `gsc_quota_exhausted`, others → `gsc_unavailable`. Read-only: no write to any GSC table. |
| `opportunities.ts` | PORT `SearchOpportunityService.ts` | `getOpportunities(admin, ws, input)`, `normalizePageKey`, `percentileRanks` (unchanged). |
| `retention.ts` | new | Job `ga4.retention` (§6.3). |
| `telemetry.ts` | new | `captureGa4Event(name, props)` → F26 sink when present, else no-op. |
| `tools.ts` | PATTERN `google-analytics-tools.ts` | §6.2.2. |
| `ga4.contract.ts` | new | Contracts for §6.5. |

#### 6.2.1 OAuth details

- **Start** (`createGa4AuthorizationUrl`): sweeps nothing (pruning is the daily job); inserts the attempt; URL `https://accounts.google.com/o/oauth2/v2/auth` with `client_id`, `redirect_uri`, `response_type=code`, `scope="openid email https://www.googleapis.com/auth/analytics.readonly"`, `access_type=offline`, `prompt="select_account consent"`, `state`, `code_challenge`, `code_challenge_method=S256`.
- **Callback** order (port of `googleOAuth.ts:243-329` onto our attempt rows): (1) no session → redirect `/login?next=/portal/settings/integrations`; (2) `state` missing or no attempt for `hashValue(state)` → `state_mismatch`; (3) compare-and-set `consumed_at` (`… is("consumed_at", null).gt("expires_at", now)`) — no row → `state_mismatch` (the state is burned even if later checks fail); (4) `attempt.user_id !== userId` or session hash differs → `state_mismatch`; (5) membership role not owner → `owner_required`; (6) Google `error` param → that code (`access_denied`, others → `oauth_failed`); no `code` → `missing_code`; (7) token exchange with `code_verifier` (decrypted) — non-2xx or schema failure → `oauth_code_verification_failed`; (8) `tokens.scope` present and not containing `GA4_DATA_SCOPE` → `scope_not_granted` (nothing stored); (9) `readIdTokenClaims` failure → `oauth_code_verification_failed`; (10) encrypt tokens, `ga4_upsert_grant` → failure `connection_save_failed`; (11) redirect `<returnPath>?ga4=linked`. Error redirects are `<returnPath>?ga4_error=<code>`. Logs: `[ga4] link outcome=<code>` only.
- Grants are per user: linking is a personal action, but only owners may start it from a workspace (they are the ones who will choose the property).

#### 6.2.2 Tools (`src/lib/ga4/tools.ts`)

Shape of F07 §6.2.8; handler context `{ admin, brand, userId }`; all read-only and free; descriptions start with the report name and end "Read-only. Free. Requires Google Analytics to be connected in Workspace settings." Inputs are `z.strictObject` with `startDate?`/`endDate?` (`YYYY-MM-DD`, both or neither), `limit` (1–1,000, default 100) and `offset` where relevant, plus the kind's options (`channel`, `includeDate`, `breakdown`, `acquisitionBreakdown`, `ecommerceBreakdown`, `ecommerceOnlyWithTransactions`, `audienceBreakdown`, `comparePreviousPeriod`). Outputs `z.looseObject` of the route payloads. Names (OpenSEO's, `google-analytics-tools.ts:514-839`): `get_google_analytics_organic_overview`, `get_google_analytics_organic_landing_pages`, `get_google_analytics_page_performance`, `get_google_analytics_key_events`, `get_google_analytics_traffic_acquisition`, `get_google_analytics_ecommerce_performance`, `get_google_analytics_site_search`, `get_google_analytics_audience_breakdown`, `get_google_analytics_measurement_health`, `get_search_opportunities` (input `{ startDate?, endDate?, limit: 1..100 default 50 }`; description adds "Ranks pages at Search Console positions 4–20 by demand, business value and reachability. Requires Search Console too.").

#### 6.2.3 Registrations

- `src/lib/features/names.ts`: `ga4: { spend: [] as const }`; `src/lib/features/clientFeatures.ts` appends `"ga4"`.
- `src/components/portal/settings/tabs.ts`: `{ href: "/portal/settings/integrations", label: "Integrations", flag: "ga4", ownerOnly: false }`.
- `src/components/app/navigation/items.ts`: group `site`, `{ id: "analytics", label: "Analytics", href: "/portal/analytics", icon: ChartColumn, flag: "ga4" }` (conventions §12).
- `src/lib/jobs/kinds.ts`: `import "../ga4/retention.ts";`.
- `src/lib/query/keys.ts`: `ga4Connection(brandKey)`, `ga4Properties(brandKey)`, `ga4Accounts(brandKey)`, `ga4Overview(brandKey, range)`, `ga4Report(brandKey, kind, paramsHash)`, `ga4Health(brandKey)`, `ga4Opportunities(brandKey, range)`.
- Telemetry names (F26 registers them in `src/lib/telemetry/events.ts`; until then no-op sinks `src/components/portal/analytics/telemetry.ts` (exports `setGa4EventTracker(fn)`; no-op until F26 wires it, F26 §6.2.7) and `src/lib/ga4/telemetry.ts` (exports `setGa4ServerTracker(fn)`; no-op until F26 wires it, F26 §6.2.7)): client `ga4:link_start { return_path }`, `ga4:property_select {}`, `ga4:disconnect {}`, `ga4:account_remove { workspaces }`, `ga4:tab_view { tab }`, `ga4:range_change { range }`; server `ga4:link_complete { outcome }`, `ga4:report_view { kind, cached, limited }`, `ga4:opportunities_view { rows, matched, engagement_fallback, cached }`.
- `.env.example`: `FEATURE_GA4=`, `FEATURE_GA4_BRANDS=`, `GA4_GOOGLE_CLIENT_ID=`, `GA4_GOOGLE_CLIENT_SECRET=`, `GA4_OAUTH_REDIRECT_URI=`.

### 6.3 Jobs

| Kind / periodic | Trigger | Steps | Result |
|---|---|---|---|
| periodic `ga4.retention` (86,400 s) | F01 `definePeriodic` | `enqueueSystemJob("ga4.retention", {}, { dedupeKey: "ga4.retention:" + YYYY-MM-DD })` | — |
| `ga4.retention` | system | `purge-1`…`purge-10` (`{ timeoutMs: 120_000, retries: 1 }`; revocation is a free, idempotent call): `purgeUnusedGrants({ updatedBefore: now − 24 h, limit: 50, deadline: step start + 100 s })`, stop when fewer than 50 were listed; `prune-attempts` (`DB_STEP`): `prune_ga4_oauth_attempts()` | `{ purged, revoked, attempts }` |

Reports run inside requests (`maxDuration = 60`): at most three parallel Data API calls (overview) or two (report + previous period) plus one Search Console call (opportunities). No job is needed for live reads.

### 6.4 Provider calls, cost, caching and quota

| Call | Endpoint | Used by | Cost | Retries |
|---|---|---|---|---|
| Token exchange / refresh | `POST https://oauth2.googleapis.com/token` | callback, `getGa4AccessToken` | free | 0 (exchange); refresh 0 (the next request refreshes again) |
| Revoke | `POST https://oauth2.googleapis.com/revoke` | removal, purge | free | job step retry 1 |
| User info | `GET https://openidconnect.googleapis.com/v1/userinfo` | property list (email), as `ga4Client.ts:15` | free | 1 on 5xx |
| Admin API | `GET https://analyticsadmin.googleapis.com/v1beta/accountSummaries`, `/v1beta/properties/{id}`, `/v1alpha/properties/{id}/dataStreams`, `/v1alpha/{stream}/enhancedMeasurementSettings`, `/v1beta/properties/{id}/keyEvents`, `/customDimensions`, `/customMetrics` | picker, set property, health | free | 1 on 5xx/network; none on 4xx/429 |
| Data API | `POST https://analyticsdata.googleapis.com/v1beta/properties/{id}:runReport` | reports, overview, opportunities | free; consumes the property's quota tokens | same |
| Search Console | `POST https://www.googleapis.com/webmasters/v3/sites/{site}/searchAnalytics/query` via `gscFetchForBrand` | opportunities | free | none (existing function) |

**Caching decision.** OpenSEO queries GA4 live per request (§2 fact 19). F20 also queries live, but wraps each result in F01 `cached()` with a short TTL, because (a) the Data API meters every property by hourly and daily token quotas that the customer's own Analytics usage shares, (b) our page issues 3 requests for the overview and 1–2 per tab, and members switch tabs and ranges often, and (c) every range ends on the last **complete** day, so a 15-minute-old answer is identical to a fresh one for the whole day except right after midnight in the property's time zone. Settings:

| Namespace | Version | TTL | `keyParts` |
|---|---|---|---|
| `ga4.overview` | 1 | 900 s | `[connection.id, property_id, connection.updated_at, startDate, endDate, trend]` |
| `ga4.report` | 1 | 900 s | `[connection.id, property_id, connection.updated_at, kind, stableStringify(normalisedParams)]` |
| `ga4.health` | 1 | 3,600 s | `[connection.id, property_id, connection.updated_at]` |
| `ga4.opportunities` | 1 | 900 s | `[connection.id, property_id, connection.updated_at, gsc.site_url, gsc.connection_generation, startDate, endDate, limit]` |

All `scope: "workspace"` with `brandKey`; schemas are `z.looseObject` of each result; a fetcher that throws caches nothing (F01). Responses carry `dataAsOf` = `fetchedAt` and `cached: boolean`. The workspace's `ga4.*` rows are deleted on property change, disconnect and account removal (`ga4_purge_cache`); otherwise F01's `cache.retention` deletes them 7 days after expiry. The property list and token calls are never cached.

**Quota handling.** Google's GA4 Data API limits for a standard property (as documented by Google; not re-verified here): 200,000 tokens per day, 40,000 per hour, 14,000 per project per property per hour, 10 concurrent requests. F20: a per-property semaphore of 4 concurrent Data API requests per function instance; `returnPropertyQuota: true` on every request; when `tokensPerHour.remaining / (consumed + remaining) < 0.1` the response gains warning `quota_low`; HTTP 429 → `ga4_quota_exhausted` (route 429, `Retry-After` header when Google sent one, capped at 86,400); the client never retries a 429 automatically (F05 global rule) and shows the copy of §6.6.3; no request is retried on 4xx. Search Console quota (per site, per minute) is far above one call per 15 minutes per workspace.

**Fixtures** (`tests/fixtures/f20/`, synthetic, in Google's documented shapes): `token-exchange.json` (fake tokens `ya29.EXAMPLE-NOT-A-REAL-TOKEN`, an unsigned test `id_token`), `token-exchange-no-scope.json`, `refresh-invalid-grant.json`, `account-summaries-page1.json`, `account-summaries-page2.json`, `property.json`, `data-streams.json`, `enhanced-measurement.json`, `key-events.json`, `custom-dimensions.json`, `custom-metrics.json`, `run-report-landing-pages.json`, `run-report-overview-current.json`, `run-report-overview-previous.json`, `run-report-overview-trend.json`, `run-report-limited.json` (thresholded), `run-report-headerless.json`, `run-report-429.json`, `gsc-pages.json`. No test reaches Google (conventions §6.5).

### 6.5 API routes

Common: all under `src/app/api/customer/ga4/`; `requireWorkspace` (members unless "owner"); `isFeatureEnabled("ga4", brandKey)` false → 404 `feature_unavailable` "This page is not available for your workspace yet."; `toErrorResponse`; `Cache-Control: no-store`; `dynamic = "force-dynamic"`; `maxDuration = 60`; database errors → 503 `ga4_unavailable` "Google Analytics data is unavailable right now. Please retry."; contracts in `src/lib/ga4/ga4.contract.ts`.

#### 6.5.1 Connection, OAuth and accounts

| Method and path | Auth | Request | Response 200/201 (example) | Extra errors |
|---|---|---|---|---|
| `GET /api/customer/ga4` | member | query `{ brand_key? }` | `{ "connected": true, "configured": true, "canManage": true, "currentUserHasGrant": true, "connectorIsMember": true, "grantStatus": "active", "property": { "id": "properties/123456789", "displayName": "Offcult India", "timeZone": "Asia/Kolkata", "currencyCode": "INR", "accountDisplayName": "Offcult" }, "connectedByEmail": "owner@example.com", "connectedAt": "2026-10-22T09:00:00.000Z" }` (`property: null` when not connected) | — |
| `POST /api/customer/ga4/connect` | owner | `z.strictObject({ brand_key?, returnTo: z.enum(["/portal/settings/integrations","/portal/analytics","/onboarding"]).default("/portal/settings/integrations") })` | `{ "authorizationUrl": "https://accounts.google.com/o/oauth2/v2/auth?…" }` | 403 `owner_required`; 503 `ga4_not_configured` "Google Analytics isn't set up on this deployment yet."; 401 `session_expired` "Your login session expired. Please sign in again." |
| `GET /api/customer/ga4/callback` | session | Google query params | 303 redirect (§6.2.1) | — (errors become `?ga4_error=`) |
| `GET /api/customer/ga4/properties` | owner | query `{ brand_key? }` | `{ "accounts": [ { "grantId": "…", "email": "owner@example.com", "requiresReconnect": false, "propertiesUnavailable": false, "properties": [ { "propertyId": "properties/123456789", "displayName": "Offcult India", "accountDisplayName": "Offcult", "isSelected": true } ] } ] }` | — |
| `POST /api/customer/ga4/property` | owner | `z.strictObject({ brand_key?, grantId: z.uuid(), propertyId: z.string().regex(/^properties\/\d{1,20}$/) })` | 201 same shape as `GET /api/customer/ga4` | 404 `ga4_grant_not_found` "That Google account isn't linked to your Perceev account."; 404 `ga4_property_not_found` "That Google Analytics property isn't available on your linked Google account."; 409 `ga4_reconnect_required` |
| `DELETE /api/customer/ga4` | owner | `z.strictObject({ brand_key? })` | `{ "connected": false }` | — |
| `GET /api/customer/ga4/accounts` | member | query `{ brand_key? }` | `{ "accounts": [ { "grantId": "…", "email": "owner@example.com", "status": "active", "linkedAt": "…", "workspaces": 2 } ] }` (the caller's own grants) | — |
| `DELETE /api/customer/ga4/accounts/[grantId]` | member (own grant) | `z.strictObject({ brand_key?, confirmed: z.literal(true) })` | `{ "removed": true, "workspacesDisconnected": 2 }` | 404 `ga4_grant_not_found` |

#### 6.5.2 Reports

| Method and path | Query (strict; coerced) | Response (abridged example) |
|---|---|---|
| `GET /api/customer/ga4/overview` | `brand_key?`, `range?: enum(GA4_RANGE_PRESETS)` default `last_28_days`, or `startDate`+`endDate` (`YYYY-MM-DD`), `trend: "daily"\|"weekly"` default `daily` | `{ "status": "ok", "request": { "resolvedDateRange": { "startDate": "2026-09-24", "endDate": "2026-10-21" }, "previousDateRange": { … }, "propertyTimeZone": "Asia/Kolkata", "currencyCode": "INR", "channel": "organic_search", "trend": "daily" }, "current": { "sessions": 4210, "activeUsers": 3022, "engagedSessions": 2650, "engagementRate": 0.629, "keyEvents": 88, "transactions": 12, "purchaseRevenue": 96400 }, "previous": { … }, "comparison": { "sessions": { "current": 4210, "previous": 3900, "absoluteChange": 310, "percentChange": 0.0795 } }, "trend": [ { "date": "2026-09-24", "sessions": 140 } ], "trendFilled": true, "diagnostics": [], "reportMetadata": { "hasLimitedData": false }, "warnings": [], "dataAsOf": "2026-10-22T09:00:00.000Z", "cached": false }` |
| `GET /api/customer/ga4/reports/[kind]` (`kind` ∈ 7 kinds) | `brand_key?`, `range?`/`startDate`+`endDate`, `channel: "organic_search"\|"all"` (default `organic_search`; `traffic_acquisition` defaults to `all`), `limit` 1–1,000 (default 100), `offset` ≥ 0, and per kind: `includeDate` (page_performance), `breakdown` (key_events), `acquisitionBreakdown`, `ecommerceBreakdown`, `ecommerceOnlyWithTransactions`, `audienceBreakdown`, `comparePreviousPeriod` | OpenSEO's `runReport` result (`Ga4ReportingService.ts:331-365`): `status`, `source`, `request`, `rowCount`, `totalRowCount`, `rows`, `pageInfo`, `reportMetadata`, `quota`, `warnings`, `diagnostics`, optional `comparison`, `ecommerceActivity`, `siteSearchActivity`, plus `dataAsOf`, `cached` |
| `GET /api/customer/ga4/health` | `brand_key?` | OpenSEO's measurement-health result (`Ga4MeasurementHealthService.ts:61-90`) + `dataAsOf`, `cached` |
| `GET /api/customer/ga4/opportunities` | `brand_key?`, `range?`/`startDate`+`endDate`, `limit` 1–100 (default 50) | OpenSEO's opportunities result (`SearchOpportunityService.ts:246-290`): `rows[{ page, normalizedPage, clicks, impressions, ctr, position, joinStatus, ga4, score, scoreComponents }]`, `scoring`, `coverage`, `truncated`, `warnings`, `request`, `source`, plus `dataAsOf`, `cached` |

Error mapping (`ga4ErrorToAppError`; messages exact):

| Code | Status | Message | Recovery |
|---|---|---|---|
| `invalid_request` (`validation_error`) | 400 | the validation message | — |
| `ga4_not_connected` | 409 | "Google Analytics isn't connected for this workspace." | "Connect it in Workspace settings." |
| `ga4_reconnect_required` | 409 | "The Google Analytics connection has expired or was revoked." — or, connector left: "The person who connected Google Analytics is no longer in this workspace." | "Reconnect Google Analytics in Workspace settings." |
| `ga4_property_inaccessible` | 409 | "The connected Google account can no longer read this property." | "Choose another property in Workspace settings." |
| `ga4_report_incompatible` | 422 | "This report isn't available for this Google Analytics property." | — |
| `ga4_quota_exhausted` | 429 | "Google Analytics' reporting quota for this property is used up." | "Try again later." (`details.retryAfterSeconds` when known) |
| `ga4_upstream_unavailable` | 503 | "Google Analytics is unavailable right now." (Data API disabled: "The Google Analytics Data API isn't enabled for Perceev's Google project.") | "Please retry." |
| `ga4_malformed_response` | 502 | "Google Analytics returned a report we couldn't read." | "Please retry." |
| `gsc_not_connected` | 409 | "Connect Search Console to see search opportunities." | — |
| `gsc_reconnect_required` | 409 | "Search Console access was lost. Reconnect it on the Search Console page." | — |
| `gsc_quota_exhausted` | 429 | "Search Console's quota is used up for now." | "Try again later." |
| `gsc_unavailable` | 503 | "Search Console is unavailable right now." | "Please retry." |

### 6.6 UI

Built from F04, F05 and F06 components named in the header; Recharts 3 through F04 `chart`. Components in `src/components/portal/analytics/` (page) and `src/components/portal/settings/integrations/` (settings); hooks in `…/hooks/`. Money formatted with `Intl.NumberFormat(undefined, { style: "currency", currency: property.currencyCode })`; rates as percentages with one decimal; "—" for `null` (never 0).

#### 6.6.1 Routes and navigation

| Path | File | Renders |
|---|---|---|
| `/portal/analytics` | `src/app/portal/analytics/page.tsx` | `AnalyticsPage` |
| `/portal/settings/integrations` | `src/app/portal/settings/integrations/page.tsx` | `IntegrationsSettings` |

Sidebar "Analytics" (My Site, flag `ga4`); settings tab "Integrations" (flag `ga4`). Flag off → F04 `NotFound`.

#### 6.6.2 Settings → Integrations (`IntegrationsSettings.tsx`)

Three cards, `space-y-8`:

1. **`Ga4ConnectionCard`** (PORT of `GoogleConnectionCard.tsx:31-281` for one provider; section `id="google-analytics"`; `CardShell title="Google Analytics"` with the Analytics logo and a status pill "Connected" / "Not connected" / "Setup required"). Props (frozen; F27 renders it in onboarding): `{ brandKey: string; returnTo: string /* path the OAuth callback returns to, must start with "/portal/" */; onConnectClick?: () => void /* called before redirecting to Google, for telemetry */ }`):

| State | Content (exact copy) |
|---|---|
| Loading | `Skeleton h-4 w-2/3` + `Skeleton h-9 w-24`, `role="status" aria-label="Loading connection"` |
| Error | `QueryError` "Couldn't check this workspace's Google Analytics connection." + "Retry" |
| Not configured | `Alert warning` "Google Analytics isn't set up on this deployment yet." |
| Link error (`?ga4_error=`) | `Alert destructive` from `ga4AuthErrorCopy(code)`: `state_mismatch` — "Google Analytics connection didn't finish" / "The attempt expired or was interrupted. Try again in a single browser tab and finish the Google steps within 10 minutes."; `access_denied` — "Google Analytics connection was cancelled" / "Google's permission screen was closed or declined. Try again whenever you're ready."; `scope_not_granted` — "Google Analytics connection is missing a permission" / "Perceev didn't get access to your Analytics data because a box on Google's permission screen wasn't ticked. Try again and tick every box."; `owner_required` — "Only the workspace owner can connect Google Analytics" / "Ask the owner to connect it."; `connection_save_failed` — "Google Analytics connection didn't finish" / "We couldn't save the connection. Please try again."; any other — "Google Analytics connection didn't finish" / "Something went wrong while talking to Google. Please try again." (PORT of `googleAuthErrorCopy.ts:11-48`). The param is removed from the URL after display. |
| Not connected, no grant (owner) | "Connect Google Analytics to see organic traffic and conversions for {website_host}." + `Button` with Google glyph "Connect" (pending "Opening Google…") |
| Not connected (member) | "Connect Google Analytics to see organic traffic and conversions for {website_host}." + `PermissionHint` "Only the workspace owner can connect Google Analytics." |
| Grant, not connected (owner) | "Choose a Google Analytics property to finish connecting this workspace. Choose within 24 hours, or you'll need to connect again." + "Choose property" |
| Picker | PORT of `GooglePropertyPicker.tsx`: one section per linked account (email, or "Google account · {last 6 of id}"); property rows "{displayName}" with detail "{accountDisplayName} · {numeric id}"; search field "Search properties" when more than 8; selected row check mark; account needing reconnection: "This Google account needs to be reconnected." + "Reconnect"; account whose list failed: "Couldn't load properties for this account." + "Retry"; account with none: "This Google account can't read any Google Analytics properties."; footer "Add another Google account" (starts the flow), "Cancel", "Save property" (disabled until a selectable property is chosen; pending "Saving…") |
| Connected | property display name (`font-semibold`), "ID {numeric id}", "{email} · connected {MMM d, yyyy}"; owner buttons "Change property or account" (outline) and "Disconnect" (destructive, pending "Disconnecting…") |
| Connector left workspace | `Alert warning` "The person who connected Google Analytics is no longer in this workspace. Reconnect it to keep seeing data." + owner button "Reconnect" |
| Grant in error | `Alert warning` "The Google Analytics connection has expired or was revoked." + owner button "Reconnect" |

Disconnect → `ConfirmDialog` "Disconnect Google Analytics?" / "This workspace stops showing Analytics data and its cached reports are deleted. Your Google account stays linked to Perceev until you remove it below." / "Disconnect". Success toasts: "Google Analytics connected", "Google Analytics disconnected from this workspace".

2. **`GoogleAccountsCard`** (`CardShell title="Your linked Google accounts"`, description "Google accounts you linked for Google Analytics. Removing one disconnects every workspace that uses it."): rows email, "Linked {date}", "Used by {n} workspace(s)", status badge "Needs reconnecting" when `error`, `RowActionsMenu` "Remove". Empty: "You haven't linked a Google account." Remove → dialog (PORT of `GoogleAccountRemovalDialog.tsx:78-134`): title "Remove Google account?", description "This removes the account's Google Analytics connection from Perceev. You can reconnect it anytime.", the email, impact "Checking connected workspaces…" / "This will also disconnect Google Analytics from {n} workspace(s)." / "No workspaces will be affected." / error "Couldn't check connected workspaces." + "Try again"; buttons "Cancel" and "Remove account" (pending "Removing…"); toast "Google account removed".

3. **`SearchConsoleNote`** (`CardShell title="Google Search Console"`): "Search Console is connected on its own page." + link "Open Search Console" → `/portal/search-console`. No other Search Console UI here (deferred Mixed row).

Phone: cards full width; picker list scrolls inside the card; dialog full screen below 640 px.

#### 6.6.3 `/portal/analytics` (`AnalyticsPage.tsx`; layout PATTERN of `SearchPerformancePage.tsx:217-354`)

Header: `PageHeader title="Analytics" description="Organic search traffic and conversions from Google Analytics 4, joined with Search Console."`; when connected, actions: property name (muted) and link "Change property" → `/portal/settings/integrations#google-analytics` (owners; members see the property name only).

| Page state | Content |
|---|---|
| Loading connection | `SkeletonPage` |
| Not connected / not configured / reconnect / connector left | `Ga4ConnectionCard` (max-w-2xl) with `returnTo="/portal/analytics"` |
| Connected | toolbar + overview + tabs |

**Toolbar:** `Select` "Date range" — "Last 7 days", "Last 28 days" (default), "Last 90 days" (URL `?range=`); muted "Data as of {h:mm a}" (from `dataAsOf`); `quota_low` → small warning text "Google Analytics' hourly quota for this property is almost used up."

**Overview** (`OrganicOverviewCard.tsx`, PORT of `Ga4Card.tsx:43-180`; `CardShell title="Organic search traffic"` sub "Google Analytics · {start} – {end} vs the previous {n} days"): `MetricsTable showChange` rows Sessions, Active users, Engaged sessions, Engagement rate, Key events, Transactions, Revenue — change "+x%"/"−x%" coloured, "—" when either value is null or previous is 0; Recharts `AreaChart` of daily (or weekly) sessions, `h-32`, tooltip "{date}: {n} sessions"; when `trendFilled` is false the series has gaps (`connectNulls={false}`) and a note "Days without data from Google Analytics are left blank." States: loading skeleton rows + `Skeleton h-32`; error by code (below); no sessions → "No organic search traffic recorded in this period."; `key_events_sharp_decline` → `Alert warning` "Organic key events fell {pct}% compared with the previous {n} days ({previous} → {current})."; `hasLimitedData` → `Alert` (info) "Google Analytics limited this report (sampling, thresholding or an “(other)” row), so numbers may be lower than in Analytics."

**Tabs** (`DataTableTabs`, URL `?tab=`, default `opportunities`; each with `ExportMenu actions={["sheets","csv","excel","json"]}` over the loaded rows, `feature: "ga4_<tab>"`):

| Tab | Controls | Columns | Empty / special states |
|---|---|---|---|
| Opportunities | — | Page (path, `ExternalUrlCell`), Score (`ScoreBadge`; "—" for unmatched), Position (1 dp), Impressions, Clicks, CTR, Organic sessions, Engagement rate, Key event rate, Match ("Matched" / "Search Console only"); row expands to "Demand {d} · Business value {b} · Reachability {r}" (0–100 each) | Intro: "Pages ranking 4–20 on Google, scored by search demand (50%), business value (30%) and how close they are to the top (20%)." Footer: "{matched} of {candidates} pages ranking 4–20 matched an Analytics landing page." `engagementFallback` → "None of these pages recorded key events, so business value uses engagement rate." `truncated.gsc` → "Search Console returned 1,000 pages, the most one request allows, so lower-traffic pages are not included." `source_time_zones_differ` → "Search Console reports days in Pacific Time; this property uses {tz}, so days may not line up exactly." `gsc_not_connected` → `EmptyState` "Connect Search Console to see search opportunities." + link "Open Search Console". No candidates → "No pages rank between positions 4 and 20 in this period." |
| Landing pages | Channel `SegmentedToggle` "Organic search" / "All traffic" | Landing page, Sessions, Active users, Engaged sessions, Engagement rate, Key events, Key event rate, Transactions, Revenue | "No landing pages recorded in this period." |
| Pages | Toggle "By day" (`includeDate`) | Page path, (Date), Views, Active users, Avg. engagement time (`userEngagementDuration / activeUsers`, "—" when 0 users), Key events | "No page views recorded in this period." |
| Key events | Toggle "By landing page"; checkbox "Compare with previous period" (only when breakdown is by event) | Event, Key events, Users (+ Previous, Change when comparing) | "No key events were recorded in this period. Check Setup health to see whether any are configured." |
| Acquisition | `Select` "Channel group" / "Source / medium" / "Campaign"; compare checkbox for channel group | Channel / Source / medium / Campaign, Sessions, Active users, Engaged sessions, Engagement rate, Key events, Transactions, Revenue | diagnostics as `Alert`s: `attribution_not_set_share_high` "{pct}% of sessions have no source/medium attribution."; `internal_referral_traffic_detected` "Traffic from local or private-network addresses appears in your acquisition data."; `source_medium_case_variants_detected` "Some sources differ only by letter case, which splits their numbers." |
| E-commerce | `SegmentedToggle` "Items" / "Landing pages"; checkbox "Only pages with purchases" | Items: Item, Item ID, Viewed, Added to cart, Purchased, Item revenue; Landing pages: Landing page, Sessions, Transactions, Revenue | activity `none` → `EmptyState` "No e-commerce activity was reported for this period."; `unknown` → info "This report is incomplete or limited, so we can't tell whether there was e-commerce activity." |
| Site search | — | Search term, Searches, Users, Sessions, Engaged sessions, Engagement rate | `none` → "No site searches were recorded in this period. Site search tracking may be off; see Setup health." |
| Audience | `SegmentedToggle` "Device" / "Country" / "New vs returning"; compare checkbox for device and new vs returning | Segment, Active users, Sessions, Engagement rate, Key events | "No visitors recorded in this period." |
| Setup health | — | Summary counts (streams, web streams, key events, custom dimensions, custom metrics); issue list; web streams table (Name, Measurement ID, URL, Enhanced measurement on/off, Site search on/off); key events list | Intro "Perceev only reads these settings. Change them in Google Analytics." Issues copy: `no_web_stream` "This property has no web data stream, so it isn't collecting website data."; `enhanced_measurement_disabled` "Enhanced measurement is off for every web stream, so scrolls, outbound clicks and site search aren't tracked."; `site_search_measurement_disabled` "Site search tracking is off."; `no_key_events_configured` "No key events are configured, so conversions can't be measured. Mark your important events as key events in Google Analytics." None → "No setup problems found." |

Per-tab states: loading `SkeletonTableRows rows={8} columns={6}`; data refetch keeps the previous rows with a small spinner (F05 `keepPreviousData`); `hasLimitedData` → the same info `Alert` as the overview; pagination (`TablePagination`, 100 rows, server `offset`) when `pageInfo.hasMore`. Error by code (overview and tabs): `ga4_reconnect_required` → `Alert warning` with the message + owner "Reconnect" (members: "Ask the workspace owner to reconnect Google Analytics."); `ga4_property_inaccessible` → message + owner link "Choose another property"; `ga4_quota_exhausted` → `Alert warning` "Google Analytics' reporting quota for this property is used up. Try again in about {ceil(retryAfterSeconds / 60)} minutes." (or "Try again later." when unknown), no Retry button; `ga4_report_incompatible` → `EmptyState` "This report isn't available for this property."; others → `QueryError` "Couldn't load this report from Google Analytics." + "Retry".

Accessibility: the chart has an `aria-label` summary ("Organic sessions per day, {start} to {end}") and the table is the accessible source of truth; tabs are keyboard reachable; change values carry "increase"/"decrease" text for screen readers. Phone (< 640 px): toolbar wraps; metrics table single column; tabs scroll horizontally; tables scroll inside the card; no horizontal page scroll.

### 6.7 Permissions, privacy, observability

- **Who can do what:** members read reports and see the connection; owners connect, choose a property and disconnect; each user lists and removes only their own linked Google accounts; the callback re-checks owner role and session binding.
- **Scopes:** `openid email analytics.readonly` only. Perceev never writes to Google Analytics or Search Console.
- **Secrets:** refresh/access tokens encrypted (AES-256-GCM via `src/lib/gsc/oauthCrypto.js`, key `GSC_TOKEN_ENCRYPTION_KEY`, AAD `ga4:<userId>:<googleSub>:refresh|access`); PKCE verifier encrypted (AAD `ga4:<brandKey>:verifier`); state stored only as a hash; tokens and Google error bodies are never returned or logged. A key rotation makes stored tokens unreadable → grants show "Needs reconnecting".
- **Data retention:** Analytics report data is not stored except in the workspace-scoped cache (15 minutes to 1 hour TTL, deleted on disconnect/property change/account removal, otherwise pruned by F01 within 7 days after expiry). Grants not bound to any workspace for 24 hours are deleted and revoked (§2 fact 6 explains the rule). OAuth attempts are pruned after a day. Deleting a Perceev user deletes their grants by cascade; Google-side revocation then depends on the user (risk 6).
- **Logs** (no tokens, codes, states, verifiers, report rows, property names, emails): `[ga4] link outcome=<code>`, `[ga4] report brand=<key> kind=<kind> cached=<bool> status=<code|ok>`, `[ga4] refresh failed reason=<invalid_grant|http_<n>>`, `[ga4] revoke failed status=<n>`, `[ga4.retention] purged=<n> revoked=<n> attempts=<n>`.
- **PostHog:** §6.2.3 names; properties never include property ids, URLs or emails.

## 7. Code reuse map

| OpenSEO source | Perceev target | Mode | Adaptation notes |
|---|---|---|---|
| `openseo:src/server/features/google/googleOAuth.ts` (+ `googleOAuth.test.ts`) | `src/lib/ga4/{oauth,tokens}.ts` (+ tests) | PORT | Better Auth `account` rows → `ga4_grants`; their verification-table state → `ga4_oauth_attempts` with our GSC flow's hashed state, session binding and encrypted verifier; Analytics only; own OAuth client; 60 s refresh skew. |
| `openseo:src/server/features/google/googleOAuthState.ts` | `src/lib/ga4/oauth.ts` | PATTERN | Single-use state kept; HMAC verifier replaced by an encrypted random verifier (as `src/lib/gsc/oauthFlow.js:42-56`). |
| `openseo:src/server/features/google/oauth-config.ts` | `src/lib/ga4/config.ts` | PORT | `GOOGLE_CLIENT_*` → `GA4_GOOGLE_CLIENT_*` + redirect URI. |
| `openseo:src/server/features/google/googleIdToken.ts` | `src/lib/ga4/idToken.ts` | PATTERN | Claims check without JWKS (OIDC Core §3.1.3.7); no `jose`. |
| `openseo:src/server/features/google/{GoogleAccountService,GoogleAccountRepository}.ts` (+ test) | `src/lib/ga4/{accounts,grants}.ts`, `136` functions (+ tests) | PORT | Drizzle → SQL functions; projects → workspaces; Analytics only. |
| `openseo:src/server/features/google/googleDataRetention.ts` | `src/lib/ga4/retention.ts` | PORT | Cloudflare cron → F01 periodic + job; 8-minute budget → steps of 50 grants. |
| `openseo:src/db/pg/ga4.schema.ts`, `drizzle/pg/0017_ga4_connections.sql` | `supabase/migrations/135_f20_ga4.sql` | PORT | Text ids/timestamps → uuid/timestamptz; organisation → workspace; `grant_id` FK added. |
| `openseo:src/server/features/ga4/repositories/Ga4ConnectionRepository.ts`, `services/Ga4Service.ts` (+ test) | `src/lib/ga4/connection.ts`, `ga4_set_connection` (+ test) | PORT | Owner role and connector-membership checks added. |
| `openseo:src/server/lib/ga4Client.ts` (+ test) | `src/lib/ga4/client.ts` (+ test) | PORT | Token getter injected; semaphore, one 5xx retry, timeout, quota-low added. |
| `openseo:src/server/lib/ga4Errors.ts` | `src/lib/ga4/errors.ts` | COPY | Parameter properties rewritten as fields (erasable syntax); HTTP mapping added. |
| `openseo:src/server/features/ga4/services/Ga4Dates.ts` | `src/lib/ga4/dates.ts` | COPY | `presetRange` added. |
| `openseo:src/server/features/ga4/services/Ga4ReportDefinitions.ts` | `src/lib/ga4/reportDefinitions.ts` | COPY | — |
| `openseo:src/server/features/ga4/services/Ga4ReportNormalization.ts` | `src/lib/ga4/normalization.ts` | COPY | — |
| `openseo:src/server/features/ga4/services/Ga4ReportEnhancements.ts` (+ test) | `src/lib/ga4/enhancements.ts` (+ test) | COPY | — |
| `openseo:src/server/features/ga4/services/Ga4ReportingService.ts` (+ test) | `src/lib/ga4/reporting.ts` (+ test) | PORT | Connection from our table; `cached()`. |
| `openseo:src/server/features/ga4/services/Ga4OrganicOverviewService.ts` (+ test), `serverFunctions/ga4.ts:57-89` | `src/lib/ga4/overview.ts` (+ test) | PORT | Zero-fill only when complete and not limited. |
| `openseo:src/server/features/ga4/services/Ga4MeasurementHealthService.ts` (+ test) | `src/lib/ga4/measurementHealth.ts` (+ test) | PORT | — |
| `openseo:src/server/features/ga4/services/SearchOpportunityService.ts` (+ test) | `src/lib/ga4/{opportunities,gscPages}.ts` (+ test) | PORT | `GscService.getPerformance` → existing `gscFetchForBrand` read-only call. |
| `openseo:src/server/features/ga4/services/ga4-test-fixtures.ts` | `tests/fixtures/f20/*.json`, `src/lib/ga4/testFixtures.ts` | PORT | — |
| `openseo:src/serverFunctions/{ga4,googleAccounts}.ts` | `src/app/api/customer/ga4/**/route.ts`, `ga4.contract.ts` | PORT | Server functions → JSON routes; report kinds exposed as routes (they were MCP-only). |
| `openseo:src/routes/api/ga4/oauth/callback.ts` | `src/app/api/customer/ga4/callback/route.ts` | PORT | — |
| `openseo:src/shared/{ga4,google-link}.ts` | `src/shared/ga4.ts` | PORT | `profile` scope dropped; Analytics-only link param. |
| `openseo:src/client/features/integrations/{GoogleConnectionCard,GooglePropertyPicker,GoogleProjectEmptyState,GoogleAccountRemovalDialog,GoogleLinkErrorAlert,googleAuthErrorCopy,googleLinkError,startGoogleLink,useGooglePickerResume}.ts(x)` | `src/components/portal/settings/integrations/*` | PORT | One provider; Next routing; Perceev copy; workspace wording. |
| `openseo:src/client/features/integrations/{GoogleConnectedState,GoogleProductLogos}.tsx`, `features/gsc/GoogleGlyph.tsx` | same folder | COPY | Logos are Google's product marks used to label the integration. |
| `openseo:src/client/features/dashboard/{Ga4Card,Ga4ConnectCard}.tsx` | `src/components/portal/analytics/OrganicOverviewCard.tsx` | PORT | Full card on the analytics page; dismissal not ported. |
| `openseo:src/client/features/search-performance/SearchPerformancePage.tsx` | `src/components/portal/analytics/AnalyticsPage.tsx` | PATTERN | Layout, connection fallback and tabbed tables. |
| `openseo:src/server/mcp/tools/google-analytics-tools.ts` | `src/lib/ga4/tools.ts` | PATTERN | Names kept; descriptions rewritten. |

## 8. Implementation plan

Branches `feat/f20-ga4-p<N>`. `NT` = `node --import ./src/lib/liveWriteGuardAuto.mjs --test`. **Every phase checkpoint includes the Search Console guard:** `git diff --stat origin/main -- src/lib/gsc src/app/api/customer/gsc src/components/portal/gsc src/app/portal/search-console src/lib/engines/gsc.js supabase/migrations/018_gsc_daily.sql supabase/migrations/025_gsc_customer_oauth.sql supabase/migrations/026_customer_uat_repairs.sql` → no output, and `node --test src/lib/gsc/` → pass.

### Phase 1 — Grants, OAuth and retention
**Goal:** an owner can link a Google account for Analytics; grants are stored safely and purged when unused.

- [x] **P1.T1 Database**
  - [x] **P1.T1.S1** *Files:* `supabase/migrations/135_f20_ga4.sql`, `136_f20_ga4_functions.sql`. *Do:* §6.1 verbatim. *Verify:* `node scripts/qa/check-f20-db.mjs --only schema` → "135/136 applied twice without error".
  - [x] **P1.T1.S2** *Files:* `scripts/setup-supabase.mjs`, `.github/workflows/ci.yml`. *Do:* required objects (3 tables, 9 functions); tenant RLS test for `ga4_connections` and denial for the two service-only tables. *Verify:* `grep -c "ga4_" scripts/setup-supabase.mjs` → ≥ 12; `node --test src/lib/migrationsRunner.test.mjs src/lib/migrationsLedger.test.mjs` → pass.
  - [x] **P1.T1.S3** *Files:* `README.md` (rows `135_f20_ga4` "Google Analytics 4: OAuth attempts, per-user Analytics grants (encrypted tokens) and one connection per workspace; separate from Search Console." and `136_f20_ga4_functions` "Google Analytics 4 functions: grant upsert, connection set/disconnect, account removal, unused-grant purge, cache purge, attempt pruning."), `docs/OPERATOR_LEDGER.md` § C ("apply 135 and 136 before deploying F20 phase 1"; "create a second OAuth client GA4_GOOGLE_CLIENT_ID in the Search Console Google Cloud project, add the redirect URI and the analytics.readonly scope to the consent screen"), `docs/PROD_MIGRATIONS.md` (two bullets with `select to_regclass('public.ga4_grants')` checks). *Verify:* `node --test src/lib/docStatus.test.mjs src/lib/migrationsRunner.test.mjs` → pass.
  - [x] **P1.T1.S4** *Files:* `scripts/qa/check-f20-db.mjs`. *Do:* loopback Postgres (`_qa`), F01 040–043 + 135/136: two users upsert grants for one `google_sub` → two rows; re-upsert without refresh token keeps it; `ga4_set_connection` refuses a member and another user's grant; `ga4_remove_grant` cascades connections and reports `remainingForGoogleAccount`; `ga4_delete_unused_grant` refuses a grant that gained a connection; `ga4_purge_cache` deletes only `ga4.%` rows of that brand; `prune_ga4_oauth_attempts`; RLS as F20-AC-25. *Verify:* `node scripts/qa/check-f20-db.mjs` → "F20 DB checks: all passed" (F20-AC-03, -07 DB half, -09 DB half, -25, -28).
- [x] **P1.T2 OAuth modules**
  - [x] **P1.T2.S1** *Files:* `src/shared/ga4.ts`, `src/lib/ga4/{config,idToken,errors,oauth,tokens,grants}.ts`, `idToken.test.ts`, `oauth.test.ts`, `tokens.test.ts`, `grants.test.ts`, `tests/fixtures/f20/{token-exchange,token-exchange-no-scope,refresh-invalid-grant}.json`. *Do:* §6.2, §6.2.1. Cases: URL parameters exact (F20-AC-01); state hashed, attempt expiry 10 minutes; callback replay → `state_mismatch` and only one grant; other session → `state_mismatch`; member → `owner_required`; Google `access_denied`; no code; exchange failure; missing analytics scope → nothing stored; bad `aud`/expired `exp` → `oauth_code_verification_failed`; re-consent keeps refresh token; refresh at ≤ 60 s; `invalid_grant` → status `error`; conditional update loses to a newer row without throwing. *Verify:* `NT src/lib/ga4/idToken.test.ts src/lib/ga4/oauth.test.ts src/lib/ga4/tokens.test.ts src/lib/ga4/grants.test.ts` → pass (F20-AC-01, -02, -03, -04).
  - [x] **P1.T2.S2** *Files:* `src/lib/ga4/accounts.ts`, `accounts.test.ts`. *Do:* port `GoogleAccountService.test.ts:154-304` (removal of all dependent connections; other user's grant untouched; revoke only when last; purge of unused grants before the cutoff; revoke failure logged not thrown). *Verify:* `NT src/lib/ga4/accounts.test.ts` → pass (F20-AC-08, -09).
  - [x] **P1.T2.S3** *Files:* `src/lib/ga4/retention.ts`, `retention.test.ts`, `src/lib/jobs/kinds.ts` (one line). *Do:* §6.3 with F01's in-memory job store. *Verify:* `NT src/lib/ga4/retention.test.ts` → pass.
  - [x] **P1.T2.S4** *Files:* `src/lib/ga4/gscUntouched.test.ts`, `src/lib/ga4/privacy.test.ts`. *Do:* static import scan (F20-AC-10); a log spy over the callback, refresh and removal paths asserting no fixture token, code, state, verifier or email appears (F20-AC-27). *Verify:* `NT src/lib/ga4/gscUntouched.test.ts src/lib/ga4/privacy.test.ts` → pass.
- [x] **P1.T3 Routes and registration**
  - [x] **P1.T3.S1** *Files:* `src/lib/features/names.ts`, `src/lib/features/clientFeatures.ts`, `.env.example` (§6.2.3). *Verify:* `NT src/lib/features/flags.test.ts` → pass; `grep -c "^GA4_GOOGLE_CLIENT_ID=$" .env.example` → 1.
  - [x] **P1.T3.S2** *Files:* `src/app/api/customer/ga4/route.ts` (GET status only in this phase), `connect/route.ts`, `callback/route.ts`, `accounts/route.ts`, `accounts/[grantId]/route.ts`, `src/lib/ga4/ga4.contract.ts`, `src/lib/ga4/oauth.route.test.mjs`. *Do:* §6.5.1 rows for these routes; `connect` obtains the session hash with `customerSessionBinding(await getCustomerContext())`. *Verify:* `NT src/lib/ga4/oauth.route.test.mjs src/lib/http/routeContract.test.ts` → pass (F20-AC-22 for these routes).

**Checkpoint:** `NT 'src/lib/ga4/**/*.test.*'` → pass; `node scripts/qa/check-f20-db.mjs` → all passed; `npm run build` → exit 0; Search Console guard clean. ACs: 01–04, 08–10, 25, 27, 28.

### Phase 2 — Properties, connection and Settings → Integrations (requires F04 and F05)
**Goal:** an owner can pick a property; members see the connection.

- [x] **P2.T1** *Files:* `src/lib/ga4/{client,connection}.ts`, `client.test.ts`, `connection.test.ts`, fixtures `account-summaries-page{1,2}.json`, `property.json`. *Do:* port `ga4Client.test.ts:36-292` (dedicated grant, pagination, token error, one token for concurrent calls, quota classification with retry delay, safe error categories, malformed responses, non-canonical ids, transport errors) plus semaphore (5th request waits), one 5xx retry, no 429 retry; connection: owner-only set, property must be listed, connector-left → `ga4_reconnect_required`. *Verify:* `NT src/lib/ga4/client.test.ts src/lib/ga4/connection.test.ts` → pass (F20-AC-05, -06, -18 client half, -20, -21 unit).
- [x] **P2.T2** *Files:* `src/app/api/customer/ga4/route.ts` (DELETE added), `properties/route.ts`, `property/route.ts`, cases in `src/lib/ga4/connection.route.test.mjs`. *Do:* §6.5.1. *Verify:* `NT src/lib/ga4/connection.route.test.mjs` → pass (F20-AC-06, -07, -22).
- [x] **P2.T3** *Files:* `src/app/portal/settings/integrations/page.tsx`, `src/components/portal/settings/tabs.ts`, `src/components/portal/settings/integrations/{IntegrationsSettings,Ga4ConnectionCard,Ga4PropertyPicker,Ga4ConnectedState,Ga4EmptyState,GoogleAccountsCard,GoogleAccountRemovalDialog,Ga4LinkErrorAlert,SearchConsoleNote,GoogleProductLogos,GoogleGlyph}.tsx`, `hooks/{useGa4Connection,useGa4Properties,useGa4Accounts,useStartGa4Link}.ts`, `src/lib/query/keys.ts`. *Do:* §6.6.2. *Verify:* `npm run build` → exit 0.

**Checkpoint:** tests pass; build green; Search Console guard clean. ACs: 05–07, 20–22.

### Phase 3 — Reports
**Goal:** overview, seven reports and health served live with a short cache.

- [x] **P3.T1** *Files:* `src/lib/ga4/{dates,reportDefinitions,normalization,enhancements}.ts`, `reportDefinitions.test.ts`, `normalization.test.ts`, `enhancements.test.ts`. *Do:* COPY; tests port OpenSEO's definitions cases and `Ga4ReportEnhancements.test.ts:26-182`; normalisation header mismatch, restricted metrics, header-less empty. *Verify:* `NT src/lib/ga4/reportDefinitions.test.ts src/lib/ga4/normalization.test.ts src/lib/ga4/enhancements.test.ts` → pass (F20-AC-11, -13, -14).
- [x] **P3.T2** *Files:* `src/lib/ga4/{reporting,overview,measurementHealth}.ts`, `reporting.test.ts`, `overview.test.ts`, `measurementHealth.test.ts`, `cache.test.ts`, fixtures `run-report-*.json`, `data-streams.json`, `enhanced-measurement.json`, `key-events.json`, `custom-dimensions.json`, `custom-metrics.json`. *Do:* port `Ga4ReportingService.test.ts:77-340`, `Ga4OrganicOverviewService.test.ts:50-158`, `Ga4MeasurementHealthService.test.ts:56-67`; add: zero-fill only when complete and unlimited; cache hit makes no fetch and returns the same `dataAsOf`; property change → new key; thrown fetcher not cached (F01 memory cache deps). *Verify:* `NT src/lib/ga4/reporting.test.ts src/lib/ga4/overview.test.ts src/lib/ga4/measurementHealth.test.ts src/lib/ga4/cache.test.ts` → pass (F20-AC-12, -15, -16, -19).
- [x] **P3.T3** *Files:* `src/app/api/customer/ga4/overview/route.ts`, `reports/[kind]/route.ts`, `health/route.ts`, `src/lib/ga4/reports.route.test.mjs`, contract entries. *Do:* §6.5.2 with the error table and `Retry-After`. *Verify:* `NT src/lib/ga4/reports.route.test.mjs` → pass (F20-AC-18, -22).

**Checkpoint:** tests pass; build green; Search Console guard clean. ACs: 11–16, 18, 19.

### Phase 4 — Search opportunities
**Goal:** the GSC × GA4 opportunity table, reading Search Console without changing it.

- [x] **P4.T1** *Files:* `src/lib/ga4/{gscPages,opportunities}.ts`, `opportunities.test.ts`, fixture `gsc-pages.json`. *Do:* port `SearchOpportunityService.test.ts:68-202` (normalisation, scoring, unmatched unscored, engagement fallback, default range anchored to the property date); add: request body passed to an injected `gscFetchForBrand` exactly as §6.2; service-account connection → `gsc_not_connected`; "access denied" → `gsc_reconnect_required`; truncation flags; time-zone warning. *Verify:* `NT src/lib/ga4/opportunities.test.ts` → pass (F20-AC-17).
- [x] **P4.T2** *Files:* `src/app/api/customer/ga4/opportunities/route.ts`, cases in `reports.route.test.mjs`. *Verify:* `NT src/lib/ga4/reports.route.test.mjs` → pass.

**Checkpoint:** tests pass; Search Console guard clean. AC: 17.

### Phase 5 — `/portal/analytics` (requires F04, F05, F06)
**Goal:** members read Analytics in the portal.

- [x] **P5.T1** *Files:* `src/app/portal/analytics/page.tsx`, `src/components/portal/analytics/{AnalyticsPage,AnalyticsToolbar,OrganicOverviewCard,OpportunitiesTab,LandingPagesTab,PagesTab,KeyEventsTab,AcquisitionTab,EcommerceTab,SiteSearchTab,AudienceTab,SetupHealthTab,Ga4ErrorState,LimitedDataNotice,telemetry}.tsx`, `hooks/{useGa4Overview,useGa4Report,useGa4Health,useGa4Opportunities}.ts`, `src/components/app/navigation/items.ts`. *Do:* §6.6.3. *Verify:* `npm run build` → exit 0.
- [x] **P5.T2** *Files:* `scripts/qa/check-f20-browser.mjs`, `tests/fixtures/f20/api/*.json`. *Do:* Playwright against `npm run dev` with fixture APIs: **B01** not configured; **B02** owner not connected → "Connect" posts `/connect` and navigates to the returned URL (intercepted); **B03** `?ga4_error=scope_not_granted` copy; **B04** picker save → connected state; **B05** connector left → warning + Reconnect; **B06** analytics overview metrics and change colours, "—" for null; **B07** limited-data notice; **B08** opportunities footer coverage and engagement-fallback note; **B09** Search Console not connected empty state; **B10** quota 429 copy without Retry; **B11** tab switch keeps URL `?tab=`; **B12** 375 px without horizontal page scroll on settings and analytics. *Verify:* `node scripts/qa/check-f20-browser.mjs` → "F20 browser: 12/12 passed" (F20-AC-23, -24).

**Checkpoint:** browser 12/12; `node --test src/components/portal/` → pass; Search Console guard clean. ACs: 23, 24.

### Phase 6 — Tools
- [x] **P6.T1** *Files:* `src/lib/ga4/tools.ts`, `tools.test.ts`. *Do:* §6.2.2; closed inputs; outputs parse fixture-driven handler results. *Verify:* `NT src/lib/ga4/tools.test.ts` → pass (F20-AC-26).
- [x] **P6.T2** *Files:* `scripts/qa/check-f20-live.mjs`. *Do:* owner-run only; refuses without `--brand <key>`; reads `GET /api/customer/ga4` state, one overview (`last_28_days`) and one opportunities request through the service functions with the service-role client; prints only row counts, `hasLimitedData`, `cached` and `quota.tokensPerHour.remaining`; never prints tokens, emails, property names or rows. *Verify:* `node scripts/qa/check-f20-live.mjs` (no args) → exits 1 with "Refusing: pass --brand <key>".

## 9. Test plan

| Test file | Cases | ACs |
|---|---|---|
| `src/lib/ga4/oauth.test.ts`, `idToken.test.ts`, `tokens.test.ts`, `grants.test.ts` | consent URL, callback paths, claims, refresh, grant upsert | 01–04 |
| `src/lib/ga4/accounts.test.ts`, `retention.test.ts` | removal, revoke-if-last, unused purge | 08, 09 |
| `src/lib/ga4/client.test.ts`, `connection.test.ts` | Admin/Data client, quota, semaphore, set property, connector membership | 05, 06, 18, 20, 21 |
| `src/lib/ga4/{reportDefinitions,normalization,enhancements,reporting,overview,measurementHealth,cache}.test.ts` | ported report logic, dates, caching | 11–16, 19 |
| `src/lib/ga4/opportunities.test.ts` | join, score, fallback, GSC call shape | 17 |
| `src/lib/ga4/{oauth,connection,reports}.route.test.mjs` | auth, flag, errors, statuses | 06, 07, 18, 22 |
| `src/lib/ga4/gscUntouched.test.ts`, `privacy.test.ts` | Search Console fence, log hygiene | 10, 27 |
| `src/lib/ga4/tools.test.ts` | ten tools | 26 |
| `scripts/qa/check-f20-db.mjs` | functions, RLS, pruning | 03, 07, 09, 25, 28 |
| `scripts/qa/check-f20-browser.mjs` | B01–B12 | 21, 23, 24 |

Fixtures are synthetic (§6.4). Fake tokens follow the secrets rule (`ya29.EXAMPLE-NOT-A-REAL-TOKEN`). Live check `scripts/qa/check-f20-live.mjs --brand <key>` (owner-run, free): reads the connection status, one overview and one opportunities request for a workspace the owner connected, and prints only row counts, `hasLimitedData` and quota remaining.

## 10. Rollout and rollback

- **Env (names only):** `FEATURE_GA4`, `FEATURE_GA4_BRANDS`, `GA4_GOOGLE_CLIENT_ID`, `GA4_GOOGLE_CLIENT_SECRET`, `GA4_OAUTH_REDIRECT_URI`; reuses `GSC_TOKEN_ENCRYPTION_KEY`.
- **Owner setup:** in the Google Cloud project that holds the Search Console client: enable the Google Analytics Admin API and Data API; create a second OAuth client (Web application) with redirect `https://perceev.xyz/api/customer/ga4/callback`; add `analytics.readonly` to the OAuth consent screen (a sensitive scope: Google's verification is needed before external users see no "unverified app" warning); set the three env vars in Vercel.
- **Migration order:** F01 040–043 → 135 → 136, before deploying phase 1. Additive.
- **Enabling:** `FEATURE_GA4=allowlist` with the owner's workspace, connect, compare the overview with Google Analytics' own "Organic Search" numbers for the same dates, then `on`.
- **Turning it off:** `FEATURE_GA4=off` hides the tab, page and sidebar item and returns 404 from routes; grants and connections stay (the purge keeps running and only removes unbound grants). To remove everything: owners disconnect their workspaces and users remove their linked accounts (each removal revokes when it is the last grant for that Google account); any grant left unbound is deleted and revoked by the daily purge after 24 hours.
- **Search Console:** unaffected by every step above.

## 11. Risks and open questions

| # | Risk / question | Default chosen |
|---|---|---|
| 1 | A second OAuth client is extra setup for the owner. | Required: it is the only way to guarantee that revoking an Analytics grant can never revoke the Search Console grant of the same Google account (§3). Without `GA4_GOOGLE_CLIENT_ID`, Analytics shows "isn't set up on this deployment yet". |
| 2 | `analytics.readonly` is a sensitive scope; Google verification may take weeks. | Allowlisted rollout first; test users are allowed before verification. |
| 3 | GA4 quota figures are Google's published standard-property limits, not re-verified for this spec. | Code reads `propertyQuota` from each response instead of assuming numbers; the cache and semaphore keep usage low. |
| 4 | `id_token` signature is not verified. | Allowed by OIDC Core §3.1.3.7 for tokens received directly from the token endpoint over TLS; `aud`, `iss`, `exp` are checked. |
| 5 | Sharing `GSC_TOKEN_ENCRYPTION_KEY` couples key rotation. | AAD prefixes separate the domains; a rotation already requires GSC reconnection, so Analytics reconnection at the same time is acceptable. |
| 6 | Deleting a Perceev user cascades their grants without revoking them at Google. | Accepted: Perceev can no longer use the tokens; the user can revoke in their Google account. A later spec may revoke on account deletion. |
| 7 | Search Console's page rows are capped at 1,000 per request. | Same as OpenSEO; the UI states the truncation. |
| 8 | Opportunities need a Search Console OAuth connection; legacy service-account connections are not used. | `gsc_not_connected` with a link to the Search Console page (no Search Console change). |
| 9 | A cached report can be up to 15 minutes old (60 for health). | Ranges end on the last complete day; "Data as of" is shown; no manual refresh button (F01 `cached()` has no bypass). |
| 10 | Connector leaves the workspace but their grant still works. | Reports refuse with `ga4_reconnect_required` until an owner reconnects (privacy over convenience). |

## 12. Definition of done

- [x] Phases 1–6 merged; subtasks ticked here.
- [x] F20-AC-01…28 covered by passing tests.
- [x] `npm run build` green; full suite green; `node scripts/qa/check-f20-db.mjs` and `node scripts/qa/check-f20-browser.mjs` pass.
- [x] Search Console guard (§8) clean on every phase; `node --test src/lib/gsc/` passes unchanged.
- [x] Migration paperwork for 135 and 136 in `README.md`, `docs/OPERATOR_LEDGER.md` § C, `docs/PROD_MIGRATIONS.md`; `THIRD_PARTY_NOTICES.md` lists every COPY/PORT path.
- [x] `features/README.md` status updated; owner-run live check recorded.

## Deviations from conventions

1. `ga4_grants` has no `brand_key` (a grant belongs to a person, as in OpenSEO); it is service-only. `ga4_oauth_attempts` and `ga4_connections` follow §6.8.
2. Analytics uses its own Google OAuth client (§3) and reuses the Search Console encryption key through `src/lib/gsc/oauthCrypto.js` without changing that module.
3. Reports are live with a short `cached()` TTL instead of stored history.
4. `id_token` is checked by claims, not by signature (no `jose` dependency).
5. Report routes are GET with query parameters (no paid action, so no `maxUsd`, no F09 registration).

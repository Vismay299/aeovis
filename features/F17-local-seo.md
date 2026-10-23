# F17 — Local SEO

> <!-- doc-status -->
> **Status: LIVE.** Implementation spec. Not built yet.

| Field | Value |
|---|---|
| ID | F17 |
| Wave | 2 |
| Comparison rows covered | "Local SEO" (OpenSEO: business profile, reviews, local rank grid, local SERP, as MCP tools. Perceev: none) |
| Depends on | F01 (merged): `requireWorkspace`, `AppError`/`toErrorResponse`/`jsonOk`, `metered`, `cached`, `isFeatureEnabled`, `definePeriodic`/`enqueueSystemJob`/`defineJob`, `keepAlive`, `f01_touch_updated_at()`, route-contract harness. F02 phase 2: `src/lib/providers/dataforseo/{core,envelope,client,serp}.ts` (`meter`, `dataforseoPost`/`dataforseoGet`, `assertOk`, `buildTaskBilling`, `isTaskInProgress`, `isNoResultsTask`, `isRecord`, `createDataforseoClient().serp.local` / `.localTaskPost`, `fetchLocalSerpTaskResult`). F03 phase 1: `dataforseoPricing.business.*`, `.serp.local`, `.serp.localTaskPost`. F07 phase 1: `appendResearch`, `findRecentResearch`. F09 phase 1 (`definePricedAction`, `requireApprovedPrice`, `recordApproval`) and phase 3 (`CostReviewDialog`, `usePriceQuote`). F13 phase 1: `src/shared/keyword-locations.ts` (`LOCATION_OPTIONS`, `workspaceMarket`, `getLanguageCode`, `SERP_LANGUAGE_OPTIONS`), `src/lib/research/{cache,providerErrors}.ts`, `PricedActionButton`. F06 (tables). UI phases need F04 and F05. |
| Blocks | F21 (local-seo skill), F22 (local tools), F23 (local report sections) |
| Reserved migrations | 120–124. **120** `120_f17_local_seo.sql` (phase 2). **121** `121_f17_local_seo_functions.sql` (phase 2). 122–124 unused. |
| Feature flag | `FEATURE_LOCAL_SEO` (name `local_seo`, spend `["local.business","local.reviews","local.serp","local.grid"]`): page, routes, sidebar item. In `CLIENT_FEATURES`; off in production by default. |
| Spend features | `local.business` ("Local business profiles and listings"), `local.reviews` ("Business reviews"), `local.serp` ("Local search results"), `local.grid` ("Local rank grids"). All ship disabled. |
| OpenSEO reference | `openseo:src/server/lib/dataforseo/business.ts`, `openseo:src/server/lib/dataforseo/serp.ts:353-517`, `openseo:src/server/mcp/tools/local-seo-tools.ts`, `openseo:src/server/mcp/tools/local-seo-shared.ts`, `openseo:src/server/mcp/tools/dataforseo-research-tools.ts:83-136, 229-323, 466-559, 682-800, 954-1091`, `openseo:src/server/lib/dataforseo/pricing.ts:94-154, 186-279`, `openseo:src/server/mcp/table.ts:105-112`, `openseo:.agents/skills/local-seo/SKILL.md` (read as data) at `c5f8db1` |

## 1. Summary

Customers see how their business appears on Google Maps and in local results: find their Google Business Profile, compare it with nearby competitors, read and page through reviews (with owner-reply gaps), check posts and Q&A, run a map rank grid around the storefront, and look at the local results for any search near any point. OpenSEO only offers this to AI agents through MCP tools; Perceev gives it a customer page at `/portal/local` built on the same services, with every paid lookup priced, approved, metered, capped and logged in project memory, and the same handlers exported as tool definitions for the in-app assistant (F22).

## 2. What OpenSEO does (observed)

1. **Surface.** Local SEO exists only as MCP tools: `search_local_businesses`, `get_local_serp_results`, `get_google_business_questions` (`openseo:src/server/mcp/tools/dataforseo-research-tools.ts:954-1091`) and `get_business_profile`, `get_business_reviews`, `get_business_updates`, `list_business_categories`, `get_local_rank_grid` (`openseo:src/server/mcp/tools/local-seo-tools.ts:219-1180`), driven by an agent skill whose workflow is: find the listing, read the local SERP, compare with the top competitors, check reviews, run the grid, then Q&A and posts (`openseo:.agents/skills/local-seo/SKILL.md:45-62`). The service logic lives inside the tool handlers; there is no app page.
2. **Provider calls** (`openseo:src/server/lib/dataforseo/business.ts`): `business_listings/search/live` with categories, title, coordinate, claimed filter, filters, order, limit, offset (`:42-74`); `google/questions_and_answers/live`, combining answered `items` and `items_without_answers` (`:79-126`); `google/my_business_info/live` by keyword with a coordinate or a location code, merging `check_url` onto the item (`:128-152`); queued `google/reviews/task_post` and `google/extended_reviews/task_post` (other sites; no sort) and `google/my_business_updates/task_post` at priority 2, never replayed on a 5xx (`:21-23`, `:161-259`); free `task_get` collection (`:272-300`); free `business_listings/categories` (`:302-334`). Local SERP: `serp/google/maps/live/advanced` and `local_finder/live/advanced` (`openseo:src/server/lib/dataforseo/serp.ts:353-404`), queued `maps/task_post` at priority 2 for grids, tag = point index, cost summed over every entry, never retried (`:413-484`), free `maps/task_get/advanced` (`:495-517`).
3. **Identifiers and coordinates** (`openseo:src/server/mcp/tools/local-seo-shared.ts`): exactly one of business name, CID or place_id (`:93-109`); `my_business_info`/`my_business_updates`/Q&A carry CID and place_id as `cid:` / `place_id:` keyword prefixes (`:111-122`); business_data radius in **metres** clamped 200–199,999, default 10 km (`:10-60`); listings radius in **whole kilometres** (`dataforseo-research-tools.ts:466-471`); Maps coordinates "lat,lng,<zoom>z" (`local-seo-shared.ts:141-149`); default local SERP zoom 12 (a ~12 km viewport) because no zoom returned 0–1 rows in testing (`dataforseo-research-tools.ts:129-136`).
4. **Row trimming.** Each tool keeps an allow-list of fields because full rows carry image URLs, xpaths and ~9 KB of popular times (`pickRowFields`, `local-seo-shared.ts:124-139`; lists at `dataforseo-research-tools.ts:682-726`, `:760-787`; reviews `local-seo-tools.ts:320-340`; posts `:483-493`).
5. **Reviews and posts**: post once (metered), poll up to 6 × 4 s inside the call (`local-seo-tools.ts:80-111`), otherwise return a resumable task id ("google:<id>" or "extended:<id>") that collects at no extra cost (`:297-318`, `:388-452`); a collection failure after the paid post keeps the id recoverable (`:100-110`). Defaults: reviews depth 20 (10–200), sort newest, other sites off; posts depth 10 (10–100) (`:258-291`, `:458-477`).
6. **Rank grid** (`local-seo-tools.ts:691-1180`): square grid of 3×3 or 5×5 points, spacing 0.25–10 km (default 2), row 0 north, longitude step corrected by latitude (`:833-865`); zoom derived from spacing and latitude, `floor(log2(24045·cos(lat)/spacing))` clamped 4–18, because a fixed zoom made a rank-3 business vanish one step away (`:707-733`); one queued Maps search per point at depth 20 (`:700`, `:1050-1061`); match by CID, then place_id, then case-insensitive title (`:867-880`); each point records rank, results count and the #1 business so a missing rank can be read as "outranked" or "sparse" (`:823-831`, `:1110-1139`); a refused point is an error cell; all points failing is an upstream error and clears the receipt (`:1092-1107`); the task ids are cached for an hour as a receipt so a repeat collects instead of re-buying (`:706-710`, `:1030-1069`); summary: points found, average rank where found, top-3 and top-10 counts (`:1141-1155`).
7. **Prices** (`openseo:src/server/lib/dataforseo/pricing.ts:94-154`, `:186-279`): listings $0.012 + $0.00036/row; profile $0.0054; Q&A $0.0054 per 20; reviews $0.001 + $0.0015 per 10 (extended $0.01 per 20); posts $0.003 + $0.0015 per 10; Maps live $0.002; Local Finder $0.002 per 10; queued Maps $0.0012 per point. The skill tells agents to state the cost before a 5×5 grid and to confirm the centre first (`SKILL.md:79-86`).
8. **Categories**: the free list is cached for 7 days and filtered in memory (`local-seo-tools.ts:594-689`).

## 3. What Perceev has today

- No local SEO, no business-data provider, no Maps SERP. The only DataForSEO use is planned by F02/F13–F16.
- F15 local trackers rank a domain in a city's organic results (`location_name`); they do not cover Maps.
- Nothing existing is touched: P0 controls, scans and portal pages stay as they are. Local SEO is classic SEO: none of its endpoints asks an answer engine, so everything goes through `metered()` (conventions §6.2) and none of it imports `src/lib/providers/dataforseo/answers.ts`.

## 4. Target behaviour and acceptance criteria

| ID | Statement | Verified by |
|---|---|---|
| F17-AC-01 | Migrations 120–121 create `local_businesses`, `local_fetches`, `local_fetch_items`, `local_grid_runs` and `local_searches` with RLS and read policies; one own business per workspace; at most 10 competitors; members read only their workspace's rows. | DB `scripts/qa/check-f17-db.mjs`; `tests/customer-uat.sql` |
| F17-AC-02 | `business.ts` passes OpenSEO's five cases: coordinate for `my_business_info` and the single item with `check_url` merged; location-code fallback and no-results as empty success; no replay of a `task_post` on a 5xx; queued task read as pending; categories mapped to `{ category, businessCount }`. | unit `src/lib/providers/dataforseo/business.test.ts` (port of `business.test.ts:37-190`) |
| F17-AC-03 | Exactly one identifier (name, CID or place_id) is required (`400 identifier_required`); CID/place_id are sent as `cid:`/`place_id:` keywords; business_data radius is metres (200–199,999), listings radius whole kilometres, Maps coordinates carry `<zoom>z`. | unit `src/lib/local/shared.test.ts` (port of `local-seo-tools.test.ts:65-130`) |
| F17-AC-04 | Every paid call goes through `meter` with its spend feature and an F03 estimate > 0; `task_get` and categories are free and never metered; posts are never retried. | unit `business.test.ts` "every entry is priced"; F02 `noPrices.test.mjs` |
| F17-AC-05 | Reviews and posts: one paid post, inline polling up to 20 s, then `202 processing` with a `fetchId`; `GET` collects at no cost; a collection error keeps the fetch collectable; the same business and parameters within 60 minutes reuse the earlier fetch with no spend; a repeated `requestId` returns the same fetch. | unit `src/lib/local/fetches.test.ts`; route test |
| F17-AC-06 | Q&A combines answered and unanswered questions, trims rows to the allow-list, and is stored like a completed fetch. | unit `fetches.test.ts` |
| F17-AC-07 | Grid: 3×3 or 5×5 points north row first; zoom from spacing and latitude; match CID > place_id > name; per-point rank, results count and top result; a refused point is an error cell; all failing → `502 local_grid_failed` and the run is not reused; a repeat with the same parameters within 60 minutes reuses the run; collection is free. | unit `src/lib/local/grid.test.ts` (ports of `local-seo-tools.test.ts:281-440`) |
| F17-AC-08 | Local results: defaults zoom 12, mobile, Maps, depth 20; rows trimmed; cached globally for 12 hours; rows matching the own business are flagged `isOwn`. | unit `src/lib/local/localSerp.test.ts` |
| F17-AC-09 | Listings search maps `minRating`/`minReviews` to filters and `sortBy` to `order_by`, caches globally for 24 hours; categories are cached for 7 days and filtered in memory. | unit `src/lib/local/listings.test.ts` (port of `local-seo-tools.test.ts:448`) |
| F17-AC-10 | Saving a business stores identity only (title, CID, place_id, coordinates) from a server-fetched result or explicit IDs; profile data comes only from a server fetch; own/competitor caps hold. | unit `src/lib/local/businesses.test.ts`; DB group `caps` |
| F17-AC-11 | Paid actions are priced through F09: inline approval for lookups quoted at ≤ $0.25; the grid always opens `CostReviewDialog`; `409 price_changed` and `400 approval_required` behave as F09 §6.2.2. | unit `src/lib/pricing/actions/local.test.ts`; route test |
| F17-AC-12 | Each purchase writes one F07 research-log entry (kind = spend feature) and quotes show `recent_research` when the same lookup ran in the last 90 days. | unit `research.test.ts` |
| F17-AC-13 | `/portal/local` renders the business picker, Profile, Reviews (10 per page, deeper collection on demand), Posts, Questions, Map rankings (SVG grid with no external map tiles) and Local results, with loading, empty, error and processing states as §6.6. | browser `scripts/qa/check-f17-browser.mjs` B1–B8 |
| F17-AC-14 | The Maps-link parser accepts `@lat,lng,<z>z`, `!3d<lat>!4d<lng>` and "lat, lng", rejects out-of-range values, and makes no network call. | unit `src/shared/local-coordinates.test.ts` |
| F17-AC-15 | Flag off → page hidden and routes `404 feature_unavailable`; a disabled spend control → `403 feature_disabled`. | route tests |
| F17-AC-16 | No reviewer names, review or post text, coordinates or business names appear in logs or telemetry; fetches, items, grids and searches older than 395 days are pruned. | unit `telemetry.test.mjs`; DB group `retention` |
| F17-AC-17 | `src/lib/local/tools.ts` exports the eight tools under OpenSEO's names with strict inputs, loose outputs, `maxUsd` on paid tools and resume ids (`fetchId`, `gridId`). | unit `tools.test.ts` |

## 5. Scope

**In scope:** DataForSEO business-data section client; local SERP and grid services on F02's SERP functions; saved own/competitor businesses; profile, listings search, categories, reviews (incl. other sites), posts, Q&A, local results, rank grid with history; priced actions; research log; retention; the `/portal/local` page; F22 tool definitions.

**Out of scope:** scheduled grid tracking over time (a later follow-up; F10/F15 patterns would apply); writing to Google Business Profiles (replying to reviews, posting) — DataForSEO is read-only; adding local competitors to F07 project competitors or to AI-visibility competitor tracking (deferred Mixed row "Competitors (tracking side)", unchanged); geocoding addresses (no geocoder; coordinates come from profiles, results or a pasted Maps link); embedded map tiles; reports (F23); the MCP server (F22 registers the tools later).

## 6. Design

### 6.1 Data model

#### `supabase/migrations/120_f17_local_seo.sql`

```sql
-- F17: local SEO. Saved businesses, paid fetches (reviews, posts, Q&A), map grids and
-- local result snapshots. Public Google data about businesses; reviewer content is kept
-- trimmed and pruned after 13 months.
CREATE TABLE IF NOT EXISTS public.local_businesses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_key text NOT NULL REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('own','competitor')),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
  cid text CHECK (cid IS NULL OR cid ~ '^[0-9]{1,30}$'),
  place_id text CHECK (place_id IS NULL OR (length(place_id) BETWEEN 1 AND 256 AND place_id ~ '^[A-Za-z0-9_:-]+$')),
  latitude numeric(10,7) CHECK (latitude IS NULL OR latitude BETWEEN -90 AND 90),
  longitude numeric(10,7) CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180),
  location_code integer CHECK (location_code IS NULL OR location_code BETWEEN 1000 AND 9999999),
  language_code text NOT NULL DEFAULT 'en' CHECK (language_code ~ '^[a-z]{2,3}(-[A-Za-z]{2,4})?$'),
  profile jsonb CHECK (profile IS NULL OR (jsonb_typeof(profile) = 'object' AND pg_column_size(profile) < 16384)),
  profile_fetched_at timestamptz,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT local_businesses_identity CHECK (cid IS NOT NULL OR place_id IS NOT NULL),
  CONSTRAINT local_businesses_id_brand UNIQUE (id, brand_key)
);
COMMENT ON COLUMN public.local_businesses.profile IS 'Trimmed BusinessProfileView (§6.2.3) from a server fetch; never written from client input.';
CREATE UNIQUE INDEX IF NOT EXISTS local_businesses_one_own_idx ON public.local_businesses (brand_key) WHERE role = 'own';
CREATE UNIQUE INDEX IF NOT EXISTS local_businesses_cid_idx ON public.local_businesses (brand_key, cid) WHERE cid IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS local_businesses_place_idx ON public.local_businesses (brand_key, place_id) WHERE place_id IS NOT NULL;
DROP TRIGGER IF EXISTS local_businesses_touch ON public.local_businesses;
CREATE TRIGGER local_businesses_touch BEFORE UPDATE ON public.local_businesses
  FOR EACH ROW EXECUTE FUNCTION public.f01_touch_updated_at();

CREATE TABLE IF NOT EXISTS public.local_fetches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_key text NOT NULL REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  request_id uuid NOT NULL UNIQUE,
  business_id uuid,
  kind text NOT NULL CHECK (kind IN ('reviews','extended_reviews','updates','questions')),
  identifier jsonb NOT NULL CHECK (jsonb_typeof(identifier) = 'object' AND pg_column_size(identifier) < 1024),
  params jsonb NOT NULL CHECK (jsonb_typeof(params) = 'object' AND pg_column_size(params) < 2048),
  params_hash text NOT NULL CHECK (params_hash ~ '^[0-9a-f]{64}$'),
  provider_task_id text CHECK (provider_task_id IS NULL OR length(provider_task_id) <= 100),
  status text NOT NULL DEFAULT 'processing' CHECK (status IN ('processing','completed','failed')),
  totals jsonb CHECK (totals IS NULL OR (jsonb_typeof(totals) = 'object' AND pg_column_size(totals) < 2048)),
  item_count integer NOT NULL DEFAULT 0 CHECK (item_count BETWEEN 0 AND 200),
  error_code text CHECK (error_code IS NULL OR error_code ~ '^[a-z_]{1,60}$'),
  error_message text CHECK (error_message IS NULL OR length(error_message) <= 300),
  last_polled_at timestamptz,
  requested_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT local_fetches_business_fk FOREIGN KEY (business_id, brand_key)
    REFERENCES public.local_businesses(id, brand_key) ON DELETE SET NULL (business_id),
  CONSTRAINT local_fetches_id_brand UNIQUE (id, brand_key)
);
COMMENT ON COLUMN public.local_fetches.params_hash IS 'sha256 of stableStringify({kind, identifier, params}); a completed or processing fetch with the same hash in the last 60 minutes is reused.';
CREATE INDEX IF NOT EXISTS local_fetches_reuse_idx ON public.local_fetches (brand_key, params_hash, created_at DESC);
CREATE INDEX IF NOT EXISTS local_fetches_business_idx ON public.local_fetches (brand_key, business_id, kind, created_at DESC);
CREATE INDEX IF NOT EXISTS local_fetches_created_idx ON public.local_fetches (created_at);

CREATE TABLE IF NOT EXISTS public.local_fetch_items (
  fetch_id uuid NOT NULL,
  brand_key text NOT NULL REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  idx integer NOT NULL CHECK (idx BETWEEN 0 AND 199),
  item jsonb NOT NULL CHECK (jsonb_typeof(item) = 'object' AND pg_column_size(item) < 32768),
  PRIMARY KEY (fetch_id, idx),
  CONSTRAINT local_fetch_items_fetch_fk FOREIGN KEY (fetch_id, brand_key)
    REFERENCES public.local_fetches(id, brand_key) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS public.local_grid_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_key text NOT NULL REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  request_id uuid NOT NULL UNIQUE,
  business_id uuid,
  keyword text NOT NULL CHECK (keyword = btrim(keyword) AND length(keyword) BETWEEN 1 AND 120),
  center_lat numeric(10,7) NOT NULL CHECK (center_lat BETWEEN -90 AND 90),
  center_lng numeric(10,7) NOT NULL CHECK (center_lng BETWEEN -180 AND 180),
  grid_size smallint NOT NULL CHECK (grid_size IN (3,5)),
  spacing_km numeric(5,2) NOT NULL CHECK (spacing_km BETWEEN 0.25 AND 10),
  zoom smallint NOT NULL CHECK (zoom BETWEEN 4 AND 18),
  device text NOT NULL CHECK (device IN ('desktop','mobile')),
  language_code text NOT NULL CHECK (language_code ~ '^[a-z]{2,3}(-[A-Za-z]{2,4})?$'),
  target jsonb NOT NULL CHECK (jsonb_typeof(target) = 'object' AND pg_column_size(target) < 1024),
  params_hash text NOT NULL CHECK (params_hash ~ '^[0-9a-f]{64}$'),
  task_ids jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(task_ids) = 'array' AND jsonb_array_length(task_ids) <= 25),
  status text NOT NULL DEFAULT 'processing' CHECK (status IN ('processing','completed','failed')),
  points jsonb CHECK (points IS NULL OR (jsonb_typeof(points) = 'array' AND jsonb_array_length(points) <= 25 AND pg_column_size(points) < 32768)),
  point_rows jsonb CHECK (point_rows IS NULL OR (jsonb_typeof(point_rows) = 'array' AND jsonb_array_length(point_rows) <= 25 AND pg_column_size(point_rows) < 131072)),
  summary jsonb CHECK (summary IS NULL OR jsonb_typeof(summary) = 'object'),
  matched jsonb CHECK (matched IS NULL OR jsonb_typeof(matched) = 'object'),
  error_code text CHECK (error_code IS NULL OR error_code ~ '^[a-z_]{1,60}$'),
  error_message text CHECK (error_message IS NULL OR length(error_message) <= 300),
  last_polled_at timestamptz,
  requested_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT local_grid_runs_business_fk FOREIGN KEY (business_id, brand_key)
    REFERENCES public.local_businesses(id, brand_key) ON DELETE SET NULL (business_id)
);
COMMENT ON COLUMN public.local_grid_runs.task_ids IS 'Provider task id per point in row-major order, null where the provider refused the point (OpenSEO receipt).';
CREATE INDEX IF NOT EXISTS local_grid_runs_reuse_idx ON public.local_grid_runs (brand_key, params_hash, created_at DESC);
CREATE INDEX IF NOT EXISTS local_grid_runs_brand_idx ON public.local_grid_runs (brand_key, created_at DESC);

CREATE TABLE IF NOT EXISTS public.local_searches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_key text NOT NULL REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('local_serp','listings')),
  params jsonb NOT NULL CHECK (jsonb_typeof(params) = 'object' AND pg_column_size(params) < 2048),
  result_count integer NOT NULL CHECK (result_count >= 0),
  own_rank integer CHECK (own_rank IS NULL OR own_rank BETWEEN 1 AND 700),
  cache_key text NOT NULL CHECK (length(cache_key) = 64),
  cached boolean NOT NULL,
  requested_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.local_searches IS 'F17: history of local result and listing searches (parameters and counts only; rows live in the provider cache).';
CREATE INDEX IF NOT EXISTS local_searches_brand_idx ON public.local_searches (brand_key, kind, created_at DESC);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['local_businesses','local_fetches','local_fetch_items','local_grid_runs','local_searches'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_read', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (public.customer_can_access_brand(brand_key))', t || '_read', t);
  END LOOP;
END $$;
NOTIFY pgrst, 'reload schema';
```

`ON DELETE SET NULL (business_id)` (column list, Postgres 15+) keeps history when a saved business is removed without nulling `brand_key`. Supabase runs Postgres 15/17; the CI database is Postgres 16.

#### `supabase/migrations/121_f17_local_seo_functions.sql`

```sql
-- Save or update a business with the own/competitor caps. Identity only; profile is optional
-- and passed only by server code that fetched it.
CREATE OR REPLACE FUNCTION public.save_local_business(p_brand text, p_role text, p_title text, p_cid text,
  p_place_id text, p_lat numeric, p_lng numeric, p_location_code integer, p_language text,
  p_profile jsonb, p_actor uuid)
RETURNS uuid LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_id uuid; v_competitors integer;
BEGIN
  IF p_role NOT IN ('own','competitor') THEN RAISE EXCEPTION 'local_business_invalid:role'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('f17:local_businesses:' || p_brand));
  SELECT id INTO v_id FROM local_businesses
   WHERE brand_key = p_brand AND ((p_cid IS NOT NULL AND cid = p_cid) OR (p_place_id IS NOT NULL AND place_id = p_place_id))
   LIMIT 1;
  IF p_role = 'own' THEN
    UPDATE local_businesses SET role = 'competitor' WHERE brand_key = p_brand AND role = 'own' AND id IS DISTINCT FROM v_id;
  END IF;
  IF v_id IS NULL THEN
    IF p_role = 'competitor' THEN
      SELECT count(*) INTO v_competitors FROM local_businesses WHERE brand_key = p_brand AND role = 'competitor';
      IF v_competitors >= 10 THEN RAISE EXCEPTION 'local_business_cap:competitors'; END IF;
    END IF;
    INSERT INTO local_businesses (brand_key, role, title, cid, place_id, latitude, longitude, location_code,
                                  language_code, profile, profile_fetched_at, created_by)
    VALUES (p_brand, p_role, p_title, p_cid, p_place_id, p_lat, p_lng, p_location_code, coalesce(p_language, 'en'),
            p_profile, CASE WHEN p_profile IS NULL THEN NULL ELSE now() END, p_actor)
    RETURNING id INTO v_id;
  ELSE
    UPDATE local_businesses SET role = p_role, title = p_title,
           cid = coalesce(p_cid, cid), place_id = coalesce(p_place_id, place_id),
           latitude = coalesce(p_lat, latitude), longitude = coalesce(p_lng, longitude),
           location_code = coalesce(p_location_code, location_code),
           profile = coalesce(p_profile, profile),
           profile_fetched_at = CASE WHEN p_profile IS NULL THEN profile_fetched_at ELSE now() END
     WHERE id = v_id;
    IF p_role = 'competitor' THEN
      SELECT count(*) INTO v_competitors FROM local_businesses WHERE brand_key = p_brand AND role = 'competitor';
      IF v_competitors > 10 THEN RAISE EXCEPTION 'local_business_cap:competitors'; END IF;
    END IF;
  END IF;
  RETURN v_id;
END $$;

-- Reuse window for paid fetches and grids (OpenSEO's one-hour receipt).
CREATE OR REPLACE FUNCTION public.find_local_reuse(p_brand text, p_table text, p_hash text, p_since timestamptz)
RETURNS uuid LANGUAGE plpgsql STABLE SET search_path = public AS $$
DECLARE v uuid;
BEGIN
  IF p_table = 'fetch' THEN
    SELECT id INTO v FROM local_fetches WHERE brand_key = p_brand AND params_hash = p_hash
       AND created_at >= p_since AND status IN ('processing','completed') ORDER BY created_at DESC LIMIT 1;
  ELSIF p_table = 'grid' THEN
    SELECT id INTO v FROM local_grid_runs WHERE brand_key = p_brand AND params_hash = p_hash
       AND created_at >= p_since AND status IN ('processing','completed') ORDER BY created_at DESC LIMIT 1;
  ELSE RAISE EXCEPTION 'local_reuse_invalid'; END IF;
  RETURN v;
END $$;

-- Claim a poll slot so concurrent tabs make at most one provider read per 4 s per fetch/grid.
CREATE OR REPLACE FUNCTION public.claim_local_poll(p_brand text, p_table text, p_id uuid, p_min_seconds integer DEFAULT 4)
RETURNS boolean LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v integer;
BEGIN
  IF p_table = 'fetch' THEN
    UPDATE local_fetches SET last_polled_at = now() WHERE id = p_id AND brand_key = p_brand AND status = 'processing'
       AND (last_polled_at IS NULL OR last_polled_at < now() - make_interval(secs => p_min_seconds));
  ELSIF p_table = 'grid' THEN
    UPDATE local_grid_runs SET last_polled_at = now() WHERE id = p_id AND brand_key = p_brand AND status = 'processing'
       AND (last_polled_at IS NULL OR last_polled_at < now() - make_interval(secs => p_min_seconds));
  ELSE RAISE EXCEPTION 'local_poll_invalid'; END IF;
  GET DIAGNOSTICS v = ROW_COUNT; RETURN v = 1;
END $$;

-- Retention: 13 months (F17-AC-16).
CREATE OR REPLACE FUNCTION public.prune_local_seo(p_before timestamptz, p_limit integer DEFAULT 1000)
RETURNS jsonb LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_f integer; v_g integer; v_s integer;
BEGIN
  WITH old AS (SELECT id FROM local_fetches WHERE created_at < p_before ORDER BY created_at LIMIT greatest(1, least(p_limit, 5000)))
  DELETE FROM local_fetches f USING old WHERE f.id = old.id; GET DIAGNOSTICS v_f = ROW_COUNT;
  WITH old AS (SELECT id FROM local_grid_runs WHERE created_at < p_before ORDER BY created_at LIMIT greatest(1, least(p_limit, 5000)))
  DELETE FROM local_grid_runs g USING old WHERE g.id = old.id; GET DIAGNOSTICS v_g = ROW_COUNT;
  WITH old AS (SELECT id FROM local_searches WHERE created_at < p_before ORDER BY created_at LIMIT greatest(1, least(p_limit, 5000)))
  DELETE FROM local_searches s USING old WHERE s.id = old.id; GET DIAGNOSTICS v_s = ROW_COUNT;
  RETURN jsonb_build_object('fetches', v_f, 'grids', v_g, 'searches', v_s);
END $$;

DO $$ DECLARE f text; BEGIN
  FOREACH f IN ARRAY ARRAY[
    'save_local_business(text,text,text,text,text,numeric,numeric,integer,text,jsonb,uuid)',
    'find_local_reuse(text,text,text,timestamptz)','claim_local_poll(text,text,uuid,integer)',
    'prune_local_seo(timestamptz,integer)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO service_role', f);
  END LOOP;
END $$;
NOTIFY pgrst, 'reload schema';
```

Error mapping: `local_business_cap:competitors` → `AppError(409,"competitor_limit","You can save up to 10 local competitors. Remove one first.")`; `local_business_invalid:*` → `400 invalid_request`; unique violation on CID/place_id from a concurrent save → retried once; anything else → `AppError(503,"local_unavailable","Local data could not be saved. Please retry.")`.

**Required objects** (`scripts/setup-supabase.mjs`): `"120_f17_local_seo.sql"`: tables `local_businesses`, `local_fetches`, `local_fetch_items`, `local_grid_runs`, `local_searches`; `"121_f17_local_seo_functions.sql"`: functions `save_local_business`, `find_local_reuse`, `claim_local_poll`, `prune_local_seo`.

**Tenant RLS test** (`tests/customer-uat.sql`): per workspace one own business, one fetch with one item, one grid, one search; as user 1 every `count(*)` = 1; an item insert with workspace 2's `brand_key` and workspace 1's `fetch_id` fails the composite FK.

**Migration paperwork:** `README.md` rows `120_f17_local_seo` "Local SEO: saved businesses, review/post/Q&A fetches and items, map rank grids, local search history; 13-month retention." and `121_f17_local_seo_functions` "Local SEO functions: business save with caps, one-hour reuse, poll throttling, retention."; `docs/OPERATOR_LEDGER.md` § C ("apply 120 and 121 before deploying F17 phase 2"); `docs/PROD_MIGRATIONS.md` two bullets.

### 6.2 Server modules

TypeScript under `src/lib/**`, erasable syntax, relative imports with extensions; COPY/PORT files carry the licence header.

#### 6.2.1 `src/lib/providers/dataforseo/business.ts` (PORT of `openseo:src/server/lib/dataforseo/business.ts:1-334`; F02 §6.2.3 rule: sections owned by other specs live in their own file)

Exports with OpenSEO's names, inputs and request bodies: `fetchBusinessListingsSearch`, `fetchQuestionsAnswers`, `fetchMyBusinessInfo`, `postGoogleReviewsTask`, `postMyBusinessUpdatesTask`, `fetchBusinessDataTaskResult`, `fetchBusinessListingsCategories`, types `BusinessTaskEndpoint`, `BusinessTaskOutcome`, `BusinessCategoryRow`. Changes: imports from F02 `./core.ts`/`./envelope.ts`; `NO_RETRY` is redundant (F02 POSTs never retry) and is dropped; `fetchBusinessDataTaskResult` failures throw F02's `AppError(502,"dataforseo_task_failed")` with the status message. **Added:**

```ts
export function createBusinessClient(deps?: { meter?: typeof meter }) {
  const m = deps?.meter ?? meter;
  return {
    businessListings: m(fetchBusinessListingsSearch, (i) => dataforseoPricing.business.businessListings({ limit: i.limit }), "local.business"),
    myBusinessInfo:   m(fetchMyBusinessInfo, () => dataforseoPricing.business.myBusinessInfo({}), "local.business"),
    questionsAnswers: m(fetchQuestionsAnswers, (i) => dataforseoPricing.business.questionsAnswers({ depth: i.depth }), "local.business"),
    reviewsTaskPost:  m(postGoogleReviewsTask, (i) => dataforseoPricing.business.reviewsTaskPost({ depth: i.depth, includeOtherSources: i.includeOtherSources }), "local.reviews"),
    updatesTaskPost:  m(postMyBusinessUpdatesTask, (i) => dataforseoPricing.business.updatesTaskPost({ depth: i.depth }), "local.business"),
  };
}
export type BusinessClient = ReturnType<typeof createBusinessClient>;
```

`fetchBusinessDataTaskResult` and `fetchBusinessListingsCategories` are free and are **not** wrapped (`business.ts:154-158`, `:314`). Local SERP fetchers come from F02's `serp.ts`: `createDataforseoClient().serp.local` (feature passed by caller `local.serp`), `.serp.localTaskPost` (feature `local.grid`), and the free `fetchLocalSerpTaskResult`.

#### 6.2.2 `src/lib/local/shared.ts` (PORT of `openseo:src/server/mcp/tools/local-seo-shared.ts:1-149`, `dataforseo-research-tools.ts:83-136, 466-471`, `openseo:src/server/mcp/table.ts:105-112`)

```ts
export const BUSINESS_DATA_MIN_RADIUS_M = 200, BUSINESS_DATA_MAX_RADIUS_M = 199_999, BUSINESS_DATA_DEFAULT_RADIUS_KM = 10;
export const DEFAULT_LOCAL_SERP_ZOOM = 12;
export function formatCoordinate(value: number): string;                                   // 7 dp, trailing zeros dropped
export const nearSchema: z.ZodObject;            // { latitude -90..90, longitude -180..180, radiusKm 0.2..199 optional }
export const listingsNearSchema: z.ZodObject;    // { latitude, longitude, radiusKm 1..100 }
export const localSerpNearSchema: z.ZodObject;   // { latitude, longitude, zoom int 4..18 optional }
export function formatBusinessDataCoordinate(near): string;     // "lat,lng,<metres>"
export function formatBusinessListingsCoordinate(near): string; // "lat,lng,<whole km ≥ 1>"
export function formatLocalSerpCoordinate(near: { latitude: number; longitude: number; zoom?: number }): string; // "lat,lng[,<z>z]"
export const businessIdentifierSchema: z.ZodObject;             // { businessName?: 1..200, cid?: /^[0-9]{1,30}$/, placeId?: 1..256 }
export function resolveBusinessIdentifier(i): { keyword?: string; cid?: string; placeId?: string }; // exactly one, else AppError(400,"identifier_required","Provide exactly one business identifier: name, CID or place ID.")
export function businessIdentifierKeyword(id): string;          // "cid:<cid>" | "place_id:<id>" | name
export function readPath(source: unknown, ...path: string[]): unknown;   // COPY table.ts:105-112
export function pickRowFields(row: unknown, fields: readonly string[]): Record<string, unknown>;
```

`src/lib/local/rowFields.ts` (COPY): `LOCAL_BUSINESS_ROW_FIELDS` (`dataforseo-research-tools.ts:682-699`), `LOCAL_SERP_ROW_FIELDS` (`:703-726`), `BUSINESS_QUESTION_ROW_FIELDS`, `BUSINESS_ANSWER_ROW_FIELDS`, `trimBusinessQuestionRow`, `latestAnswerText` (`:760-810`), `REVIEW_ROW_FIELDS` (`local-seo-tools.ts:322-340`), `BUSINESS_UPDATE_ROW_FIELDS` (`:484-493`), `formatPostLinks` (`:497-506`).

`src/shared/local-coordinates.ts` (new, client-safe): `parseMapsLocation(input: string): { latitude: number; longitude: number; zoom: number | null } | null` — accepts a Google Maps URL containing `@<lat>,<lng>,<z>z` (zoom kept, rounded, clamped 4–18), or `!3d<lat>!4d<lng>` (place URLs; zoom null), or plain "lat, lng" / "lat lng"; rejects latitude outside ±90, longitude outside ±180, and any other text; never fetches (short links like `maps.app.goo.gl` are rejected with null, and the UI says "Paste the full Google Maps link from your browser's address bar."). `googleMapsPointUrl(lat, lng, zoom, keyword?)` builds `https://www.google.com/maps/search/<encoded keyword>/@lat,lng,<z>z` (or `/@lat,lng,<z>z` without a keyword) for "Open in Google Maps" links.

#### 6.2.3 `src/lib/local/profile.ts` (PORT of `local-seo-tools.ts:127-252`)

```ts
export type BusinessProfileView = { title: string | null; category: string | null; additionalCategories: string[];
  rating: { value: number | null; votes: number | null }; ratingDistribution: Record<"1"|"2"|"3"|"4"|"5", number> | null;
  address: string | null; phone: string | null; website: string | null; domain: string | null; isClaimed: boolean | null;
  currentStatus: string | null; hours: Array<{ day: "monday"|"tuesday"|"wednesday"|"thursday"|"friday"|"saturday"|"sunday"; spans: Array<{ open: string; close: string }> }> | null;
  totalPhotos: number | null; cid: string | null; placeId: string | null; latitude: number | null; longitude: number | null; checkUrl: string | null };
export function toProfileView(raw: Record<string, unknown>): BusinessProfileView;   // from formatProfileText/formatTimetable/formatRatingDistribution :137-217
export async function lookupBusinessProfile(ws, i: { identifier; near?; locationCode?; languageCode?; save?: "own" | "competitor";
  maxUsd?: number; requestId: string }, deps?): Promise<{ profile: BusinessProfileView | null; businessId: string | null }>;
export async function refreshBusinessProfile(ws, businessId: string, i: { maxUsd?: number; requestId: string }, deps?): Promise<BusinessProfileView | null>;
```

Location: `near` → `formatBusinessDataCoordinate`; else `locationCode ?? workspaceMarket(brand).locationCode`; language default `getLanguageCode(locationCode)` (`local-seo-tools.ts:54-68`). Call `business.myBusinessInfo({ brandKey, feature: "local.business", idempotencyKey: "local.profile:" + requestId, maxUsd }, …)`. `website`/`checkUrl` pass `safeHttpUrl` (F02/F04 `src/shared/safe-url.ts`) or become null. A profile with `save` → `save_local_business(…, profile)`. Research log: kind `local.business`, key `profile|<cid ?? placeId ?? name>`, summary "Google Business Profile for <title>: <category>, <rating>★ from <votes> reviews." or "No Google Business Profile matched <identifier>.".

#### 6.2.4 `src/lib/local/listings.ts` (PORT of `dataforseo-research-tools.ts:229-282, 533-559, 954-999`; `local-seo-tools.ts:594-689`)

```ts
export async function searchLocalBusinesses(ws, i: { near; query?: string; categories?: string[]; minRating?: number; minReviews?: number;
  isClaimed?: boolean; sortBy?: "relevance"|"rating"|"reviews"; limit: number; offset: number; maxUsd?: number; requestId: string }, deps?):
  Promise<{ businesses: LocalBusinessRow[]; cached: boolean; fetchedAt: string }>;
export async function listBusinessCategories(i: { query?: string; limit: number }, deps?): Promise<{ categories: BusinessCategoryRow[]; total: number }>;
```

Filters: `minRating` → `["rating.value", ">=", n]`, `minReviews` → `["rating.votes_count", ">=", n]` joined with `"and"` (F13 `filters.ts` `pushAnd`); `sortBy` rating → `["rating.value,desc"]`, reviews → `["rating.votes_count,desc"]`, relevance → none. Cache: `cached({ namespace: "local.listings", version: 1, keyParts: [lat, lng, radiusKm, query, categories, minRating, minReviews, isClaimed, sortBy, limit, offset], ttlSeconds: 86400, scope: "global", schema })` through F13 `cachedIf` (keep non-empty). Rows → `pickRowFields(LOCAL_BUSINESS_ROW_FIELDS)` then `LocalBusinessRow = { title, category, additionalCategories, rating, votes, isClaimed, domain, url (safe), phone, address, cid, placeId, latitude, longitude, totalPhotos, checkUrl (safe), isSaved: "own" | "competitor" | null }`. A `local_searches` row records parameters and counts. Categories: `cached({ namespace: "local.categories", version: 1, keyParts: [], ttlSeconds: 604800, scope: "global" })` over the free `fetchBusinessListingsCategories()` (not metered), filtered in memory by case-insensitive substring, sliced to `limit` (default 50, max 200).

#### 6.2.5 `src/lib/local/fetches.ts` (PORT of `local-seo-tools.ts:80-121, 258-588`, `dataforseo-research-tools.ts:1050-1091`)

```ts
export const INLINE_POLL_ATTEMPTS = 5, INLINE_POLL_INTERVAL_MS = 4000, REUSE_WINDOW_MINUTES = 60;
export type FetchKind = "reviews" | "extended_reviews" | "updates" | "questions";
export async function startFetch(ws, i: { kind: "reviews" | "updates" | "questions"; businessId: string; depth: number;
  sortBy?: "newest" | "highest_rating" | "lowest_rating" | "relevant"; includeOtherSources?: boolean; maxUsd?: number; requestId: string }, deps?):
  Promise<FetchView>;                  // status "completed" | "processing" | "failed"
export async function collectFetch(ws, fetchId: string, deps?): Promise<FetchView>;
export async function listFetches(ws, i: { businessId?: string; kind?: FetchKind; limit: number }): Promise<FetchSummary[]>;
export type FetchView = { id: string; kind: FetchKind; status: "processing" | "completed" | "failed"; businessId: string | null;
  params: { depth: number; sortBy?: string; includeOtherSources?: boolean }; totals: { reviewsCount?: number | null; rating?: number | null; title?: string | null } | null;
  items: unknown[] | null; itemCount: number; reused: boolean; error: { code: string; message: string } | null;
  createdAt: string; completedAt: string | null; pollAfterSeconds: number | null };
```

`startFetch` order:
1. Business must exist in the workspace (`404 business_not_found`); identifier = its CID, else place_id (never a name, so chains cannot mismatch, `SKILL.md:82`); coordinate = its latitude/longitude (radius 10 km) when known, else its `location_code`.
2. `kind` reviews with `includeOtherSources` → stored kind `extended_reviews` (sort ignored, as OpenSEO).
3. `params_hash` = sha256 of F01 `stableStringify({ kind, identifier, depth, sortBy, coordinate })`; `find_local_reuse(…, "fetch", hash, now − 60 min)` hit → return that fetch with `reused: true` (no spend; quotes show `reuse_note`).
4. Insert the `local_fetches` row (`request_id` unique: a repeated `requestId` returns the existing row via `ON CONFLICT (request_id) DO NOTHING` + select).
5. Questions: `business.questionsAnswers({ brandKey, feature: "local.business", idempotencyKey: "local.questions:" + requestId, maxUsd }, { keyword: businessIdentifierKeyword(id), locationCoordinate, languageCode, depth })` (live); rows → `trimBusinessQuestionRow` → items; status completed.
6. Reviews/posts: `business.reviewsTaskPost` / `.updatesTaskPost` with `idempotencyKey: "local.<kind>:" + requestId` → store `provider_task_id` **before** polling (so the paid task is never lost); then poll `fetchBusinessDataTaskResult` up to 5 × 4 s; completed → items (`REVIEW_ROW_FIELDS` / `BUSINESS_UPDATE_ROW_FIELDS`, `review_text` and `owner_answer` kept whole; capped at 200 items), `totals` from the result (`title`, `reviews_count`, `rating.value`), status completed; still pending → return `processing` with `pollAfterSeconds: 5`; a collection error → leave `processing` and return it (the next `GET` retries for free, `local-seo-tools.ts:100-110`).
7. A failed paid call (`ChargedCallError`, `AmbiguousCallError`) → status `failed`, `error_code`, message "Google data could not be collected. Try again later."; `UnbilledCallError` → row deleted and the error mapped by F13 `toResearchError` (`unavailableCode: "local_unavailable"`).
8. Research log once per completed paid fetch (not for reuse): kind `local.reviews` or `local.business`; summaries "Reviews for <title>: collected <n> of <total>.", "Posts on <title>'s profile: <n> collected.", "Questions on <title>'s profile: <n> collected.".

`collectFetch`: completed/failed → stored view; processing → `claim_local_poll(…, 4)` true → one free `fetchBusinessDataTaskResult`; completed → items written (`local_fetch_items` upsert by `idx`, idempotent), status completed; a provider failure status → `failed` with the message trimmed; a transient error → stays processing. `pollAfterSeconds` 5 while processing.

#### 6.2.6 `src/lib/local/grid.ts` (PORT of `local-seo-tools.ts:691-1180`)

```ts
export const KM_PER_DEGREE_LATITUDE = 110.574, KM_PER_DEGREE_LONGITUDE = 111.32, MIN_LONGITUDE_COSINE = 0.01;
export const RANK_GRID_DEPTH = 20, RANK_GRID_ZOOM_NUMERATOR_KM = 24045, MIN_RANK_GRID_ZOOM = 4, MAX_RANK_GRID_ZOOM = 18;
export const GRID_INLINE_COLLECT_MS = 20_000, GRID_POLL_INTERVAL_MS = 5000;
export function rankGridZoom(spacingKm: number, latitude: number): number;                       // COPY :724-733
export function buildRankGridPoints(center, gridSize: 3 | 5, spacingKm: number): GridPoint[];     // COPY :833-865
export function matchGridItem(items: unknown[], target: { cid?: string; placeId?: string; name?: string }): unknown; // COPY :867-880
export function gridPointResult(point: GridPoint, outcome: LocalSerpTaskOutcome, target): GridPointResult;          // PORT :1110-1139
export function summarizeGrid(points: GridPointResult[]): GridSummary;                                              // PORT :1141-1155, plus `failed`
export async function startGrid(ws, i: { keyword: string; center: { latitude: number; longitude: number }; gridSize: 3 | 5;
  spacingKm: number; device: "desktop" | "mobile"; zoom?: number; languageCode?: string;
  target: { businessId?: string; cid?: string; placeId?: string; name?: string }; maxUsd?: number; requestId: string }, deps?): Promise<GridView>;
export async function collectGrid(ws, gridId: string, deps?): Promise<GridView>;
export async function listGrids(ws, limit: number): Promise<GridSummaryRow[]>;
export type GridPointResult = { row: number; col: number; latitude: number; longitude: number; rank: number | null;
  resultsCount?: number; topResult?: { title: string | null; cid: string | null } | null; error?: true };
export type GridSummary = { pointsSearched: number; pointsFound: number; failed: number; averageRank: number | null; top3Count: number; top10Count: number };
export type GridView = { id: string; status: "processing" | "completed" | "failed"; keyword: string; center; gridSize; spacingKm; zoom; device;
  pointsReady: number; pointsTotal: number; points: GridPointResult[] | null; summary: GridSummary | null;
  matched: { title: string | null; cid: string | null; placeId: string | null } | null; reused: boolean;
  error: { code: string; message: string } | null; createdAt: string; pollAfterSeconds: number | null };
```

`startGrid`: target from `businessId` (CID/place_id/title of the saved business) or explicit ids/name; none → `400 grid_target_required` "Choose the business to find in each search."; `zoom ?? rankGridZoom(spacing, center.latitude)`; language default the business's or workspace's; daily limit: more than 20 grids created today (UTC) for the workspace → `AppError(429,"local_grid_limit","This workspace has run 20 map grids today. Try again tomorrow.")`; `params_hash` over keyword, centre, size, spacing, zoom, device, language (the target is not part of the key: it only filters rows, `:1030`); reuse within 60 minutes → that run with `reused: true`; when the requested target differs from the stored one, points, summary and match are recomputed from `point_rows` (each point's top 20 `{ cid, place_id, title, rank }` tuples, stored on completion), so a grid can be re-read for a competitor without buying it again. Then insert the run with `task_ids = []`, `createDataforseoClient().serp.localTaskPost({ brandKey, feature: "local.grid", idempotencyKey: "local.grid:" + requestId, maxUsd }, { keyword, locationCoordinates: points.map(p => formatLocalSerpCoordinate({ ...p, zoom })), languageCode, device, depth: 20 })`, store `task_ids`; inline collection until `GRID_INLINE_COLLECT_MS` (all tasks in parallel, 5 s apart); all ready → complete; else `processing` with `pointsReady`. All points failed → status `failed`, `error_code "local_grid_failed"`, message "Every map search failed at the data provider. Try again later.", and the run is excluded from reuse (status failed), mirroring the receipt reset (`:1092-1107`). Research log kind `local.grid`, key `<keyword>|<lat>|<lng>|<size>|<spacing>`, summary "Map ranking grid for “<keyword>” (<size>×<size>, <spacing> km): ranked at <found> of <searched> points, average <avg>.".

`collectGrid`: processing → `claim_local_poll(…, "grid", id, 4)` → one free `fetchLocalSerpTaskResult` per still-pending point (25 in flight max); write `points`/`point_rows`/`summary`/`matched` when every point is ready.

#### 6.2.7 `src/lib/local/localSerp.ts` (PORT of `dataforseo-research-tools.ts:284-309, 1001-1048`)

```ts
export async function getLocalSerpResults(ws, i: { keyword: string; near: { latitude: number; longitude: number; zoom?: number };
  searchType: "maps" | "local_finder"; device: "desktop" | "mobile"; depth: number; languageCode?: string; maxUsd?: number; requestId: string }, deps?):
  Promise<{ results: LocalSerpRow[]; ownRank: number | null; cached: boolean; fetchedAt: string }>;
```

`createDataforseoClient().serp.local({ brandKey, feature: "local.serp", idempotencyKey: "local.serp:" + requestId, maxUsd }, { keyword, locationCoordinate: formatLocalSerpCoordinate({ ...near, zoom: near.zoom ?? 12 }), languageCode, searchType, device, depth, searchPlaces: false })`, cached `cached({ namespace: "local.serp", version: 1, keyParts: [keyword, lat, lng, zoom, searchType, device, depth, languageCode], ttlSeconds: 43200, scope: "global" })` via `cachedIf` (non-empty). Rows → `LOCAL_SERP_ROW_FIELDS` → `LocalSerpRow = { rank (rank_absolute ?? rank_group), title, domain, url (safe), phone, address, category, additionalCategories, rating, votes, priceLevel, isClaimed, cid, placeId, latitude, longitude, totalPhotos, isOwn, isCompetitor }`; `isOwn` = CID or place_id equals the own business, else `domain` equals the workspace `website_host` without `www.`. A `local_searches` row stores parameters, `result_count`, `own_rank`. Research log kind `local.serp` on a miss: "Local results for “<keyword>” near <lat>,<lng>: <n> businesses; you rank <r | not in the results>.".

#### 6.2.8 `src/lib/local/businesses.ts`

```ts
export async function listBusinesses(ws): Promise<SavedBusinessView[]>;    // own first, then competitors by title
export async function saveBusiness(ws, i: { role: "own" | "competitor"; title: string; cid?: string; placeId?: string;
  latitude?: number; longitude?: number; locationCode?: number; languageCode?: string }): Promise<SavedBusinessView>;   // identity only; profile untouched
export async function updateBusinessRole(ws, businessId: string, role: "own" | "competitor"): Promise<SavedBusinessView>;
export async function removeBusiness(ws, businessId: string): Promise<void>;
```

`saveBusiness` requires a CID or place_id (`400 identifier_required`); the profile stays `null` until a priced lookup.

#### 6.2.9 Priced actions (`src/lib/pricing/actions/local.ts`, one import line in `src/lib/pricing/actions/index.ts`)

| Key | Feature | Input (`z.strictObject`) | `requireApproval` | Estimate (exact labels) |
|---|---|---|---|---|
| `local.profile.lookup` | `local.business` | `{ identifier: businessIdentifierSchema, near: nearSchema.optional(), locationCode: z.int().positive().optional() }` | false | "Google Business Profile lookup" = `business.myBusinessInfo({})` (0.0054). Warning `recent_research`. |
| `local.listings.search` | `local.business` | `{ near: listingsNearSchema, query?, categories?: z.array(z.string().min(1).max(120)).max(10), minRating?: 1..5, minReviews?: int ≥ 0, isClaimed?: boolean, sortBy?: enum, limit: z.int().min(1).max(50).default(20), offset: z.int().min(0).max(1000).default(0) }` | false | "Up to {limit} nearby businesses" = `business.businessListings({ limit })`. Warning `cache_note` "Repeating this search within 24 hours is free." (total 0 on a cache hit, checked with `peekCached`). |
| `local.reviews.collect` | `local.reviews` | `{ businessId: z.uuid(), depth: z.union([20, 50, 100, 200]), sortBy?, includeOtherSources: z.boolean().default(false) }` | false | "Collect up to {depth} Google reviews" = `business.reviewsTaskPost({ depth, includeOtherSources: false })`, or "Collect up to {depth} reviews from Google and other sites" with `includeOtherSources: true`. Warning `reuse_note` (total 0) "You collected these reviews {n} minutes ago. That result is reused at no cost." |
| `local.updates.collect` | `local.business` | `{ businessId, depth: z.union([10, 20, 50, 100]) }` | false | "Collect up to {depth} profile posts" = `business.updatesTaskPost({ depth })`. `reuse_note`. |
| `local.questions.collect` | `local.business` | `{ businessId, depth: z.union([20, 50, 100]) }` | false | "Collect up to {depth} questions and answers" = `business.questionsAnswers({ depth })`. `reuse_note`. |
| `local.serp.search` | `local.serp` | `{ keyword: z.string().trim().min(1).max(120), near: localSerpNearSchema, searchType: enum default maps, device: enum default mobile, depth: z.int().min(1).max(100).default(20), languageCode? }` | false | Maps: "Google Maps results for “{keyword}”" = `serp.local({ searchType: "maps", depth })` (0.002); Local Finder: "Local Finder results for “{keyword}”" = `serp.local({ searchType: "local_finder", depth })`. `cache_note` "Results for the same search and place are reused for 12 hours." |
| `local.grid.run` | `local.grid` | `{ keyword, center: { latitude, longitude }, gridSize: z.union([3, 5]).default(3), spacingKm: z.number().min(0.25).max(10).default(2), device: default mobile, zoom?: int 4..18, languageCode? }` | **true** | "{n} Google Maps searches ({size}×{size} grid, {spacing} km apart)" = `serp.localTaskPost({ locationCoordinates })` (n × 0.0012). Warnings: `grid_size_note` (5×5) "A 5×5 grid runs 25 searches. Use it when your service area is wide."; `center_note` "Check that the centre is your storefront before running. A grid centred in the wrong place is worse than no grid."; `reuse_note`. Blocked: `local_grid_limit` (20 today). |

Every paid route calls `requireApprovedPrice(key, ctx, input, body.maxUsd)` before reserving and passes `approvedMaxUsd` as `maxUsd` to the metered call. When a quote total is 0 (cache hit or reuse), the client omits `maxUsd`.

#### 6.2.10 Contracts, tools, telemetry, registrations

- `src/lib/local/local.contract.ts`: contracts for every §6.5 route.
- `src/lib/local/tools.ts` (shape of F13 §6.2.6; F22 registers them): `search_local_businesses`, `get_local_serp_results`, `get_local_rank_grid` (input adds optional `gridId` to resume), `get_business_profile`, `get_business_reviews` (optional `fetchId` to resume), `get_business_updates` (`fetchId`), `get_google_business_questions`, `list_business_categories` (free). Descriptions adapted from OpenSEO's (`local-seo-tools.ts:223-224`, `:372-373`, `:528-529`, `:636-637`, `:957-958`; `dataforseo-research-tools.ts:958-959`, `:1005-1006`, `:1054-1055`) with "Charges credits" replaced by "Paid: call the price estimate for <action> first and pass the approved maxUsd." Handlers call the §6.2.3–6.2.7 services.
- `src/lib/local/jobs.ts`: periodic `local.retention` (86,400 s) → `enqueueSystemJob("local.retention", {}, { dedupeKey: "local.retention:" + YYYY-MM-DD })`; kind `local.retention`: `prune-1`…`prune-20` (`DB_STEP`) `prune_local_seo(now − 395 days, 1000)` while any count is 1,000. `src/lib/jobs/kinds.ts` gains `import "../local/jobs.ts";`.
- `src/shared/spend-features.ts`: the four keys with labels "Local business profiles and listings", "Business reviews", "Local search results", "Local rank grids". `src/lib/features/names.ts`: `local_seo: { spend: ["local.business","local.reviews","local.serp","local.grid"] as const }`. `src/lib/features/clientFeatures.ts` appends `"local_seo"`.

### 6.3 Jobs

| Kind / periodic | Trigger | Steps | Completion |
|---|---|---|---|
| periodic `local.retention` (86,400 s) | F01 `definePeriodic` | enqueue `local.retention` | — |
| `local.retention` | system | `prune-<n>` loop (`DB_STEP`) | `completed` `{ fetches, grids, searches }` |

No other jobs: paid posts happen once inside the request (metered, never retried); collection is free and driven by the client's polling of `GET` routes, with `claim_local_poll` limiting provider reads to one per 4 s per fetch or grid. A paid task id is stored before any polling, so a lost response never loses the purchase.

### 6.4 Provider calls and cost

| Use | Endpoint | Body per task | Fields used | Unit price (F03) | Retries |
|---|---|---|---|---|---|
| Listings search | `POST /v3/business_data/business_listings/search/live` | `categories, title, location_coordinate "lat,lng,km", is_claimed, filters, order_by, limit, offset` | `result[0].items[]` → `LOCAL_BUSINESS_ROW_FIELDS` | $0.012 + $0.00036/row | 0 |
| Profile | `POST /v3/business_data/google/my_business_info/live` | `keyword (name \| cid: \| place_id:), location_coordinate "lat,lng,m" \| location_code, language_code` | `result[0].items[0]`, `result[0].check_url` | $0.0054 | 0 |
| Q&A | `POST /v3/business_data/google/questions_and_answers/live` | `keyword, location_coordinate, language_code, depth` | `items`, `items_without_answers` | $0.0054 per 20 | 0 |
| Reviews | `POST /v3/business_data/google/reviews/task_post` (or `extended_reviews/task_post`) | `keyword?, cid?, place_id?, location, language_code, depth, sort_by (regular only), priority: 2` | task `id`, `cost` | $0.001 + $0.0015/10 (extended $0.01/20) | 0 |
| Posts | `POST /v3/business_data/google/my_business_updates/task_post` | `keyword, location, language_code, depth, priority: 2` | task `id`, `cost` | $0.003 + $0.0015/10 | 0 |
| Collection | `GET /v3/business_data/google/{reviews\|extended_reviews\|my_business_updates}/task_get/{id}` | — | `result[0]` (`items`, `reviews_count`, `rating`, `title`, `cid`) | free | 2 (F02 GET) |
| Categories | `GET /v3/business_data/business_listings/categories` | — | `result[]` | free | 2 |
| Local results | `POST /v3/serp/google/maps/live/advanced` or `local_finder/live/advanced` | `keyword, location_coordinate "lat,lng,<z>z", language_code, device, os, depth, search_places: false` | `items[]` → `LOCAL_SERP_ROW_FIELDS` | $0.002 (Maps) / $0.002 per 10 (Local Finder) | 0 |
| Grid | `POST /v3/serp/google/maps/task_post` (≤ 25 tasks) | per point, `tag: "<index>"`, `priority: 2`, `depth: 20`, `search_places: false` | `tasks[].id, data.tag, cost` | $0.0012 per point | 0 |
| Grid collection | `GET /v3/serp/google/maps/task_get/advanced/{id}` | — | `items[]` | free | 2 |

**Caches.** `local.listings` (global, 24 h), `local.serp` (global, 12 h), `local.categories` (global, 7 days): public market data (§5.6). Profiles are stored per workspace on `local_businesses`; reviews, posts, Q&A and grids are stored per workspace and reused for 60 minutes.

**Fixtures** (`tests/fixtures/f17/`, synthetic from DataForSEO's public docs; person names replaced by "Reviewer A/B", text by short neutral sentences, no account ids): `business-info.json`, `business-info-no-results.json` (40501), `listings-search.json` (5 rows), `qa.json` (2 answered, 1 unanswered), `reviews-task-post.json`, `reviews-task-get-pending.json`, `reviews-task-get-done.json` (20 reviews, 6 with owner answers), `extended-reviews-task-get-done.json`, `updates-task-get-done.json`, `categories.json` (50 rows), `maps-live.json` (20 rows incl. the target CID at rank 4), `local-finder-live.json`, `maps-task-post-9.json` (8 accepted, 1 refused), `maps-task-get-<i>.json` (9 point results, one sparse with 2 rows), `maps-task-get-failed.json`. Live QA: `scripts/qa/check-f17-live.mjs --brand <key> --max-spend-usd 0.05` (one profile lookup and one Maps search; owner-run only).

### 6.5 API routes

All under `src/app/api/customer/local/`: `requireWorkspace` (members and owners); `isFeatureEnabled("local_seo", brandKey)` false → `404 feature_unavailable` ("This page is not available for your workspace yet."); `toErrorResponse`; `Cache-Control: no-store`; `export const maxDuration = 60` on routes that poll inline. Common errors: 400 `invalid_request`/`invalid_json`/`identifier_required`; 401/403/404/503 from `requireWorkspace`; 402 `daily_cap`/`workspace_cap`; 403 `feature_disabled`; 409 `price_changed`, `duplicate_paid_call`; 502 `local_unavailable` ("Local data could not be loaded. Please retry.", F13 `toResearchError`); 503 `local_unavailable`.

| Method and path | Request | Response (example) | Extra errors |
|---|---|---|---|
| `GET /businesses` | — | `{ "businesses": [ { "id": "…", "role": "own", "title": "Offcult Store", "cid": "1234567890123456789", "placeId": "ChIJ…", "latitude": 19.0760, "longitude": 72.8777, "profile": { …BusinessProfileView }, "profileFetchedAt": "…" } ] }` | — |
| `POST /businesses` | `{ brand_key?, role, title: 1..300, cid?, placeId?, latitude?, longitude?, locationCode?, languageCode? }` | 201 `{ "business": {…, "profile": null } }` | 409 `competitor_limit` |
| `PATCH /businesses/[businessId]` | `{ brand_key?, role }` | `{ "business": {…} }` | 404 `business_not_found` |
| `DELETE /businesses/[businessId]` | — | `{ "removed": true }` | 404 |
| `POST /profile` | `{ brand_key?, identifier, near?, locationCode?, languageCode?, save?: "own" \| "competitor", maxUsd?, requestId: z.uuid() }` | `{ "profile": {…} \| null, "businessId": "…" \| null }` | — |
| `POST /businesses/[businessId]/profile` | `{ brand_key?, maxUsd?, requestId }` | `{ "profile": {…} \| null }` | 404 |
| `POST /listings` | `{ brand_key?, …local.listings.search input, maxUsd?, requestId }` | `{ "businesses": [ { "title": "Bonkers Corner", "category": "Clothing store", "rating": 4.3, "votes": 812, "isClaimed": true, "domain": "bonkerscorner.com", "phone": "+91 …", "address": "…", "cid": "…", "placeId": "…", "latitude": 19.07, "longitude": 72.88, "isSaved": null } ], "cached": false, "fetchedAt": "…" }` | — |
| `GET /categories` | query `{ q?: 1..80, limit?: 1..200 }` | `{ "categories": [ { "category": "clothing_store", "businessCount": 512334 } ], "total": 1 }` | — |
| `POST /fetches` | `{ brand_key?, kind: "reviews" \| "updates" \| "questions", businessId, depth, sortBy?, includeOtherSources?, maxUsd?, requestId }` | 200 `FetchView` (completed) or **202** `FetchView` (`"status": "processing"`, `"pollAfterSeconds": 5`) | 404 `business_not_found` |
| `GET /fetches/[fetchId]` | — | `FetchView` (items: reviews `{ rank_absolute, time_ago, timestamp, rating: { value }, review_text, profile_name, local_guide, source, owner_answer, owner_time_ago, review_id }`) | 404 `fetch_not_found` |
| `GET /fetches` | `{ businessId?, kind?, limit?: 1..50 = 20 }` | `{ "fetches": [ { "id", "kind", "status", "itemCount", "createdAt", "params" } ] }` | — |
| `POST /serp` | `{ brand_key?, …local.serp.search input, maxUsd?, requestId }` | `{ "results": [ { "rank": 1, "title": "…", "rating": 4.6, "votes": 1203, "isOwn": false, … } ], "ownRank": 4, "cached": true, "fetchedAt": "…" }` | — |
| `POST /grids` | `{ brand_key?, keyword, center, gridSize, spacingKm, device, zoom?, languageCode?, target: { businessId?, cid?, placeId?, name? }, maxUsd?, requestId }` | 200 `GridView` (completed) or **202** (processing, `pointsReady`, `pointsTotal`, `pollAfterSeconds: 5`) | 400 `approval_required`, `grid_target_required`; 429 `local_grid_limit`; 502 `local_grid_failed` |
| `GET /grids/[gridId]` | — | `GridView` | 404 `grid_not_found` |
| `GET /grids` | `{ limit?: 1..50 = 20 }` | `{ "grids": [ { "id", "keyword", "gridSize", "spacingKm", "status", "summary", "createdAt" } ] }` | — |

Example `GridView` (completed):

```json
{ "id": "3c1e…", "status": "completed", "keyword": "streetwear store", "center": { "latitude": 19.076, "longitude": 72.8777 },
  "gridSize": 3, "spacingKm": 2, "zoom": 13, "device": "mobile", "pointsReady": 9, "pointsTotal": 9,
  "points": [ { "row": 0, "col": 0, "latitude": 19.0940872, "longitude": 72.8586652, "rank": 6, "resultsCount": 20,
                "topResult": { "title": "Bonkers Corner", "cid": "987…" } } ],
  "summary": { "pointsSearched": 9, "pointsFound": 7, "failed": 1, "averageRank": 4.29, "top3Count": 3, "top10Count": 7 },
  "matched": { "title": "Offcult Store", "cid": "1234567890123456789", "placeId": "ChIJ…" }, "reused": false,
  "error": null, "createdAt": "2026-10-22T08:10:00.000Z", "pollAfterSeconds": null }
```

Idempotency: every paid route takes `requestId` (UUID); the metered idempotency key is `local.<action>:<requestId>`; fetch and grid rows are unique on `request_id`, so a retried request returns the same row rather than buying twice (F01 `duplicate_paid_call` is the last line).

### 6.6 UI

`/portal/local` (`src/app/portal/local/page.tsx` → `src/components/portal/local/LocalSeoPage.tsx`). Built from F04 (`PageHeader`, `CardShell`, `Card`, `NavTabs`, `Button`, `Badge`, `Alert`, `Skeleton`, `EmptyState`, `QueryState`, `ConfirmDialog`, `FormDialog`, `Tooltip`, `Select`, `SegmentedToggle`, `CountryCombobox`, `CopyButton`, `SafeExternalLink`, `ExpandableList`), F05 (`useUrlSearchState`, `useServerPacedQuery`, `fetchJson`, `keys`), F06 (`DataTable`, `useDataTable`, `TablePagination`, `SortableHeader`), F09 (`CostReviewDialog`), F13 (`PricedActionButton`, `LOCATION_OPTIONS`, `SERP_LANGUAGE_OPTIONS`). Navigation: `items.ts` group `research` → `{ id: "local", label: "Local", href: "/portal/local", icon: MapPin, flag: "local_seo" }`. Query keys: `localBusinesses(brandKey)`, `localFetch(brandKey, fetchId)`, `localFetches(brandKey, businessId, kind)`, `localGrid(brandKey, gridId)`, `localGrids(brandKey)`, `localCategories(query)`. URL state: `tab=profile|reviews|posts|questions|grid|results`, `business=<id>` (competitor view), `fetch=<id>`, `grid=<id>`.

`PageHeader` title "Local SEO", description "See how your business looks and ranks on Google Maps: profile, reviews, posts, questions and map rankings around your location."

#### 6.6.1 Business picker (`BusinessPicker.tsx`)

- **No own business yet:** `CardShell` "Find your business on Google" with three `SegmentedToggle` modes:
  - "By name": "Business name" (prefilled with the workspace display name), "Country" (`CountryCombobox` default `workspaceMarket`), optional "Near (Google Maps link or coordinates)" with helper "Paste the full Google Maps link from your browser's address bar, or coordinates like 19.0760, 72.8777."; `PricedActionButton label="Find business"` (action `local.profile.lookup`). Result card with the profile summary and buttons "This is my business" (saves own) / "Not it". No match: "No Google Business Profile matched that name. Try the exact name shown on Google Maps, add a Maps link, or search nearby businesses."
  - "Nearby": "Near" (required), "Radius (km)" (1–50, default 10), "Name or text", "Category" (combobox fed by `GET /categories`, free), "Minimum rating", "Minimum reviews", "Claimed" (Any / Claimed / Unclaimed), "Sort" (Relevance / Rating / Reviews); `PricedActionButton label="Search businesses"`; results `DataTable` (Title, Category, Rating, Reviews, Claimed, Phone, Address) with row actions "Use as my business", "Save as competitor"; pager "Next 20" is a priced button (each page is a paid search); empty "No businesses found here. Widen the radius or remove filters."
  - "Google IDs": "CID" or "Place ID" (exactly one; error "Provide exactly one business identifier: name, CID or place ID."), then "Find business".
- **Own business saved:** compact header row: title, category, "★ {rating} ({votes} reviews)", claimed badge ("Claimed" / "Unclaimed" warning), "Change business", and a business switcher `Select` listing "Your business" and saved competitors ("Viewing: {title}"). When the profile is null: "Load full profile" priced button.
- Saved competitors manager (`CompetitorList.tsx`): list with remove (`ConfirmDialog` "Remove {title}?" / "Saved reviews and grids stay in history."), cap message "You can save up to 10 local competitors. Remove one first."

#### 6.6.2 Profile tab (`ProfileTab.tsx`)

Card rows: Category (+ additional), Rating with a 5→1 star breakdown as horizontal bars (labels "5★ 210" …; `sr-only` text), Address, Phone, Website (`SafeExternalLink`), Claimed, "Open now" status, Hours table (Mon…Sun, "Closed" when no span), Photos, CID and Place ID with `CopyButton`, "Open on Google Maps" (`check_url`). Footer "Profile fetched {date}" and `PricedActionButton label="Refresh profile"`. With competitors saved: "Head to head" table (rows: Primary category, Additional categories, Rating, Reviews, Photos, Claimed, Hours listed, Website), columns "You" and each competitor with a fetched profile; a missing profile shows "Not loaded" with a "Load" priced button (never "0"). Loading: `Skeleton` rows; error: `QueryError` "Couldn't load your saved businesses."

#### 6.6.3 Reviews tab (`ReviewsTab.tsx`)

Controls: "Reviews to collect" (20 / 50 / 100 / 200), "Sort" (Newest / Highest rating / Lowest rating / Most relevant; disabled with tooltip "Other sites can't be sorted." when the next box is ticked), checkbox "Include reviews from other sites (Yelp, Tripadvisor and others)"; `PricedActionButton label="Collect reviews"`.

| State | Content |
|---|---|
| Never collected | `EmptyState` icon `MessageSquareQuote`, "No reviews collected yet", "Collect reviews to see ratings, text and which ones your business replied to." |
| Processing | `Skeleton` list + `aria-live` "Collecting reviews… This usually takes 20 to 60 seconds." Polling at the server's `pollAfterSeconds`; after 10 minutes the client stops and shows "Still collecting. Come back later to collect it at no extra cost." with "Check again". |
| Failed | `Alert` destructive with the message and "Try again" (priced). |
| Completed | Summary "Collected **{n}** of **{total}** reviews · average ★ {avg} of the collected · owner replied to **{r} of {n}**". Client filters: rating chips (5★…1★) and "Without owner reply". List of review cards (stars `aria-label="{n} out of 5"`, author with "Local Guide" badge, time, source, text with "Show more" over 600 chars, owner reply indented with time, or chip "No reply"). Pagination: 10 per page (`TablePagination`, "Page {p} of {pages}"). Below the last page: "These are the {n} most recent of {total} reviews." and `PricedActionButton label="Collect up to {next depth} reviews"` (deeper collection re-collects from the top, as DataForSEO has no offset). Empty completed: "This profile has no reviews matching the request." |
| Reused | Note "Collected {m} minutes ago. Reused at no cost." |

History select "Earlier collections" (free) lists previous fetches with date and count.

#### 6.6.4 Posts and Questions tabs (`PostsTab.tsx`, `QuestionsTab.tsx`)

Posts: depth (10 / 20 / 50 / 100); `PricedActionButton label="Collect posts"`; cards with date, text, link list "{title} → {url}" (`SafeExternalLink`); empty "This profile has published no posts."; same processing/failed/reused states as reviews; summary "Latest post {time ago}" when any.

Questions: depth (20 / 50 / 100); requires coordinates (from the profile); without them: "Load the full profile first so we know where the business is." Cards: question, asker, time, "{k} answers", the latest answer, "Show all answers" (`ExpandableList`). Empty: "Google returned no questions for this business." (Q&A availability depends on Google; see §11.)

#### 6.6.5 Map rankings tab (`GridTab.tsx`, `RankGridSvg.tsx`)

Form: "Search term" (e.g. "streetwear store"; helper "Use what customers search, not your business name."), "Centre" (defaults to the business coordinates, shown as "Centred on {title} ({lat}, {lng})" with "Open in Google Maps" and "Change centre" accepting a Maps link or coordinates), "Grid" (3×3 / 5×5), "Spacing" (0.5, 1, 2, 3, 5, 10 km; default 2), "Device" (Mobile / Desktop), advanced "Map zoom" (Auto, 4–18). `PricedActionButton label="Run grid" alwaysConfirm` → `CostReviewDialog` title "Run map ranking grid", confirm "Run grid", detail "{n} Google Maps searches around {centre label}." with the `center_note` warning.

**Rendering decision: an inline SVG schematic, no map tiles.** The grid points are equidistant in kilometres by construction (`buildRankGridPoints` converts km to degrees per latitude), so a square SVG grid is a true-to-scale picture of the search area. Using tiles would need a third-party tile provider (an API key, licence terms, a CSP change in `next.config`, and every view sending the customer's storefront location to that provider), would make browser tests depend on the network, and adds nothing the numbers do not already say. Geography stays one click away: every point and the centre have "Open in Google Maps" links (`googleMapsPointUrl`), which open Google in a new tab without loading anything into our page.

`RankGridSvg` (`viewBox="0 0 {100·n} {100·n}"`, responsive width 100%, max 520 px): one circle per point at `(50 + 100·col, 50 + 100·row)` (row 0 = north), radius 34; fill by bucket: rank 1–3 `--chart-good` (green), 4–10 `--chart-mid` (amber), 11–20 `--chart-low` (orange), not in results `--muted` with "–", search failed hatched pattern with "×"; label = rank number (`font-variant-numeric: tabular-nums`); the centre point gets a 3 px ring and a small pin glyph; a north arrow "N" top-right; a scale bar under the grid "{spacing} km" spanning one cell. Each circle is a `<button>`-equivalent (`role="gridcell"`, `tabIndex`, roving focus with arrow keys inside `role="grid"`); focus or hover shows a tooltip: "Row {r+1}, column {c+1} · {lat}, {lng}", "Rank {k}" or "Not in the {resultsCount} results here" (with "Few businesses here" when `resultsCount < 5`) or "Search failed", "#1 here: {top title}", and the link "Open in Google Maps". Colours meet 3:1 against the card in both themes; the rank number is always present, so colour is never the only cue. An `sr-only` table repeats every point.

Summary above the SVG: "Ranked at **{found} of {searched}** points · average rank **{avg}** where found · top 3 at {x} · top 10 at {y}"; when `failed > 0`: "{failed} searches failed and may still have been charged." Below: the per-point table (Row, Col, Lat, Lng, Rank, Results, #1 business) and "Grid history" (free list of previous grids; selecting one shows it). States: processing → the SVG with grey placeholder circles filling as points arrive, `aria-live` "{ready} of {total} searches back"; failed → `Alert` "Every map search failed at the data provider. Try again later."; reused → "Reused the grid you ran {m} minutes ago at no cost."; daily limit → `Alert` with the API message. Phone: the SVG scales to the card width; the table scrolls horizontally inside its card.

#### 6.6.6 Local results tab (`LocalResultsTab.tsx`)

Form: "Search term", "Near" (default the business coordinates; Maps link or coordinates), "Zoom" (default 12; helper "12 is about one city. Raise it for a neighbourhood, lower it for a metro area."), "Type" (Google Maps / Local Finder), "Device", "Results" (10, 20, 50, 100); `PricedActionButton label="Search"`. Results `DataTable`: Rank, Business (with "You" badge for `isOwn`, "Competitor" badge for saved ones), Rating, Reviews, Category, Claimed, Phone, Address; row menu "Save as competitor", "Use as my business", "Open on Google Maps". Summary "You rank **#{r}** of {n}" or "Your business is not in these {n} results." Empty: "Google returned no businesses for this search here. Try a lower zoom." Cached results show "Fetched {time} · reused at no cost".

**Accessibility:** tabs are F04 `NavTabs` with `aria-current`; all priced buttons state the price in text; star ratings have text equivalents; the grid has keyboard navigation and a table equivalent.

### 6.7 Permissions, privacy, observability

- Members and owners can look up, collect, run grids and save businesses (OpenSEO: project members). Spend caps bound use.
- Reviews and posts are public Google content that can name people. Stored rows are trimmed to the allow-lists, readable only by the workspace (RLS), pruned after 13 months, and never logged. Log lines carry ids, kinds, counts and codes only: `[local] fetch <id> <kind> <status>`, `[local] grid <id> <status> ready=<n>/<total>`.
- PostHog (F26 names; sink `trackLocalEvent` in `src/components/portal/local/telemetry.ts` (exports `setLocalEventTracker(fn)`; no-op until F26 wires it, F26 §6.2.7) until F26): `local:business_saved { role }`, `local:profile_lookup { found }`, `local:listings_search { count, cached }`, `local:reviews_collect { depth, other_sources, reused }`, `local:updates_collect { reused }`, `local:questions_collect { reused }`, `local:serp_search { type, cached, own_ranked }`, `local:grid_run { size, reused, points_found }`. No names, text, coordinates or keywords.

## 7. Code reuse map

| OpenSEO source | Perceev target | Mode | Adaptation notes |
|---|---|---|---|
| `openseo:src/server/lib/dataforseo/business.ts` (+ `business.test.ts`) | `src/lib/providers/dataforseo/business.ts` (+ test) | PORT | F02 core/envelope; `createBusinessClient` on F02 `meter` with F03 estimators; free calls unwrapped. |
| `openseo:src/server/mcp/tools/local-seo-shared.ts`, `openseo:src/server/mcp/table.ts:105-112`, `dataforseo-research-tools.ts:83-136, 466-471` | `src/lib/local/shared.ts` (+ test) | PORT | zod schemas without MCP `describe` text; errors as `AppError`. |
| `dataforseo-research-tools.ts:682-810`, `local-seo-tools.ts:320-340, 483-506` | `src/lib/local/rowFields.ts` | COPY | — |
| `local-seo-tools.ts:127-252` | `src/lib/local/profile.ts` | PORT | Text formatter → structured `BusinessProfileView`; saving; research log. |
| `local-seo-tools.ts:80-121, 258-588`; `dataforseo-research-tools.ts:1050-1091` | `src/lib/local/fetches.ts` (+ tests) | PORT | Task id stored in `local_fetches` instead of returned to an agent; reuse window in SQL; free collection via `GET`. |
| `local-seo-tools.ts:594-689`; `dataforseo-research-tools.ts:229-282, 533-559, 954-999` | `src/lib/local/listings.ts` (+ test) | PORT | R2 → F01 provider cache. |
| `local-seo-tools.ts:691-1180` (+ `local-seo-tools.test.ts:242-440`) | `src/lib/local/grid.ts` (+ test) | PORT | Receipt → `local_grid_runs` row; inline collect 20 s instead of 40 s; stored top rows allow re-matching. |
| `dataforseo-research-tools.ts:284-309, 1001-1048` | `src/lib/local/localSerp.ts` (+ test) | PORT | Cached globally; `isOwn` flag. |
| `openseo:src/server/lib/dataforseo/serp.ts:353-517` | F02 `serp.ts` | (owned by F02) | Used through `createDataforseoClient().serp.local` / `.localTaskPost`. |
| `openseo:src/server/lib/dataforseo/pricing.ts:94-154, 186-279` | F03 `src/lib/pricing/dataforseo.ts` | (owned by F03) | Estimators bound in `createBusinessClient`. |
| `openseo:src/server/mcp/tools/{local-seo-tools,dataforseo-research-tools}.ts` tool definitions | `src/lib/local/tools.ts` | PATTERN | Same names and inputs; F22 registry shape; resume ids. |
| `openseo:.agents/skills/local-seo/SKILL.md` | `/portal/local` flow, copy of guardrails | PATTERN | Read as data; the page follows its order (business → results → profile → reviews → grid → Q&A/posts). |

## 8. Implementation plan

### Phase 1 — Provider section and pure logic

**Goal:** the metered business-data client and every pure helper, with tests, and no database.

- [ ] **P1.T1 Provider**
  - [ ] **P1.T1.S1** *Files:* `src/lib/providers/dataforseo/business.ts`, `business.test.ts`, fixtures `tests/fixtures/f17/{business-info,business-info-no-results,listings-search,qa,reviews-task-post,reviews-task-get-pending,reviews-task-get-done,categories}.json`. *Do:* §6.2.1; port the five cases of `business.test.ts:37-190` with an injected `fetchImpl` through F02 `core.ts`; "every entry is priced" walks `createBusinessClient({ meter: spyMeter })` and asserts each estimator > 0 and the feature names. *Verify:* `node --test src/lib/providers/dataforseo/business.test.ts` → pass (F17-AC-02, 04).
- [ ] **P1.T2 Helpers**
  - [ ] **P1.T2.S1** *Files:* `src/lib/local/shared.ts`, `shared.test.ts`, `src/lib/local/rowFields.ts`, `rowFields.test.ts`. *Do:* §6.2.2; port `local-seo-tools.test.ts:65-130` (identifier rule, `cid:` keyword with a metre radius, project-market fallback); listings km rounding (`radiusKm 2.6` → `3`); zoom suffix; `trimBusinessQuestionRow` keeps nested answers trimmed. *Verify:* `node --test src/lib/local/shared.test.ts src/lib/local/rowFields.test.ts` → pass (F17-AC-03).
  - [ ] **P1.T2.S2** *Files:* `src/shared/local-coordinates.ts`, `local-coordinates.test.ts`. *Do:* §6.2.2 parser cases: `https://www.google.com/maps/@19.0760,72.8777,14z` → zoom 14; place URL with `!3d19.07!4d72.87`; "19.0760, 72.8777"; `91,0` → null; `https://maps.app.goo.gl/abc` → null; the module has no `fetch` reference. *Verify:* `node --test src/shared/local-coordinates.test.ts` → pass (F17-AC-14).
  - [ ] **P1.T2.S3** *Files:* `src/lib/local/grid.ts` (pure half), `grid.test.ts`. *Do:* `rankGridZoom` (2 km at 37.3° → 13; clamps), `buildRankGridPoints` (3×3 north row first, longitude step widened by latitude), `matchGridItem` (CID beats name; name case-insensitive), `gridPointResult`/`summarizeGrid` (ports of `local-seo-tools.test.ts:312-375`). *Verify:* `node --test src/lib/local/grid.test.ts` → pass (F17-AC-07 pure half).
  - [ ] **P1.T2.S4** *Files:* `src/lib/pricing/actions/local.ts`, `local.test.ts`, `src/lib/pricing/actions/index.ts` (one line). *Do:* §6.2.9; labels and totals (profile 0.0054; listings 20 → 0.0192; reviews 20 → 0.004, 200 → 0.031, other sites 20 → 0.01; posts 10 → 0.0045; Q&A 20 → 0.0054; Maps 0.002; Local Finder 20 → 0.004; grid 3×3 → 0.0108, 5×5 → 0.03); grid requires approval; `local_grid_limit` blocked. *Verify:* `node --test src/lib/pricing/actions/local.test.ts` → pass (F17-AC-11 unit half).
  - [ ] **P1.T2.S5** *Files:* `src/shared/spend-features.ts`, `src/lib/features/names.ts`, `src/lib/features/clientFeatures.ts`, `.env.example` (`FEATURE_LOCAL_SEO=`, `FEATURE_LOCAL_SEO_BRANDS=`), `THIRD_PARTY_NOTICES.md`. *Verify:* `node --test src/lib/features/flags.test.ts src/shared/*.test.ts src/lib/platform/thirdPartyNotices.test.mjs` → pass; `grep -c "^FEATURE_LOCAL_SEO=$" .env.example` → 1.

**Checkpoint:** full suite `node --import ./src/lib/liveWriteGuardAuto.mjs --test-concurrency=4 --test 'src/**/*.test.mjs' 'src/**/*.test.ts'`, `npm run typecheck`, F02 `noPrices.test.mjs` and `answerImportGuard.test.mjs` pass. Completes F17-AC-02, 03, 04, 14.

### Phase 2 — Database, services and API

**Goal:** every local lookup works through the API with storage, reuse and research logging.

- [ ] **P2.T1 Database**
  - [ ] **P2.T1.S1** *Files:* `supabase/migrations/120_f17_local_seo.sql`, `121_f17_local_seo_functions.sql`. *Do:* §6.1. *Verify:* `node --test src/lib/migrationsRunner.test.mjs src/lib/migrationsLedger.test.mjs` → pass.
  - [ ] **P2.T1.S2** *Files:* `scripts/setup-supabase.mjs`, `tests/customer-uat.sql`. *Verify:* CI customer-database commands against local Postgres 16 → exit 0.
  - [ ] **P2.T1.S3** *Files:* `README.md`, `docs/OPERATOR_LEDGER.md` § C, `docs/PROD_MIGRATIONS.md`. *Verify:* `node --test src/lib/docStatus.test.mjs src/lib/migrationsRunner.test.mjs` → pass.
  - [ ] **P2.T1.S4** *Files:* `scripts/qa/check-f17-db.mjs`. *Do:* groups `schema`, `rls`, `caps` (second own demotes the first to competitor; 11th competitor raises), `reuse` (`find_local_reuse` window and failed exclusion), `poll` (`claim_local_poll` twice within 4 s → second false), `retention`. *Verify:* `node scripts/qa/check-f17-db.mjs` → "ok 6 groups" (F17-AC-01, 10 DB half, 16 DB half).
- [ ] **P2.T2 Services**
  - [ ] **P2.T2.S1** *Files:* `src/lib/local/businesses.ts`, `businesses.test.ts`, `src/lib/local/profile.ts`, `profile.test.ts`. *Do:* §6.2.3, §6.2.8; `toProfileView` from `business-info.json` (hours spans, rating distribution, unsafe URL → null); save own/competitor; research log entry. *Verify:* `node --test src/lib/local/businesses.test.ts src/lib/local/profile.test.ts` → pass (F17-AC-10).
  - [ ] **P2.T2.S2** *Files:* `src/lib/local/listings.ts`, `listings.test.ts`. *Do:* §6.2.4; port `local-seo-tools.test.ts:448` (categories cached and filtered in memory); filter/order mapping; cache hit costs nothing. *Verify:* `node --test src/lib/local/listings.test.ts` → pass (F17-AC-09).
  - [ ] **P2.T2.S3** *Files:* `src/lib/local/fetches.ts`, `fetches.test.ts`. *Do:* §6.2.5 with F01 memory spend and a fake clock; ports of `local-seo-tools.test.ts:136-240` (resumable when queued; collection failure keeps the fetch; resume without a new post); reuse within 60 minutes; repeated `requestId`; Q&A combine (F17-AC-06). *Verify:* `node --test src/lib/local/fetches.test.ts` → pass (F17-AC-05, 06).
  - [ ] **P2.T2.S4** *Files:* `src/lib/local/grid.ts` (service half), `grid.service.test.ts`. *Do:* §6.2.6; ports of `local-seo-tools.test.ts:281`, `:375`, `:392`, `:410`, `:431` (posts 9 searches; one refused point; all failing → error and no reuse; processing then free collect; different arguments post again); re-match for another target from stored rows; daily limit. *Verify:* `node --test src/lib/local/grid.service.test.ts` → pass (F17-AC-07).
  - [ ] **P2.T2.S5** *Files:* `src/lib/local/localSerp.ts`, `localSerp.test.ts`. *Do:* §6.2.7; defaults; `isOwn` by CID and by domain; cached second call has no spend. *Verify:* `node --test src/lib/local/localSerp.test.ts` → pass (F17-AC-08).
  - [ ] **P2.T2.S6** *Files:* `src/lib/local/research.ts`, `research.test.ts`. *Do:* summaries and keys of §6.2.3–6.2.7; `recent_research` warning in quotes. *Verify:* `node --test src/lib/local/research.test.ts` → pass (F17-AC-12).
  - [ ] **P2.T2.S7** *Files:* `src/lib/local/jobs.ts`, `retention.test.ts`, `src/lib/jobs/kinds.ts` (one import). *Verify:* `node --test src/lib/local/retention.test.ts` → pass; `node scripts/qa/check-f17-db.mjs --only retention` → ok (F17-AC-16 retention half).
- [ ] **P2.T3 Routes**
  - [ ] **P2.T3.S1** *Files:* `src/app/api/customer/local/{businesses,businesses/[businessId],businesses/[businessId]/profile,profile,listings,categories,fetches,fetches/[fetchId],serp,grids,grids/[gridId]}/route.ts`, `src/lib/local/local.contract.ts`. *Do:* §6.5. *Verify:* `node --test src/lib/http/routeContract.test.ts` → pass.
  - [ ] **P2.T3.S2** *Files:* `src/lib/local/local.route.test.mjs`. *Do:* flag off → 404; disabled spend → 403; grid without `maxUsd` → 400 `approval_required`; lower `maxUsd` → 409 `price_changed`; `POST /fetches` → 202 then `GET` → 200 completed (fixtures); foreign `businessId` → 404; extra field → 400. *Verify:* `node --import ./src/lib/liveWriteGuardAuto.mjs --test src/lib/local/local.route.test.mjs` → pass (F17-AC-05 route half, 11, 15).

**Checkpoint:** full suite, `npm run build`, `check-f17-db.mjs` pass. Completes F17-AC-01, 05–12, 15.

### Phase 3 — Page: picker, profile, reviews, posts, questions (requires F04, F05, F06, F09 phase 3, F13 phase 1 merged)

- [ ] **P3.T1 Components**
  - [ ] **P3.T1.S1** *Files:* `src/app/portal/local/page.tsx`, `src/components/portal/local/{LocalSeoPage,BusinessPicker,CompetitorList,ProfileTab}.tsx`, `hooks/{useLocalBusinesses,useLocalFetch}.ts`, `telemetry.ts`, `src/components/app/navigation/items.ts` (entry), `src/lib/query/keys.ts`. *Do:* §6.6.1–6.6.2. *Verify:* `npm run build` → exit 0.
  - [ ] **P3.T1.S2** *Files:* `src/components/portal/local/{ReviewsTab,ReviewCard,PostsTab,QuestionsTab}.tsx`. *Do:* §6.6.3–6.6.4; polling with F05 `useServerPacedQuery` (`isActive = status === "processing"`, stop after 10 minutes). *Verify:* `npm run build` → exit 0.
  - [ ] **P3.T1.S3** *Files:* `scripts/qa/check-f17-browser.mjs`, `tests/fixtures/f17/api/*.json`. *Do:* fixture API server; B1 no business → "By name" lookup shows the price and the result card; B2 "Nearby" search table and "Save as competitor"; B3 profile head-to-head shows "Not loaded" (not 0) for a competitor without a profile; B4 reviews: processing then completed, "owner replied to 6 of 20", page 2 of 2, rating filter; B5 posts and questions empty states. *Verify:* `node scripts/qa/check-f17-browser.mjs --only B1,B2,B3,B4,B5` → "ok 5 scenarios".

**Checkpoint:** full suite, build, B1–B5 pass.

### Phase 4 — Page: map rankings and local results

- [ ] **P4.T1 Components**
  - [ ] **P4.T1.S1** *Files:* `src/components/portal/local/{GridTab,RankGridSvg,GridPointTable,GridHistory,LocalResultsTab}.tsx`, `hooks/{useLocalGrid,useLocalSerp}.ts`. *Do:* §6.6.5–6.6.6. *Verify:* `npm run build` → exit 0.
  - [ ] **P4.T1.S2** *Files:* `scripts/qa/check-f17-browser.mjs` (B6–B8). *Do:* B6 "Run grid" opens the cost dialog with "9 Google Maps searches" and the centre warning; after confirm the SVG fills from "3 of 9" to complete; the summary reads "Ranked at 7 of 9 points"; the failed point shows "×"; arrow keys move focus between points; no request leaves `localhost` (Playwright request log has no third-party host); B7 local results "You rank #4 of 20" with the "You" badge; B8 phone width 390 px: no horizontal page scroll, SVG fits. *Verify:* `node scripts/qa/check-f17-browser.mjs --only B6,B7,B8` → "ok 3 scenarios" (F17-AC-13).
  - [ ] **P4.T1.S3** *Files:* `src/components/portal/local/telemetry.test.mjs`. *Do:* payloads contain only the listed keys; none contains a fixture name, text, coordinate or keyword. *Verify:* `node --test src/components/portal/local/telemetry.test.mjs` → pass (F17-AC-16).

**Checkpoint:** full suite, build, `node scripts/qa/check-f17-browser.mjs` → "ok 8 scenarios". Completes F17-AC-13, 16.

### Phase 5 — Tool definitions for F22

- [ ] **P5.T1.S1** *Files:* `src/lib/local/tools.ts`, `tools.test.ts`. *Do:* §6.2.10; eight names exactly as OpenSEO; strict inputs (`z.toJSONSchema(..., { io: "input" })` has `additionalProperties: false`), loose outputs; paid tools refuse without `maxUsd`; resume by `fetchId`/`gridId` makes no paid call. *Verify:* `node --test src/lib/local/tools.test.ts` → pass (F17-AC-17).

**Checkpoint:** full suite passes. Completes F17-AC-17.

## 9. Test plan

| File | Cases | ACs |
|---|---|---|
| `src/lib/providers/dataforseo/business.test.ts` | five ported cases, every entry priced | 02, 04 |
| `src/lib/local/shared.test.ts`, `rowFields.test.ts` | identifiers, radius units, zoom, trimming | 03 |
| `src/shared/local-coordinates.test.ts` | Maps link parsing, no network | 14 |
| `src/lib/local/grid.test.ts`, `grid.service.test.ts` | zoom, points, matching, summary, reuse, failures, limit | 07 |
| `src/lib/pricing/actions/local.test.ts` | seven actions, labels, totals, approval | 11 |
| `src/lib/local/{businesses,profile,listings,fetches,localSerp,research,retention}.test.ts` | services | 05, 06, 08, 09, 10, 12, 16 |
| `src/lib/local/local.route.test.mjs` | auth, flags, approvals, 202/200, foreign ids | 05, 11, 15 |
| `src/lib/local/tools.test.ts` | tool shapes | 17 |
| `src/components/portal/local/telemetry.test.mjs` | no personal data | 16 |
| `scripts/qa/check-f17-db.mjs` | schema, rls, caps, reuse, poll, retention | 01, 10, 16 |
| `scripts/qa/check-f17-browser.mjs` | B1–B8 | 13 |

Fixtures are synthetic (§6.4). The live check runs only on the owner's instruction.

## 10. Rollout and rollback

- Env names: `FEATURE_LOCAL_SEO`, `FEATURE_LOCAL_SEO_BRANDS` (`.env.example`). DataForSEO credentials are F02's.
- Migrations 120 then 121 before phase 2; additive.
- Defaults: flag off in production; spend controls `local.business`, `local.reviews`, `local.serp`, `local.grid` disabled.
- Owner enabling: enable the four spend features in `/ops/costs` for an allowlisted workspace with a daily cap (suggested $1) and per-call maximum $0.25; set `FEATURE_LOCAL_SEO=allowlist` with the brand; optionally run `scripts/qa/check-f17-live.mjs --brand <key> --max-spend-usd 0.05`.
- Turning off: flag `off` (page hidden, routes 404) or disable one spend control (that action refuses with 403; the rest keep working). Processing fetches and grids can still be collected for free while the flag is on.
- Cleanup: workspace deletion cascades; retention prunes after 13 months; removing a saved business keeps its history (`business_id` set null).

## 11. Risks and open questions

| # | Risk / question | Default chosen |
|---|---|---|
| 1 | Google has been reducing Q&A on Business Profiles; DataForSEO may return no questions. | Keep the tab; show "Google returned no questions for this business." honestly; the charge is the documented minimum (one 20-row unit). If Q&A returns nothing for every fixture-verified business in the owner's live check, hide the tab behind a constant `QUESTIONS_TAB_ENABLED`. |
| 2 | No geocoder: customers must find their business by name, IDs, nearby search or a pasted Maps link. | Accepted; the Maps-link parser covers the common case without a network call; short links are refused with copy explaining why. |
| 3 | A 5×5 grid is 25 paid searches; repeated grids add up. | Dialog approval always, 60-minute reuse, 20 grids per workspace per day, spend caps. |
| 4 | Reviews contain personal names and opinions. | Trimmed, workspace-only, never logged, 13-month retention; no export in v1. |
| 5 | Saving local competitors could be expected to feed F07 project competitors or AI-visibility competitors (deferred Mixed row). | Not linked; local competitors live in `local_businesses` only. |
| 6 | Conventions §5.6 names `src/lib/keywords/keyword-locations.ts`; F13 ships `src/shared/keyword-locations.ts`. | F17 imports F13's actual path. |
| 7 | `ON DELETE SET NULL (column)` needs Postgres 15+. | Supabase and CI run 15/16/17; documented in §6.1. |
| 8 | Inline polling holds a function for up to 20 s. | `maxDuration = 60`; collection continues through free `GET` polls. |
| 9 | Business-data endpoints accept `location_name` too, but OpenSEO only uses coordinates or codes. | Use coordinates or codes only (verified paths). |

## 12. Definition of done

- [ ] Phases 1–5 merged; every subtask ticked.
- [ ] F17-AC-01 … F17-AC-17 covered by passing tests in §9.
- [ ] Build, typecheck, full suite, `check-f17-db.mjs` (6 groups) and `check-f17-browser.mjs` (8 scenarios) pass.
- [ ] Migration paperwork for 120 and 121 and `THIRD_PARTY_NOTICES.md` updated.
- [ ] `features/README.md` status updated.
- [ ] Owner-run live check result recorded (or "not run" stated).

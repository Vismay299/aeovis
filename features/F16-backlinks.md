# F16 — Backlinks

> <!-- doc-status -->
> **Status: LIVE.** Implementation spec. Not built yet.

| Field | Value |
|---|---|
| ID | F16 |
| Wave | 2 |
| Comparison rows covered | "Backlinks" (OpenSEO: summary, list, referring domains, top pages, new and lost, spam filter, free Ahrefs DR column. Perceev: none) |
| Depends on | F02 phase 2 (merged): `core.ts`, `envelope.ts`, `billingClassification.ts`, `meter`. F03 phase 1: `dataforseoPricing.backlinks.*`, `BACKLINKS_DEFAULT_LIMIT`. F06 (tables, export). **F13 phase 1** (requested addition to `features/README.md`): `src/shared/researchScope.ts`, `src/lib/providers/dataforseo/{filters,researchScopeFilters}.ts`, `src/lib/research/{cache,providerErrors}.ts`, `ResearchScopeSelect`, `SearchCard`, `PricedActionButton`. F01, F07 phase 1 (`declaredCompetitors`, `appendResearch`, `findRecentResearch`), F09 phase 1. UI phases need F04, F05. Phase 5 also needs F10 phase 1 (`src/shared/schedule.ts`, `src/lib/schedules/runDue.ts`). |
| Blocks | F21 (link-prospecting skill uses these tools), F22 (backlink tools), F23 (reports read stored snapshots) |
| Reserved migrations | 115–119. **115** `115_f16_backlink_snapshots.sql` (phase 5, optional). 116–119 unused. |
| Feature flag | `FEATURE_BACKLINKS` (feature name `backlinks`, spend `["backlinks.research"]`): page, routes, sidebar item. `FEATURE_BACKLINKS_AHREFS_DR` (name `backlinks_ahrefs_dr`, spend `[]`): the free Ahrefs DR column, a separately flagged sub-feature pending the terms-of-use check. `FEATURE_BACKLINK_SNAPSHOTS` (name `backlink_snapshots`, spend `["backlinks.snapshots"]`): tracked history. All three in `CLIENT_FEATURES`; all off in production by default. |
| Spend features | `backlinks.research` ("Backlink research"), `backlinks.snapshots` ("Backlink history snapshots"). Both ship disabled. |
| OpenSEO reference | `openseo:src/server/lib/dataforseo/backlinks.ts`, `openseo:src/server/lib/dataforseoBacklinksTarget.ts`, `openseo:src/server/features/backlinks/services/*`, `openseo:src/serverFunctions/{backlinks,ahrefs}.ts`, `openseo:src/types/schemas/backlinks.ts`, `openseo:src/client/features/backlinks/**`, `openseo:src/db/app.schema.ts:417-445`, `openseo:drizzle/pg/0012_dashboard.sql`, `openseo:drizzle/pg/0016_panoramic_blob.sql` at `c5f8db1` |

## 1. Summary

Customers see who links to any domain, folder or page: a summary (backlinks, referring domains and pages, rank, spam scores, broken links), a year of growth and new-versus-lost charts, and three paged tables (individual backlinks, referring domains, top linked pages) with server-side filters, a one-link-per-domain view, a "best links only" spam filter and CSV/Sheets export. An optional, separately flagged column adds Ahrefs' free Domain Rating. An optional last phase stores backlink snapshots for the workspace's own site and declared competitors, so history exists for every scope and can be read for free by reports and the assistant.

## 2. What OpenSEO does (observed)

1. **Common request** for summary, list, referring domains and pages: `target`, `include_subdomains` (default true), `include_indirect_links: true`, `exclude_internal_backlinks: true`, `backlinks_status_type: "live"`, `rank_scale: "one_hundred"` (`openseo:src/server/lib/dataforseo/backlinks.ts:143-152`).
2. **Endpoints** (`backlinks.ts:175-343`): `backlinks/summary/live` (first result validated with a schema that accepts both `*_reffering_*` and `*_referring_*` keys, `:51-75`); `backlinks/backlinks/live` (default limit 100, `order_by` `rank,desc`, `mode` `one_per_domain`/`as_is`, `backlinks_status_type`, spam filter); `backlinks/referring_domains/live` (default order `backlinks,desc`); `backlinks/domain_pages_summary/live`; `backlinks/history/live` (`date_from`, `date_to`, no `include_subdomains`).
3. **Spam filter.** With `hideSpam` (default true) the backlinks list adds `backlink_spam_score < 40 OR backlink_spam_score = null` and the referring-domains list adds `backlinks_spam_score <= 40`, both ANDed after user filters (`backlinks.ts:157-173`, `:212-257`; threshold `openseo:src/types/schemas/backlinks.ts:43`). The web app passes `hideSpam: false` for referring domains, whose scores aggregate many links (`openseo:src/serverFunctions/backlinks.ts:11-12`, `:41-52`).
4. **Target normalisation** (`openseo:src/server/lib/dataforseoBacklinksTarget.ts:34-79`): shared research-scope parser; non-page scopes send the hostname with `include_subdomains = scope === "subdomains"`; `exact_url` sends an absolute URL keeping an explicit `http://`, and rejects query strings or fragments ("Page URLs with query strings or fragments are not supported"). Legacy scope `page` = `exact_url` (`schemas/backlinks.ts:18-38`).
5. **Overview** (`openseo:src/server/features/backlinks/services/backlinksServiceData.ts:81-153`, `:292-374`): summary and history in parallel; history covers one year ending yesterday (UTC); `exact_url` has no history; `subfolder` uses two sequential filtered `total_count` reads (all links `as_is`, and `one_per_domain`) with rank, spam, new/lost and trends unavailable (`backlinksSubfolderOverview.ts:9-65`); result shape `backlinksOverviewSchema.ts:56-77`.
6. **Tab pages** (`backlinksServiceData.ts:155-290`): offset paging, sort maps (`backlinksApiFilters.ts:20-64`), scope filters on `url_to` (backlinks) or `url` (pages) prepended (`researchScopeFilters.ts:69-93`), budget counting the spam condition as 2 (`backlinksServiceData.ts:175-182`); referring domains refuse subfolder scope ("Referring domains can't be broken down for a subfolder — use the Backlinks tab, or switch to Domain or Subdomains scope.", `:222-231`); `hasMore` from total or a full page (`backlinksRowMappers.ts:55-73`).
7. **Filters** (`backlinksApiFilters.ts:66-179`, `schemas/backlinks.ts:81-124`): include terms OR'd in one group, exclude terms ANDed, ranges, link type (dofollow/nofollow), hide lost, hide broken, exact `domain_from`; per-tab fields; 8-condition budget.
8. **Row mapping** (`backlinksRowMappers.ts:11-53`): backlinks (domain, URLs, anchor, type, dofollow, rel attributes, rank, domain rank, page rank, spam score, first/last seen, lost, broken, links count), referring domains, top pages.
9. **Cache** (`openseo:src/server/features/backlinks/services/BacklinksService.ts:20-151`): 6 h for the overview and every tab page (`backlinksServiceData.ts:64-65`); versioned prefixes `backlinks:overview:v2`, `backlinks:rows-page:v2`, `backlinks:referring-domains-page`, `backlinks:top-pages-page`; keys include organisation, API target, scope, path, `includeSubdomains` ("keeping it in the key retires entries written before scopes could exclude subdomains"), page, size, sort, filters, mode and `hideSpam`.
10. **Prices** (`openseo:src/server/lib/dataforseo/pricing.ts:90-92`, `:170-172`, `:216-230`): $0.024 per task + $0.000036 per row; history rows = inclusive days in the range; default row limit 100.
11. **Ahrefs DR** (`openseo:src/serverFunctions/ahrefs.ts:8-119`): free, keyless `https://api.ahrefs.com/v3/public/domain-rating-free?target=<domain>`; inputs normalised (`www.` stripped) and de-duplicated; batches of 20, at most 100 domains per call, 5 s timeout; every result cached 24 h, including "no rating" (DR 0 → null); a failure is returned as null and not cached. The client chunks larger sets by 100 and keeps partial results (`client/features/backlinks/useAhrefsDomainRatings.ts:10-66`).
12. **Page** (`openseo:src/client/features/backlinks/BacklinksPage.tsx:105-185`, `BacklinksPageContent.tsx:95-211`): header "Backlinks" / "Understand who links to a site, what changed recently, and which pages attract links."; search card "Enter a domain or URL" with scope select; recent searches "Enter a domain or URL to get started"; loading skeleton (`BacklinksPageStates.tsx`); error "Could not load backlinks"; scope notes for exact URL and subfolder (`BacklinksOverviewPanels.tsx:16-36`); search tabs.
13. **Overview panels** (`BacklinksOverviewPanels.tsx:38-132`, `backlinksPageUtils.ts:4-55`): metrics with help text; "Backlink growth" (backlinks and referring domains, two axes) and "New vs lost" line charts, only for domain/subdomains scope, empty "Not enough historical data yet." (`BacklinksPageCharts.tsx:1-162`).
14. **Results card** (`BacklinksPageSections.tsx:37-286`): tabs "Backlinks", "Referring Domains", "Top Pages" with descriptions; export "Current page · selected view"; "Best links: On/Off" menu (`BacklinksToolbarMenus.tsx:14-53`); "One per domain" / "All links" toggle; filter panel per tab (`BacklinksFilterPanel.tsx:40-247`) with the budget message (`backlinksFilterTypes.ts:117-136`); actions menu "Ahrefs DR" (`BacklinksToolbarMenus.tsx:55-90`).
15. **Tables** (`BacklinksTableColumns.tsx:150-339`, `ReferringDomainsTable.tsx:28-198`, `TopPagesTable.tsx:22-118`): columns with help text; spam unknown shown as "-" with title "Spam score unknown" and kept distinct from 0 (`BacklinksTable.test.ts:8`). One-per-domain rows expand to every link from that domain with one billed request of up to 100 links (`useBacklinksDomainExpansion.ts:6-101`), statuses "Loading links…", "Couldn't load this domain's links.", "No other links from this domain." (`BacklinksTableColumns.tsx:68-84`).
16. **URL state** (`schemas/backlinks.ts:199-220`): `includeSpam`, `target`, `scope`, `tab`, `page`, `size` (50/100/200), `sort`, `order`, `view=all`; per-tab default sorts (`:151-160`). Filters are page state, not URL.
17. **Export** (`client/features/backlinks/export.ts:13-131`): per-tab headers, an "Ahrefs DR" column when ratings are loaded, filename from tab and target.
18. **Snapshots defined but unused.** `backlink_snapshots` (project, domain, rank, backlinks, referring domains, broken, new/lost counts, `captured_at`; counts widened to bigint) exists in the schema with the comment "Retained backlink profile history. The dashboard no longer writes snapshots." and no reader or writer in `src/` (`openseo:src/db/app.schema.ts:417-445`; `openseo:drizzle/pg/0012_dashboard.sql:1-33`, `0016_panoramic_blob.sql:1-7`).
19. **Link prospecting** exists only as an agent skill (`openseo:.agents/skills/link-prospecting/SKILL.md:1-12`, read as data).
20. **Tests** we port: `backlinks.test.ts:31-200` (target normalisation, summary error classification, domain scope excludes subdomains), `backlinksApiFilters.test.ts:14-144`, `BacklinksService.billing.test.ts:77-257` (6 cases), client `BacklinksTable.test.ts`, `backlinksFilterTypes.test.ts`, `backlinksPageUtils.test.ts`, `export.test.ts`.

## 3. What Perceev has today

- No backlink data, no Ahrefs call, no backlink history. The site checks (`src/lib/crawlers/`, "Check owned website") do not read inbound links.
- F13 phase 1 supplies research scope parsing, DataForSEO filter builders, cache helpers and the priced button; F07 the declared competitor list; F10 the schedule maths and due-runner.
- **Must not break:** P0 controls (F16 calls only Backlinks endpoints through `metered()` and one free third-party endpoint; no answer engine); scans and their competitor roster; existing tests.

## 4. Target behaviour and acceptance criteria

| ID | Statement | Verified by |
|---|---|---|
| F16-AC-01 | The five fetchers send OpenSEO's bodies (common payload, defaults, spam conditions, history range) and `normalizeBacklinksTarget` passes the ported cases (scopes, `http://` kept, query/fragment rejected, domain scope sends `include_subdomains: false`). Provider failures surface as F02's error classes. | unit `src/lib/providers/dataforseo/backlinks.test.ts`, `backlinksTarget.test.ts` |
| F16-AC-02 | Every entry of `createBacklinksClient()` is metered with an F03 `dataforseoPricing.backlinks.*` estimate > 0 and default feature `backlinks.research`. | unit `backlinks.test.ts` "every entry is priced" |
| F16-AC-03 | The overview fetches summary and one year of history (ending yesterday UTC) in parallel for domain and subdomain scopes, summary only for an exact URL, and two sequential filtered counts for a subfolder with the other fields null and no trends; misspelled `reffering` keys are read. | unit `src/lib/backlinks/backlinksService.test.ts` |
| F16-AC-04 | Tab pages use OpenSEO's offsets, sort fields, scope filters and `hasMore`; the spam condition counts 2 toward the 8-condition budget (`400 filters_over_budget` beyond); referring domains refuse subfolder scope with `400 subfolder_not_supported` and OpenSEO's message; backlinks default to `hideSpam: true`, referring domains always send `hideSpam: false`. | unit `backlinksService.test.ts`; `backlinksApiFilters.test.ts` |
| F16-AC-05 | Filter builders pass OpenSEO's `backlinksApiFilters.test.ts` cases (include OR group, single include plain, budget throw, per-endpoint fields, client count equals server count). | unit `src/lib/backlinks/backlinksApiFilters.test.ts` |
| F16-AC-06 | Results are cached with `scope: "workspace"` for 6 h under versioned namespaces whose keys include target, scope, path, `includeSubdomains`, page, size, sort, filters, mode and `hideSpam`; OpenSEO's six billing cases hold (overview reuses cache on repeat; rows paged with offset and total; referring domains never fall back to the target spam score; page entries isolated per page, workspace and scope; subfolder totals from two counts; `last_seen` shown). | unit `backlinksService.test.ts` |
| F16-AC-07 | `cacheOnly: true` never reserves or calls; loading `/portal/backlinks?target=…` never spends (live mode); priced actions quote §6.4's lines; a stale `maxUsd` returns `409 price_changed`. | route `src/lib/backlinks/backlinks.route.test.mjs`; browser B2 |
| F16-AC-08 | An overview cache miss appends a research-log entry (`kind "backlinks.research"`); the lookup quote warns `recent_research` within 90 days. | unit `backlinksService.test.ts`; `src/lib/pricing/actions/backlinks.test.ts` |
| F16-AC-09 | Ahrefs DR (flag `backlinks_ahrefs_dr`): ≤ 100 domains per call, normalised and de-duplicated, fetched 20 at a time with a 5 s timeout from `api.ahrefs.com` only; DR 0 → null; ratings and nulls cached 24 h globally; a failed fetch returns null and is not cached; the flag off → `404 feature_unavailable` and no column or menu item. | unit `src/lib/backlinks/ahrefsDomainRating.test.ts`; route test; browser B7 |
| F16-AC-10 | `/portal/backlinks` renders every state in §6.6 with exact copy: overview metrics with "—" for unknown, growth and new/lost charts that draw gaps for missing days (never zero), three tabs, filters with the budget message, "Best links" menu, one-per-domain toggle, domain expansion statuses, export with an "Ahrefs DR" column when loaded, and no horizontal scroll at 375 px. | browser `scripts/qa/check-f16-browser.mjs` B1–B8; unit `src/shared/backlinks.test.ts` |
| F16-AC-11 | With `backlinks` off the sidebar item is hidden, the page shows the unavailable copy, every route returns `404 feature_unavailable`; a disabled spend control returns `403 feature_disabled`. | route test; browser B1 |
| F16-AC-12 | (P5) Migration 115 creates `backlink_snapshot_targets` and `backlink_snapshots` with RLS; members read only their workspace's rows; at most 20 enabled targets per workspace; one snapshot per target, scope and UTC day. | DB `scripts/qa/check-f16-db.mjs` groups `schema`, `rls`, `caps`; `tests/customer-uat.sql` |
| F16-AC-13 | (P5) Tracking a target requires price approval (`backlinks.snapshots.track`, monthly projection weekly × 4 or monthly × 1); the due tick advances every target before or instead of capturing, captures with one billed summary call under `backlinks.snapshots` within the approved maximum, records skip reasons, and a paid overview fetch of a tracked target stores a free `lookup` snapshot at most once per UTC day. | unit `src/lib/backlinks/snapshots.test.ts`; DB group `snapshots` |
| F16-AC-14 | (P5) The tracked-history chart reads stored snapshots only (no provider call), draws gaps for missing periods, and snapshots older than 25 months are pruned by a daily job. | browser B9; DB group `retention` |

## 5. Scope

**In scope:** DataForSEO Backlinks section client; overview, backlinks, referring domains and top pages with scopes, filters, spam filter, one-per-domain view, domain expansion, sorting, paging, workspace cache, export; quick picks from the workspace's site and declared competitors; Ahrefs DR as a flagged sub-feature; tracked snapshots as an optional last phase; priced actions, spend features, flags, contracts, research-log writes, tools for F22.

**Out of scope:** link prospecting and outreach (an agent skill; F21 packages it on top of F16's tools), backlink alerts and emails, anchor-text analytics beyond the table, disavow files, Ahrefs paid API, F14's domain overview (no backlink numbers there), changes to scans or competitor extraction.

## 6. Design

### 6.1 Data model (phase 5 only)

Phases 1–4 store nothing: lookups live in F01's provider cache. Phase 5 adds one migration.

**Why store snapshots (recommended, optional last phase):** (1) `history/live` takes only a hostname and has no `include_subdomains`, so OpenSEO shows no trend for exact-URL or subfolder scope and a subdomain-inclusive trend for domain scope (§2 item 5); stored summaries give a per-scope history. (2) Every view of the growth chart buys `history/live` again (about $0.037); stored snapshots are free to read for the overview, F23 reports and the F22 assistant. (3) DataForSEO restates history as its index changes; a stored snapshot is the number we showed at the time, so month-over-month comparisons in reports stay reproducible. (4) It is cheap: one summary call ($0.024) per target per week, and a free snapshot whenever a tracked target's summary is fetched anyway. OpenSEO defined the table and stopped writing it from its dashboard (§2 item 18); we keep it explicit and opt-in per target instead.

#### `supabase/migrations/115_f16_backlink_snapshots.sql`

```sql
-- F16: opt-in backlink history per workspace target (port of the unused
-- openseo backlink_snapshots table, app.schema.ts:417-445, made per-scope and scheduled).
CREATE TABLE IF NOT EXISTS public.backlink_snapshot_targets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_key text NOT NULL REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  target text NOT NULL CHECK (target = lower(target) AND length(target) BETWEEN 3 AND 255
    AND target ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$' AND target !~ '^www\.'),
  scope text NOT NULL CHECK (scope IN ('domain','subdomains')),
  label text CHECK (label IS NULL OR length(label) BETWEEN 1 AND 120),
  schedule_interval text NOT NULL CHECK (schedule_interval IN ('weekly','monthly')),
  enabled boolean NOT NULL DEFAULT true,
  next_run_at timestamptz NOT NULL,
  approved_max_usd numeric(12,6) NOT NULL CHECK (approved_max_usd > 0 AND approved_max_usd <= 1000),
  approval_id uuid,
  last_run_at timestamptz,
  last_skip_reason text CHECK (last_skip_reason IS NULL OR length(last_skip_reason) <= 64),
  last_skip_at timestamptz,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT backlink_snapshot_targets_unique UNIQUE (brand_key, target, scope)
);
COMMENT ON COLUMN public.backlink_snapshot_targets.approval_id IS 'F09 price approval row (source schedule) that set approved_max_usd.';
CREATE INDEX IF NOT EXISTS backlink_snapshot_targets_due_idx
  ON public.backlink_snapshot_targets (next_run_at) WHERE enabled;

-- Counts are bigint: large sites exceed 2,147,483,647 backlinks (OpenSEO widened them, 0016_panoramic_blob.sql).
CREATE TABLE IF NOT EXISTS public.backlink_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_key text NOT NULL REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  target text NOT NULL CHECK (length(target) BETWEEN 3 AND 255),
  scope text NOT NULL CHECK (scope IN ('domain','subdomains')),
  captured_on date NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL CHECK (source IN ('scheduled','lookup')),
  rank smallint CHECK (rank IS NULL OR rank BETWEEN 0 AND 100),
  backlinks bigint CHECK (backlinks IS NULL OR backlinks >= 0),
  referring_domains bigint CHECK (referring_domains IS NULL OR referring_domains >= 0),
  referring_pages bigint CHECK (referring_pages IS NULL OR referring_pages >= 0),
  broken_backlinks bigint CHECK (broken_backlinks IS NULL OR broken_backlinks >= 0),
  broken_pages bigint CHECK (broken_pages IS NULL OR broken_pages >= 0),
  new_backlinks bigint CHECK (new_backlinks IS NULL OR new_backlinks >= 0),
  lost_backlinks bigint CHECK (lost_backlinks IS NULL OR lost_backlinks >= 0),
  new_referring_domains bigint CHECK (new_referring_domains IS NULL OR new_referring_domains >= 0),
  lost_referring_domains bigint CHECK (lost_referring_domains IS NULL OR lost_referring_domains >= 0),
  backlinks_spam_score smallint CHECK (backlinks_spam_score IS NULL OR backlinks_spam_score BETWEEN 0 AND 100),
  target_spam_score smallint CHECK (target_spam_score IS NULL OR target_spam_score BETWEEN 0 AND 100),
  CONSTRAINT backlink_snapshots_one_per_day UNIQUE (brand_key, target, scope, captured_on)
);
CREATE INDEX IF NOT EXISTS backlink_snapshots_series_idx
  ON public.backlink_snapshots (brand_key, target, scope, captured_on DESC);

DROP TRIGGER IF EXISTS backlink_snapshot_targets_touch ON public.backlink_snapshot_targets;
CREATE TRIGGER backlink_snapshot_targets_touch BEFORE UPDATE ON public.backlink_snapshot_targets
  FOR EACH ROW EXECUTE FUNCTION public.f01_touch_updated_at();

-- Cap: 20 enabled targets per workspace (own site plus competitors).
CREATE OR REPLACE FUNCTION public.f16_snapshot_target_cap() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.enabled AND (SELECT count(*) FROM backlink_snapshot_targets
                       WHERE brand_key = NEW.brand_key AND enabled AND id <> NEW.id) >= 20 THEN
    RAISE EXCEPTION 'backlink_snapshots_cap:targets';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS backlink_snapshot_targets_cap ON public.backlink_snapshot_targets;
CREATE TRIGGER backlink_snapshot_targets_cap BEFORE INSERT OR UPDATE OF enabled ON public.backlink_snapshot_targets
  FOR EACH ROW EXECUTE FUNCTION public.f16_snapshot_target_cap();

CREATE OR REPLACE FUNCTION public.prune_backlink_snapshots(p_before date, p_limit integer) RETURNS integer
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_count integer;
BEGIN
  DELETE FROM backlink_snapshots WHERE id IN (
    SELECT id FROM backlink_snapshots WHERE captured_on < p_before LIMIT greatest(1, least(p_limit, 10000)));
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['backlink_snapshot_targets','backlink_snapshots'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
    EXECUTE format('DROP POLICY IF EXISTS f16_member_read ON public.%I', t);
    EXECUTE format('CREATE POLICY f16_member_read ON public.%I FOR SELECT TO authenticated USING (public.customer_can_access_brand(brand_key))', t);
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.f16_snapshot_target_cap() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.prune_backlink_snapshots(date, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prune_backlink_snapshots(date, integer) TO service_role;
```

Error mapping (`src/lib/backlinks/snapshots.ts`): `backlink_snapshots_cap:targets` → `AppError(409, "snapshot_target_limit", "A workspace can track history for up to 20 sites. Stop tracking one first.")`; `23505` on `backlink_snapshot_targets_unique` → `AppError(409, "already_tracked", "This site's history is already tracked.")`; other database errors → `AppError(503, "snapshots_unavailable", "Backlink history is unavailable. Please retry.")`.

**Required objects** (`scripts/setup-supabase.mjs`): `"115_f16_backlink_snapshots.sql": [{kind:"table",name:"backlink_snapshot_targets"},{kind:"table",name:"backlink_snapshots"},{kind:"function",name:"prune_backlink_snapshots"},{kind:"function",name:"f16_snapshot_target_cap"}]`.

**Tenant RLS test** (`tests/customer-uat.sql`): one target and one snapshot per workspace (brand keys `10000000-…-0001` and `…-0002`, target `same.example`, scope `subdomains`); as user 1, `count(*)` of each table = 1; an insert of a 21st enabled target for workspace 1 raises (wrapped in a `BEGIN … EXCEPTION WHEN raise_exception` block that re-raises unless the message is `backlink_snapshots_cap:targets`).

**Migration paperwork:** `README.md` row `115_f16_backlink_snapshots` "Opt-in backlink history: tracked targets (weekly/monthly, approved maximum) and daily snapshots, 25-month retention."; `docs/OPERATOR_LEDGER.md` § C ("apply before deploying F16 phase 5"); `docs/PROD_MIGRATIONS.md` one bullet. Subtask P5.T1.S3.

### 6.2 Server modules

TypeScript under `src/lib/**`, relative imports with `.ts`; COPY/PORT files carry the licence header.

#### 6.2.1 Provider section (`src/lib/providers/dataforseo/`)

| File | Mode | Exports |
|---|---|---|
| `backlinks.ts` | COPY `openseo:src/server/lib/dataforseo/backlinks.ts:1-349` | `backlinksSummaryItemSchema`, `backlinksItemSchema`, `referringDomainItemSchema`, `domainPageSummaryItemSchema`, `backlinksHistoryItemSchema` (`z.looseObject`), `fetchBacklinksSummary`, `fetchBacklinksRows`, `fetchReferringDomains`, `fetchDomainPagesSummary`, `fetchBacklinksHistory`, `BACKLINKS_DEFAULT_LIMIT` (re-exported from F03, not redefined), item types. Classifier from F02 `billingClassification.ts` with `pathPrefix "/backlinks/"`, `billingIssueCode "dataforseo_balance"`. **Added:** `createBacklinksClient(deps?)`. |
| `backlinksTarget.ts` | COPY `openseo:src/server/lib/dataforseoBacklinksTarget.ts` | `normalizeBacklinksTarget(input, { scope? })` → `{ apiTarget, displayTarget, scope, includeSubdomains, path }`; errors `AppError(400, "invalid_target", …)`. |

```ts
export function createBacklinksClient(deps?: { meter?: typeof meter }) {
  const m = deps?.meter ?? meter;
  return {
    summary: m(fetchBacklinksSummary, () => dataforseoPricing.backlinks.summary({}), "backlinks.research"),
    rows: m(fetchBacklinksRows, (i) => dataforseoPricing.backlinks.rows({ limit: i.limit ?? BACKLINKS_DEFAULT_LIMIT }), "backlinks.research"),
    referringDomains: m(fetchReferringDomains, (i) => dataforseoPricing.backlinks.referringDomains({ limit: i.limit ?? BACKLINKS_DEFAULT_LIMIT }), "backlinks.research"),
    domainPages: m(fetchDomainPagesSummary, (i) => dataforseoPricing.backlinks.domainPages({ limit: i.limit ?? BACKLINKS_DEFAULT_LIMIT }), "backlinks.research"),
    history: m(fetchBacklinksHistory, (i) => dataforseoPricing.backlinks.history({ dateFrom: i.dateFrom, dateTo: i.dateTo }), "backlinks.research"),
  };
}
export type BacklinksClient = ReturnType<typeof createBacklinksClient>;
```

Snapshot capture calls `summary` with `ctx.feature = "backlinks.snapshots"`.

#### 6.2.2 Shared module (`src/shared/backlinks.ts`, client-safe)

PORT of `openseo:src/types/schemas/backlinks.ts`, `client/features/backlinks/{backlinksFilterTypes,backlinksPageUtils,export,backlinksPageTypes}.ts`:

```ts
export const BACKLINKS_TABS = ["backlinks","domains","pages"] as const;
export const DEFAULT_BACKLINKS_SPAM_THRESHOLD = 40;
export const BACKLINKS_PAGE_SIZES = [50, 100, 200] as const;  export const DEFAULT_BACKLINKS_PAGE_SIZE = 50;
export const backlinksScopeParamSchema;               // research scopes + legacy "page" → "exact_url"
export const backlinksRowsFiltersSchema, referringDomainsFiltersSchema, topPagesFiltersSchema;   // theirs, :81-124
export const backlinksRowsSortFieldSchema, referringDomainsSortFieldSchema, topPagesSortFieldSchema, BACKLINKS_DEFAULT_SORT;
export const backlinksRowsModeSchema;                 // one_per_domain | as_is
export const backlinksSearchSchema;                   // URL params, theirs :199-220
export const BACKLINKS_FILTER_FIELDS, REFERRING_DOMAINS_FILTER_FIELDS, TOP_PAGES_FILTER_FIELDS, EMPTY_* filter values;
export function countFilterConditions(values), backlinksFilterConditionLimit(scope, hideSpam), backlinksFilterBudgetError(values, scope, hideSpam);
export function toBacklinksFiltersPayload(values), toReferringDomainsFiltersPayload(values), toTopPagesFiltersPayload(values);
export const TAB_DESCRIPTIONS; export function buildSummaryStats(overview); export function truncateMiddle(s, max); export function formatRelativeTimestamp(iso);
export function buildBacklinksTabExport({ tab, rows, domainRatings }); export function buildBacklinksTabFilename(tab, target);
export type BacklinksOverview, BacklinksRow, ReferringDomainRow, TopPageRow, BacklinksSnapshot;
```

`buildSummaryStats` renders unknown values as "—" (OpenSEO "-").

#### 6.2.3 Services (`src/lib/backlinks/`)

| File | Mode | Exports and behaviour |
|---|---|---|
| `backlinksApiFilters.ts` | COPY | `buildBacklinksRowsOrderBy`, `buildReferringDomainsOrderBy`, `buildTopPagesOrderBy`, `buildBacklinksRowsApiFilters`, `buildReferringDomainsApiFilters`, `buildTopPagesApiFilters` (F13 `filters.ts`). |
| `backlinksRowMappers.ts`, `backlinksOverviewSchema.ts` | COPY | as theirs (`z.looseObject` for the response-facing schemas). |
| `backlinksSubfolderOverview.ts` | PORT | `buildSubfolderOverview(client, target, now, ctx)`: two sequential metered `rows` calls with idempotency keys `<base>:subfolder_all` and `<base>:subfolder_domains`. |
| `backlinksService.ts` | PORT `BacklinksService.ts` + `backlinksServiceData.ts` | `BACKLINKS_CACHE_SCOPE = "workspace"`; `BACKLINKS_CACHE = { overview: { namespace: "backlinks.overview", version: 2 }, rows: { namespace: "backlinks.rows_page", version: 2 }, domains: { namespace: "backlinks.referring_domains_page", version: 1 }, pages: { namespace: "backlinks.top_pages_page", version: 1 } }` (OpenSEO's version numbers kept), `ttlSeconds: 21600`. `profileOverview(input, deps)`, `profileBacklinksPage(input, deps, { hideSpam })`, `profileReferringDomainsPage(input, deps)` (always `hideSpam: false`), `profileTopPagesPage(input, deps)`. `deps = { client: BacklinksClient; brandKey; requestId; maxUsd?: number; cacheOnly: boolean; onFetchedSummary?(overview): Promise<void>; now?: () => Date }`. Cache keyParts = OpenSEO's key fields minus organisation (§2 item 9). `cacheOnly` → `peekCached`. Referring-domains subfolder → `AppError(400, "subfolder_not_supported", "Referring domains can't be broken down for a subfolder — use the Backlinks tab, or switch to Domain or Subdomains scope.")`. Idempotency keys `backlinks.research:<requestId>:<call>` (`summary`, `history`, `rows`, `domains`, `pages`). Provider errors → `toResearchError` with `backlinks_unavailable` "Backlink data is unavailable right now. Please retry.". |
| `researchLog.ts` | new | `backlinksResearchKey({ apiTarget, scope, path })`; summary "Backlinks for <display>: <backlinks> backlinks from <referringDomains> domains." ("unknown" for nulls). |
| `ahrefsDomainRating.ts` (P4) | PORT `openseo:src/serverFunctions/ahrefs.ts:8-119` | `AHREFS_DR_ENDPOINT = "https://api.ahrefs.com/v3/public/domain-rating-free"`, `FETCH_BATCH_SIZE = 20`, `MAX_DOMAINS_PER_CALL = 100`, `FETCH_TIMEOUT_MS = 5000`; `getAhrefsDomainRatings(domains, deps?: { fetch?, cached? }): Promise<Record<string, number \| null>>`; per normalised domain `cached({ namespace: "backlinks.ahrefs_dr", version: 1, keyParts: [domain], ttlSeconds: 86400, scope: "global", schema: z.strictObject({ dr: z.number().min(1).max(100).nullable() }) }, fetchDomainRating)`; `fetchDomainRating` = `fetch(AHREFS_DR_ENDPOINT + "?target=" + encodeURIComponent(domain), { signal: AbortSignal.timeout(5000), redirect: "error", headers: { Accept: "application/json" } })`, non-2xx or schema failure throws (not cached → null), DR 0 → `{ dr: null }`. Normalisation with F13 `normalizeDomainInput(original, true)`; invalid inputs map to null without a fetch. |
| `snapshots.ts` (P5) | new (PATTERN of the unused OpenSEO table) | §6.3; `createSnapshotTarget`, `deleteSnapshotTarget`, `listSnapshotTargets`, `listSnapshots`, `recordLookupSnapshot`, `captureScheduledSnapshot`, `listDueSnapshotTargets`, `blockSnapshotTarget`, `SNAPSHOT_SKIP_REASONS`. |
| `backlinks.contract.ts` | new | Route contracts. |
| `tools.ts` | new | F22 tools `get_backlinks_overview`, `list_backlinks`, `list_referring_domains` (paid; input includes `maxUsd`) and `get_backlink_history` (free; stored snapshots only), same shape as F07 §6.2.8. These are the building blocks F21's link-prospecting skill calls. |

#### 6.2.4 Priced actions (`src/lib/pricing/actions/backlinks.ts`, registered in `src/lib/pricing/actions/index.ts`)

| Key | Feature | Input (`z.strictObject`) | `requireApproval` | Lines (exact labels) |
|---|---|---|---|---|
| `backlinks.lookup.run` | `backlinks.research` | `{ target: string(1..2048), scope?: ResearchScope, tab: "backlinks"\|"domains"\|"pages" = "backlinks", pageSize: 50\|100\|200 = 50 }` | false | domain/subdomains: "Backlink summary" `backlinks.summary({})`, "12 months of history" `backlinks.history({ dateFrom, dateTo })` (range of §2 item 5); exact URL: summary only; subfolder: "Filtered backlink totals (2 requests)" 2 × `backlinks.rows({ limit: 1 })`; plus the tab's first page "First <pageSize> backlinks" / "First <pageSize> referring domains" / "First <pageSize> top pages" (`rows`/`referringDomains`/`domainPages` with `limit: pageSize`; none for referring domains with subfolder scope). Warnings `cache_note` "Looking up the same target again within 6 hours is free."; `recent_research`. Blocked `invalid_target`, `subfolder_not_supported` (tab domains + subfolder). |
| `backlinks.page` | `backlinks.research` | `{ tab, pageSize }` | false | "<pageSize> <tab rows>" |
| `backlinks.expand_domain` | `backlinks.research` | `{}` | false | "All links from one domain (up to 100)" `backlinks.rows({ limit: 100 })` |
| `backlinks.snapshots.track` (P5) | `backlinks.snapshots` | `{ target: string(3..255), scope: "domain"\|"subdomains", interval: "weekly"\|"monthly" }` | true | per run "Backlink summary for <target>" `backlinks.summary({})`; `monthly = { interval, runsPerMonth: scheduledChecksPerMonth(interval), totalUsd }` (F10/F03). Blocked `already_tracked`, `snapshot_target_limit`. |

**Worked example** (offcult.in, subdomains, Backlinks tab, 50 rows): summary 0.024036 + history 0.024 + 366 × 0.000036 = 0.037176 + first page 0.0258 → **$0.087012**; each further page, sort or filter $0.0258; one domain expansion $0.0276; weekly snapshot $0.096 a month.

### 6.3 Jobs (phase 5)

| Kind / periodic | Trigger | Steps | Completion |
|---|---|---|---|
| periodic `backlinks.snapshots_tick` | `definePeriodic({ everySeconds: 3600 })` → `enqueueSystemJob("backlinks.snapshots_tick", {}, { dedupeKey: "backlinks.snapshots_tick:" + hourIso, singleActiveKey: "backlinks.snapshots_tick" })` | — | — |
| `backlinks.snapshots_tick` (system; `deadlineSeconds: 240`, `pollAfterSeconds: 20`) | periodic | `list` (`DB_STEP`): `listDueSnapshotTargets(now, 20)` → `[{ key: id, observedNextRunAt, interval, brandKey, target, scope, approvedMaxUsd }]` oldest first. Then F10 `runDueSchedules` with `wrap = (name, fn) => ctx.step.do(name, { timeoutMs: 60000, retries: 0 }, fn)`: **evaluate** (first failure wins): `isFeatureEnabled("backlink_snapshots", brandKey)` false → `snapshots_disabled`; workspace inactive → `workspace_inactive`; `quote("backlinks.snapshots.track")` total > `approvedMaxUsd` → `price_changed`. **start**: update `next_run_at = plan.next`, `last_run_at = now` first (advance before running, OpenSEO `scheduledAiVisibility.ts:36-62`), then `client.summary({ brandKey, feature: "backlinks.snapshots", idempotencyKey: "backlinks.snapshot:" + id + ":" + plan.run, maxUsd: approvedMaxUsd }, { target, includeSubdomains: scope === "subdomains" })`, then insert the snapshot (`source 'scheduled'`, `captured_on` = UTC date of `plan.run`, `ON CONFLICT DO NOTHING`). `SpendRefused` → block with its reason. **block**: `next_run_at = plan.next`, `last_skip_reason`, `last_skip_at`. | `completed` `{ started, skipped, failed, notDue }`; `partial` when `failed > 0` |
| periodic `backlinks.snapshots_retention` | every 86,400 s | `rpc("prune_backlink_snapshots", { p_before: today − 25 months, p_limit: 5000 })` | log `[backlinks.retention] pruned=N` |

Skip reasons (closed list, `SNAPSHOT_SKIP_REASONS`, copy for the UI): `snapshots_disabled` "History tracking is turned off for this workspace."; `workspace_inactive` "This workspace is inactive."; `price_changed` "The price rose above what you approved. Approve the new price to continue."; `feature_disabled` "Backlink history is not enabled for this workspace."; `daily_cap` "Today's spend limit was reached."; `workspace_cap` "This month's spend limit was reached."; `start_failed` "The snapshot could not be taken. It will try again next time."

**Free lookup snapshots:** `profileOverview` calls `deps.onFetchedSummary(overview)` after a fetched (not cached) summary for domain or subdomain scope; the route passes `recordLookupSnapshot`, which inserts a `source 'lookup'` row only when an enabled target exists for `(brandKey, apiTarget, scope)`, with `ON CONFLICT DO NOTHING` on the per-day constraint, in `keepAlive`.

### 6.4 Provider calls and cost

| Use | Endpoint | Body | Response used | Estimate (F03) | Cache (F01) | Spend feature | Fixtures `tests/fixtures/f16/` |
|---|---|---|---|---|---|---|---|
| Summary | `POST /v3/backlinks/summary/live` | common payload | `result[0]` | `backlinks.summary` = 0.024036 | `backlinks.overview` v2, 6 h, workspace | `backlinks.research` (or `backlinks.snapshots`) | `backlinks-summary.json` (misspelled `reffering` keys), `backlinks-summary-subdomains-false.json` |
| History | `POST /v3/backlinks/history/live` | `target, date_from, date_to, rank_scale` | `result[0].items[]` | `backlinks.history` = 0.024 + 0.000036 × days | inside the overview entry | `backlinks.research` | `backlinks-history.json` (one month missing to prove gaps) |
| Backlinks | `POST /v3/backlinks/backlinks/live` | + `limit, offset, order_by, mode, filters, backlinks_status_type` | `result[0].items[]`, `total_count` | `backlinks.rows` = 0.024 + 0.000036 × limit | `backlinks.rows_page` v2, 6 h, workspace | `backlinks.research` | `backlinks-rows.json` (spam 0, null and 55) |
| Referring domains | `POST /v3/backlinks/referring_domains/live` | same | same | `backlinks.referringDomains` | `backlinks.referring_domains_page` v1 | `backlinks.research` | `backlinks-referring-domains.json` |
| Top pages | `POST /v3/backlinks/domain_pages_summary/live` | same | same | `backlinks.domainPages` | `backlinks.top_pages_page` v1 | `backlinks.research` | `backlinks-domain-pages.json` |
| Ahrefs DR (P4) | `GET https://api.ahrefs.com/v3/public/domain-rating-free?target=<domain>` | — | `domain_rating.domain_rating` | free (no hold) | `backlinks.ahrefs_dr` v1, 24 h, **global** | none | `ahrefs-dr.json`, `ahrefs-dr-zero.json` |
| Errors | — | — | — | — | — | — | `backlinks-balance-40200.json`, `backlinks-invalid-field.json` |

**Cache scope decision: workspace** for DataForSEO lookups, for the reason F14 gives: a lookup reveals which sites a workspace studies, and global caching would let an instant $0 answer reveal that another workspace looked at the same target in the last 6 hours. The cost: two workspaces researching the same site each pay (about $0.09 per lookup). `BACKLINKS_CACHE_SCOPE` is one constant. **Global** for Ahrefs DR: it is free, public and per referring domain rather than per researched target, so sharing reveals nothing about a workspace and avoids hammering a free endpoint (OpenSEO's KV cache is global too).

Fixtures are synthetic, shaped like DataForSEO's and Ahrefs' public documentation, with no account or task ids.

### 6.5 API routes

All under `src/app/api/customer/backlinks/**/route.ts`; `requireWorkspace(request)`; `isFeatureEnabled("backlinks", brandKey)` false → `AppError(404, "feature_unavailable", "This page is not available for your workspace yet.")`; strict bodies; `z.looseObject` responses; `toErrorResponse`; `Cache-Control: no-store`; members and owners; `maxDuration = 60`. Common codes as F13 §6.5 plus `invalid_target`, `filters_over_budget`, `subfolder_not_supported`, `backlinks_unavailable`.

**`POST /api/customer/backlinks/overview`** — `z.strictObject({ target: z.string().trim().min(1).max(2048), scope: backlinksScopeParamSchema.optional(), tab: z.enum(BACKLINKS_TABS).default("backlinks"), pageSize: 50|100|200 = 50, cacheOnly: z.boolean().default(false), maxUsd?, requestId: z.uuid() })` (`tab`/`pageSize` only shape the quote). Not `cacheOnly`: `requireApprovedPrice("backlinks.lookup.run", …)` (implicit when absent); miss → `appendResearch(kind "backlinks.research")`. Response:

```json
{ "status": "ok", "target": "offcult.in", "displayTarget": "offcult.in", "scope": "subdomains",
  "summary": { "rank": 21, "backlinks": 4120, "referringPages": 2980, "referringDomains": 312, "brokenBacklinks": 14,
               "brokenPages": 3, "backlinksSpamScore": 12, "targetSpamScore": 4, "newBacklinks": 85, "lostBacklinks": 40,
               "newReferringDomains": 9, "lostReferringDomains": 5 },
  "trends": [ { "date": "2025-10-31", "backlinks": 3810, "referringDomains": 290, "rank": 20 } ],
  "newLostTrends": [ { "date": "2025-10-31", "newBacklinks": 70, "lostBacklinks": 22, "newReferringDomains": 6, "lostReferringDomains": 2 } ],
  "tracked": null, "isOwnSite": true, "isDeclaredCompetitor": false,
  "cached": false, "fetchedAt": "2026-10-21T09:30:00.000Z", "provenance": { "gateway": "dataforseo" } }
```

`tracked` (P5) is `{ "interval": "weekly", "nextRunAt": "…" }` or null. `cacheOnly` miss → `{ "status": "not_cached", "target": "offcult.in", "displayTarget": "offcult.in", "scope": "subdomains" }`.

**`POST /api/customer/backlinks/rows`** — `{ target, scope?, page: z.int().positive().default(1), pageSize: 50|100|200 = 50, sortField: backlinksRowsSortFieldSchema.default("firstSeen"), sortOrder: asc|desc = "desc", filters: backlinksRowsFiltersSchema.default({}), mode: backlinksRowsModeSchema.default("one_per_domain"), hideSpam: z.boolean().default(true), cacheOnly, maxUsd?, requestId }`. Action `backlinks.page` (or `backlinks.expand_domain` when `filters.domainFrom` is set). Response `{ status, rows: [ { domainFrom, urlFrom, urlTo, anchor, itemType, isDofollow, relAttributes, rank, domainFromRank, pageFromRank, spamScore, firstSeen, lastSeen, isLost, isBroken, linksCount } ], totalCount, hasMore, page, pageSize, cached, fetchedAt, provenance }`.

**`POST /api/customer/backlinks/referring-domains`** — `{ target, scope?, page, pageSize, sortField: referringDomainsSortFieldSchema.default("backlinks"), sortOrder, filters: referringDomainsFiltersSchema.default({}), cacheOnly, maxUsd?, requestId }`; always `hideSpam: false` server-side. Response rows `{ domain, backlinks, referringPages, rank, spamScore, firstSeen, brokenBacklinks, brokenPages }`. Error `400 subfolder_not_supported`.

**`POST /api/customer/backlinks/top-pages`** — `{ target, scope?, page, pageSize, sortField: topPagesSortFieldSchema.default("backlinks"), sortOrder, filters: topPagesFiltersSchema.default({}), cacheOnly, maxUsd?, requestId }`. Rows `{ page, backlinks, referringDomains, rank, brokenBacklinks }`.

**`POST /api/customer/backlinks/ahrefs-dr`** (P4) — flag `backlinks_ahrefs_dr` (else `404 feature_unavailable`); `{ domains: z.array(z.string().trim().min(1).max(253)).min(1).max(100) }` → `{ "ratings": { "bewakoof.com": 61, "www.example.in": null } }` (keys are the inputs as sent). Free; `maxDuration = 30`.

**`GET /api/customer/backlinks/snapshot-targets`** (P5) — flag `backlink_snapshots` → `{ "targets": [ { "id": "…", "target": "offcult.in", "scope": "subdomains", "label": "Your site", "interval": "weekly", "enabled": true, "nextRunAt": "…", "lastRunAt": null, "lastSkipReason": null, "lastSkipMessage": null } ] }`.

**`POST /api/customer/backlinks/snapshot-targets`** (P5) — `{ target: z.string().trim().min(3).max(255), scope: z.enum(["domain","subdomains"]), interval: z.enum(["weekly","monthly"]), label: z.string().trim().min(1).max(120).optional(), maxUsd: z.number().positive().max(1000).optional() }` → `requireApprovedPrice("backlinks.snapshots.track", …)` (required) → `recordApproval(source "schedule", subject { kind: "backlink_snapshot_target", id })` → insert with `next_run_at = computeNextRunAt(interval, null)` → `201 { "target": { … } }`. Errors `409 already_tracked`, `409 snapshot_target_limit`, price codes.

**`DELETE /api/customer/backlinks/snapshot-targets/[targetId]`** (P5) → `{ "deleted": true }` (snapshots are kept until retention); `404 snapshot_target_not_found`.

**`GET /api/customer/backlinks/snapshots`** (P5) — query `{ brand_key, target, scope: domain|subdomains }` → `{ "snapshots": [ { "capturedOn": "2026-10-14", "source": "scheduled", "rank": 21, "backlinks": 4120, "referringDomains": 312, … } ] }` (oldest first, ≤ 120 rows). Free.

Contracts in `src/lib/backlinks/backlinks.contract.ts`.

### 6.6 UI

Built from F04, F05, F06, F09 and F13 components (as F14 §6.6). Unknown numbers render "—"; charts use `connectNulls={false}` so missing days are gaps.

**Navigation:** `items.ts` group `research` → `{ id: "backlinks", label: "Backlinks", href: "/portal/backlinks", icon: Link2, flag: "backlinks" }`. `CLIENT_FEATURES` gains `"backlinks"`, `"backlinks_ahrefs_dr"`, `"backlink_snapshots"`. Query keys: `backlinksOverview(brandKey, inputKey)`, `backlinksTab(brandKey, tab, inputKey)`, `backlinksDomainLinks(brandKey, inputKey)`, `ahrefsRatings(brandKey, inputKey)`, `backlinkSnapshotTargets(brandKey)`, `backlinkSnapshots(brandKey, target, scope)`.

**Page** `src/app/portal/backlinks/page.tsx` → `src/components/portal/backlinks/BacklinksPage.tsx` (PORT). URL state via `useUrlSearchState(backlinksSearchSchema, defaults)`; filters are component state (theirs). **Live mode** as F13 §6.6.2: before the first priced click every query is `cacheOnly`; afterwards paging, sorting, filters, view, spam toggle and expansions run directly within their shown price.

| State | Shown |
|---|---|
| Flag off | `EmptyState` "This page is not available for your workspace yet." / "Ask Perceev support to turn on backlinks." |
| Header | `PageHeader` "Backlinks", description "Understand who links to a site, what changed recently, and which pages attract links."; back link "Recent searches" when a target is set |
| Search card | `SearchInput` "Enter a domain or URL" (`aria-label` "Domain or URL"), `ResearchScopeSelect`, `PricedActionButton` "Search" (action `backlinks.lookup.run`); quick picks "Your site · {ownHost}" and declared competitors (F07, when `project_memory` is on), filling the input only |
| No target | (P5) "Tracked history" list when targets exist (target, "Weekly"/"Monthly", "Next snapshot {date}", skip message in muted text), then `RecentSearches` with empty title "Enter a domain or URL to get started" |
| Loading | `BacklinksLoadingState` (PORT) |
| Not loaded | `Card` "Backlinks for {displayTarget} are not loaded." / "Running this lookup buys fresh backlink data." + `PricedActionButton` "Run lookup" |
| Error, no data | `QueryError` title "Could not load backlinks"; validation code → "Enter a valid domain or page URL."; spend refusals via `SpendRefusedError` |
| Scope notes | info `Alert` for exact URL: "Showing backlinks for this exact page. Switch the scope to Domain or Subdomains for site-wide results — trend charts need one of those."; subfolder: "Showing backlinks pointing into this subfolder. Counts come from filtered backlink totals; rank, trends, and the referring-domains breakdown need Domain or Subdomains scope." |
| Overview | `h2` display target, scope badge, "Your site"/"Competitor" badges, "Updated {relative}"; `MetricsTable` with `HelpLabel`: "Backlinks" ("Total links pointing to this site or page."), "Referring Domains" ("Unique domains linking to this site or page."), "Referring Pages" ("Unique pages linking to this site or page."), "Rank" ("DataForSEO's 0-100 authority score."), "Backlink Spam Score" ("Estimated spam risk of links pointing here."), "Broken Backlinks" ("Links pointing to broken pages here."), "Broken Pages" ("Broken pages here that still have backlinks."), "Target Spam Score" ("Estimated spam risk of this site or page."); domain/subdomain scope: panels "Backlink growth" (description "Last year · Includes subdomains" for domain scope, "Backlinks and referring domains over the last year" for subdomains; lines "Backlinks" left axis, "Referring domains" right axis) and "New vs lost" ("Backlink acquisition and attrition"; lines "New backlinks", "Lost backlinks"); empty chart "Not enough historical data yet." |
| (P5) Tracking control | in the overview header, domain/subdomain scope, flag on: not tracked → button "Track history" → `CostReviewDialog` (title "Track backlink history", interval radio "Weekly" / "Monthly", F09 `MonthlyProjection`, detail "Takes one backlink summary per period for {target}. Viewing saved history is free.", confirm "Start tracking") → toast "Tracking backlink history for {target}, {weekly/monthly}."; tracked → badge "History tracked · {Weekly}" and menu item "Stop tracking" → `ConfirmDialog` "Stop tracking history?" / "Saved snapshots are kept for 25 months." → toast "Stopped tracking {target}." |
| (P5) Tracked history | panel "Tracked history" (shown when ≥ 2 snapshots), description "Saved {weekly/monthly} since {first date}. Free to view."; lines backlinks and referring domains from stored snapshots; one snapshot → "One snapshot so far. The chart appears after the next one." |
| Results card | `DataTableTabs` "Backlinks", "Referring Domains", "Top Pages" with descriptions ("See the individual links pointing to your target, including source page, anchor text, and link quality signals." / "View the unique domains linking to your target, grouped at the site level instead of by individual link." / "See which pages on the target site attract the most backlinks and referring domains."); toolbar: filter toggle with count; Backlinks tab: menu "Best links: On/Off" with "Best links only" ("Scores below 40 or unknown") and "All links (spammy included)" ("Includes scores 40 or higher"), `SegmentedToggle` "One per domain" / "All links"; `ExportMenu` (scope label "Current page · selected view"); (P4) actions menu item "Ahrefs DR" (title "Look up Ahrefs Domain Rating for each domain in the table") on Backlinks and Referring Domains; muted cost hint "Each new page, sort or filter costs up to {formatUsd}. Results are reused for 6 hours." |
| Filters | Backlinks: "Source URL Contains", "Source URL Excludes", ranges "Domain Authority", "Link Authority", "Spam Score", "Link Type" (All / Dofollow / Nofollow), "Visibility" ("Hide lost", "Hide broken"). Referring Domains: "Domain Contains", "Domain Excludes", "Backlinks", "Rank", "Spam Score". Top Pages: "Page URL Contains", "Page URL Excludes", "Backlinks", "Referring Domains", "Rank". Over budget: "These filters exceed the {n}-condition limit for this view. Remove conditions in Filters or choose All links (spammy included) from Best links. Your filters have been kept." (the Best-links clause only when spam hiding is on) and the table is hidden until fixed |
| Backlinks table | Source ("Page linking to you"; middle-truncated path), Target ("Destination on your site"), Anchor ("Text or format of the link"), Flags ("Special backlink attributes, such as lost, broken, nofollow, or multiple links from the same source."), Link ("Authority of the linking page"), DA ("Authority of the linking domain"), Spam (help as OpenSEO; unknown "—" with title "Spam score unknown"; 0 shown as 0), First Seen ("When this link was first discovered by the crawler"), (P4) Ahrefs DR; one-per-domain rows have an expand toggle (`aria-label` "Show all links from {domain}" / "Hide all links from {domain}", title "Load all links from {domain} · up to {price}") with statuses "Loading links…", "Couldn't load this domain's links.", "No other links from this domain."; empty "No backlinks found for this target." |
| Referring Domains table | Domain, Backlinks, Referring Pages, Rank, Spam, First Seen, Issues ("Broken link and broken page counts tied to this domain."), (P4) Ahrefs DR; empty "No referring domains found for this target."; subfolder scope → `Alert` with the `subfolder_not_supported` message instead of the table |
| Top Pages table | Page, Backlinks, Referring Domains, Rank, Broken Backlinks; empty "No top pages found for this target." |
| Pagination | 50/100/200, total, next |
| (P4) Ahrefs DR | loading spinner on the menu item; partial results kept; failure toast "Could not load Ahrefs DR."; footnote under the table when loaded "Domain Rating from Ahrefs' free public lookup." |

Accessibility and phone: as F14 §6.6; charts have `aria-label` "Backlink trend chart" and "New and lost backlinks chart" and a visually hidden table of the same numbers.

### 6.7 Permissions, privacy, observability

- Members and owners may look up and export; tracking history (P5) needs an owner (`requireWorkspace(..., { role: "owner" })` on create/delete), because it creates recurring spend; members can view snapshots.
- Logs: `[backlinks] lookup { brandKey, targetHash, scope, cached, ms }`, `[backlinks] tab { brandKey, tab, rows, cached }`, `[backlinks] ahrefs { count, failed }` (no domains), `[backlinks.snapshots] tick { started, skipped, failed }`. Never provider bodies.
- The Ahrefs request carries only the domain; no Perceev identifiers, cookies or keys.
- PostHog (F26 names; until F26 merges through `trackBacklinksEvent` in `src/components/portal/backlinks/telemetry.ts` (exports `setBacklinksEventTracker(fn)`; no-op until F26 wires it, F26 §6.2.7), a no-op sink): `backlinks:lookup { scope, cached }`, `backlinks:tab { tab }`, `backlinks:expand_domain`, `backlinks:ahrefs_dr { count }`, `backlinks:track_history { interval }`. No targets in events.

### Deviations from conventions

1. **Snapshot counts are `bigint`**, not `integer` (conventions §8): large sites exceed 2,147,483,647 backlinks (OpenSEO widened the same columns).
2. **Inline price approval and live mode** as F13 deviations 2 and 3. Tracking history always uses `CostReviewDialog`.
3. **Ahrefs DR is fetched with plain `fetch`** to one fixed host, not F01's `safeFetch`: the URL is a constant and only a URL-encoded domain parameter comes from the customer, so there is no customer-supplied URL (conventions §6.7 targets those).

## 7. Code reuse map

| OpenSEO source | Perceev target | Mode | Adaptation notes |
|---|---|---|---|
| `openseo:src/server/lib/dataforseo/backlinks.ts` (+ `backlinks.test.ts`) | `src/lib/providers/dataforseo/backlinks.ts` (+ `.test.ts`) | COPY | F02 classifier and error classes; `createBacklinksClient` on F02 `meter` with F03 estimators. |
| `openseo:src/server/lib/dataforseoBacklinksTarget.ts` | `src/lib/providers/dataforseo/backlinksTarget.ts` (+ `.test.ts`) | COPY | `AppError(400, "invalid_target")`. |
| `openseo:src/server/features/backlinks/services/backlinksApiFilters.ts` (+ test) | `src/lib/backlinks/backlinksApiFilters.ts` (+ `.test.ts`) | COPY | F13 `filters.ts`. |
| `openseo:src/server/features/backlinks/services/{backlinksRowMappers,backlinksOverviewSchema}.ts` | `src/lib/backlinks/…` | COPY | zod v4. |
| `openseo:src/server/features/backlinks/services/backlinksSubfolderOverview.ts` | `src/lib/backlinks/backlinksSubfolderOverview.ts` | PORT | Metered calls with idempotency keys. |
| `openseo:src/server/features/backlinks/services/{BacklinksService,backlinksServiceData}.ts` (+ `BacklinksService.billing.test.ts`) | `src/lib/backlinks/backlinksService.ts` (+ `.test.ts`) | PORT | R2 → F01 `cached` (workspace) with OpenSEO's version numbers; `cacheOnly`; lookup snapshot hook. |
| `openseo:src/serverFunctions/backlinks.ts` | `src/app/api/customer/backlinks/{overview,rows,referring-domains,top-pages}/route.ts` | PORT | `requireWorkspace`, priced actions. |
| `openseo:src/serverFunctions/ahrefs.ts` | `src/lib/backlinks/ahrefsDomainRating.ts`, `src/app/api/customer/backlinks/ahrefs-dr/route.ts` | PORT | KV → F01 `cached` (global); flagged. |
| `openseo:src/types/schemas/backlinks.ts`, `client/features/backlinks/{backlinksFilterTypes,backlinksPageUtils,export,backlinksPageTypes}.ts` (+ tests) | `src/shared/backlinks.ts` (+ `.test.ts`) | PORT | "—" for unknown; tests ported (`BacklinksTable.test.ts`, `backlinksFilterTypes.test.ts`, `backlinksPageUtils.test.ts`, `export.test.ts`). |
| `openseo:src/client/features/backlinks/*.tsx`, `useBacklinksPageData.ts`, `useBacklinksFilters.ts`, `useBacklinksDomainExpansion.ts`, `useAhrefsDomainRatings.ts`, `openseo:src/client/hooks/useBacklinksSearchHistory.ts` | `src/components/portal/backlinks/**` | PORT | F04/F05/F06/F09/F13 components; live mode; quick picks; tracking control. |
| `openseo:src/db/app.schema.ts:417-445`, `drizzle/pg/0012_dashboard.sql:1-33`, `0016_panoramic_blob.sql` | `supabase/migrations/115_f16_backlink_snapshots.sql` | PATTERN | Per-scope, per-day, opt-in targets with schedules; written by our jobs (theirs is unused). |

## 8. Implementation plan

### Phase 1 — Backlinks provider section

**Goal:** the metered Backlinks client and target normalisation.

- [x] **P1.T1 Client**
  - [x] **P1.T1.S1** *Files:* `src/lib/providers/dataforseo/backlinks.ts`, `backlinks.test.ts`, `backlinksTarget.ts`, `backlinksTarget.test.ts`, fixtures `tests/fixtures/f16/backlinks-*.json`. *Do:* §6.2.1; port `backlinks.test.ts:31-200` (target normalisation cases; "rejects exact-url targets with query strings or fragments"; summary top-level error classified through F02 to `UnbilledCallError`/`dataforseo_balance`; domain scope sends `include_subdomains: false`); add body assertions for each fetcher, spam conditions with `hideSpam` true/false, and "every entry is priced" with a spy `meter`. *Verify:* `node --test src/lib/providers/dataforseo/backlinks.test.ts src/lib/providers/dataforseo/backlinksTarget.test.ts` → pass (F16-AC-01, 02).
  - [x] **P1.T1.S2** *Files:* `THIRD_PARTY_NOTICES.md`. *Verify:* `node --test src/lib/platform/thirdPartyNotices.test.mjs` → pass.

**Checkpoint:** full suite `node --import ./src/lib/liveWriteGuardAuto.mjs --test-concurrency=4 --test 'src/**/*.test.mjs' 'src/**/*.test.ts'`, `npm run typecheck`, `npm run build`, F02's `noPrices.test.mjs` and `answerImportGuard.test.mjs` pass. Completes F16-AC-01, 02.

### Phase 2 — Backlinks API

**Goal:** priced, cached overview and tab routes.

- [x] **P2.T1 Registration**
  - [x] **P2.T1.S1** *Files:* `src/shared/spend-features.ts` (`"backlinks.research"`, `"backlinks.snapshots"`; labels "Backlink research", "Backlink history snapshots"), `src/lib/features/names.ts` (`backlinks: { spend: ["backlinks.research"] as const }`, `backlinks_ahrefs_dr: { spend: [] as const }`, `backlink_snapshots: { spend: ["backlinks.snapshots"] as const }`), `src/lib/features/clientFeatures.ts` (append the three), `.env.example` (`FEATURE_BACKLINKS=`, `FEATURE_BACKLINKS_BRANDS=`, `FEATURE_BACKLINKS_AHREFS_DR=`, `FEATURE_BACKLINKS_AHREFS_DR_BRANDS=`, `FEATURE_BACKLINK_SNAPSHOTS=`, `FEATURE_BACKLINK_SNAPSHOTS_BRANDS=`). *Verify:* `node --test src/lib/features/flags.test.ts src/shared/*.test.ts` → pass; `grep -c "^FEATURE_BACKLINKS=$" .env.example` → 1.
- [x] **P2.T2 Services**
  - [x] **P2.T2.S1** *Files:* `src/shared/backlinks.ts`, `src/shared/backlinks.test.ts`. *Do:* §6.2.2; port `BacklinksTable.test.ts` (zero vs missing spam), `backlinksFilterTypes.test.ts` (two cases), `backlinksPageUtils.test.ts` (truncateMiddle), `export.test.ts` (six cases incl. the DR column keyed off the `www.`-stripped source domain). *Verify:* `node --test src/shared/backlinks.test.ts` → pass (F16-AC-10 logic).
  - [x] **P2.T2.S2** *Files:* `src/lib/backlinks/{backlinksApiFilters,backlinksRowMappers,backlinksOverviewSchema,backlinksSubfolderOverview}.ts`, `backlinksApiFilters.test.ts`. *Do:* COPY/PORT; port `backlinksApiFilters.test.ts:14-144`. *Verify:* `node --test src/lib/backlinks/backlinksApiFilters.test.ts` → pass (F16-AC-05).
  - [x] **P2.T2.S3** *Files:* `src/lib/backlinks/backlinksService.ts`, `researchLog.ts`, `backlinksService.test.ts`. *Do:* §6.2.3; port the six cases of `BacklinksService.billing.test.ts:77-257` onto a fake client and F01 memory cache; add: exact URL makes no history call; subfolder calls are sequential (second starts after the first resolves); history range ends yesterday UTC with a fixed clock; referring domains always `hideSpam: false`; spam condition counts 2 (`400 filters_over_budget` at 7 user conditions with spam hiding); workspace B misses A's entry; `cacheOnly` miss → null with zero calls; `onFetchedSummary` called on a fetch only. *Verify:* `node --test src/lib/backlinks/backlinksService.test.ts` → pass (F16-AC-03, 04, 06, 08).
  - [x] **P2.T2.S4** *Files:* `src/lib/pricing/actions/backlinks.ts` (`backlinks.lookup.run`, `backlinks.page`, `backlinks.expand_domain`), `src/lib/pricing/actions/index.ts` (one import), `src/lib/pricing/actions/backlinks.test.ts`. *Do:* §6.2.4; tests: worked example $0.087012 with a fixed clock; exact URL and subfolder lines; `subfolder_not_supported` block; `recent_research`. *Verify:* `node --test src/lib/pricing/actions/backlinks.test.ts` → pass (F16-AC-07 unit half, F16-AC-08 quote half).
- [x] **P2.T3 Routes**
  - [x] **P2.T3.S1** *Files:* `src/app/api/customer/backlinks/{overview,rows,referring-domains,top-pages}/route.ts`, `src/lib/backlinks/backlinks.contract.ts`. *Verify:* `node --test src/lib/http/routeContract.test.ts` → pass.
  - [x] **P2.T3.S2** *Files:* `src/lib/backlinks/backlinks.route.test.mjs` (hook pattern). Cases: flag off → 404; unknown field → 400; `cacheOnly` miss → `not_cached`, zero spend calls; stale `maxUsd` → 409; invalid target → 400; referring domains + subfolder → 400 `subfolder_not_supported`; spend refusal passes through; tenant isolation of cache (workspace B gets `cached: false`). *Verify:* `node --test src/lib/backlinks/backlinks.route.test.mjs` → pass (F16-AC-07, 11 route half).
  - [x] **P2.T3.S3** *Files:* `src/lib/backlinks/tools.ts` (`get_backlinks_overview`, `list_backlinks`, `list_referring_domains`), `tools.test.ts`. *Verify:* `node --test src/lib/backlinks/tools.test.ts` → pass.
  - [x] **P2.T3.S4** *Files:* `THIRD_PARTY_NOTICES.md`. *Verify:* `node --test src/lib/platform/thirdPartyNotices.test.mjs` → pass.

**Checkpoint:** full suite, typecheck, build. Completes F16-AC-03…08, 11 (route half).

### Phase 3 — Backlinks page (requires F04, F05, F06, F09 phase 3 merged)

**Goal:** `/portal/backlinks` with overview, charts, tabs, filters and export.

- [x] **P3.T1 Components**
  - [x] **P3.T1.S1** *Files:* `src/app/portal/backlinks/page.tsx`, `src/components/portal/backlinks/{BacklinksPage,BacklinksSearchCard,BacklinksQuickPicks,BacklinksPageContent,BacklinksNotLoadedCard,BacklinksOverviewPanels,BacklinksPageCharts,BacklinksPageSections,BacklinksPageStates,BacklinksFilterPanel,BacklinksToolbarMenus,BacklinksTable,BacklinksTableColumns,ReferringDomainsTable,TopPagesTable}.tsx`, `hooks/{useBacklinksPageData,useBacklinksFilters,useBacklinksDomainExpansion,useBacklinksSearchHistory,useBacklinksSearchTabs,useBacklinksLiveMode}.ts`, `telemetry.ts`, `src/components/app/navigation/items.ts` (entry), `src/lib/query/keys.ts` (factories). *Do:* §6.6 without P4/P5 rows. *Verify:* `npm run build` → exit 0.
- [x] **P3.T2 Browser checks**
  - [x] **P3.T2.S1** *Files:* `scripts/qa/check-f16-browser.mjs` (Playwright, local app, fixture APIs). B1 flag off; B2 `/portal/backlinks?target=offcult.in` sends only `cacheOnly` requests and shows "Run lookup · up to $0.09"; B3 click → overview metrics ("—" for a null), growth chart with a gap for the missing month, new/lost chart; B4 Best links off → `hideSpam: false` request; One per domain/All links toggles `mode`; B5 filters over budget → message, table hidden; B6 expand a domain → "Loading links…" then links, second domain error → "Couldn't load this domain's links."; B8 375 px no horizontal scroll; export CSV headers. *Verify:* `node scripts/qa/check-f16-browser.mjs --only B1-B6,B8` → "ok 7 scenarios" (F16-AC-07 browser half, F16-AC-10, F16-AC-11).

**Checkpoint:** full suite, build, browser scenarios. Completes F16-AC-10, 11.

### Phase 4 — Ahrefs DR (separately flagged)

**Goal:** the free DR column behind `backlinks_ahrefs_dr`, pending the owner's terms-of-use check.

- [x] **P4.T1 Ahrefs DR service, route and column**
  - [x] **P4.T1.S1** *Files:* `src/lib/backlinks/ahrefsDomainRating.ts`, `ahrefsDomainRating.test.ts`, fixtures `ahrefs-dr.json`, `ahrefs-dr-zero.json`. *Do:* §6.2.3 with injected `fetch` and memory cache. Tests: 101 domains → zod 400 at the route, service takes ≤ 100; `www.a.com` and `https://a.com` resolve once and fan out to both keys; at most 20 concurrent fetches (counter); 5 s timeout via fake timer → null, not cached, next call fetches again; DR 0 → null cached; second call within 24 h → zero fetches; every URL starts with `https://api.ahrefs.com/v3/public/domain-rating-free?target=`. *Verify:* `node --test src/lib/backlinks/ahrefsDomainRating.test.ts` → pass (F16-AC-09). *(BE 2026-11-14: 8/8 pass.)*
  - [x] **P4.T1.S2** *Files:* `src/app/api/customer/backlinks/ahrefs-dr/route.ts`, contract, `backlinks.route.test.mjs` (flag off → 404), `src/components/portal/backlinks/{useAhrefsDomainRatings.ts,BacklinksToolbarMenus.tsx,BacklinksPageSections.tsx,BacklinksTableColumns.tsx,ReferringDomainsTable.tsx}`, `scripts/qa/check-f16-browser.mjs` (B7: flag off → no menu item and no column; on → menu item, column fills, export gains "Ahrefs DR", failure toast). *Verify:* `node --test src/lib/backlinks/backlinks.route.test.mjs src/lib/http/routeContract.test.ts` → pass; `node scripts/qa/check-f16-browser.mjs --only B7` → "ok 1 scenario". *(BE half 2026-11-14: route + contract + 6 route-test additions green, `routeContract.test.ts` green; FE half pending — box left for coordinator.)* *(FE 2026-11-14: hook + actions menu + DR columns/export/footnote + B7 green; full browser B1-B8 "ok 9 scenarios"; `npm run build` + `typecheck` green. Wiring lives in `BacklinksPageSections.tsx` — §8 file list omits the wiring site, see FE handoff SPEC GAP.)* *(CTO 2026-11-14: APPROVE — wiring file accepted as minimal fix (spec deviation #1); S2 file list updated to include `BacklinksPageSections.tsx`.)*

**Checkpoint:** full suite, build, browser B7. Completes F16-AC-09.

### Phase 5 — Tracked backlink history (optional; requires F10 phase 1 merged)

**Goal:** opt-in snapshots of the workspace's site and competitors, free to read.

- [ ] **P5.T1 Database**
  - [ ] **P5.T1.S1** *Files:* `supabase/migrations/115_f16_backlink_snapshots.sql`. *Do:* §6.1 verbatim. *Verify:* loopback `_qa` database, all migrations applied twice → exit 0.
  - [ ] **P5.T1.S2** *Files:* `scripts/setup-supabase.mjs` (`EXPECTED_OBJECTS` entry), `tests/customer-uat.sql` (§6.1 block). *Verify:* `node --test src/lib/migrationsRunner.test.mjs src/lib/migrationsLedger.test.mjs` → pass; CI customer-database commands against local Postgres 16 → exit 0.
  - [ ] **P5.T1.S3** *Files:* `README.md` (migration row), `docs/OPERATOR_LEDGER.md` § C ("apply 115 before deploying F16 phase 5"), `docs/PROD_MIGRATIONS.md` (one bullet: two tables, cap trigger, prune function). *Verify:* `node --test src/lib/docStatus.test.mjs src/lib/migrationsRunner.test.mjs` → pass.
  - [ ] **P5.T1.S4** *Files:* `scripts/qa/check-f16-db.mjs` (loopback `_qa`). Groups: `schema`, `rls` (member reads own rows only), `caps` (21st enabled target raises; disabling one allows another), `snapshots` (one per target/scope/day; `lookup` insert ignored on conflict), `retention` (rows older than 25 months pruned, newer kept). *Verify:* `node scripts/qa/check-f16-db.mjs` → "ok 5 groups" (F16-AC-12, 13 DB half, 14 retention).
- [ ] **P5.T2 Server**
  - [ ] **P5.T2.S1** *Files:* `src/lib/backlinks/snapshots.ts`, `snapshots.test.ts`, `src/lib/backlinks/jobs.ts` (periodics and `backlinks.snapshots_tick`), `src/lib/jobs/kinds.ts` (one import), `src/lib/pricing/actions/backlinks.ts` (`backlinks.snapshots.track`). *Do:* §6.3. Tests with F01 memory jobs/spend and F10 `runDueSchedules`: weekly target due → advance first, one billed summary with feature `backlinks.snapshots` and the target's `maxUsd`, snapshot inserted; flag off → `snapshots_disabled` recorded and advanced; price above approval → `price_changed`; `SpendRefused` → its reason; three missed weeks → one capture; a failed capture → `start_failed` and the next target still runs; lookup snapshot only for tracked targets and once per day. *Verify:* `node --test src/lib/backlinks/snapshots.test.ts` → pass (F16-AC-13).
  - [ ] **P5.T2.S2** *Files:* `src/app/api/customer/backlinks/snapshot-targets/route.ts` (GET, POST), `snapshot-targets/[targetId]/route.ts` (DELETE), `snapshots/route.ts` (GET), overview route (`tracked`, `recordLookupSnapshot`), contracts, `src/lib/backlinks/tools.ts` (`get_backlink_history`), `backlinks.route.test.mjs` (member POST → 403 `owner_required`; without `maxUsd` → 400 `approval_required`; duplicate → 409 `already_tracked`; flag off → 404). *Verify:* `node --test src/lib/backlinks/backlinks.route.test.mjs src/lib/http/routeContract.test.ts src/lib/backlinks/tools.test.ts` → pass.
- [ ] **P5.T3 UI**
  - [ ] **P5.T3.S1** *Files:* `src/components/portal/backlinks/{TrackHistoryControl,TrackedHistoryPanel,TrackedTargetsList}.tsx`, `hooks/{useSnapshotTargets,useSnapshots}.ts`, `BacklinksOverviewPanels.tsx`, `BacklinksPageContent.tsx`, `scripts/qa/check-f16-browser.mjs` (B9: owner tracks weekly via dialog with monthly projection; badge appears; tracked history chart from stored snapshots with a gap; stop tracking keeps the chart; member sees no "Track history"). *Verify:* `node scripts/qa/check-f16-browser.mjs --only B9` → "ok 1 scenario" (F16-AC-14).

**Checkpoint:** full suite, typecheck, build, `check-f16-db.mjs`, `check-f16-browser.mjs` (all scenarios), CI customer-database job. Completes F16-AC-12, 13, 14.

## 9. Test plan

| File | Cases | ACs |
|---|---|---|
| `src/lib/providers/dataforseo/backlinks.test.ts`, `backlinksTarget.test.ts` | ported target/summary cases, bodies, spam conditions, priced entries | 01, 02 |
| `src/shared/backlinks.test.ts` | ported client cases (spam zero vs missing, budgets, truncation, exports) | 10 |
| `src/lib/backlinks/backlinksApiFilters.test.ts` | ported | 05 |
| `src/lib/backlinks/backlinksService.test.ts` | six ported billing cases + §8 P2.T2.S3 list | 03, 04, 06, 08 |
| `src/lib/pricing/actions/backlinks.test.ts` | lines, warnings, blocks, snapshot projection | 07, 08, 13 |
| `src/lib/backlinks/ahrefsDomainRating.test.ts` | §8 P4.T1.S1 list | 09 |
| `src/lib/backlinks/snapshots.test.ts` | §8 P5.T2.S1 list | 13 |
| `src/lib/backlinks/tools.test.ts` | closed inputs, outputs | — |
| `src/lib/backlinks/backlinks.route.test.mjs` | flags, auth, strict bodies, cacheOnly, prices, isolation, owner-only tracking | 07, 09, 11, 13 |
| `scripts/qa/check-f16-db.mjs` | five groups | 12, 13, 14 |
| `tests/customer-uat.sql` | tenant reads, target cap | 12 |
| `scripts/qa/check-f16-browser.mjs` | B1–B9 | 07, 09, 10, 11, 14 |
| `scripts/qa/check-f16-live.mjs` (owner-run) | one overview (summary + history) and one 50-row page for a workspace-owned domain; refuses without `--brand <key> --max-spend-usd 0.15` and an enabled `backlinks.research` control; `--ahrefs` adds one DR lookup only when the owner passes it; prints counts and ledger rows only | — |

Fixtures: `tests/fixtures/f16/` as in §6.4, synthetic, never recorded in CI.

## 10. Rollout and rollback

- **Env (names only):** `FEATURE_BACKLINKS`, `FEATURE_BACKLINKS_BRANDS`, `FEATURE_BACKLINKS_AHREFS_DR`, `FEATURE_BACKLINKS_AHREFS_DR_BRANDS`, `FEATURE_BACKLINK_SNAPSHOTS`, `FEATURE_BACKLINK_SNAPSHOTS_BRANDS`.
- **Defaults:** all off in production; no `paid_feature_controls` rows for `backlinks.research` or `backlinks.snapshots`.
- **Migration order:** 115 (phase 5 only), after F01 (040–044), F09 (080) and F10's migrations.
- **Owner enabling:** enable `backlinks.research` for an allowlisted workspace in `/ops/costs` with a daily cap (suggested $3) and `maxCallUsd` $0.10; set `FEATURE_BACKLINKS=allowlist` with the brand key; run `scripts/qa/check-f16-live.mjs` if wanted. Ahrefs DR: only after the terms-of-use check (§11 #1), set `FEATURE_BACKLINKS_AHREFS_DR`. Snapshots: apply 115, enable `backlinks.snapshots` and `FEATURE_BACKLINK_SNAPSHOTS`.
- **Turn off:** set the flag `off` (Ahrefs DR can be switched off alone); disabling `backlinks.snapshots` makes the tick record `feature_disabled` and keep advancing.
- **Cleanup (owner request only):** `drop table backlink_snapshots, backlink_snapshot_targets cascade;` and the two functions; delete provider-cache rows with namespaces `backlinks.overview`, `backlinks.rows_page`, `backlinks.referring_domains_page`, `backlinks.top_pages_page`, `backlinks.ahrefs_dr`.

## 11. Risks and open questions

| # | Risk or question | Default chosen |
|---|---|---|
| 1 | **Owner question: Ahrefs' terms of use** for calling the free public Domain Rating endpoint from a commercial product, caching results for 24 h and showing them to customers have not been checked. | Ship behind its own flag `backlinks_ahrefs_dr`, off everywhere; the owner enables it only after reading Ahrefs' terms (or asking Ahrefs). Removing the sub-feature is deleting one route, one service and one column. |
| 2 | Workspace-scoped caching makes tenants pay twice for the same site. | Accept for privacy; one constant to change. |
| 3 | Every page, sort, filter or domain expansion is a paid call (about $0.026). | Cost hints, 6 h cache, live mode; per-feature caps in F01. |
| 4 | `history/live` and summary numbers differ in scope (history always includes subdomains). | Labelled as OpenSEO ("Last year · Includes subdomains"); tracked snapshots (P5) give a true per-scope history. |
| 5 | Snapshots add recurring spend. | Owner-only, price-approved per target with a monthly projection, capped at 20 targets, skip reasons visible. |
| 6 | F21's link-prospecting skill needs more than these tools (contact discovery). | Out of scope here; F21 composes F16's tools with others. |
| 7 | README lists F16 as depending only on F02 and F06, but it needs F13 phase 1's shared research primitives. | Requested README change: F16 depends on F13 (phase 1). |

## 12. Definition of done

- [ ] Phases 1–4 merged (phase 5 when the owner wants history); every subtask ticked here.
- [ ] F16-AC-01…11 (and 12–14 with phase 5) covered by passing tests (§9).
- [ ] Full suite, `npm run typecheck`, `npm run build`, `node scripts/qa/check-f16-browser.mjs` green; with phase 5 also `check-f16-db.mjs` and the CI customer-database job.
- [ ] Migration paperwork for 115 (README, OPERATOR_LEDGER § C, PROD_MIGRATIONS) and `THIRD_PARTY_NOTICES.md` updated.
- [ ] `features/README.md` status for F16 updated.
- [ ] Owner-run live check result (if run) and the Ahrefs terms decision recorded.

# F07 — Project memory

> <!-- doc-status -->
> **Status: LIVE.** Implementation spec. Not built yet.

| Field | Value |
|---|---|
| ID | F07 |
| Wave | 1 |
| Comparison rows covered | "Project memory" (OpenSEO: business overview, goal, positioning, competitors, key pages and research log, edited by users and agents. Perceev: brand briefs and knowledge exist, operator-only) |
| Depends on | F01 (merged): `requireWorkspace`, `AppError`/`toErrorResponse`, `isFeatureEnabled`, `defineJob`/`definePeriodic`, route-contract harness. Phase 3 (UI) also needs F04 and F05 merged. |
| Blocks | F08 (setup reads missing fields and writes reviewed competitors and the overview here), F22 (assistant reads and writes memory through the tools in §6.2), F27 (onboarding), F13 (writes research-log entries) |
| Reserved migrations | 070–074. **070** `070_f07_project_memory.sql`. 071–074 unused. |
| Feature flag | `FEATURE_PROJECT_MEMORY` (feature name `project_memory`, spend `[]`): page, routes and sidebar item. `FEATURE_PROJECT_MEMORY_CONTENT` (name `project_memory_content`, spend `[]`): Content Studio reads memory (§6.2.6). Both in `CLIENT_FEATURES` only for `project_memory`. |
| Spend features | none (memory is free; it records other features' paid research) |
| OpenSEO reference | `openseo:src/db/project-context.schema.ts`, `openseo:src/types/schemas/projectContext.ts`, `openseo:src/serverFunctions/projectContext.ts`, `openseo:src/serverFunctions/projectWebsite.ts`, `openseo:src/server/features/project-context/{services,repositories}/*`, `openseo:src/server/features/projects/{services,repositories}/ProjectWebsite*.ts`, `openseo:src/client/features/projects/project-context/*` at `c5f8db1` |

## 1. Summary

Every workspace gets one shared memory: what the business sells and to whom, the current goal, positioning, writing preferences, free-form custom sections, declared competitors, a shortlist of key pages and a 90-day research log. Customers edit it at `/portal/context`; question setup (F08), the assistant (F22) and Content Studio read it, and F08/F13 append what paid research they bought so it is not bought twice. Memory stores declared competitors for those readers; it does **not** change how scans extract or roster competitors.

## 2. What OpenSEO does (observed)

1. **Data model.** Prose lives in `project_context_sections` with primary key `(project_id, key)`; `key` is a typed key or `custom:<slug>`, with `title` only for custom sections (`openseo:src/db/project-context.schema.ts:17-38`). `updated_by` is `user | sam | mcp` (`:33`).
2. Competitors: one row per normalised bare host, unique `(project_id, domain)`, with optional `name` and `notes` (`:40-63`).
3. Key pages: "a curated shortlist of pages that matter, NOT a page inventory"; `role` is `hub | spoke | money | other`, with `topic` and `notes`, unique `(project_id, url)` (`:65-89`).
4. Research log: "what research has already been bought and what it concluded"; the entry date is a server-stamped day, pruned to 90 days on append; `created_at` is ISO for ordering (`:91-118`).
5. **Wire vocabulary.** Typed keys `business_overview, current_goal, positioning, writing_preferences` and their labels (`openseo:src/types/schemas/projectContext.ts:7-28`); `PROSE_MAX_CHARS = 4000` (`:30-31`); roles (`:33`); authors (`:37`); custom slug `^[a-z0-9]+(?:-[a-z0-9]+)*$`, max 60 (`:41-52`); competitor input domain ≤ 255, name ≤ 120, notes ≤ 500 (`:56-60`); key-page input with an optional role that keeps the stored one when omitted (`:62-69`); a strict-object union of patch ops (`:71-110`); 1–50 updates per call (`:118-121`).
6. **Service.** `getProjectContext` returns typed sections in declared order, `missingSections`, `customSections`, competitors, key pages and the newest 20 research-log entries (`openseo:src/server/features/project-context/services/ProjectContextService.ts:17-18`, `:67-123`).
7. `applyContextUpdates` resolves and caps the whole batch first, then writes in one atomic batch, so a rejected op writes nothing; appending a log entry stamps the day and prunes past 90 days (`:130-228`).
8. `renderProjectContextMarkdown` is the one digest for agents: typed sections always listed (`_Empty_` when missing), custom sections, competitors, key pages, a research-log heading that counts entries and says when older ones are omitted, and a final `Missing sections:` line (`:230-331`).
9. **Batch resolution.** Caps: 20 custom sections, 100 competitors, 100 key pages (`openseo:src/server/features/project-context/services/contextUpdateOps.ts:42-44`); prose over 4,000 characters is rejected with "Summarize instead of pasting" (`:46-53`); repeats within one op collapse to the last (`:55-60`); an empty section clears it (`:109-123`); competitor domains are normalised like the project domain (`:158-181`); key-page URLs are forced to https without `www.` or fragment, keeping path and query (`:10-36`); caps count earlier ops of the same batch (`:96-104`, `:171-177`, `:203-209`); an error names the rejected op and says nothing was applied (`:236-249`).
10. **Repository.** Upserts keep the stored title, name and notes when the caller omits them (`coalesce`), and an omitted key-page role keeps the stored role; new pages without a role get `other` (`openseo:src/server/features/project-context/repositories/ProjectContextRepository.ts:58-83`, `:107-136`, `:159-198`). Tests: `ProjectContextRepository.query.test.ts:79-156`.
11. **Domain normalisation.** Lowercase, add `https://` when no scheme, take the URL hostname, strip a leading `www.` (`openseo:src/server/lib/domainUtils.ts:32-50`, used through `openseo:src/server/lib/dataforseoBacklinksTarget.ts:34-58`).
12. **Server functions.** Read and patch through project middleware; everything from this entry point is written as `"user"` (`openseo:src/serverFunctions/projectContext.ts:9-28`).
13. **Website setup writes.** The overview is insert-only and competitors are inserted only when the project has none: "A saved competitor list is authoritative … Setup never edits that list" (`openseo:src/server/features/projects/services/ProjectWebsiteService.ts:72-91`; `openseo:src/server/features/projects/repositories/ProjectWebsiteRepository.ts:44-76`). Your own domain cannot be a competitor (`ProjectWebsiteService.ts:82-86`).
14. **UI.** Intro paragraph, then prose form, competitors, key pages, custom sections, research log (`openseo:src/client/features/projects/project-context/ProjectContextPage.tsx:57-97`). Section hints and placeholders (`:30-46`); only touched fields are pinned as drafts so agent writes show on refetch (`:109-149`); empty-state copy (`:153-160`, `:236-242`, `:364-370`); `staleTime: 0` (`:49-55`). One shared mutation writes the returned context into the cache, toasts "Project context updated" and invalidates on settle (`openseo:src/client/features/projects/project-context/shared.tsx:20-45`); provenance line "Updated by {author} · {relative time}" (`:47-61`). Competitors and key pages use an editable list with inline forms and role labels "Hub page / Supporting page / Money page / Other" (`CompetitorsSection.tsx:41-75`, `KeyPagesSection.tsx:20-29`, `:70-100`).
15. **Tests.** Typed vs custom split and missing sections; empty clears; URL and domain canonicalisation; caps including "counts earlier ops" and "writes nothing when a later op is rejected"; server-stamped date and 90-day prune; "says so when the research log is rendered at its limit" (`ProjectContextService.test.ts:58-330`).

## 3. What Perceev has today

- **Brand briefs** (`supabase/migrations/002_content_os.sql:48-54`): one `brand_briefs.brief` jsonb per brand (`one_liner, vertical, personas, priority_topics, money_pages, competitors, tone_rules, platforms, win_definition`). The operator route `src/app/api/brand-briefs/route.js` reads and writes it. Content jobs call `resolveBrief(brand, input)` (`src/lib/content/contentWorker.js:185-216`), which returns the stored brief or seeds a preset. The customer content route passes `ctx.brand.brandKey` as the brand (`src/app/api/customer/content/route.js:54`), so a customer workspace's brief row is keyed by its `brand_key`. Regression: `src/lib/content/brandBriefRegression.test.mjs`.
- **Knowledge blocks** (`supabase/migrations/004_crew_canvas_knowledge.sql:16-27`): `url | snippet | banned_claims | glossary` context for content agents, operator-gated `src/app/api/knowledge/route.js`.
- **Brand names for matching**: `customer_brands.display_name`, `website`, `aliases text[]` (`supabase/migrations/023_customer_auth_and_tenant_rls.sql:5-16`), turned into match aliases by `getBrandAliases(brand, website)` (`src/lib/scoring/aliases.js:93`). Editing aliases is operator-only.
- **Competitors on the tracking side**: extracted from answers (`extractCompetitors`, `src/lib/scoring/competitorExtract.js:92`), carried forward when extraction is unavailable (`src/lib/scoring/rosterContinuity.js:24-78`), or configured per scan through the `competitors` string in `POST /api/customer/scan` (`src/app/api/customer/scan/route.js:32`). The customer cannot add or remove competitors. This is the deferred Mixed row **"Competitors (tracking side)"**.
- **Missing:** any customer-editable business overview, goal, positioning, competitor list, key pages or research log, and any memory an assistant or setup flow can read and write.
- **Must not break:** content brief resolution and `brandBriefRegression.test.mjs`; scan competitor extraction and roster continuity; tenant RLS tests in `tests/customer-uat.sql`.

## 4. Target behaviour and acceptance criteria

| ID | Statement | Verified by |
|---|---|---|
| F07-AC-01 | Migration 070 creates `project_context_sections`, `project_competitors`, `project_key_pages`, `project_research_log` and `project_memory_state` with RLS; a member reads only their workspace's rows; anon reads nothing; customers cannot write directly. | DB `scripts/qa/check-f07-db.mjs` group `rls`; `tests/customer-uat.sql` |
| F07-AC-02 | A prose section over 4,000 characters is refused with `400 context_invalid` "updates[i] was rejected (nothing in this batch was applied): Sections are capped at 4,000 characters. Summarize instead of pasting." An empty section deletes the row and the key appears in `missingSections`. | unit `src/lib/projectContext/contextUpdateOps.test.ts` |
| F07-AC-03 | Custom sections use slug `^[a-z0-9]+(-[a-z0-9]+)*$` (≤ 60) and are stored as `custom:<slug>`; a 21st is refused; re-using a slug edits it. | unit `contextUpdateOps.test.ts` |
| F07-AC-04 | Competitor domains are normalised (`https://www.Acme.com/pricing` → `acme.com`); repeats in one op collapse to the last; the workspace's own host is refused with "Your own website cannot be a competitor." | unit `contextUpdateOps.test.ts` |
| F07-AC-05 | Caps of 100 competitors and 100 key pages count earlier ops in the same batch; an entry already stored at the cap can still be updated. The SQL function re-checks every cap and rolls the whole batch back when one is exceeded. | unit `contextUpdateOps.test.ts`; DB group `atomic` |
| F07-AC-06 | Upserts keep stored `title`, `name`, `notes`, `topic` and `source_url` when the caller omits them; an omitted key-page role keeps the stored role; a new page without a role is `other`. | DB group `coalesce` |
| F07-AC-07 | Research-log entries get a server-stamped UTC `entry_date` (callers cannot supply one); entries older than 90 days are pruned on every append and by the daily `project_context.retention` job; reads return the newest 20; the digest says when older entries are omitted. | unit `src/lib/projectContext/service.test.ts`; DB group `research` |
| F07-AC-08 | `findRecentResearch(admin, { brandKey, kind, researchKey, days })` returns the newest entry of that kind whose normalised key matches within the window, or `null`. | unit `service.test.ts`; DB group `research` |
| F07-AC-09 | Writes record `updated_by` = `user` (routes, with `updated_by_user` = the caller), `assistant` (tool handler) or `system` (brief import, F08 setup writes made without a reviewer); the UI shows "Updated by you", "a teammate", "the assistant" or "Perceev". | route test; DB group `coalesce` |
| F07-AC-10 | `GET /api/customer/context` returns typed sections in declared order, `missingSections`, `customSections`, competitors, key pages, research log and `brandIdentity`; `PATCH` applies 1–50 updates and returns the new context; members and owners may edit; flag off → `404 feature_unavailable`. | route `src/lib/projectContext/context.route.test.mjs` |
| F07-AC-11 | On the first `GET` for a workspace whose memory is empty and whose `brand_briefs` row is not the auto-seeded preset, memory imports the brief (overview, writing preferences, priority topics, domain-shaped competitors, money pages) once, as `system`; later `GET`s never import again, even after the user deletes those rows. | unit `src/lib/projectContext/briefImport.test.ts`; DB group `import-once` |
| F07-AC-12 | Tracking isolation: `src/lib/workers/**`, `src/lib/scoring/**`, `src/lib/engines/**` and `src/app/api/customer/scan/**` import nothing from `src/lib/projectContext/`; `POST /api/customer/scan` still passes only the request body's `competitors` to `createScanJob`. | unit `src/lib/projectContext/trackingIsolation.test.mjs` |
| F07-AC-13 | `renderProjectContextMarkdown` matches OpenSEO's digest format: `# Project context`, typed sections always present (`_Empty_`), custom sections, `Competitors`, `Key pages`, `Research log (n entries)`, omission note at the limit, `Missing sections:` line. | unit `service.test.ts` |
| F07-AC-14 | With `project_memory_content` on for the workspace, `resolveBrief` returns the brief plus `project_memory` (the digest, ≤ 12,000 characters) and never persists it; with it off the returned brief is byte-identical to today. | unit `src/lib/projectContext/contentOverlay.test.ts`; existing `brandBriefRegression.test.mjs` |
| F07-AC-15 | Tool definitions `get_project_context` and `update_project_context` validate input and output with zod (closed inputs, loose outputs) and write as `assistant`. | unit `src/lib/projectContext/tools.test.ts` |
| F07-AC-16 | `/portal/context` shows loading, error (Retry), empty, saved and edited states with exact copy (§6.6); a save toasts "Context updated"; the sidebar item "Context" shows only when `project_memory` is on. | browser `scripts/qa/check-f07-browser.mjs` B1–B4 |
| F07-AC-17 | At 375 px wide the page has no horizontal scroll; every control is reachable by keyboard and labelled. | browser B5 |

## 5. Scope

**In scope:** migration 070; shared vocabulary; batch resolution and caps; repository and service; markdown digest; research-log API for other features; one-time import from brand briefs; customer routes; tool definitions for F21/F22; flagged Content Studio overlay; `/portal/context` page and sidebar entry; retention job.

**Out of scope:**
- **Competitors (tracking side)**, a deferred Mixed row. Memory stores declared competitors and exposes them to F08 setup, F22 and Content Studio. It must not feed `createScanJob({ competitors })`, `extractCompetitors`, `resolveCompetitorRoster`, `result_brands` or any metric. F07-AC-12 guards this.
- Editing brand aliases (`customer_brands.aliases`) or the legacy alias registry; the page only displays them.
- Changing or removing `brand_briefs`, `knowledge_blocks` or their operator routes.
- Assistant chat (F22), skills (F21), onboarding (F27), question setup itself (F08), keyword research (F13). They call this spec's service.
- Report templates (OpenSEO lists them in the digest, `ProjectContextService.ts:59-64`); F23 may add a section later.

## 6. Design

### 6.1 Data model

#### `supabase/migrations/070_f07_project_memory.sql`

```sql
-- F07: project memory. Additive. Writes only through apply_project_context_ops (service role).
CREATE OR REPLACE FUNCTION public.f07_touch_updated_at() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$ BEGIN NEW.updated_at := now(); RETURN NEW; END $$;

CREATE TABLE IF NOT EXISTS public.project_context_sections (
  brand_key text NOT NULL REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  key text NOT NULL CHECK (key ~ '^(business_overview|current_goal|positioning|writing_preferences|custom:[a-z0-9]+(-[a-z0-9]+)*)$'
                           AND length(key) <= 67),
  title text CHECK (title IS NULL OR length(title) BETWEEN 1 AND 120),
  content text NOT NULL CHECK (length(content) BETWEEN 1 AND 4000),
  updated_by text NOT NULL CHECK (updated_by IN ('user','assistant','system')),
  updated_by_user uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (brand_key, key),
  CHECK (title IS NULL OR key LIKE 'custom:%')
);
COMMENT ON TABLE public.project_context_sections IS 'F07 prose memory: typed sections or custom:<slug>. Port of OpenSEO project_context_sections.';

CREATE TABLE IF NOT EXISTS public.project_competitors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_key text NOT NULL REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  domain text NOT NULL CHECK (domain = lower(domain) AND length(domain) BETWEEN 3 AND 255
    AND domain ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$' AND domain !~ '^www\.'),
  name text CHECK (name IS NULL OR length(name) BETWEEN 1 AND 120),
  notes text CHECK (notes IS NULL OR length(notes) <= 500),
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','setup_research','assistant','brief_import')),
  source_url text CHECK (source_url IS NULL OR length(source_url) <= 2048),
  updated_by text NOT NULL CHECK (updated_by IN ('user','assistant','system')),
  updated_by_user uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (brand_key, domain)
);
COMMENT ON COLUMN public.project_competitors.source_url IS 'Page actually read when setup research proposed this competitor (F08). Declared list only; never used by scan roster extraction.';

CREATE TABLE IF NOT EXISTS public.project_key_pages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_key text NOT NULL REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  url text NOT NULL CHECK (length(url) BETWEEN 9 AND 2048 AND url ~ '^https://' AND position('#' in url) = 0),
  role text NOT NULL DEFAULT 'other' CHECK (role IN ('hub','spoke','money','other')),
  topic text CHECK (topic IS NULL OR length(topic) BETWEEN 1 AND 200),
  notes text CHECK (notes IS NULL OR length(notes) <= 500),
  updated_by text NOT NULL CHECK (updated_by IN ('user','assistant','system')),
  updated_by_user uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (brand_key, url)
);
COMMENT ON TABLE public.project_key_pages IS 'Curated shortlist of pages that matter (hub, spoke, money), not a page inventory.';

CREATE TABLE IF NOT EXISTS public.project_research_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_key text NOT NULL REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  entry_date date NOT NULL DEFAULT ((now() AT TIME ZONE 'UTC')::date),
  kind text NOT NULL DEFAULT 'note' CHECK (kind = 'note' OR kind ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  research_key text CHECK (research_key IS NULL OR length(research_key) BETWEEN 1 AND 300),
  summary text NOT NULL CHECK (length(summary) BETWEEN 1 AND 1000),
  spend_usd numeric(12,6) CHECK (spend_usd IS NULL OR spend_usd >= 0),
  job_id uuid,
  created_by text NOT NULL CHECK (created_by IN ('user','assistant','system')),
  created_by_user uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
COMMENT ON COLUMN public.project_research_log.kind IS 'Spend feature that bought the research (e.g. questions.setup), or note.';
COMMENT ON COLUMN public.project_research_log.research_key IS 'Normalised input (keyword, domain) so a repeat purchase within 90 days can be detected.';
CREATE INDEX IF NOT EXISTS project_research_log_recent_idx ON public.project_research_log (brand_key, created_at DESC);
CREATE INDEX IF NOT EXISTS project_research_log_lookup_idx
  ON public.project_research_log (brand_key, kind, research_key, created_at DESC) WHERE research_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.project_memory_state (
  brand_key text PRIMARY KEY REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  brief_import_checked_at timestamptz,
  brief_imported boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS project_context_sections_touch ON public.project_context_sections;
CREATE TRIGGER project_context_sections_touch BEFORE UPDATE ON public.project_context_sections
  FOR EACH ROW EXECUTE FUNCTION public.f07_touch_updated_at();
DROP TRIGGER IF EXISTS project_competitors_touch ON public.project_competitors;
CREATE TRIGGER project_competitors_touch BEFORE UPDATE ON public.project_competitors
  FOR EACH ROW EXECUTE FUNCTION public.f07_touch_updated_at();
DROP TRIGGER IF EXISTS project_key_pages_touch ON public.project_key_pages;
CREATE TRIGGER project_key_pages_touch BEFORE UPDATE ON public.project_key_pages
  FOR EACH ROW EXECUTE FUNCTION public.f07_touch_updated_at();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['project_context_sections','project_competitors','project_key_pages',
                           'project_research_log','project_memory_state'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
    EXECUTE format('DROP POLICY IF EXISTS f07_member_read ON public.%I', t);
    EXECUTE format('CREATE POLICY f07_member_read ON public.%I FOR SELECT TO authenticated USING (public.customer_can_access_brand(brand_key))', t);
  END LOOP;
END $$;

-- Applies an already-resolved batch (src/lib/projectContext/contextUpdateOps.ts) in one transaction.
-- Caps are re-checked after all ops; any violation raises and rolls the whole batch back.
CREATE OR REPLACE FUNCTION public.apply_project_context_ops(p_brand text, p_ops jsonb, p_author text, p_actor uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SET search_path = public AS $$
DECLARE op jsonb; r jsonb; v_kind text; v_applied integer := 0;
  v_today date := (now() AT TIME ZONE 'UTC')::date;
BEGIN
  IF p_author IS NULL OR p_author NOT IN ('user','assistant','system') THEN RAISE EXCEPTION 'project_memory_invalid:author'; END IF;
  IF jsonb_typeof(p_ops) IS DISTINCT FROM 'array' OR jsonb_array_length(p_ops) NOT BETWEEN 1 AND 60 THEN
    RAISE EXCEPTION 'project_memory_invalid:ops'; END IF;
  IF NOT EXISTS (SELECT 1 FROM customer_brands WHERE brand_key = p_brand AND is_active) THEN
    RAISE EXCEPTION 'project_memory_invalid:brand'; END IF;
  IF p_actor IS NOT NULL AND NOT EXISTS (SELECT 1 FROM customer_brand_memberships WHERE brand_key = p_brand AND user_id = p_actor) THEN
    RAISE EXCEPTION 'project_memory_invalid:actor'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('f07:memory:' || p_brand));
  FOR op IN SELECT value FROM jsonb_array_elements(p_ops) LOOP
    v_kind := op->>'kind';
    IF v_kind = 'upsert_section' THEN
      INSERT INTO project_context_sections(brand_key, key, title, content, updated_by, updated_by_user)
      VALUES (p_brand, op->>'key', op->>'title', op->>'content', p_author, p_actor)
      ON CONFLICT (brand_key, key) DO UPDATE SET title = coalesce(excluded.title, project_context_sections.title),
        content = excluded.content, updated_by = excluded.updated_by, updated_by_user = excluded.updated_by_user;
    ELSIF v_kind = 'insert_section_if_missing' THEN
      INSERT INTO project_context_sections(brand_key, key, title, content, updated_by, updated_by_user)
      VALUES (p_brand, op->>'key', op->>'title', op->>'content', p_author, p_actor) ON CONFLICT DO NOTHING;
    ELSIF v_kind = 'delete_section' THEN
      DELETE FROM project_context_sections WHERE brand_key = p_brand AND key = op->>'key';
    ELSIF v_kind IN ('upsert_competitors','insert_competitors_if_none') THEN
      IF v_kind = 'upsert_competitors' OR NOT EXISTS (SELECT 1 FROM project_competitors WHERE brand_key = p_brand) THEN
        FOR r IN SELECT value FROM jsonb_array_elements(op->'rows') LOOP
          INSERT INTO project_competitors(brand_key, domain, name, notes, source, source_url, updated_by, updated_by_user)
          VALUES (p_brand, r->>'domain', r->>'name', r->>'notes', coalesce(r->>'source','manual'), r->>'source_url', p_author, p_actor)
          ON CONFLICT (brand_key, domain) DO UPDATE SET name = coalesce(excluded.name, project_competitors.name),
            notes = coalesce(excluded.notes, project_competitors.notes),
            source_url = coalesce(excluded.source_url, project_competitors.source_url),
            updated_by = excluded.updated_by, updated_by_user = excluded.updated_by_user;
        END LOOP;
      END IF;
    ELSIF v_kind = 'delete_competitors' THEN
      DELETE FROM project_competitors WHERE brand_key = p_brand
        AND domain IN (SELECT jsonb_array_elements_text(op->'domains'));
    ELSIF v_kind = 'upsert_key_pages' THEN
      FOR r IN SELECT value FROM jsonb_array_elements(op->'rows') LOOP
        INSERT INTO project_key_pages(brand_key, url, role, topic, notes, updated_by, updated_by_user)
        VALUES (p_brand, r->>'url', coalesce(r->>'role','other'), r->>'topic', r->>'notes', p_author, p_actor)
        ON CONFLICT (brand_key, url) DO UPDATE SET
          role = CASE WHEN r->>'role' IS NULL THEN project_key_pages.role ELSE excluded.role END,
          topic = coalesce(excluded.topic, project_key_pages.topic),
          notes = coalesce(excluded.notes, project_key_pages.notes),
          updated_by = excluded.updated_by, updated_by_user = excluded.updated_by_user;
      END LOOP;
    ELSIF v_kind = 'delete_key_pages' THEN
      DELETE FROM project_key_pages WHERE brand_key = p_brand AND url IN (SELECT jsonb_array_elements_text(op->'urls'));
    ELSIF v_kind = 'append_research_log' THEN
      INSERT INTO project_research_log(brand_key, entry_date, kind, research_key, summary, spend_usd, job_id, created_by, created_by_user)
      VALUES (p_brand, v_today, coalesce(op->>'research_kind','note'), op->>'research_key', op->>'summary',
              (op->>'spend_usd')::numeric, (op->>'job_id')::uuid, p_author, p_actor);
      DELETE FROM project_research_log WHERE brand_key = p_brand AND entry_date < v_today - 90;
    ELSIF v_kind = 'delete_research_log' THEN
      DELETE FROM project_research_log WHERE brand_key = p_brand
        AND id IN (SELECT (jsonb_array_elements_text(op->'ids'))::uuid);
    ELSE
      RAISE EXCEPTION 'project_memory_invalid:kind';
    END IF;
    v_applied := v_applied + 1;
  END LOOP;
  IF (SELECT count(*) FROM project_context_sections WHERE brand_key = p_brand AND key LIKE 'custom:%') > 20 THEN
    RAISE EXCEPTION 'project_memory_cap:custom_sections'; END IF;
  IF (SELECT count(*) FROM project_competitors WHERE brand_key = p_brand) > 100 THEN
    RAISE EXCEPTION 'project_memory_cap:competitors'; END IF;
  IF (SELECT count(*) FROM project_key_pages WHERE brand_key = p_brand) > 100 THEN
    RAISE EXCEPTION 'project_memory_cap:key_pages'; END IF;
  RETURN jsonb_build_object('applied', v_applied);
END $$;

CREATE OR REPLACE FUNCTION public.claim_project_brief_import(p_brand text) RETURNS boolean
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v boolean;
BEGIN
  INSERT INTO project_memory_state(brand_key) VALUES (p_brand) ON CONFLICT DO NOTHING;
  UPDATE project_memory_state SET brief_import_checked_at = now()
   WHERE brand_key = p_brand AND brief_import_checked_at IS NULL RETURNING true INTO v;
  RETURN coalesce(v, false);
END $$;

CREATE OR REPLACE FUNCTION public.prune_project_research_log(p_before date, p_limit integer DEFAULT 5000)
RETURNS integer LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v integer;
BEGIN
  WITH old AS (SELECT id FROM project_research_log WHERE entry_date < p_before ORDER BY entry_date LIMIT p_limit)
  DELETE FROM project_research_log l USING old WHERE l.id = old.id;
  GET DIAGNOSTICS v = ROW_COUNT; RETURN v;
END $$;

REVOKE ALL ON FUNCTION public.apply_project_context_ops(text,jsonb,text,uuid),
  public.claim_project_brief_import(text), public.prune_project_research_log(date,integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_project_context_ops(text,jsonb,text,uuid),
  public.claim_project_brief_import(text), public.prune_project_research_log(date,integer) TO service_role;
NOTIFY pgrst, 'reload schema';
```

`scripts/setup-supabase.mjs` required objects: `"070_f07_project_memory.sql": [{kind:"table",name:"project_context_sections"},{kind:"table",name:"project_competitors"},{kind:"table",name:"project_key_pages"},{kind:"table",name:"project_research_log"},{kind:"table",name:"project_memory_state"},{kind:"function",name:"apply_project_context_ops"},{kind:"function",name:"claim_project_brief_import"},{kind:"function",name:"prune_project_research_log"}]`. `tests/customer-uat.sql`: one section, competitor, key page and log entry per tenant workspace; each user reads exactly their own (4 rows). Retention: research log 90 days (`project_context.retention`, §6.3). Other tables hold one bounded set per workspace (caps) and need no retention.

### 6.2 Server modules

All files under `src/lib/**` use relative imports with explicit extensions (conventions §5.4). Licence header on every PORT/COPY file.

#### 6.2.1 `src/shared/project-context.ts` (PORT of `openseo:src/types/schemas/projectContext.ts`)

```ts
export const PROJECT_CONTEXT_SECTION_KEYS = ["business_overview","current_goal","positioning","writing_preferences"] as const;
export type ProjectContextSectionKey = typeof PROJECT_CONTEXT_SECTION_KEYS[number];
export const PROJECT_CONTEXT_SECTION_LABELS: Record<ProjectContextSectionKey, string>;
  // "Business overview", "Current goal", "Positioning", "Writing preferences"
export const PROJECT_CONTEXT_SECTION_HINTS: Record<ProjectContextSectionKey, string>;   // §6.6 copy
export const PROJECT_CONTEXT_SECTION_PLACEHOLDERS: Record<ProjectContextSectionKey, string>; // §6.6 copy
export const PROSE_MAX_CHARS = 4000;
export const CUSTOM_SECTION_KEY_PREFIX = "custom:";
export const KEY_PAGE_ROLES = ["hub","spoke","money","other"] as const;
export type KeyPageRole = typeof KEY_PAGE_ROLES[number];
export const KEY_PAGE_ROLE_LABELS: Record<KeyPageRole, string>; // "Hub page","Supporting page","Money page","Other"
export const CONTEXT_AUTHORS = ["user","assistant","system"] as const;
export type ContextAuthor = typeof CONTEXT_AUTHORS[number];
export const MAX_CUSTOM_SECTIONS = 20, MAX_COMPETITORS = 100, MAX_KEY_PAGES = 100;
export const RESEARCH_LOG_RETENTION_DAYS = 90, RESEARCH_LOG_LIMIT = 20;
export const customSectionSlugSchema: z.ZodString;   // trim, max 60, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, message "Use a lowercase slug like 'launch-plan'"
export const projectContextUpdateSchema;              // z.union of z.strictObject, exactly OpenSEO's 9 members (:76-110),
  // with appendResearchLog extended to { summary: string(1..1000), kind?: string (spend-feature regex or "note"), researchKey?: string(1..300) }
export type ProjectContextUpdate = z.infer<typeof projectContextUpdateSchema>;
export const updateProjectContextBody = z.strictObject({ brand_key: z.string().min(1).max(200).optional(),
  updates: z.array(projectContextUpdateSchema).min(1).max(50) });
export const projectContextSchema;                    // z.looseObject response, see §6.5
export type ProjectContext = z.infer<typeof projectContextSchema>;
```

#### 6.2.2 `src/lib/projectContext/normalize.ts`

```ts
export function normalizeCompetitorDomain(raw: string): string;   // PORT domainUtils.ts:32-50 (lowercase, add https://, URL hostname, strip ^www.)
  // throws AppError(400,"context_invalid","Not a valid website: <raw>") when the host has no dot, is an IP literal, or URL parsing fails
export function normalizeKeyPageUrl(raw: string): string;          // COPY contextUpdateOps.ts:16-36 (https, no www, no fragment, keeps path+query; bare host has no trailing slash)
export function normalizeResearchKey(raw: string): string;         // NFKC, trim, collapse whitespace, lowercase; ≤ 300 chars
```

#### 6.2.3 `src/lib/projectContext/contextUpdateOps.ts` (PORT of `contextUpdateOps.ts`)

```ts
export type ResolvedOp =
  | { kind: "upsert_section" | "insert_section_if_missing"; key: string; title: string | null; content: string }
  | { kind: "delete_section"; key: string }
  | { kind: "upsert_competitors" | "insert_competitors_if_none"; rows: { domain: string; name: string | null; notes: string | null; source: "manual"|"setup_research"|"assistant"|"brief_import"; source_url: string | null }[] }
  | { kind: "delete_competitors"; domains: string[] }
  | { kind: "upsert_key_pages"; rows: { url: string; role: KeyPageRole | null; topic: string | null; notes: string | null }[] }
  | { kind: "delete_key_pages"; urls: string[] }
  | { kind: "append_research_log"; summary: string; research_kind: string; research_key: string | null; spend_usd: number | null; job_id: string | null }
  | { kind: "delete_research_log"; ids: string[] };
export function resolveContextUpdates(updates: ProjectContextUpdate[],
  current: { customKeys: Set<string>; domains: Set<string>; urls: Set<string>; ownHost: string },
  opts?: { competitorSource?: "manual" | "assistant" }): ResolvedOp[];
```

Behaviour is OpenSEO's (§2 item 9) with three additions: (a) a competitor whose normalised domain equals `ownHost` (the workspace's `website_host` with `www.` stripped) throws "Your own website cannot be a competitor." (OpenSEO applies this only at setup, `ProjectWebsiteService.ts:82-86`; we apply it everywhere); (b) `appendResearchLog.kind` defaults to `"note"`, and `researchKey` is passed through `normalizeResearchKey`; (c) errors are `AppError(400, "context_invalid", "updates[<i>] was rejected (nothing in this batch was applied): <message>", { details: { index: i } })`. Cap messages (exact): "A workspace can hold 20 custom sections. Delete one first.", "A workspace can track 100 competitors. Remove some first.", "A workspace can hold 100 key pages. This is a shortlist, not a page inventory.", "Sections are capped at 4,000 characters. Summarize instead of pasting."

#### 6.2.4 `src/lib/projectContext/repository.ts`

```ts
export function createProjectContextRepository(admin: SupabaseClient): {
  listSections(brandKey: string): Promise<SectionRow[]>;            // order by key
  listCompetitors(brandKey: string): Promise<CompetitorRow[]>;      // order by domain
  listKeyPages(brandKey: string): Promise<KeyPageRow[]>;            // order by url
  listResearchLog(brandKey: string, limit: number): Promise<ResearchRow[]>; // order by created_at desc
  findRecentResearch(brandKey: string, kind: string, researchKey: string, since: string /* YYYY-MM-DD */): Promise<ResearchRow | null>;
  applyOps(brandKey: string, ops: ResolvedOp[], author: ContextAuthor, actor: string | null): Promise<{ applied: number }>;
  claimBriefImport(brandKey: string): Promise<boolean>;
  markBriefImported(brandKey: string): Promise<void>;
  getBrandBrief(brandKey: string): Promise<Record<string, unknown> | null>;  // brand_briefs.brief where brand = brandKey
};
```

`applyOps` calls `rpc("apply_project_context_ops", { p_brand, p_ops, p_author, p_actor })`. Postgres errors map: message starting `project_memory_cap:competitors|key_pages|custom_sections` → `AppError(400,"context_cap", <matching cap message>)`; `project_memory_invalid:*` → `AppError(400,"context_invalid","These changes could not be applied.")`; any other → `AppError(503,"context_unavailable","Context could not be saved. Please retry.")`. `src/lib/projectContext/memoryRepository.ts` implements the same interface in memory (same coalesce, cap and prune semantics) for unit tests.

#### 6.2.5 `src/lib/projectContext/service.ts` (PORT of `ProjectContextService.ts`)

```ts
export type ProjectContextDeps = { repo?: ProjectContextRepository; now?: () => Date };
export async function getProjectContext(admin: SupabaseClient, brand: { brandKey: string; display_name: string; website: string; website_host: string; aliases: string[] }, deps?): Promise<ProjectContext>;
export async function applyContextUpdates(admin: SupabaseClient, brand: {...same}, updates: ProjectContextUpdate[],
  author: ContextAuthor, actorUserId: string | null, deps?): Promise<ProjectContext>;
export async function applyResolvedOps(admin: SupabaseClient, brandKey: string, ops: ResolvedOp[], author: ContextAuthor,
  actorUserId: string | null, deps?): Promise<void>;   // used by F08 setup save (insert_*_if_* ops)
export async function appendResearch(admin: SupabaseClient, i: { brandKey: string; kind: string; researchKey?: string;
  summary: string; spendUsd?: number | null; jobId?: string | null; author: ContextAuthor; actorUserId?: string | null }, deps?): Promise<void>;
export async function findRecentResearch(admin: SupabaseClient, i: { brandKey: string; kind: string; researchKey: string; days?: number /* default 90 */ }, deps?):
  Promise<{ id: string; entryDate: string; summary: string; spendUsd: number | null; createdAt: string } | null>;
export async function declaredCompetitors(admin: SupabaseClient, brandKey: string, deps?): Promise<{ domain: string; name: string | null; notes: string | null }[]>;
export function renderProjectContextMarkdown(context: ProjectContext): string;   // PORT :248-331, minus report templates
export async function maybeImportBrandBrief(admin: SupabaseClient, brand: {...}, deps?): Promise<boolean>;
```

- `getProjectContext` first calls `maybeImportBrandBrief` (§6.2.7), then reads the four lists in parallel and builds the response (§6.5). `missingSections` lists typed keys with no row. `brandIdentity = { displayName, website, matchNames: unique([display_name, ...aliases]) }`.
- `applyContextUpdates` reads current custom keys, domains and URLs, calls `resolveContextUpdates(..., { ownHost: brand.website_host.replace(/^www\./,"") })`, then `repo.applyOps` once, then returns `getProjectContext` (no import attempt on this path).
- `appendResearch` resolves one `appendResearchLog` op and applies it. `findRecentResearch` computes `since = UTC date of now − days` and normalises the key.

#### 6.2.6 Content overlay `src/lib/projectContext/contentOverlay.ts`

```ts
export const PROJECT_MEMORY_BRIEF_MAX_CHARS = 12_000;
export function withProjectMemory(brief: Record<string, unknown>, markdown: string): Record<string, unknown>;
  // returns { ...brief, project_memory: markdown.slice(0, 12000) }; never mutates its input
```

`src/lib/content/contentWorker.js` `resolveBrief(brand, input, deps)`: after computing the brief it returns, when `await (deps.isFeatureEnabled ?? isFeatureEnabled)("project_memory_content", brand)` is true and `deps.getProjectMemoryMarkdown` (default: `getProjectContext` + `renderProjectContextMarkdown` with the service client) resolves, return `withProjectMemory(brief, md)`. The overlay is applied **after** any `upsert` so it is never persisted. Any error in the overlay is logged `[content-worker] project memory unavailable` and the plain brief is returned. Flag off → no call and an identical object.

#### 6.2.7 Brief import `src/lib/projectContext/briefImport.ts`

```ts
export function isSeededBrief(brief: Record<string, unknown>, brandKey: string): boolean;
  // true when it equals HEALTHCARE_CXO_BRIEF with one_liner `${brandKey} — …` (contentWorker.js:194-199 rule)
  // or is the generic preset { one_liner: brandKey|brand_name, website, tone_rules: [the two default rules] } (contentWorker.js:205-209)
export function briefToOps(brief: Record<string, unknown>, ownHost: string): ResolvedOp[];
```

`briefToOps` (all `insert_*` so nothing existing is overwritten):
- `insert_section_if_missing business_overview` = `one_liner` + (when `personas` is a non-empty string array) `"\n\nBuyers: " + personas.join("; ")`, trimmed to 4,000.
- `insert_section_if_missing writing_preferences` = `tone_rules` as `- rule` lines, when non-empty.
- `insert_section_if_missing custom:priority-topics` title "Priority topics" = `priority_topics` as `- topic` lines, when non-empty.
- `insert_competitors_if_none` with `source: "brief_import"` for each `competitors` string that `normalizeCompetitorDomain` accepts and that is not the own host; names without a domain are skipped.
- `upsert_key_pages` role `money` for each `money_pages` string that `normalizeKeyPageUrl` accepts (max 100).

`maybeImportBrandBrief`: if `claimBriefImport(brandKey)` returns false → return false (already checked once, ever). Otherwise read the brief; when present and not seeded, apply `briefToOps` as author `system`, then `markBriefImported`. Errors are logged `[project-context] brief import failed {brandKey}` and do not fail the read.

#### 6.2.8 Tool definitions `src/lib/projectContext/tools.ts`

MCP-compatible definitions in the shape F21/F22 own (`name, description, input zod, output zod, handler`). F22 registers them in its registry; F07 only exports them.

```ts
export const getProjectContextTool = {
  name: "get_project_context",
  description: "Read this workspace's memory: business overview, goal, positioning, writing preferences, custom sections, declared competitors, key pages and the research log. Call before research or writing. Use the research log to avoid buying the same research twice within 90 days.",
  input: z.strictObject({}),
  output: z.looseObject({ markdown: z.string(), context: projectContextSchema }),
  handler: async (ctx: { admin: SupabaseClient; brand: WorkspaceBrand; userId: string }) => …,
};
export const updateProjectContextTool = {
  name: "update_project_context",
  description: "Apply 1–50 edits to this workspace's memory in one atomic batch. Saved values are authoritative: only fill what is missing or what the user asked to change.",
  input: z.strictObject({ updates: z.array(projectContextUpdateSchema).min(1).max(50) }),
  output: z.looseObject({ markdown: z.string() }),
  handler: async (ctx, input) => …,   // applyContextUpdates(..., author "assistant", actor null; competitorSource "assistant")
};
```

### 6.3 Jobs

| Kind / periodic | Trigger | Steps | Completion |
|---|---|---|---|
| periodic `project_context.retention` (86,400 s) | F01 `definePeriodic` | `enqueueSystemJob("project_context.retention", {}, { dedupeKey: "project_context.retention:" + YYYY-MM-DD })` | — |
| `project_context.retention` | system | `prune-1`…`prune-10` (`DB_STEP`): `prune_project_research_log(today − 90 days, 5000)`, stop when fewer than 5,000 deleted | `completed` |

Registered in `src/lib/projectContext/jobs.ts`, imported from `src/lib/jobs/kinds.ts`.

### 6.4 Provider calls and cost

None. F07 makes no paid calls. It records other features' research (`spend_usd` is informational and copied from the caller's settled amount; the spend ledger stays authoritative).

### 6.5 API routes

Contracts: `src/lib/projectContext/projectContext.contract.ts` (`defineRouteContract`). Both routes: `requireWorkspace(request, { brandKey })`, then `isFeatureEnabled("project_memory", brandKey)` false → `AppError(404, "feature_unavailable", "This page is not available for your workspace yet.")`; `toErrorResponse`; `Cache-Control: no-store`.

**`GET /api/customer/context?brand_key=`** (`src/app/api/customer/context/route.ts`). Query `z.strictObject({ brand_key: z.string().min(1).max(200).optional() })`. Response 200:

```json
{
  "brandKey": "offcult.in",
  "sections": [ { "key": "business_overview", "content": "Oversized and heavyweight T-shirts with anime graphics, sold online across India.",
                  "updatedAt": "2026-10-21T09:12:00.000Z", "updatedBy": "user", "updatedByUser": "6f1c…" } ],
  "missingSections": ["current_goal", "positioning", "writing_preferences"],
  "customSections": [ { "slug": "priority-topics", "title": "Priority topics", "content": "- Anime streetwear",
                        "updatedAt": "2026-10-21T09:12:00.000Z", "updatedBy": "system", "updatedByUser": null } ],
  "competitors": [ { "id": "1b7e…", "domain": "bewakoof.com", "name": "Bewakoof", "notes": null, "source": "setup_research",
                     "sourceUrl": "https://bewakoof.com/men-oversized-t-shirts", "updatedAt": "…", "updatedBy": "user", "updatedByUser": "6f1c…" } ],
  "keyPages": [ { "id": "9d2a…", "url": "https://offcult.in/collections/oversized-tees", "role": "money", "topic": "oversized t-shirts",
                  "notes": null, "updatedAt": "…", "updatedBy": "user", "updatedByUser": "6f1c…" } ],
  "researchLog": [ { "id": "c3f0…", "entryDate": "2026-10-21", "kind": "questions.setup", "researchKey": "offcult.in",
                     "summary": "Website research: overview, 5 competitors checked, 25 draft questions.", "spendUsd": 0.0841, "createdBy": "system" } ],
  "researchLogLimited": false,
  "brandIdentity": { "displayName": "Offcult", "website": "https://offcult.in", "matchNames": ["Offcult", "offcult"] }
}
```

Errors: 400 `invalid_request`; 401/403/404/503 from `requireWorkspace`; 404 `feature_unavailable`; 503 `context_unavailable`.

**`PATCH /api/customer/context`** (same file). Body `updateProjectContextBody` (§6.2.1). Example:

```json
{ "updates": [ { "section": "current_goal", "content": "Be named for 'oversized tees India' by March." },
               { "addCompetitors": [ { "domain": "https://www.thesouledstore.com/", "name": "The Souled Store" } ] },
               { "addKeyPages": [ { "url": "offcult.in/collections/oversized-tees", "role": "money", "topic": "oversized t-shirts" } ] } ] }
```

Response 200: the full context (same shape as GET). Errors: 400 `invalid_request` (zod), 400 `context_invalid` (with `details.index`), 400 `context_cap`, 403 `cross_site`, 404 `feature_unavailable`, 503 `context_unavailable`. Author `user`, actor = `user.id`. Members and owners may edit. Not idempotent by key; re-sending the same batch converges to the same state (upserts and deletes are idempotent; a repeated `appendResearchLog` adds a second entry, as OpenSEO).

### 6.6 UI

Route `src/app/portal/context/page.tsx` (client component in the F04 shell). Components in `src/components/portal/context/`: `ProjectContextPage.tsx` (PORT `ProjectContextPage.tsx`), `ProseSections.tsx`, `CustomSections.tsx`, `ResearchLog.tsx`, `CompetitorsSection.tsx` (PORT), `KeyPagesSection.tsx` (PORT), `EditableListSection.tsx` (PORT), `Provenance.tsx`, `BrandIdentityCard.tsx`, `hooks/useProjectContext.ts` (`useProjectContext(brandKey)`: `useQuery({ queryKey: keys.projectContext(brandKey), staleTime: 0 })`; `useContextUpdate(brandKey)`: PORT `shared.tsx:25-45`, toast "Context updated"). F04 primitives: `PageHeader`, `QueryState`, `EmptyState`, `CardShell`, `SectionHeader`, `Field`, `Textarea`, `Input`, `Select`, `Button`, `Badge`, `InlineConfirm`, `FormActions`, `Skeleton`, `SafeExternalLink`. `src/lib/query/keys.ts` gains `projectContext: (brandKey) => ["projectContext", brandKey]`.

**Navigation:** `src/components/app/navigation/items.ts` group `tools`: `{ id: "context", label: "Context", href: "/portal/context", icon: BookOpen, flag: "project_memory" }`. `src/lib/features/clientFeatures.ts` appends `"project_memory"`.

**Layout (top to bottom):** `PageHeader title="Context" description="What Perceev knows about {brand.display_name}."`; intro `p.text-sm.text-muted-foreground`: "Question setup, the assistant and Content Studio read this before they work, and some of them write back what they learn. Correct anything that looks wrong."; `BrandIdentityCard`; prose form; Competitors; Key pages; Custom sections; Research log. `div.space-y-8`, max width `max-w-3xl`.

**Copy:**

| Element | Copy |
|---|---|
| Brand identity card title / body | "Names we look for in AI answers" / chips of `matchNames`; footnote "Website: {website}. To change these names, contact Perceev support." |
| Section hints | business_overview "What you sell, who buys it, and where."; current_goal "What you're pushing for right now, and by when."; positioning "Why someone picks you over the alternatives."; writing_preferences "Voice, words to avoid, topics that are off-limits." |
| Placeholders | business_overview "e.g. Oversized and heavyweight T-shirts with anime graphics, sold online across India. Buyers are 18–30 and shop on their phones."; current_goal "e.g. Be named in AI answers for 'oversized tees India' by March."; positioning "e.g. Heavier fabric than fast-fashion brands, original artwork instead of licensed prints."; writing_preferences "e.g. Casual and direct. Never say 'premium quality'. Don't compare prices with named competitors." |
| Empty prose (all four missing) | `EmptyState size="sm"` "Nothing written down yet" / "Fill in what you can, or run question setup to draft it from your website." |
| Section status | "Empty" when missing; else `Provenance` |
| Save button | "Save changes" (disabled when nothing changed or while saving) |
| Competitors | title "Competitors"; hint "The sites you measure yourself against. Question setup, the assistant and Content Studio use this list. Scan results still find competitors in the answers themselves."; add "Add competitor"; empty "No competitors yet" / "Add the sites you compete with, or run question setup to find them."; form placeholders "competitor.com", "Name (optional)", "Why they matter (optional)"; a `setup_research` row shows a "Found by setup" badge and a "Source" link to `sourceUrl` |
| Key pages | title "Key pages"; hint "A shortlist of the pages that carry the site, not an inventory."; add "Add page"; empty "No key pages yet" / "Add the handful of pages that have to win: hubs, supporting pages and money pages."; placeholders "offcult.in/collections/oversized-tees", "Target topic (optional)", "Notes (optional)"; role select labels from `KEY_PAGE_ROLE_LABELS`; row shows "Target: {topic}" |
| Custom sections | title "Custom sections"; hint "Anything worth remembering that doesn't fit the sections above."; empty "Nothing here yet" / "The assistant adds a section when it learns something important that has nowhere else to live." |
| Research log | title "Research log"; hint "Paid research already bought for this workspace, so nobody buys the same data twice."; empty "Nothing logged yet" / "Question setup and research tools record what they bought here."; row: summary, then `entryDate · {spend formatted with formatUsd when not null} · Added by …`; delete via `InlineConfirm` "Delete log entry from {entryDate}" |
| Provenance | "Updated by you · 3 minutes ago" (`updatedByUser === current user`), "Updated by a teammate · …", "Updated by the assistant · …", "Updated by Perceev · …"; log rows "Added by …" |
| Toasts | success "Context updated"; error: the API `error` |

**States:** loading → `QueryState` with `Skeleton` blocks (4 textareas, 2 lists); error without data → `ErrorState` "Context could not be loaded." + "Retry"; error with data → banner above the stale page (F04 rule); saving → buttons disabled, `aria-busy` on the form; a cap or invalid error → toast with the message and the form stays as typed. Drafts follow OpenSEO: only touched sections are pinned locally; a section edited elsewhere refreshes on refetch unless it has a draft.

**Accessibility:** every textarea has a `label` bound by `htmlFor`; list rows use `aria-label="Edit {domain}"`/`"Remove {domain}"`; `InlineConfirm` for deletes; the toast region is `aria-live="polite"`.

**Phone (< 640 px):** single column; list rows stack actions under content; inputs full width; no horizontal page scroll.

### 6.7 Permissions, privacy, observability

- Read: any member. Write: members and owners (memory is collaborative, as OpenSEO). The service role writes only through `apply_project_context_ops`, which re-checks membership of `p_actor`.
- Logs: `[project-context] brief import failed {brandKey}`, `[content-worker] project memory unavailable`. Never log section content, notes or summaries.
- PostHog (F26 names, registered when `src/lib/telemetry/events.ts` exists): `project_context:viewed {}`, `project_context:updated { ops: number, kinds: string[] }`.
- Memory text is customer content and is sent only to the LLM features that read it (F08, F22, Content Studio), under their own spend features.

## 7. Code reuse map

| OpenSEO source | Perceev target | Mode | Adaptation notes |
|---|---|---|---|
| `openseo:src/db/project-context.schema.ts:17-118` | `supabase/migrations/070_f07_project_memory.sql` | PORT | Drizzle → SQL; `project_id` → `brand_key`; authors `user/assistant/system`; adds `updated_by_user`, competitor `source`/`source_url`, research `kind/research_key/spend_usd/job_id`, `project_memory_state`. |
| `openseo:src/types/schemas/projectContext.ts:1-121` | `src/shared/project-context.ts` | PORT | zod v4; `projectId` → `brand_key`; append op gains `kind`/`researchKey`. |
| `openseo:src/server/features/project-context/services/contextUpdateOps.ts:1-252` | `src/lib/projectContext/contextUpdateOps.ts` | PORT | Same caps, dedupe, ordering and op-index errors; own-domain refusal everywhere; `AppError(400,"context_invalid")`. |
| `openseo:src/server/features/project-context/services/ProjectContextService.ts:17-337` | `src/lib/projectContext/service.ts` | PORT | `runBatch` → `apply_project_context_ops`; report templates dropped; brief import added. |
| `openseo:src/server/features/project-context/repositories/ProjectContextRepository.ts:1-283` | `src/lib/projectContext/repository.ts` + SQL function | PORT | Coalesce/role-keep semantics moved into SQL; memory repository for tests. |
| `openseo:src/server/features/project-context/services/ProjectContextService.test.ts:58-330` | `src/lib/projectContext/contextUpdateOps.test.ts`, `service.test.ts` | PORT | Same cases, `node --test`. |
| `openseo:src/server/features/project-context/repositories/ProjectContextRepository.query.test.ts:79-156` | `scripts/qa/check-f07-db.mjs` group `coalesce` | PORT | Real Postgres instead of D1. |
| `openseo:src/server/lib/domainUtils.ts:32-50` | `src/lib/projectContext/normalize.ts` (`normalizeCompetitorDomain`) | PORT | Domain scope only. |
| `openseo:src/serverFunctions/projectContext.ts:9-28` | `src/app/api/customer/context/route.ts` | PORT | Server functions → GET/PATCH JSON route with `requireWorkspace`. |
| `openseo:src/server/features/projects/services/ProjectWebsiteService.ts:72-91`, `repositories/ProjectWebsiteRepository.ts:44-76` | `insert_section_if_missing` / `insert_competitors_if_none` ops | PATTERN | Insert-only setup writes, used by F08. |
| `openseo:src/client/features/projects/project-context/ProjectContextPage.tsx:1-400` | `src/components/portal/context/ProjectContextPage.tsx`, `ProseSections.tsx`, `CustomSections.tsx`, `ResearchLog.tsx` | PORT | F04 components; Perceev copy; brand identity card added. |
| `openseo:src/client/features/projects/project-context/{CompetitorsSection,KeyPagesSection,EditableListSection}.tsx` | same names under `src/components/portal/context/` | PORT | Copy adapted; setup badge and source link. |
| `openseo:src/client/features/projects/project-context/shared.tsx:1-69` | `hooks/useProjectContext.ts`, `Provenance.tsx` | PORT | F05 keys; author labels. |
| `openseo:src/client/features/projects/project-context/EditableListSection.test.ts` | `src/components/portal/context/editableList.test.ts` | PORT | Pure helper extracted (`nextEditingId`). |

## 8. Implementation plan

### Phase 1 — Schema, vocabulary, batch resolution, service
**Goal:** memory can be read, patched atomically and logged in the database, with OpenSEO's semantics proven by tests.

- [ ] **P1.T1 Migration and paperwork**
  - [ ] **P1.T1.S1** *Files:* `supabase/migrations/070_f07_project_memory.sql`. *Do:* §6.1 verbatim. *Verify:* CI job `customer-database` applies all migrations → green.
  - [x] **P1.T1.S2** *Files:* `scripts/setup-supabase.mjs`. *Do:* add the §6.1 required-objects entry. *Verify:* `node --test src/lib/migrationsRunner.test.mjs` → pass.
  - [x] **P1.T1.S3** *Files:* `README.md` (migration table: `| \`070_f07_project_memory\` | Project memory: sections, declared competitors, key pages, 90-day research log. |`), `docs/OPERATOR_LEDGER.md` § C (append `070_f07_project_memory` to the additive list with "apply before deploying F07"), `docs/PROD_MIGRATIONS.md` (one bullet describing the five tables and three service-only functions). *Verify:* the paperwork guards `node --test src/lib/docStatus.test.mjs src/lib/migrationsRunner.test.mjs` → pass (README and OPERATOR_LEDGER § C list 070).
  - [ ] **P1.T1.S4** *Files:* `tests/customer-uat.sql`, `.github/workflows/ci.yml`. *Do:* tenant block per §6.1; add `node scripts/qa/check-f07-db.mjs` after `check-repair-workflows.mjs` in `customer-database`. *Verify:* CI green.
- [ ] **P1.T2 Shared vocabulary and normalisers**
  - [x] **P1.T2.S1** *Files:* `src/shared/project-context.ts`, `src/shared/project-context.test.ts`. *Do:* §6.2.1. Tests: slug accepts `launch-plan`, rejects `Launch_Plan`; an update `{ section, contents }` fails (strict); 51 updates fail. *Verify:* `node --test src/shared/project-context.test.ts` → pass.
  - [x] **P1.T2.S2** *Files:* `src/lib/projectContext/normalize.ts`, `normalize.test.ts`. *Do:* §6.2.2. Cases: `https://www.Acme.com/pricing` → `acme.com`; `ACME.co.in` → `acme.co.in`; `localhost` and `192.168.1.1` → `context_invalid`; key page `example.com` → `https://example.com`; `http://www.x.com/a?b=1#c` → `https://x.com/a?b=1`. *Verify:* `node --test src/lib/projectContext/normalize.test.ts` → pass.
- [ ] **P1.T3 Batch resolution**
  - [x] **P1.T3.S1** *Files:* `src/lib/projectContext/contextUpdateOps.ts`, `contextUpdateOps.test.ts`. *Do:* §6.2.3; port every case of `ProjectContextService.test.ts:91-267` plus own-domain refusal and research `kind` default. *Verify:* `node --test src/lib/projectContext/contextUpdateOps.test.ts` → pass (F07-AC-02..05).
- [ ] **P1.T4 Repository and service**
  - [x] **P1.T4.S1** *Files:* `src/lib/projectContext/repository.ts`, `memoryRepository.ts`. *Do:* §6.2.4 with the error mapping. *Verify:* `npm run typecheck` → exit 0.
  - [x] **P1.T4.S2** *Files:* `src/lib/projectContext/service.ts`, `service.test.ts`. *Do:* §6.2.5. Tests (memory repo, fixed clock): typed vs custom split and `missingSections` (port `:67-89`); appended entry gets today's UTC date and a 91-day-old one is pruned (port `:278-304`); 20-entry limit and digest note (port `:306-330`); `findRecentResearch` hit within 90 days and miss at 91; digest format snapshot. *Verify:* `node --test src/lib/projectContext/service.test.ts` → pass (F07-AC-07, F07-AC-08, F07-AC-13).
  - [x] **P1.T4.S3** *Files:* `scripts/qa/check-f07-db.mjs` (loopback `_qa` DB guard as `check-repair-workflows.mjs:13-18`). *Do:* groups `rls` (two workspaces, two users), `atomic` (batch with 101st competitor raises and leaves zero new rows), `coalesce` (port of the two repository query tests plus title and source_url), `research` (append prunes, lookup by key), `import-once` (two `claim_project_brief_import` calls → true then false). *Verify:* `PGHOST=localhost PGDATABASE=perceev_qa node scripts/qa/check-f07-db.mjs` → "ok 5 groups" (F07-AC-01, F07-AC-05, F07-AC-06).
- [ ] **P1.T5 Tracking isolation guard**
  - [x] **P1.T5.S1** *Files:* `src/lib/projectContext/trackingIsolation.test.mjs`. *Do:* walk `src/lib/workers`, `src/lib/scoring`, `src/lib/engines`, `src/app/api/customer/scan` (all `.js/.mjs/.ts/.tsx/.jsx`) and fail on any import specifier containing `projectContext`; assert `src/app/api/customer/scan/route.*` reads competitors only from the request body (regex on `body?.competitors` / `body.competitors`). *Verify:* `node --test src/lib/projectContext/trackingIsolation.test.mjs` → pass (F07-AC-12).

**Checkpoint:** `npm test`, `npm run typecheck`, `npm run build`, `node scripts/qa/check-f07-db.mjs` pass. ACs 01–08, 12, 13.

### Phase 2 — Routes, flags, brief import, tools, content overlay, retention
**Goal:** customers and other features can use memory through stable interfaces.

- [ ] **P2.T1 Flags**
  - [ ] **P2.T1.S1** *Files:* `src/lib/features/names.ts`. *Do:* add `project_memory: { spend: [] as const }` and `project_memory_content: { spend: [] as const }`. *Verify:* `node --test src/lib/features/*.test.ts` → pass.
  - [ ] **P2.T1.S2** *Files:* `.env.example`. *Do:* add names only: `FEATURE_PROJECT_MEMORY=`, `FEATURE_PROJECT_MEMORY_BRANDS=`, `FEATURE_PROJECT_MEMORY_CONTENT=`, `FEATURE_PROJECT_MEMORY_CONTENT_BRANDS=` with one comment line each. *Verify:* `grep -c '^FEATURE_PROJECT_MEMORY' .env.example` → `4`; `node --test src/lib/credentialAssertionGuard.test.mjs` → pass.
- [ ] **P2.T2 Brief import**
  - [ ] **P2.T2.S1** *Files:* `src/lib/projectContext/briefImport.ts`, `briefImport.test.ts`. *Do:* §6.2.7; cases: seeded healthcare preset → `isSeededBrief` true; generic preset → true; edited brief → false; competitors `["Bewakoof", "thesouledstore.com"]` → one competitor op with `thesouledstore.com`; own host dropped; money pages normalised. *Verify:* `node --test src/lib/projectContext/briefImport.test.ts` → pass.
  - [ ] **P2.T2.S2** *Files:* `src/lib/projectContext/service.ts` (`maybeImportBrandBrief` wired into `getProjectContext`), `service.test.ts`. *Do:* second call imports nothing after the user deleted the imported section. *Verify:* `node --test src/lib/projectContext/service.test.ts` → pass (F07-AC-11).
- [ ] **P2.T3 Routes**
  - [ ] **P2.T3.S1** *Files:* `src/app/api/customer/context/route.ts`, `src/lib/projectContext/projectContext.contract.ts`. *Do:* §6.5. *Verify:* `node --test src/lib/http/routeContract.test.ts` → pass.
  - [ ] **P2.T3.S2** *Files:* `src/lib/projectContext/context.route.test.mjs` (hook pattern `src/lib/customerRoutes.test.hooks.mjs`). *Do:* cases: GET shape and order; PATCH writes `updated_by "user"` with the caller id; `context_invalid` with `details.index`; `context_cap`; flag off → 404 `feature_unavailable`; member allowed; cross-site → 403. *Verify:* `node --import ./src/lib/liveWriteGuardAuto.mjs --test src/lib/projectContext/context.route.test.mjs` → pass (F07-AC-09, F07-AC-10).
- [ ] **P2.T4 Tools and content overlay**
  - [ ] **P2.T4.S1** *Files:* `src/lib/projectContext/tools.ts`, `tools.test.ts`. *Do:* §6.2.8; tests: `z.toJSONSchema(input, {io:"input"}).additionalProperties === false`; handler writes `assistant`; output parses. *Verify:* `node --test src/lib/projectContext/tools.test.ts` → pass (F07-AC-15).
  - [ ] **P2.T4.S2** *Files:* `src/lib/projectContext/contentOverlay.ts`, `contentOverlay.test.ts`, `src/lib/content/contentWorker.js` (`resolveBrief`). *Do:* §6.2.6; tests: flag on → `project_memory` present, upsert receives the brief without it; flag off → `deepStrictEqual` to today's output; overlay error → plain brief. *Verify:* `node --test src/lib/projectContext/contentOverlay.test.ts src/lib/content/brandBriefRegression.test.mjs src/lib/content/contentWorker.test.mjs` → pass (F07-AC-14).
- [ ] **P2.T5 Retention**
  - [ ] **P2.T5.S1** *Files:* `src/lib/projectContext/jobs.ts`, `src/lib/jobs/kinds.ts` (one import line). *Do:* §6.3. *Verify:* `node scripts/qa/check-f07-db.mjs --group research` → ok; `node --test src/lib/jobs/*.test.ts` → pass.

**Checkpoint:** full suite, typecheck, build, DB harness. ACs 09–11, 14, 15.

### Phase 3 — `/portal/context` (requires F04 and F05 merged)
**Goal:** customers read and edit memory in the app.

- [ ] **P3.T1 Data hooks and keys**
  - [ ] **P3.T1.S1** *Files:* `src/lib/query/keys.ts` (`projectContext`), `src/lib/query/keys.test.ts`, `src/components/portal/context/hooks/useProjectContext.ts`. *Verify:* `node --test src/lib/query/keys.test.ts` → pass.
- [ ] **P3.T2 Page and sections**
  - [ ] **P3.T2.S1** *Files:* `src/app/portal/context/page.tsx`, `src/components/portal/context/{ProjectContextPage,ProseSections,CustomSections,ResearchLog,CompetitorsSection,KeyPagesSection,EditableListSection,Provenance,BrandIdentityCard}.tsx`, `editableList.ts`, `editableList.test.ts`. *Do:* §6.6 with the exact copy. *Verify:* `node --test src/components/portal/context/editableList.test.ts` → pass; `npm run build` → exit 0.
  - [ ] **P3.T2.S2** *Files:* `src/components/app/navigation/items.ts`, `src/lib/features/clientFeatures.ts`. *Do:* add the `context` item and `"project_memory"`. *Verify:* `node --test src/components/app/navigation/navModel.test.ts` → pass.
- [ ] **P3.T3 Browser checks**
  - [ ] **P3.T3.S1** *Files:* `scripts/qa/check-f07-browser.mjs` (Playwright from `worker/node_modules/playwright`, local app with fixture APIs). Scenarios: B1 loading → saved state; B2 edit overview + add competitor → toast "Context updated", provenance "Updated by you"; B3 cap error toast; B4 flag off → no sidebar item and page shows `feature_unavailable` copy; B5 375 px: `document.documentElement.scrollWidth <= 375`, Tab order reaches every control. *Verify:* `node scripts/qa/check-f07-browser.mjs` → "ok 5 scenarios" (F07-AC-16, F07-AC-17).

**Checkpoint:** build, unit suite, browser script. ACs 16–17.

## 9. Test plan

| Test file | Cases | ACs |
|---|---|---|
| `src/shared/project-context.test.ts` | strict union, slug, batch size | 03 |
| `src/lib/projectContext/normalize.test.ts` | domains, URLs, research keys | 04 |
| `src/lib/projectContext/contextUpdateOps.test.ts` | prose cap, clear, custom cap, domain normalisation and dedupe, own domain, caps across ops, op-index error | 02–05 |
| `src/lib/projectContext/service.test.ts` | split, missing, research stamp/prune/limit, recent lookup, digest, import once | 07, 08, 11, 13 |
| `src/lib/projectContext/briefImport.test.ts` | seeded detection, mapping | 11 |
| `src/lib/projectContext/contentOverlay.test.ts` | flag on/off, no persistence, error fallback | 14 |
| `src/lib/projectContext/tools.test.ts` | schemas, author | 15 |
| `src/lib/projectContext/trackingIsolation.test.mjs` | import walk, scan route body | 12 |
| `src/lib/projectContext/context.route.test.mjs` | GET/PATCH, errors, flag, roles | 09, 10 |
| `scripts/qa/check-f07-db.mjs` | rls, atomic, coalesce, research, import-once | 01, 05, 06, 07, 08, 11 |
| `scripts/qa/check-f07-browser.mjs` | B1–B5 | 16, 17 |

Fixtures: `tests/fixtures/f07/brand-briefs.json` (seeded healthcare preset, generic preset, an edited Offcult-like brief with names and domains mixed). All synthetic; no provider payloads.

## 10. Rollout and rollback

- **Env (names only):** `FEATURE_PROJECT_MEMORY`, `FEATURE_PROJECT_MEMORY_BRANDS`, `FEATURE_PROJECT_MEMORY_CONTENT`, `FEATURE_PROJECT_MEMORY_CONTENT_BRANDS`.
- **Defaults:** both flags unset → off in production, on in development and preview (F01 rule).
- **Migration:** 070, additive. No backfill job; brief import happens lazily on first read per workspace.
- **Owner enabling steps:** apply 070; deploy; set `FEATURE_PROJECT_MEMORY=allowlist` with the QA workspace in `FEATURE_PROJECT_MEMORY_BRANDS`; open `/portal/context`, check the imported brief; then `on`. Enable `project_memory_content` only after reviewing one Content Studio draft with memory.
- **Turn off:** set the flags to `off`. Data stays; content jobs return to today's brief.
- **Cleanup (only on owner request):** `drop table project_research_log, project_key_pages, project_competitors, project_context_sections, project_memory_state cascade;` and the three functions.

## 11. Risks and open questions

| # | Risk / question | Default chosen |
|---|---|---|
| 1 | Members (not only owners) can delete memory entries. | Allowed, as OpenSEO; provenance shows who changed what. Revisit with the Teams Mixed row. |
| 2 | A brand brief's `competitors` are free-text names, not domains. | Import only domain-shaped strings; names are left in the brief and Content Studio still sees them through the brief. |
| 3 | The brief import runs once per workspace forever; a later brief edit is not re-imported. | Accept; memory becomes the editable source and the brief stays as is. |
| 4 | Declared competitors could be expected to change scan results. | Explicitly not (Mixed row deferred); the page copy says scan results find competitors in the answers. Guard test F07-AC-12. |
| 5 | `spend_usd` on log entries duplicates ledger data. | Informational only, written by the feature that settled the spend; the Usage page reads the ledger. |
| 6 | No optimistic locking: two editors can overwrite each other's prose. | Accept, as OpenSEO; drafts are per section and the last save wins. |

**Deviations from conventions:** none. (Retention exists only for the research log; the other tables are capped per workspace.)

## 12. Definition of done

- [ ] Phases 1–3 merged; every subtask ticked.
- [ ] F07-AC-01..17 covered by passing tests listed in §9.
- [ ] `npm test`, `npm run typecheck`, `npm run build`, `check-f07-db.mjs`, `check-f07-browser.mjs` green.
- [ ] Migration paperwork updated (README, OPERATOR_LEDGER § C, PROD_MIGRATIONS); `THIRD_PARTY_NOTICES.md` lists every PORT/COPY file.
- [ ] `features/README.md` F07 status updated.
- [ ] Owner check recorded: QA workspace context page reviewed with the flag on.

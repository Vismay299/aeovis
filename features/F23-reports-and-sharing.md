# F23 — Reports and public sharing

> <!-- doc-status -->
> **Status: LIVE.** Implementation spec. Not built yet.

| Field | Value |
|---|---|
| ID | F23 |
| Wave | 4 |
| Comparison rows covered | Reports and sharing |
| Depends on | F22 (merged: tool registry, assistant, kickoff registry), F21 (skill library), F01, F04, F05 |
| Blocks | F25 (a future emailed digest could link reports), F27 (optional) |
| Reserved migrations | 150–154. **150** `150_f23_reports.sql`, **151** `151_f23_report_share_views.sql`. 152–154 unused. |
| Feature flags | `FEATURE_REPORTS` (name `reports`, spend `[]`, `CLIENT_FEATURES`): pages, routes, report tools, `/r`. `FEATURE_REPORT_SHARING` (name `report_sharing`, spend `[]`, `CLIENT_FEATURES`): share toggle and every `/s` route. `FEATURE_REPORT_GENERATE` (name `report_generate`, spend `["assistant.turn"]`, `CLIENT_FEATURES`): "Generate report" buttons. All off in production by default. |
| Spend features | none new. Writing a report is assistant work metered under F22's `assistant.turn`; paid lookups use their owners' features through approval cards. |
| OpenSEO reference | `openseo:src/db/{reports,report-templates}.schema.ts`, `openseo:src/types/schemas/{reports,report-templates}.ts`, `openseo:src/server/features/reports/**`, `openseo:src/serverFunctions/{reports,reportTemplates}.ts`, `openseo:src/shared/{report-sandbox,report-share}.ts`, `openseo:src/routes/r/$reportId.ts`, `openseo:src/routes/s/$token/{index,raw,og[.]png}.ts`, `openseo:src/client/features/reports/**`, `openseo:src/routes/_app/p/$projectId/reports/**`, `openseo:src/server/mcp/tools/{report-tools,report-template-tools,report-sharing-tools}.ts`, `openseo:.agents/skills/seo-report/SKILL.md` at `c5f8db1` |

## 1. Summary

The assistant can save its work as a one-page HTML report that the team opens in the app, prints to PDF, and, when someone chooses to, shares through a public link with a preview image. Workspaces keep report templates (reusable briefs such as "Monthly client check-in"), and a "Generate report" button starts the assistant on a template. Because reports are written by a model from untrusted inputs (AI answers, web pages), the stored HTML is sanitised, served from a sandboxed opaque origin with a strict Content Security Policy, and the public pages are kept out of search indexes and away from the app's session cookies.

## 2. What OpenSEO does (observed)

**Data model and caps**
1. `reports(id, project_id, title, summary, html, skill, template_id, created_by, created_by_user_id, size_bytes, share_token, shared_at, created_at, updated_at)`; HTML stored in the row; index `(project_id, updated_at, id, size_bytes)`; unique `share_token` (`openseo:src/db/reports.schema.ts:11-85`). `template_id` has no FK so deleting a template never touches reports (`:34-37`); `created_by` is a self-reported client label, the user id is the identity (`:38-45`).
2. `report_templates(id, project_id, name, description, instructions, created_by, created_by_user_id, …)`, unique `(project_id, name)` (`openseo:src/db/report-templates.schema.ts:5-43`). Caps: 10 per project, name 80, description 200, instructions 3,000 (`openseo:src/types/schemas/report-templates.ts:5-13`).
3. Report caps: HTML 500,000 UTF-8 bytes; 10,000 per project (creates only); 5 GB per organisation; title 120; summary 2,500; skill slug 60; list defaults 20 / max 50 / app 100 (`openseo:src/types/schemas/reports.ts:5-37`).

**Service rules** (`openseo:src/server/features/reports/services/ReportService.ts`)
4. Save is create-or-update and validates everything before writing: title and summary length, UTF-8 byte size with "actual rounded up, limit rounded down" copy, a structural check that the document contains `<html` and ends with `</html>` (models stop mid-document), existing `reportId`, unique title within the project, per-project count on create, per-organisation byte ceiling on create and update (`:22-31`, `:55-145`). Updates keep the stored skill and template when omitted and never re-stamp attribution (`:147-168`; repository `:153-183`).
5. Sharing is idempotent: an existing token is returned; a mint uses a conditional update so concurrent publishers keep the first token; revoke nulls the token; content saves never touch sharing (`ReportService.ts:244-306`; `openseo:src/server/features/reports/repositories/ReportRepository.ts:221-248`). Token = 24 random bytes as 32 base64url characters (192 bits) (`openseo:src/shared/report-share.ts:5-20`). Shares are refused server-side when the deployment cannot serve them (`ReportService.ts:251-259`; `openseo:src/server/features/reports/shareAccess.ts:8-23`).
6. Every query filters by project as well as id, except the two document reads (`/r/<id>` resolves the project first, then authorises; `/s/<token>` is authorised by the token) (`ReportRepository.ts:6-11`, `:59-70`, `:185-219`).

**Documents and sandbox** (`openseo:src/shared/report-sandbox.ts`)
7. Reports are treated as hostile: the iframe uses `sandbox="allow-popups allow-popups-to-escape-sandbox"` and never `allow-same-origin`; the response carries `Content-Security-Policy: sandbox …; default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'; frame-ancestors 'self'`, so even a top-level open gets an opaque origin with no cookies (`:1-33`).
8. Print mode `?print=1` appends one script (open all `<details>`, then `print()` 150 ms after load), authorised by its SHA-256 hash, spliced in without attributes so a dangling tag cannot absorb them; a test recomputes the hash (`:35-101`; `report-sandbox.test.ts:8-17`).
9. Both document routes share one response builder with `Cross-Origin-Opener-Policy: same-origin`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`; the public one adds `X-Robots-Tag: noindex, nofollow` (`:103-130`).
10. `/r/<id>`: auth by session; unauthenticated → 302 to sign-in with redirect; one 404 body for "no such report" and "another organisation's report"; `private, no-store` (`openseo:src/routes/r/$reportId.ts:10-105`).
11. `/s/<token>/raw`: shape check before any query; any query string → 302 to the bare path (cache-busting defence); top-level navigation → 302 to the wrapper (the document is only shown framed); one 404 body for every dead end; `public, max-age=0, s-maxage=60` (revocation can lag 60 s, which the share dialog says); anonymous view event with distinct id `share:<first 16 hex of sha256(token)>`, `from_browser` from `Sec-Fetch-Dest`, no person profile (`openseo:src/routes/s/$token/raw.ts:12-121`).
12. `/s/<token>`: server-rendered static HTML (no app bundle), escaped values, `meta robots noindex`, OG/Twitter tags with a versioned image URL, a slim header (title, "Made with …", Share button with a tiny clipboard script, "Try …"), the sandboxed iframe, `no-store`; dead ends are 404 pages that do not name the report (`openseo:src/server/features/reports/sharePage.tsx:12-260`).
13. `/s/<token>/og.png`: 1200×630 PNG via takumi-js `ImageResponse` with logo, title (size by length) and project domain; `no-store`, `noindex`; renderer loaded lazily; a render failure redirects to a static card (`openseo:src/routes/s/$token/og[.]png.ts:9-38`; `openseo:src/server/features/reports/reportSocialImage.tsx:6-89`).

**Writing and UI**
14. Reports are written by agents over MCP: `save_report` (title, summary, html, reportId, skill, templateId; detailed HTML rules in the description), `list_reports`, `get_report` (`includeHtml` only when editing), `delete_report`, `set_report_sharing` (only when the user explicitly asks) (`openseo:src/server/mcp/tools/report-tools.ts:59-414`; `report-sharing-tools.ts:19-84`). The `seo-report` skill carries the house style and a starter template (`openseo:.agents/skills/seo-report/SKILL.md:1-264`).
15. Reports page: table Title / Created by / Type (template name, else skill) / Updated, row delete; templates link; empty state pointing at external agents (`openseo:src/client/features/reports/ReportsList.tsx:20-99`; `openseo:src/routes/_app/p/$projectId/reports/index.tsx:20-82`).
16. Detail page: header metadata, Share (hosted) or Export, menu with Export and Delete, sandboxed viewer with skeleton until load, floating Full screen and Open in new tab, full-screen mode in the URL with Esc and a focused Exit button (`openseo:src/routes/_app/p/$projectId/reports/$reportId.tsx:44-346`; `openseo:src/client/features/reports/ReportViewer.tsx:21-56`).
17. Share dialog: switch "Public link", copy and open buttons, copy "Anyone with the link can view. No sign-in needed.", "Shows the latest saved version. Hidden from search engines." (`openseo:src/client/features/reports/shared.tsx:110-253`). Delete is confirmed by name (`:84-108`).
18. Templates page and form (TanStack Form; name, one-line description "This is what an agent reads to decide.", instructions with a placeholder brief) (`openseo:src/client/features/reports/ReportTemplateForm.tsx:18-150`; `ReportTemplatesList.tsx:17-86`; `openseo:src/routes/_app/p/$projectId/reports/templates.tsx:27-125`).
19. No scheduled or emailed reports.

## 3. What Perceev has today

- **No report store.** The customer scan report page offers a JSON download per scan (`src/app/api/customer/scan/report/[scan_id]/route.js:46-67`). The free scan's dashboard is shareable by URL at `/dashboard/[brand]/[scanId]`, a private-prefix route with `noindex`.
- **Middleware** runs only on `/api/:path*` (`src/middleware.js:88-91`), so new page routes `/r/*` and `/s/*` never reach it; there is no auth middleware for pages. The operator perimeter (`src/server/operatorPerimeter.js`) is untouched by this feature.
- **Indexing:** `PRIVATE_ROUTE_PREFIXES` (`src/server/publicSite.js:57-67`) drive `robots.txt` disallows (`src/app/robots.js:18-25`) and an `X-Robots-Tag: noindex, nofollow` header from `next.config.mjs:5-11`; `sitemap.js` lists only `PUBLIC_INDEXABLE_ROUTES` (`publicSite.js:14-51`, `:129-137`). Tests: `src/server/repairs/r20-public-site.test.mjs:73-75`, `:90-99`, `:117-123`; hosted check `scripts/qa/check-public-site.mjs:17-25`.
- **Sign-in redirect** uses `?next=` (`src/app/login/page.jsx:33-36`).
- **Brand colours** `--brand: #3730CE`, `--brand-lift: #5B54F0` (`src/app/globals.css:57-58`). There is no `public/` folder.
- **F22** provides the registry (`src/server/tools/`), `TOOL_NAMES` with the four report names in `PLANNED_TOOL_NAMES`, the assistant runtime, `registerKickoff`, `buildSystemPrompt({ templatesBlock })`, and `TOOL_PRESENTATION`. **F21** provides the skill library and its expected-list test.
- **F04** provides `APP_SURFACES` (append-only; F23 adds `/r`), UI primitives, `PageHeader`, `BackLink`, `EmptyState`, `QueryError`, `ConfirmDialog`, `RowActionsMenu`, `SkeletonPresets`; **F05** `fetchJson`, keys, `useWorkspace()`.

## 4. Target behaviour and acceptance criteria

| ID | Statement | Verified by |
|---|---|---|
| F23-AC-01 | `saveReport` validates in the order of §6.2.3 and writes nothing when any check fails; each refusal has the code and copy listed there. | unit `src/server/reports/service.test.ts` |
| F23-AC-02 | Byte limits are UTF-8 (`TextEncoder`) and measured on the sanitised document; input over 1,000,000 bytes is refused before sanitising; the refusal prints the size rounded up and the limit rounded down. | unit `service.test.ts` |
| F23-AC-03 | A save without `</html>` at the end, or without `<html`, is refused with `report_incomplete` and the stored report is unchanged. | unit `service.test.ts` |
| F23-AC-04 | Titles are unique per workspace (DB unique index and service check); a clash names the existing id. Creates stop at 2,000 reports per workspace; creates and updates stop at 250,000,000 stored bytes net of the replaced document. | unit `service.test.ts`; DB group `reports` |
| F23-AC-05 | Updates keep `skill`, `skill_version` and `template_id` when omitted, never change `created_by`, `created_by_user_id`, `share_token` or `shared_at`, and bump `updated_at`; share changes do not bump `updated_at`. | unit; DB group `reports` |
| F23-AC-06 | **Sanitiser:** the output contains no element outside the allowlist of §6.2.2, no `on*` attribute, no `javascript:`/`vbscript:`/`data:` link, no `<meta http-equiv>`, no remote `img`, no CSS `@import`, `expression(`, `behavior:` or non-`data:` `url(…)`; non-fragment links get `target="_blank" rel="noopener noreferrer nofollow"`; `<!doctype html>` is first; the result of sanitising the sanitised output is identical (idempotent). | unit `src/server/reports/sanitize.test.ts` (40-case corpus) |
| F23-AC-07 | `/r/[reportId]` and `/s/[token]/raw` responses carry exactly the CSP of `reportCsp(print)`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy: same-origin`, `X-Robots-Tag: noindex, nofollow`; the iframe attribute equals `REPORT_IFRAME_SANDBOX` and never contains `allow-same-origin`. | unit `src/shared/report-sandbox.test.ts`, `documentRoutes.test.ts` |
| F23-AC-08 | Print mode appends the print script once, last, attribute-free; the CSP authorises exactly its hash; `PRINT_SCRIPT_SHA256` equals the recomputed digest. | unit `report-sandbox.test.ts` (port of OpenSEO's) |
| F23-AC-09 | `/r/[reportId]`: invalid id shape, unknown id, another workspace's report, or `reports` off → 404 with the single body "This report does not exist or you do not have access to it."; signed out → 302 `/login?next=%2Fr%2F<id>`; HTML is read only after authorisation; `private, no-store`. | unit `documentRoutes.test.ts` |
| F23-AC-10 | **Share token:** 32 base64url chars from `crypto.getRandomValues(24 bytes)`; minting is idempotent and race-safe (two concurrent mints return the same token); revoke nulls it; re-sharing mints a different token. | unit `report-share.test.ts`; DB group `sharing` |
| F23-AC-11 | `/s/[token]/raw`: bad token shape → 404 without a DB query; any query string → 302 to the bare path without a query; unknown, revoked, inactive workspace or `report_sharing` off → 404 "This report isn't shared."; `Sec-Fetch-Dest` present and not `iframe` → 302 to `/s/<token>`; otherwise 200 with `public, max-age=0, s-maxage=60`. | unit `documentRoutes.test.ts` |
| F23-AC-12 | A served public document records one view: `record_report_view(report, brand, "share:<16 hex>", fromBrowser)`; the pseudonym is derived from the token and never equals it; no IP, user agent or cookie is stored. | unit `documentRoutes.test.ts`; DB group `views` |
| F23-AC-13 | `/s/[token]` wrapper: static HTML with every report value HTML-escaped (a title `<script>alert(1)</script>` appears escaped), `<meta name="robots" content="noindex, nofollow">`, OG and Twitter tags with image `/s/<token>/og.png?v=<updatedAt>`, the iframe with `REPORT_IFRAME_SANDBOX` and `referrerpolicy="no-referrer"`, headers `no-store`, `X-Robots-Tag: noindex, nofollow`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY` and the wrapper CSP of §6.2.6 whose `script-src` hash matches `SHARE_SCRIPT`. Dead ends are 404 pages that do not contain the report title. | unit `sharePage.test.ts` |
| F23-AC-14 | `/s/[token]/og.png`: same access checks as raw; 200 `image/png` 1200×630 with `no-store` and `noindex`; title and workspace host only; a render failure returns 500 `text/plain` "Preview image unavailable." with `no-store`. | unit `ogRoute.test.ts`; browser check |
| F23-AC-15 | **Indexing and auth:** `/r` is in `PRIVATE_ROUTE_PREFIXES` (robots disallow + noindex header); `/s` is in the new `NOINDEX_ROUTE_PREFIXES` (noindex header and meta, **not** disallowed in robots so link previews can read the tags); neither appears in the sitemap; `getRouteIndexingPolicy("/s/x")` → `{ index: false, follow: false, disallowRobots: false, reason: "share_link" }`; the middleware matcher still covers only `/api/:path*`. Existing R20 tests pass unchanged. | unit `src/server/reports/indexing.test.mjs`; `node --test src/server/repairs/r20-public-site.test.mjs` |
| F23-AC-16 | Report tools: `list_reports`, `get_report`, `save_report`, `list_report_templates` are registered, pass F22's contract tests, never return a share token or URL, and mark `summary`/`html` read back as untrusted; `save_report` with `reportId` needs a `confirm` approval; there is no tool to share, unshare or delete. | unit `src/server/reports/tools.test.ts`, F22 `contract.test.ts` |
| F23-AC-17 | `TOOL_NAMES` contains the four report tools and `PLANNED_TOOL_NAMES` is empty; F22's registry equality test and F21's reference test pass; the `seo-report` skill is served when `save_report` is available and F21's expected list has 15 names. | unit F22 `registry.test.ts`, F21 `skills.test.ts`, `toolReferences.test.ts` |
| F23-AC-18 | Templates: create, update, delete; caps 10 per workspace (creates), name 80, description 200, instructions 3,000 (trimmed); case-insensitive unique names; refusals return 400/409 with OpenSEO's copy; deleting a template leaves reports intact and their Type falls back to the skill. | unit `templateService.test.ts`; route test |
| F23-AC-19 | `POST /api/customer/reports/generate { templateId }` requires `reports`, `report_generate` and `assistant`, creates an assistant session titled "Report: {name}" with kickoff `{ kind: "generate_report", templateId }` and returns its path; the kickoff builder produces the text of §6.2.8 and the chip "Generate a report from “{name}”". | route test; unit `generate.test.ts` |
| F23-AC-20 | The assistant's system prompt lists the workspace's templates in `<report_templates>` (name, id, description) when `reports` is on and templates exist. | unit `src/server/reports/promptBlock.test.ts` |
| F23-AC-21 | Customer routes: list (no `html`, no `summary`), detail (with `views30d` for the current link), delete, share/unshare (`report_sharing` off → 404 `feature_unavailable`), templates CRUD; every route rejects unknown fields and other workspaces' ids with 404. | route test `src/server/reports/reports.route.test.mjs` |
| F23-AC-22 | UI: list, empty state, detail with viewer skeleton, Export opens `/r/<id>?print=1`, full screen with Esc and Exit, share dialog states, delete confirm, templates page and form, Generate dialog; phone layout has no horizontal page scroll. | browser `scripts/qa/check-f23-browser.mjs` |
| F23-AC-23 | Public pages in a real browser: the report document runs no script (an injected `<script>` in a fixture is absent and `window.__pwned` stays undefined), cannot read `document.cookie` (opaque origin), cannot load a remote image (no request leaves to the fixture's remote host), and links open new tabs. | browser `scripts/qa/check-f23-browser.mjs` |
| F23-AC-24 | `APP_SURFACES` contains `{ prefix: "/r", theme: "light" }`. | unit F04 `theme.test.ts` (case added) |
| F23-AC-25 | Retention: share-view rows older than 395 days are pruned daily; reports and templates are kept until deleted. | DB group `retention` |

## 5. Scope

**In scope:** tables, service, sanitiser, templates, report tools on F22's registry, the `seo-report` skill, document route `/r/[reportId]` with print, public routes `/s/[token]`, `/s/[token]/raw`, `/s/[token]/og.png`, anonymous view counts, Reports and Templates pages, share and delete dialogs, Generate from template, indexing and header changes, threat model.

**Out of scope:**
- **Scheduled or emailed reports** (OpenSEO has none either). Follow-up: a weekly digest built on F10 schedules and F25 email, linking the latest report.
- Sharing, unsharing or deleting reports by the assistant (deliberately UI-only).
- Report version history (OpenSEO has none; replacing is confirmed instead).
- A separate user-content domain for documents (listed in Risks as a hardening follow-up).
- MCP access to reports (MCP excluded).
- Deferred Mixed rows: reports read existing data only; no change to citations, competitors, trends or teams.

## 6. Design

### 6.1 Data model

#### `supabase/migrations/150_f23_reports.sql`

```sql
-- F23: assistant-written HTML reports and report templates. Customer content.
CREATE TABLE IF NOT EXISTS public.reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_key text NOT NULL REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  summary text NOT NULL CHECK (char_length(summary) BETWEEN 1 AND 2500),
  html text NOT NULL,
  size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 500000),
  sanitizer_version integer NOT NULL CHECK (sanitizer_version >= 1),
  skill text CHECK (skill IS NULL OR skill ~ '^[a-z][a-z0-9-]{2,59}$'),
  skill_version text CHECK (skill_version IS NULL OR skill_version ~ '^\d+\.\d+\.\d+$'),
  template_id uuid,
  session_id uuid,
  created_by text NOT NULL CHECK (created_by IN ('assistant','app')),
  created_by_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  share_token text CHECK (share_token IS NULL OR share_token ~ '^[A-Za-z0-9_-]{32}$'),
  shared_at timestamptz,
  shared_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (octet_length(html) = size_bytes),
  CHECK ((share_token IS NULL) = (shared_at IS NULL))
);
COMMENT ON COLUMN public.reports.html IS 'Sanitised self-contained HTML document (§6.2.2). Read only by /r and /s/<token>/raw and get_report(includeHtml).';
COMMENT ON COLUMN public.reports.template_id IS 'Template followed, if any. No FK: deleting a template must not touch reports (OpenSEO reports.schema.ts:34-37).';
COMMENT ON COLUMN public.reports.session_id IS 'Assistant session that wrote the report. No FK: sessions are pruned after 395 days idle.';
COMMENT ON COLUMN public.reports.share_token IS 'Public link capability (192 bits). NULL = private; nulling revokes.';
CREATE UNIQUE INDEX IF NOT EXISTS reports_title_idx ON public.reports (brand_key, title);
CREATE UNIQUE INDEX IF NOT EXISTS reports_share_token_idx ON public.reports (share_token) WHERE share_token IS NOT NULL;
CREATE INDEX IF NOT EXISTS reports_list_idx ON public.reports (brand_key, updated_at DESC, id DESC) INCLUDE (size_bytes);

-- updated_at changes only with content, never with sharing (OpenSEO ReportRepository.ts:221-223).
CREATE OR REPLACE FUNCTION public.reports_touch_content() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.html IS DISTINCT FROM OLD.html OR NEW.title IS DISTINCT FROM OLD.title OR NEW.summary IS DISTINCT FROM OLD.summary
     OR NEW.skill IS DISTINCT FROM OLD.skill OR NEW.template_id IS DISTINCT FROM OLD.template_id THEN
    NEW.updated_at := now();
  END IF;
  NEW.created_by := OLD.created_by; NEW.created_by_user_id := OLD.created_by_user_id; NEW.created_at := OLD.created_at;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS reports_touch ON public.reports;
CREATE TRIGGER reports_touch BEFORE UPDATE ON public.reports FOR EACH ROW EXECUTE FUNCTION public.reports_touch_content();

CREATE TABLE IF NOT EXISTS public.report_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_key text NOT NULL REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  description text NOT NULL CHECK (char_length(description) BETWEEN 1 AND 200),
  instructions text NOT NULL CHECK (char_length(instructions) BETWEEN 1 AND 3000),
  created_by text NOT NULL CHECK (created_by IN ('assistant','app')),
  created_by_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS report_templates_name_idx ON public.report_templates (brand_key, lower(name));
DROP TRIGGER IF EXISTS report_templates_touch ON public.report_templates;
CREATE TRIGGER report_templates_touch BEFORE UPDATE ON public.report_templates
  FOR EACH ROW EXECUTE FUNCTION public.f01_touch_updated_at();

-- Race-safe mint: keeps the first token (OpenSEO ReportRepository.ts:224-248).
CREATE OR REPLACE FUNCTION public.set_report_share_token(p_report uuid, p_brand text, p_token text, p_user uuid)
RETURNS TABLE (share_token text, shared_at timestamptz, created boolean) LANGUAGE plpgsql SET search_path = public AS $$
DECLARE r reports;
BEGIN
  UPDATE reports SET share_token = p_token, shared_at = now(), shared_by = p_user
   WHERE id = p_report AND brand_key = p_brand AND reports.share_token IS NULL RETURNING * INTO r;
  IF FOUND THEN RETURN QUERY SELECT r.share_token, r.shared_at, true; RETURN; END IF;
  SELECT * INTO r FROM reports WHERE id = p_report AND brand_key = p_brand;
  IF NOT FOUND THEN RAISE EXCEPTION 'report_not_found'; END IF;
  RETURN QUERY SELECT r.share_token, r.shared_at, false;
END $$;

CREATE OR REPLACE FUNCTION public.clear_report_share_token(p_report uuid, p_brand text)
RETURNS boolean LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v integer;
BEGIN
  PERFORM 1 FROM reports WHERE id = p_report AND brand_key = p_brand;
  IF NOT FOUND THEN RAISE EXCEPTION 'report_not_found'; END IF;
  UPDATE reports SET share_token = NULL, shared_at = NULL, shared_by = NULL
   WHERE id = p_report AND brand_key = p_brand AND share_token IS NOT NULL;
  GET DIAGNOSTICS v = ROW_COUNT; RETURN v > 0;
END $$;

-- The public read: token → report and workspace state. Service role only.
CREATE OR REPLACE FUNCTION public.get_shared_report(p_token text)
RETURNS TABLE (id uuid, brand_key text, title text, summary text, skill text, updated_at timestamptz,
               website_host text, workspace_active boolean, sanitizer_version integer)
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT r.id, r.brand_key, r.title, r.summary, r.skill, r.updated_at, b.website_host, b.is_active, r.sanitizer_version
    FROM reports r JOIN customer_brands b ON b.brand_key = r.brand_key
   WHERE r.share_token = p_token
   LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.report_workspace_usage(p_brand text)
RETURNS TABLE (report_count bigint, total_bytes bigint) LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT count(*)::bigint, coalesce(sum(size_bytes), 0)::bigint FROM reports WHERE brand_key = p_brand;
$$;

ALTER TABLE public.reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.report_templates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.reports, public.report_templates FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.reports, public.report_templates TO authenticated;
GRANT ALL ON public.reports, public.report_templates TO service_role;
DROP POLICY IF EXISTS reports_read ON public.reports;
CREATE POLICY reports_read ON public.reports FOR SELECT TO authenticated USING (public.customer_can_access_brand(brand_key));
DROP POLICY IF EXISTS report_templates_read ON public.report_templates;
CREATE POLICY report_templates_read ON public.report_templates FOR SELECT TO authenticated USING (public.customer_can_access_brand(brand_key));
REVOKE ALL ON FUNCTION public.set_report_share_token(uuid,text,text,uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.clear_report_share_token(uuid,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_shared_report(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.report_workspace_usage(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_report_share_token(uuid,text,text,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.clear_report_share_token(uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_shared_report(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.report_workspace_usage(text) TO service_role;
NOTIFY pgrst, 'reload schema';
```

#### `supabase/migrations/151_f23_report_share_views.sql`

```sql
-- F23: anonymous daily view counts per public link. No IP, user agent or cookie is stored.
CREATE TABLE IF NOT EXISTS public.report_share_views (
  report_id uuid NOT NULL REFERENCES public.reports(id) ON DELETE CASCADE,
  brand_key text NOT NULL REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  day date NOT NULL,
  share_pseudonym text NOT NULL CHECK (share_pseudonym ~ '^share:[0-9a-f]{16}$'),
  browser_views integer NOT NULL DEFAULT 0 CHECK (browser_views >= 0),
  other_views integer NOT NULL DEFAULT 0 CHECK (other_views >= 0),
  PRIMARY KEY (report_id, day, share_pseudonym)
);
COMMENT ON COLUMN public.report_share_views.share_pseudonym IS '"share:" + first 16 hex of sha256(token). Identifies the link, never a person.';
CREATE INDEX IF NOT EXISTS report_share_views_day_idx ON public.report_share_views (day);

CREATE OR REPLACE FUNCTION public.record_report_view(p_report uuid, p_brand text, p_pseudonym text, p_from_browser boolean)
RETURNS void LANGUAGE sql SET search_path = public AS $$
  INSERT INTO report_share_views (report_id, brand_key, day, share_pseudonym, browser_views, other_views)
  VALUES (p_report, p_brand, (now() AT TIME ZONE 'utc')::date, p_pseudonym,
          CASE WHEN p_from_browser THEN 1 ELSE 0 END, CASE WHEN p_from_browser THEN 0 ELSE 1 END)
  ON CONFLICT (report_id, day, share_pseudonym) DO UPDATE
    SET browser_views = report_share_views.browser_views + EXCLUDED.browser_views,
        other_views = report_share_views.other_views + EXCLUDED.other_views;
$$;

CREATE OR REPLACE FUNCTION public.prune_report_share_views(p_before date, p_limit integer DEFAULT 5000)
RETURNS integer LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v integer;
BEGIN
  WITH old AS (SELECT report_id, day, share_pseudonym FROM report_share_views WHERE day < p_before LIMIT p_limit)
  DELETE FROM report_share_views s USING old
   WHERE s.report_id = old.report_id AND s.day = old.day AND s.share_pseudonym = old.share_pseudonym;
  GET DIAGNOSTICS v = ROW_COUNT; RETURN v;
END $$;

ALTER TABLE public.report_share_views ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.report_share_views FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.report_share_views TO authenticated;
GRANT ALL ON public.report_share_views TO service_role;
DROP POLICY IF EXISTS report_share_views_read ON public.report_share_views;
CREATE POLICY report_share_views_read ON public.report_share_views FOR SELECT TO authenticated
  USING (public.customer_can_access_brand(brand_key));
REVOKE ALL ON FUNCTION public.record_report_view(uuid,text,text,boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.prune_report_share_views(date,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_report_view(uuid,text,text,boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.prune_report_share_views(date,integer) TO service_role;
NOTIFY pgrst, 'reload schema';
```

**Registration:** `scripts/setup-supabase.mjs` gains `"150_f23_reports.sql": [{kind:"table",name:"reports"},{kind:"table",name:"report_templates"},{kind:"index",name:"reports_share_token_idx"},{kind:"function",name:"set_report_share_token"},{kind:"function",name:"clear_report_share_token"},{kind:"function",name:"get_shared_report"},{kind:"function",name:"report_workspace_usage"}]`, `"151_f23_report_share_views.sql": [{kind:"table",name:"report_share_views"},{kind:"function",name:"record_report_view"},{kind:"function",name:"prune_report_share_views"}]`. `tests/customer-uat.sql` gains one report, template and view row per workspace; each user sees exactly their workspace's rows.

### 6.2 Server modules

#### 6.2.1 Shared vocabulary

| File | Exports | Source |
|---|---|---|
| `src/shared/reports.ts` | `REPORT_MAX_HTML_BYTES = 500_000`, `REPORT_MAX_INPUT_BYTES = 1_000_000`, `REPORT_MAX_PER_WORKSPACE = 2_000`, `REPORT_MAX_BYTES_PER_WORKSPACE = 250_000_000`, `REPORT_DEFAULT_LIST_LIMIT = 20`, `REPORT_MAX_LIST_LIMIT = 50`, `REPORT_APP_LIST_LIMIT = 100`, `REPORT_MAX_TITLE_CHARS = 120`, `REPORT_MAX_SUMMARY_CHARS = 2_500`, `REPORT_TEMPLATE_MAX_PER_WORKSPACE = 10`, `REPORT_TEMPLATE_MAX_NAME_CHARS = 80`, `REPORT_TEMPLATE_MAX_DESCRIPTION_CHARS = 200`, `REPORT_TEMPLATE_MAX_INSTRUCTIONS_CHARS = 3_000`; types `ReportMetadata`, `ReportListItem`, `ReportDetail`, `ReportTemplate` | PORT `openseo:src/types/schemas/{reports,report-templates}.ts` (per-workspace caps replace per-project/org) |
| `src/shared/report-share.ts` | `mintShareToken()`, `sharePath(token)`, `SHARE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32}$/`, `sharePseudonym(token): Promise<string>` ("share:" + first 16 hex of SHA-256) | COPY `report-share.ts:11-20`; PORT `shareAccess.ts:23`, `raw.ts:44-53` |
| `src/shared/report-sandbox.ts` | `REPORT_IFRAME_SANDBOX`, `REPORT_CSP`, `PRINT_SCRIPT`, `PRINT_SCRIPT_SHA256`, `reportCsp(print?)`, `textResponse(body, status)`, `reportDocumentResponse(html, { print?, cacheControl, noindex? })` | COPY `report-sandbox.ts:1-130` (constants byte-identical; `PRINT_SCRIPT_SHA256` stays `uE0MLbgBgIu3I3pghlY0762kVHKlP7Udz5qzZNT7piw=` because the script text is unchanged) |

#### 6.2.2 Sanitiser — `src/server/reports/sanitize.ts`

Dependencies added to `package.json`, pinned exactly (no caret): `sanitize-html` (current 2.x release) and `htmlparser2` (the major version `sanitize-html` itself uses), plus `@types/sanitize-html` in devDependencies.

```ts
export const SANITIZER_VERSION = 1;
export type SanitizeResult = { html: string; changed: boolean; removedTags: string[]; removedAttributes: number; blockedUrls: number };
export function sanitizeReportHtml(input: string): SanitizeResult;
export function filterCss(css: string): { css: string; blocked: number };
export function auditHtml(html: string): { tags: Set<string>; eventAttributes: number; urls: string[] }; // htmlparser2 pass used for counts
```

Configuration (exact):
- `allowedTags`: `html, head, body, title, meta, style, header, footer, main, article, section, aside, nav, div, span, p, br, hr, h1, h2, h3, h4, h5, h6, ul, ol, li, dl, dt, dd, table, thead, tbody, tfoot, tr, th, td, caption, colgroup, col, figure, figcaption, blockquote, pre, code, kbd, samp, strong, b, em, i, u, s, small, sub, sup, mark, abbr, time, details, summary, a, img, svg, g, path, rect, circle, ellipse, line, polyline, polygon, text, tspan, desc, defs, lineargradient, radialgradient, stop, clippath` (lower case because the parser lower-cases; browsers restore SVG case when parsing HTML).
- `allowedAttributes`: `*`: `id, class, style, title, lang, dir, role, aria-*`; `a`: `href, target, rel, name`; `img`: `src, alt, width, height`; `td`, `th`: `colspan, rowspan, scope, headers`; `col`, `colgroup`: `span`; `time`: `datetime`; `ol`: `start, reversed, type`; `details`: `open`; `meta`: `charset, name, content`; `html`: `lang`; every SVG tag: `viewbox, width, height, xmlns, fill, fill-opacity, stroke, stroke-width, stroke-linecap, stroke-linejoin, stroke-dasharray, stroke-opacity, opacity, d, x, y, x1, y1, x2, y2, cx, cy, r, rx, ry, points, transform, text-anchor, dominant-baseline, font-size, font-weight, font-family, dx, dy, offset, stop-color, stop-opacity, gradientunits, gradienttransform, preserveaspectratio, clip-path, focusable, aria-hidden`.
- `allowedSchemes: ["http","https","mailto"]`; `allowedSchemesByTag: { img: ["data"] }`; `allowProtocolRelative: false`; `allowVulnerableTags: true` (required for `<style>`; the CSS filter and CSP neutralise it); `nonTextTags: ["script","textarea","option","noscript","iframe","object","embed","template"]` (so `<style>` text is kept and those elements' text is dropped).
- `exclusiveFilter`: drops `meta` unless it has only `charset`, or `name="viewport"` with `content`; drops `img` whose `src` does not match `^data:image/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=\s]+$` (SVG data images are excluded).
- `transformTags`: `a` → fragment links (`href` starting with `#`) keep only `href`; all others get `target="_blank"`, `rel="noopener noreferrer nofollow"`. `*` → when `style` is present, replace with `filterCss(style).css` (empty → attribute removed).
- `textFilter(text, tagName)`: `tagName === "style"` → `filterCss(text).css`.
- `filterCss` rules, in order: remove `@import …;` and `@font-face { … }` blocks; replace each `url(…)` whose argument (quotes trimmed) is not `data:image/(png|jpeg|gif|webp);base64,…` with `url()` and count it; remove declarations containing `expression(`, `behavior:` or `-moz-binding`; remove any `</` sequence.
- After sanitising: strip any leading doctype/comment the library left, prepend `<!doctype html>\n`; `changed` = output differs from the input with whitespace normalised; `removedTags` = tag names present in `auditHtml(input).tags` but not in the allowlist, sorted.

Every serve path re-sanitises documents whose `sanitizer_version < SANITIZER_VERSION` before responding and updates the row in `keepAlive` (so a sanitiser fix reaches old reports).

#### 6.2.3 Service — `src/server/reports/service.ts` (PORT `ReportService.ts`), `repository.ts` (PORT `ReportRepository.ts`), `templateService.ts`, `templateRepository.ts`

```ts
export async function saveReport(admin: SupabaseClient, p: { brandKey: string; reportId?: string; title: string; summary: string; html: string;
  skill?: string; skillVersion?: string; templateId?: string; sessionId?: string; createdBy: "assistant" | "app"; createdByUserId: string })
  : Promise<{ reportId: string; title: string; created: boolean; htmlBytes: number; sanitized: { changed: boolean; removedTags: string[] } }>;
export async function listReports(admin, i: { brandKey: string; limit: number; offset: number }): Promise<{ reports: ReportMetadata[]; totalCount: number; remaining: number }>;
export async function getReport(admin, brandKey: string, reportId: string): Promise<ReportMetadata>;
export async function getReportWithHtml(admin, brandKey: string, reportId: string): Promise<{ report: ReportMetadata; html: string }>;
export async function deleteReport(admin, brandKey: string, reportId: string): Promise<void>;
export async function shareReport(admin, i: { brandKey: string; reportId: string; userId: string }): Promise<{ shareToken: string; sharedAt: string }>;
export async function unshareReport(admin, i: { brandKey: string; reportId: string; userId: string }): Promise<{ shareToken: null; sharedAt: null }>;
export async function viewsLast30Days(admin, i: { brandKey: string; reportId: string; shareToken: string }): Promise<number>;
```

`saveReport` order (each step throws `AppError` and writes nothing):

| # | Check | Status, code, message (copy ported from `ReportService.ts:63-145`) |
|---|---|---|
| 1 | trimmed title 1–120 chars | 400 `title_too_long` "Title is {n} characters; the limit is 120. Shorten it and save again." (empty → 400 `title_required` "Give the report a title.") |
| 2 | summary 1–2,500 chars | 400 `summary_too_long` "Summary is {n} characters; the limit is 2,500. Shorten it and save again." |
| 3 | input ≤ 1,000,000 UTF-8 bytes | 400 `report_too_large` "Report is {kbUp} KB; the limit is 500 KB. Inlined images are the usual cause. Remove them and save again." |
| 4 | lower-cased trimmed input contains `<html` and ends with `</html>` | 400 `report_incomplete` "The HTML has no closing </html>; the writer stopped early. Write the whole document and save again." |
| 5 | sanitise; sanitised bytes ≤ 500,000 | 400 `report_too_large` (same copy, sanitised size) |
| 6 | `templateId` belongs to the workspace | 404 `template_not_found` "No report template {id} in this workspace. Call list_report_templates to see what exists." |
| 7 | `reportId` belongs to the workspace | 404 `report_not_found` "No report {id} in this workspace. Call list_reports, or omit reportId to create a new one." |
| 8 | no other report with the same title | 409 `report_title_taken` "A report titled '{title}' exists (id {id}). Pass reportId to update it, or change the title." |
| 9 | creating and `report_count ≥ 2,000` | 409 `report_limit` "This workspace has 2,000 reports, the limit. Delete one from the Reports page." |
| 10 | `total_bytes − existing.size_bytes + new ≤ 250,000,000` | 409 `report_storage_limit` "This workspace is storing {mb} MB of reports, the limit. Delete reports you no longer need from the Reports page." |
| 11 | write | insert (`sanitizer_version = SANITIZER_VERSION`) or update content columns only (`skill`, `skill_version`, `template_id` kept when omitted); a unique-violation race on title → `report_title_taken` |

`kbUp(bytes) = ceil(bytes/1000)`, `kbDown` floors (OpenSEO `:22-27`); numbers formatted with `Intl.NumberFormat("en-US")`.

`shareReport`: `isFeatureEnabled("report_sharing", brandKey)` false → `AppError(404, "feature_unavailable", "Public links are not available for this workspace.")`; report must exist (404 `report_not_found`); `set_report_share_token(report, brand, mintShareToken(), user)`; telemetry `report:shared` only when `created` (OpenSEO `:271-285`). `unshareReport` → `clear_report_share_token`; telemetry `report:unshared` only when it changed. `viewsLast30Days` sums `browser_views` for `(report_id, share_pseudonym = sharePseudonym(token), day ≥ today − 29)`.

`templateService.ts` (PORT `ReportTemplateService.ts:17-184`): `listReportTemplates(admin, brandKey) → { templates, remaining }`, `getReportTemplate`, `saveReportTemplate(admin, { brandKey, templateId?, name, description, instructions, createdBy: "app", createdByUserId })`, `deleteReportTemplate`. Copy (trimmed values): empty name 400 `template_name_required` "Give the template a name."; name > 80 400 `template_name_too_long` "Name is {n} characters; the limit is 80. Shorten it and save again."; empty description 400 `template_description_required` "Add a one-line description saying when to use this template. It is what the assistant reads to decide."; description > 200 400 `template_description_too_long` "Description is {n} characters; the limit is 200. It is one line saying when to use the template — move the detail into the instructions."; empty instructions 400 `template_instructions_required` "Add instructions: the audience, the sections in order, the tone, and the sign-off."; instructions > 3,000 400 `template_instructions_too_long` "Instructions are {n} characters; the limit is 3,000. A template is a brief, not the report — say the audience, the sections in order, the tone and the sign-off, and cut the rest."; unknown id 404 `template_not_found`; name clash (case-insensitive) 409 `template_name_taken` "A template named \"{name}\" exists in this workspace. Choose another name."; creating at 10 → 409 `template_limit` "This workspace has 10 report templates, the limit. Delete one from the Templates page."

#### 6.2.4 Tools — `src/server/reports/tools.ts` and `src/server/tools/catalog/reports.ts`

Shape of F22 §6.2.1. Handler context `ToolHandlerContext`.

| Tool | Input (`z.strictObject`) | Output (`z.looseObject`) | Handler |
|---|---|---|---|
| `list_reports` | `{ limit: z.int().min(1).max(50).default(20), offset: z.int().min(0).max(10000).default(0) }` | `{ reports: [{ id, title, skill, updatedAt, htmlBytes, summaryPreview }], totalCount, rowCount, remaining }` | `listReports`; `summaryPreview` = summary cut to 300 chars + "…" (OpenSEO `formatters.ts:78-79`) |
| `get_report` | `{ reportId: z.uuid(), includeHtml: z.boolean().default(false) }` | `{ report: { id, title, summary, skill, templateId, createdBy, updatedAt, htmlBytes, path, shared: boolean, html?: string } }` | `getReport`/`getReportWithHtml`; never returns the token or a URL |
| `save_report` | `{ title: z.string().min(1).max(120), summary: z.string().min(1).max(2500), html: z.string().min(1).max(1_000_000), reportId: z.uuid().optional(), skill: z.string().regex(/^[a-z][a-z0-9-]{2,59}$/).optional(), templateId: z.uuid().optional() }` | `{ reportId, title, created, htmlBytes, path, sanitized: { changed, removedTags } }` | `saveReport` with `createdBy "assistant"`, `createdByUserId ctx.userId`, `skillVersion` from the F21 manifest when `skill` names a skill, `sessionId` from `ctx.sessionId` (set by F22 for the assistant and approval sources) |
| `list_report_templates` | `{}` | `{ templates: [{ id, name, description, instructions }], remaining }` | `listReportTemplates` |

Descriptions (exact):
- `save_report`: "Save a finished, self-contained HTML report to this workspace, where the team can read and print it. New reports are private; only a person can share them from Reports. Call list_reports first and pass the reportId of the report you are redoing instead of creating a near-duplicate; a title already used in this workspace is refused. Give a specific title (the report type or subject and the full date), a summary with the verdict, the top action and the key numbers, and the skill name you are running. Scripts, forms, iframes, remote images and fonts are removed when saved. Then reply with the returned path, a one-line verdict and the top action; do not paste the report into chat."
- `list_reports`: "List this workspace's saved reports, newest first: id, title, skill, size, update time and a short summary preview. Call this before save_report so you replace the right report instead of making a near-duplicate."
- `get_report`: "Read one saved report: title, summary, skill and size. Pass includeHtml only when you must edit a specific passage; a large report is long. Reading never shares a report."
- `list_report_templates`: "List this workspace's report templates: the user's briefs for kinds of report (audience, sections, tone, sign-off). Use one only when the user names it or asks for the kind of report it describes, and pass its id to save_report."

Registrations (`catalog/reports.ts`): area `reports`, gate `reports`; `list_reports`, `get_report`, `list_report_templates` effect `read`, approval none; `save_report` effect `write`, approval `input.reportId ? { kind: "confirm", label: "Replace the report “" + (existing title) + "”" } : { kind: "none" }` (label resolves the stored title; unknown id → none, the handler then returns `report_not_found`), annotations `destructiveHint: true`; links `/portal/reports/<reportId>` or `/portal/reports`; untrusted paths `get_report`: `report.summary`, `report.html`; `list_reports`: `reports[*].summaryPreview`. Summaries: "Saved report “{title}” ({size})." / "Replaced report “{title}” ({size})."; "{rowCount} of {totalCount} reports."; "Report “{title}” ({size})."; "{n} report templates.". `size` = bytes < 1,000 → "{n} bytes", else "{round(n/1000)} KB" (OpenSEO `report-tools.ts:34-39`).

#### 6.2.5 Document routes — `src/server/reports/documentRoutes.ts` (pure handlers; route files call them)

```ts
export async function handleReportRequest(reportId: string, request: Request, deps?: DocDeps): Promise<Response>;        // /r/[reportId]
export async function handleSharedReportRequest(token: string, request: Request, deps?: DocDeps): Promise<Response>;    // /s/[token]/raw
export async function handleSharePage(token: string, request: Request, deps?: DocDeps): Promise<Response>;              // /s/[token]
export async function handleReportSocialImage(token: string, deps?: DocDeps & { render?: typeof renderReportSocialImage }): Promise<Response>; // /s/[token]/og.png
type DocDeps = { getCustomerContext?; getSupabaseAdmin?; isFeatureEnabled?; keepAlive?; now?: () => Date };
```

`handleReportRequest` (PORT `openseo:src/routes/r/$reportId.ts:23-89`):
1. `reportId` not a UUID → 404 `textResponse(NOT_FOUND_BODY, 404)`; `NOT_FOUND_BODY = "This report does not exist or you do not have access to it."`.
2. `getCustomerContext()`: `auth_not_configured` → 503 text "Sign-in is not configured."; no user → 302 `Location: /login?next=` + `encodeURIComponent("/r/" + reportId)`, `Cache-Control: private, no-store`; other error → 503 text "Could not check your access. Please retry.".
3. `select brand_key, sanitizer_version from reports where id` (service role) → none → 404. Membership `findCustomerBrand(ctx.brands, brand_key)` → none → 404. `isFeatureEnabled("reports", brand_key)` false → 404.
4. Only now read `html` (scoped by id and brand). Re-sanitise when `sanitizer_version` is old (§6.2.2).
5. `print = searchParams.get("print") === "1"`; `reportDocumentResponse(html, { print, cacheControl: "private, no-store", noindex: true })`.

`handleSharedReportRequest` (PORT `raw.ts:55-121`):
1. `!SHARE_TOKEN_PATTERN.test(token)` → 404 `textResponse("This report isn't shared.", 404)` (no query).
2. `url.search !== ""` → 302 `Location: /s/<token>/raw`, `Cache-Control: no-store`.
3. `rpc("get_shared_report", { p_token })` → none, `workspace_active` false, or `isFeatureEnabled("report_sharing", brand_key)` false → 404 "This report isn't shared.".
4. `dest = Sec-Fetch-Dest`; `dest !== null && dest !== "iframe"` → 302 `/s/<token>`.
5. Read html by id and brand (null → 404); re-sanitise when old.
6. `keepAlive(rpc("record_report_view", { p_report, p_brand, p_pseudonym: await sharePseudonym(token), p_from_browser: dest === "iframe" }))` plus telemetry `report:public_view { from_browser }` with distinct id = pseudonym and `$process_person_profile: false` once F26 exists.
7. `reportDocumentResponse(html, { cacheControl: "public, max-age=0, s-maxage=60", noindex: true })`.

`handleSharePage` → §6.2.6. `handleReportSocialImage` (PORT `og[.]png.ts:9-38`): steps 1 and 3 of the raw handler; then `render(title, website_host)`; any throw → `console.error("[reports] social image failed")` and 500 `text/plain` "Preview image unavailable." with `Cache-Control: no-store`, `X-Robots-Tag: noindex, nofollow`.

Route files (all `export const dynamic = "force-dynamic"`, `runtime = "nodejs"`, GET only):
- `src/app/r/[reportId]/route.ts` → `handleReportRequest(params.reportId, request)`.
- `src/app/s/[token]/route.ts` → `handleSharePage`.
- `src/app/s/[token]/raw/route.ts` → `handleSharedReportRequest`.
- `src/app/s/[token]/og.png/route.tsx` → `handleReportSocialImage(params.token, { render: renderReportSocialImage })` from `src/server/reports/ogImage.tsx`.

#### 6.2.6 Share wrapper — `src/server/reports/sharePage.ts` (PORT `sharePage.tsx:12-260`)

Rendered to a string with an `escapeHtml` helper (`&`, `<`, `>`, `"`, `'`) applied to every interpolated value; no React and no app bundle. Exports `renderSharePageHtml(i: { title; description; canonical; imageUrl; token; updatedAgo }): string`, `renderUnavailableHtml(heading, detail): string`, `SHARE_SCRIPT`, `SHARE_SCRIPT_SHA256` (base64 SHA-256 of `SHARE_SCRIPT`, hardcoded; the test recomputes it), `WRAPPER_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; frame-src 'self'; script-src 'sha256-" + SHARE_SCRIPT_SHA256 + "'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"`, `shareDescription(summary)` (COPY `:32-41`, 200 chars), `formatUpdatedAgo(iso, now)`.

- Head: `<meta charset="utf-8">`, viewport, `<meta name="robots" content="noindex, nofollow">`, `<title>{title} · Perceev</title>`, OG `og:type article`, `og:site_name Perceev`, `og:title`, `og:description` and `description` (when present), `og:url` = canonical (`<request origin>/s/<token>`), `og:image` = `<canonical>/og.png?v=<encodeURIComponent(updatedAt)>`, `og:image:width 1200`, `og:image:height 630`, `og:image:alt "{title} · Perceev"`, `twitter:card summary_large_image`, `twitter:title`, `twitter:image`, `twitter:image:alt`; `<link rel="icon" href="/favicon.ico">`; inline styles = OpenSEO's `STYLES` (`:46-67`) with `--primary: #3730CE` (light) and `#5B54F0` (dark).
- Body: `<header>` with `<h1>{title}</h1>` and `<p class="meta">Made with Perceev · Updated {updatedAgo}</p>`; actions: `<button class="btn" id="share"><svg…/><span>Share</span></button>` and `<a class="btn primary" href="https://perceev.com/?utm_source=shared_report" target="_blank" rel="noopener noreferrer">Try Perceev</a>`; `<iframe src="/s/<token>/raw" sandbox="{REPORT_IFRAME_SANDBOX}" referrerpolicy="no-referrer" title="{title}">`; `<script>{SHARE_SCRIPT}</script>` (COPY `:71-81`, attribute-free).
- `formatUpdatedAgo`: < 60 min → "{m} min ago" ("just now" under 1); < 24 h → "{h} h ago"; 1 day → "yesterday"; else "{d} days ago"; ≥ 365 days → "on {MMM d, yyyy}".
- Dead ends (404, same headers, no report title anywhere): unknown/revoked/off → heading "This report isn't shared." detail "The link may have been turned off, or the report may have been deleted."; inactive workspace → heading "This report isn't available." detail "Its workspace is no longer active." Both show the "Try Perceev" button.
- Headers: `Content-Type: text/html; charset=utf-8`, `Cache-Control: no-store`, `Content-Security-Policy: WRAPPER_CSP`, `X-Robots-Tag: noindex, nofollow`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`.

#### 6.2.7 Social image — `src/server/reports/ogImage.tsx`

`renderReportSocialImage(title: string, host: string | null): Promise<Response>` using `ImageResponse` from `next/og` (PORT of `reportSocialImage.tsx:6-89`, takumi-js replaced): 1200×630, background `#ffffff`, text `#0a0a0a`; top-left mark: 64×64 `div` with `borderRadius: 14`, `background: linear-gradient(135deg, #3730CE, #5B54F0)`, then the wordmark "perceev" (34 px, weight 700, letter-spacing −1); title centred vertically, font size 80/64/54 by length (> 48, > 85 chars, as OpenSEO `:42`); host bottom-right (24 px, `#65716b`, ellipsis). Default bundled font (no network). Headers `Cache-Control: no-store`, `X-Robots-Tag: noindex, nofollow`, `X-Content-Type-Options: nosniff`. No remote assets.

#### 6.2.8 Generate from template and prompt block

- `src/server/reports/generate.ts`: `startReportGeneration(ws: Workspace, i: { templateId: string }, deps?) → { sessionId, path }`: flags `reports`, `report_generate`, `assistant` (any off → 404 `feature_unavailable`); template must exist (404 `template_not_found`); F22 `createSession(admin, { brandKey, userId, kickoff: { kind: "generate_report", templateId } })` then `renameSession` to `("Report: " + name).slice(0, 80)`; `path = "/portal/assistant?s=" + sessionId`. Telemetry `report:generate_start {}`.
- `src/server/reports/kickoff.ts` (imported for side effect from F22's `src/server/assistant/kickoffKinds.ts`): `registerKickoff("generate_report", build)`; `build` loads the template (missing → `AppError(409, "template_not_found", "This report template was deleted. Choose another one.")`) and returns `label = "Generate a report from “{name}”"` and `text` (exact):
  ```text
  Write a report using the report template “{name}” (id {id}). First call activate_skill with "seo-report". The template is the user's brief: follow its audience, sections, tone and sign-off.
  <report_template>
  {instructions}
  </report_template>
  Gather the data the template needs with your tools (paid lookups will ask the user first), then save the report with save_report, passing templateId "{id}". If something the template asks for is not available, say so in the report instead of inventing it.
  ```
- `src/server/reports/promptBlock.ts`: `buildTemplatesBlock(admin, brandKey): Promise<string | null>` → `null` when `reports` is off or there are no templates; else `"Report templates are the user's briefs for reports. Use one only when the user names it or asks for the kind of report it describes; pass its id to save_report as templateId.\n<report_templates>\n" + lines "- {name} (id {id}): {description}" + "\n</report_templates>"`. F22's `runAssistantTurn` passes it as `templatesBlock` (one-line edit in `turn.ts`), placed after `</workspace_memory>`.

#### 6.2.9 The `seo-report` skill — `src/assistant/skills/seo-report/SKILL.md` (PORT of `openseo:.agents/skills/seo-report/SKILL.md:1-264`)

Frontmatter: `name: seo-report`, `description: "Write and save a Perceev report as one self-contained HTML page. Use when a workflow has finished its research and the user wants a report, and whenever the user asks for a report, check-in or summary, or names a report template."`, `version: 1.0.0`, `source: openseo:.agents/skills/seo-report/SKILL.md@c5f8db1`, `tools: [save_report, list_reports, get_report]`, `optional_tools: [list_report_templates]`. Port recipe (headings in order: Goal · Before you write · Following a template · Writing rules · Title and summary · The closing section · HTML constraints · Sharing · After you save · Starter template · The primitives · Guardrails):
- F21 global edits E2, E5, E6, E9 apply (E3/E4 do not: this skill is the delivery).
- "Following a template": templates come from `list_report_templates` or the `<report_templates>` block; keep `:24` rules.
- "The closing section": the fixed line becomes `<p>Generated by the Perceev {Workflow title} workflow, run by the Perceev assistant on MONTH D, YYYY.</p>` (no external link); delete `:52` (docs URL rule).
- "HTML constraints": keep `:58-65` except: delete the backtick/`${` rule (`:63`, Codex-specific); replace "Every request from a saved report is blocked" with "Perceev removes scripts, forms, iframes, remote images and web fonts when it saves a report, and blocks any request a report tries to make"; keep "Links open in a new tab" and add "Perceev adds `target` and `rel` for you".
- "Public sharing" (`:67-75`) becomes "Sharing": "Reports are private when saved. Only a person can make a report public, from the report's Share button. Never tell the user a report is public, and never present the app link as a public link."
- "After you save": keep `:79-81`; the link line is `Read the full report: <path>`.
- Starter template: copy `:87-243` with `REPORT TITLE` placeholders unchanged, footer `Prepared with Perceev. Data as of MONTH D, YYYY.`, the closing paragraph as above.
- Guardrails `:258-264`: keep; delete "do not offer to write it to a local file instead" clause's file part (no filesystem) by replacing it with "do not paste the report body into chat".

### 6.3 Jobs

| Kind / periodic | Trigger | Steps | Completion |
|---|---|---|---|
| periodic `reports.retention` | `definePeriodic({ name: "reports.retention", everySeconds: 86400 })` → `enqueueSystemJob("reports.retention", {}, { dedupeKey: "reports.retention:" + YYYY-MM-DD })` | `prune-1`…`prune-20` (`DB_STEP`): `prune_report_share_views(today − 395 days, 5000)` while 5,000 deleted | `completed` `{ views }` |

Registered in `src/server/reports/jobs.ts`; `src/server/jobs/kinds.ts` gains `import "../reports/jobs.ts";`.

### 6.4 Provider calls and cost

None in F23 code. Generating a report is one or more F22 assistant turns (`assistant.turn`, capped per turn) plus any paid lookups the user approves on cards. OG images render locally (no network). Fixtures: `tests/fixtures/f23/` (§9).

### 6.5 API routes

Customer routes: `src/app/api/customer/reports/**/route.ts`, `requireWorkspace`, `isFeatureEnabled("reports", brandKey)` false → 404 `feature_unavailable` "This page is not available for your workspace yet.", `toErrorResponse`, `Cache-Control: no-store`, contracts in `src/server/reports/reports.contract.ts`. Members and owners have the same rights (OpenSEO parity).

**`GET /api/customer/reports?brand_key=&limit=`** query `z.strictObject({ brand_key?, limit: z.coerce.number().int().min(1).max(100).default(100) })` → 200
```json
{ "reports": [ { "id": "1f0c…", "title": "AI Visibility Audit — Oct 22, 2026", "skill": "ai-visibility-audit", "skillTitle": "AI Visibility Audit",
  "templateId": null, "templateName": null, "createdBy": "assistant", "createdByYou": true, "htmlBytes": 21480, "shared": false,
  "createdAt": "2026-10-22T09:00:00.000Z", "updatedAt": "2026-10-22T09:00:00.000Z" } ] }
```
(`skillTitle` from the F21 manifest; `templateName` resolved within the workspace; no `html`, no `summary`, no token.)

**`GET /api/customer/reports/[reportId]?brand_key=`** → 200 `{ "report": { …list fields…, "shareToken": "abc…32 chars" | null, "sharedAt": "…" | null, "views30d": 4 | null, "chatPath": "/portal/assistant?s=…" | null } }` (`chatPath` only when the session exists and belongs to the caller). 404 `report_not_found`.

**`DELETE /api/customer/reports/[reportId]`** body `{ brand_key? }` → 200 `{ "reportId": "1f0c…", "deleted": true }`; 404 `report_not_found`.

**`POST /api/customer/reports/[reportId]/share`** body `z.strictObject({ brand_key?, public: z.boolean() })` → 200 `{ "shareToken": "…", "sharedAt": "…" }` or `{ "shareToken": null, "sharedAt": null }`. Errors: 404 `feature_unavailable` (sharing off), `report_not_found`.

**`GET /api/customer/reports/templates?brand_key=`** → `{ "templates": [ { "id", "name", "description", "instructions", "createdAt", "updatedAt" } ], "remaining": 9 }`.

**`POST /api/customer/reports/templates`** body `z.strictObject({ brand_key?, name: z.string().max(200), description: z.string().max(400), instructions: z.string().max(6000) })` (shape only; the service owns the caps and copy) → 201 `{ "templateId": "…", "created": true }`. **`PUT /api/customer/reports/templates/[templateId]`** same body → 200 `{ "templateId": "…", "created": false }`. **`DELETE /api/customer/reports/templates/[templateId]`** → 200 `{ "templateId": "…", "deleted": true }`. Errors per §6.2.3.

**`POST /api/customer/reports/generate`** body `z.strictObject({ brand_key?, templateId: z.uuid() })` → 201 `{ "sessionId": "…", "path": "/portal/assistant?s=…" }`. Errors 404 `feature_unavailable`, `template_not_found`.

Document routes (§6.2.5): `GET /r/[reportId]`, `GET /s/[token]`, `GET /s/[token]/raw`, `GET /s/[token]/og.png`. They are page-level route handlers, outside `/api`, so the middleware (`matcher: ["/api/:path*"]`) and the operator perimeter never see them; `/r` authenticates itself, `/s` is authorised by the token.

### 6.6 UI

Pages `src/app/portal/reports/page.tsx`, `src/app/portal/reports/[reportId]/page.tsx`, `src/app/portal/reports/templates/page.tsx`; components in `src/components/portal/reports/`. Built from F04 (`PageHeader`, `BackLink`, `EmptyState`, `QueryError`, `ConfirmDialog`, `RowActionsMenu`, `SkeletonPage`, `SkeletonTableRows`, `Table`/`TableCard`, `Badge`, `Button`, `Dialog`, `Field`, `Input`, `Textarea`, `Switch`, `Select`, `Alert`, `DropdownMenu`, `Tooltip`) and F05 (`fetchJson`, `withBrand`, keys, `useWorkspace()`); forms with TanStack Form (as OpenSEO's `useAppForm`). Query keys added to `src/shared/query/keys.ts`: `reports: (brandKey) => ["reports", brandKey]`, `report: (reportId) => ["report", reportId]`, `reportTemplates: (brandKey) => ["reportTemplates", brandKey]`; `staleTime: 0` on all three (OpenSEO `shared.tsx:33-35`).

| File | Source |
|---|---|
| `ReportsList.tsx` | PORT `ReportsList.tsx:20-99` |
| `ReportViewer.tsx` | PORT `ReportViewer.tsx:21-56` |
| `ShareReportDialog.tsx`, `DeleteReportDialog.tsx`, `hooks/useReports.ts` (`useDeleteReport`) | PORT `shared.tsx:36-253` |
| `FullScreenReport.tsx` | PORT `$reportId.tsx:300-346` |
| `ReportTemplatesList.tsx`, `ReportTemplateForm.tsx` | PORT `ReportTemplatesList.tsx:17-86`, `ReportTemplateForm.tsx:18-150` |
| `GenerateReportDialog.tsx` | new |
| `formatWrittenBy.ts` (pure) | PATTERN `shared.tsx:45-54` |

**Reports page** (`/portal/reports`): `PageHeader` title "Reports", description "Reports the assistant wrote for {display_name}. Open one to read, print or share it.", actions: ghost `Button` "Templates" → `/portal/reports/templates`; primary `Button` "Generate report" (`Sparkles`) when `report_generate` and `assistant` are on.
- Loading: `SkeletonTableRows rows={6}`. Error: `QueryError` "Failed to load reports" with Retry.
- Empty: `EmptyState icon={FileText} title="No reports yet" description="Ask the assistant for a report, or generate one from a template."` actions "Open assistant" (→ `/portal/assistant`, when `assistant` on) and "Generate report".
- Table (`TableCard`): Title (link) · Written by (`formatWrittenBy`: "Assistant · you", "Assistant · a teammate", "Perceev app") · Type (`templateName ?? skillTitle ?? "—"`) · Sharing (`Badge` "Public" with `Globe` when shared, muted "Private" otherwise) · Updated (relative, `title` = full date) · row menu (Open, Delete). Footer when 100 rows: "Showing the 100 most recent reports."

**Detail page** (`/portal/reports/[reportId]`): `BackLink` "Reports"; `PageHeader` title = report title; description `dl`: "Written by", "Type", "Updated". Actions: `Button` "Share" (icon `Globe` when shared, `Lock` when private; only when `report_sharing` on) else `Button` "Export"; `DropdownMenu` (aria-label "Report actions"): "Export to PDF" (opens `/r/<id>?print=1` in a new tab, `noopener`), "Open the chat that wrote this" (when `chatPath`), separator, "Delete" (destructive). Viewer `ReportViewer src="/r/<id>"` with the document-shaped skeleton until `onLoad`; floating controls top-right: "Full screen" (`?full=1`, replace) and "Open in new tab" (`/r/<id>`, `target="_blank" rel="noreferrer"`). Full screen: fixed overlay with title and focused "Exit" button; Esc exits (OpenSEO `$reportId.tsx:300-326`).
- Loading: `SkeletonPage`. Not found (404): `QueryError variant="page" title="Report not found" fallback="This report does not exist or you do not have access to it."` (no retry). Other error: `QueryError variant="page" title="Couldn't load the report"` with Retry.

**Share dialog** (`DialogContent className="sm:max-w-lg"`): title "Share", description = report title (truncate). Bordered box: `Field` horizontal with label "Public link" and `Switch` (follows the click while pending; disabled while pending).
- Private (off): description "Only members of this workspace can open it." plus `Alert variant="info"`: "Check the report before you share it. It was written by an AI assistant from your data and from other websites."
- Public (on): description "Anyone with the link can view. No sign-in needed."; row with read-only `Input` (selects on focus, `aria-label="Share link"`), icon button "Open link", button "Copy link" (toast "Link copied"; failure "Clipboard not available"); muted text "Shows the latest saved version. Hidden from search engines. Link created {relative}." and "Opened {views30d} times in the last 30 days." (omitted when `views30d` is null).
- Turning off: description becomes "Only members of this workspace can open it. A link that was public can keep loading for up to a minute."
- Error: inline `text-destructive` with the API error ("Failed to update sharing" fallback).

**Delete dialog:** `ConfirmDialog title="Delete “{title}”?" confirmLabel="Delete report" destructive` body "This cannot be undone. A public link stops working." On success toast "Report deleted", invalidate list, remove the detail query, `router.replace("/portal/reports")` from the detail page.

**Templates page** (`/portal/reports/templates`): `BackLink` "Reports"; `PageHeader` title "Report templates", description "Reusable briefs the assistant follows when it writes a report: who it is for, which sections it has, and how it should sound.", action "New template" (`Plus`; disabled with tooltip "You have 10 templates, the limit." when `remaining === 0`). Empty: `EmptyState icon={LayoutTemplate} title="No templates yet" description="A template is a reusable brief for a kind of report: who it is for, which sections it has, how it sounds."`. Table: Name (button opens edit) · Description · Updated · menu (Generate report — when allowed; Edit; Delete). Delete confirm: "Delete “{name}”?" body "Reports already written from it are not affected." confirm "Delete template".
- **Form dialog** (`sm:max-w-2xl`, `showCloseButton={false}`): title "New template"/"Edit template"; fields "Name" (placeholder "Monthly client check-in"), "Description" (help "One line saying when to use it. This is what the assistant reads to decide."; placeholder "The monthly update we send retainer clients."), "Instructions" (help "Brand voice for the whole workspace lives in Context › Writing preferences."; `Textarea h-56 font-mono md:text-xs`; placeholder exactly:
  ```text
  Audience: the client's marketing lead, not technical.
  Sections, in order: Where we are / What we did this month / What moved in AI answers / What to expect next.
  Tone: plain and confident. Explain every term. No exclamation points.
  Sign off as: Acme Studio
  Accent: #3730CE
  ```
  ). Client validation (trimmed, non-empty) with OpenSEO's messages; server refusals show in a toast. Buttons "Cancel" / "Create template" | "Save changes"; toasts "Template created" / "Template saved".

**Generate dialog** (`GenerateReportDialog`): title "Generate a report"; `Select` "Template" listing templates (preselected when opened from a template row); text "The assistant reads your workspace data and writes the report. It may ask you to approve paid lookups. Each assistant reply uses up to {formatUsd(turnMaxUsd)} (from `/api/customer/assistant/config`)."; buttons "Start" (pending "Starting…") and "Cancel". No templates → body "Create a template first. It tells the assistant who the report is for and which sections it needs." with button "New template". Success → `router.push(path)`. Errors inline (`describeError`).

**Phone:** tables scroll inside their card; header actions wrap; the viewer fills the width with `min-h-[70dvh]`; dialogs use `fullScreenOnMobile`; share link input wraps onto its own line (OpenSEO `shared.tsx:203-229`).

**Accessibility:** iframe `title` = report title; full screen focuses Exit; the share switch has `aria-describedby`; menus have labels; no information conveyed by colour alone (Public badge has text).

**Registrations:** `src/components/app/navigation/items.ts` group `tools`: `{ id: "reports", label: "Reports", href: "/portal/reports", icon: FileText, flag: "reports" }` (after Assistant). `src/server/features/names.ts`: `reports: { spend: [] as const }`, `report_sharing: { spend: [] as const }`, `report_generate: { spend: ["assistant.turn"] as const }`; `src/server/features/clientFeatures.ts` appends all three. `src/shared/theme/theme.ts` `APP_SURFACES` appends `{ prefix: "/r", theme: "light" }`. `src/shared/assistant-tools.ts` (F22) adds `TOOL_PRESENTATION` for the four tools (`list_reports` table: Title, Skill, Updated; `get_report` keyValue: Title, Skill, Size, Updated; `save_report` keyValue: Title, Created, Size, Changes on save; `list_report_templates` table: Name, Description). `src/server/tools/names.ts`: move the four names into `TOOL_NAMES`; `PLANNED_TOOL_NAMES = [] as const`.

### 6.7 Permissions, privacy, observability, threat model

**Permissions.** Members and owners can list, read, delete, share and generate reports and manage templates in their workspace. Public links are readable by anyone holding the token while `report_sharing` is on for the workspace and the workspace is active.

**Threat model.** Assets: workspace data inside reports (scan results, Search Console and Analytics figures, competitor research); the app's session cookies; public links. Adversaries: injected instructions in AI answers, crawled pages, SERP titles or reviews that the assistant copies into a report; an anonymous internet user holding or guessing a link; link-preview bots and search engines; a member of another workspace.

| # | Threat | Mitigation | Verified by |
|---|---|---|---|
| T1 | Stored XSS against the app origin through report HTML | Allowlist sanitiser at save (and re-sanitise on version bump); CSP `sandbox` (opaque origin, no `allow-same-origin`, no `allow-scripts`) on both document routes; iframe `sandbox` attribute; `nosniff`; HTML read only by the two document routes | AC-06, AC-07, AC-23 |
| T2 | Navigation or phishing inside the frame (`meta refresh`, forms, top navigation, `base`) | `meta http-equiv` and `base`, `form`, `input`, `button` removed; sandbox without `allow-top-navigation`/`allow-forms`; CSP `form-action 'none'`, `base-uri 'none'`; the wrapper states "Made with Perceev" and links leave in new tabs | AC-06, AC-07 |
| T3 | Exfiltration or tracking from a report (images, fonts, CSS, beacons) | CSP `default-src 'none'`, `img-src data:`, `font-src data:`, `connect-src 'none'`; sanitiser drops remote images, `@import`, `@font-face`, non-data `url()` | AC-06, AC-23 |
| T4 | Clickjacking / framing of our pages by others | raw document `frame-ancestors 'self'`; wrapper `frame-ancestors 'none'` and `X-Frame-Options: DENY` | AC-07, AC-13 |
| T5 | Guessing or enumerating links | 192-bit tokens from `crypto.getRandomValues`; shape check before any query; one 404 body for every dead end; revoked links do not confirm they existed | AC-10, AC-11, AC-13 |
| T6 | Revoked link keeps working | revoke nulls the token; raw cached at most 60 s at the edge (dialog says "up to a minute"); wrapper and image `no-store` | AC-11, AC-13, AC-14 |
| T7 | Search-engine indexing | `X-Robots-Tag: noindex, nofollow` on `/s/*` and `/r/*` (route headers and `next.config.mjs`), `meta robots` in the wrapper, not in the sitemap; `/s` deliberately **not** disallowed in robots.txt so crawlers and preview bots can see the `noindex` and the OG tags (a disallowed URL can still be indexed from links without its noindex being read); `/r` disallowed (auth-only) | AC-15 |
| T8 | Token leakage through `Referer` | `Referrer-Policy: no-referrer` on all share responses; iframe `referrerpolicy="no-referrer"`; report links get `rel="noopener noreferrer nofollow"` | AC-07, AC-13 |
| T9 | Poisoned report shared publicly (injected text published) | sharing is a human action only (no assistant tool); the share dialog asks the user to check the report; reports render text as text (no scripts) | AC-16, browser check |
| T10 | Cross-tenant read of `/r/<id>` | membership checked before reading HTML; one 404 body for missing and foreign; RLS on tables | AC-09, RLS test |
| T11 | Reverse tabnabbing through `target=_blank` | `rel="noopener"` forced; `Cross-Origin-Opener-Policy: same-origin` on documents | AC-06, AC-07 |
| T12 | Cache-busting request floods | query strings on raw bounce to the bare path before any query; shape check first | AC-11 |
| T13 | Preview image leaks after revoke | image route re-checks the token each request; `no-store` | AC-14 |
| T14 | Storage abuse | 500 KB per document, 1 MB input ceiling, 2,000 reports and 250 MB per workspace | AC-02, AC-04 |
| T15 | Print script abused | one hash-locked script, appended last without attributes (dangling tags cannot absorb attributes) | AC-08 |
| T16 | Auth bypass assumptions | `/r` and `/s` are outside the middleware matcher by design; `/r` authenticates itself; `/s` is authorised by the token; robots rules are never treated as access control (R20-03) | AC-09, AC-15 |
| T17 | Wrapper XSS through title or summary | every interpolated value HTML-escaped; wrapper CSP allows only the hashed share script | AC-13 |

**Privacy.** View counts store a per-link pseudonym, day and two counters only. Report HTML is customer content: it is never logged. Allowed log lines: `[reports] social image failed`, `[reports] view record failed { reportId }`, `[reports] resanitize failed { reportId }`.

**Telemetry events** (names for F26; until then `src/server/reports/telemetry.ts` (exports `setReportEventTracker(fn)`; no-op until F26 wires it, F26 §6.2.7) is a no-op sink):

| Event | Props |
|---|---|
| `report:saved` (server) | `{ skill, used_template, size_bytes, is_update, sanitized_changed, source: "assistant" }` |
| `report:opened` (client) | `{ skill }` |
| `report:exported_pdf` (client) | `{}` |
| `report:shared`, `report:unshared` (server) | `{ skill }` |
| `report:deleted` (client) | `{}` |
| `report:public_view` (server; distinct id = share pseudonym; `$process_person_profile: false`) | `{ from_browser }` |
| `report_template:saved` (client) | `{ is_update }` |
| `report_template:deleted` (client) | `{}` |
| `report:generate_start` (server) | `{}` |

### 6.8 Deviations from conventions

1. **Public routes outside `/api` and the portal**, fixed by conventions §12 (`/r/[reportId]`, `/s/[token]`, `/s/[token]/og.png`) plus `/s/[token]/raw` (the framed document, as OpenSEO).
2. **`/s` is noindexed but not robots-disallowed** (reason in T7). `publicSite.js` gains a separate `NOINDEX_ROUTE_PREFIXES` list rather than adding `/s` to `PRIVATE_ROUTE_PREFIXES`.
3. **`report_share_views` has no user** and is written by an unauthenticated request (through a service-role function after the token check).
4. **HTML stored in a column** (≤ 500 KB) rather than Storage, as OpenSEO (one store, cascade deletes, simple authorisation).

## 7. Code reuse map

| OpenSEO source | Perceev target | Mode | Adaptation notes |
|---|---|---|---|
| `openseo:src/db/reports.schema.ts:11-85`, `report-templates.schema.ts:5-43` | `supabase/migrations/150_f23_reports.sql` | PORT | Drizzle → SQL; workspace instead of project; `created_by` enum; `sanitizer_version`, `skill_version`, `session_id`, `shared_by` added; content-only `updated_at` trigger. |
| `openseo:src/types/schemas/reports.ts:5-70`, `report-templates.ts:5-26` | `src/shared/reports.ts` | PORT | Per-workspace caps (2,000 reports, 250 MB); input ceiling added. |
| `openseo:src/shared/report-share.ts:5-20` | `src/shared/report-share.ts` | COPY | Adds `SHARE_TOKEN_PATTERN` (from `shareAccess.ts:23`) and `sharePseudonym` (from `raw.ts:44-53`). |
| `openseo:src/shared/report-sandbox.ts:1-130`, `report-sandbox.test.ts:4-17` | `src/shared/report-sandbox.ts` (+ test) | COPY | Byte-identical constants; parity test. |
| `openseo:src/server/features/reports/services/ReportService.ts:22-326` (+ `ReportService.test.ts` cases `:61-276`) | `src/server/reports/service.ts` (+ test) | PORT | Sanitise before size; per-workspace caps; feature flag instead of hosted mode; ported test cases kept. |
| `openseo:src/server/features/reports/repositories/ReportRepository.ts:1-276` (+ `ReportRepository.query.test.ts:75-178`) | `src/server/reports/repository.ts`; SQL functions in 150 | PORT | Race-safe mint as a SQL function; DB group ports the two race cases. |
| `openseo:src/server/features/reports/services/ReportTemplateService.ts:17-184`, `ReportTemplateRepository.ts:1-113` (+ `ReportTemplateService.test.ts:53-115`) | `src/server/reports/templateService.ts`, `templateRepository.ts` (+ test) | PORT | Copy adjusted ("assistant" for "agent"). |
| `openseo:src/server/features/reports/shareAccess.ts:8-23` | `src/server/reports/documentRoutes.ts` | PORT | Per-workspace `report_sharing` flag after the token lookup. |
| `openseo:src/routes/r/$reportId.ts:10-105` (+ `reportRoute.test.ts:48-172`) | `documentRoutes.ts` `handleReportRequest`, `src/app/r/[reportId]/route.ts` | PORT | Supabase session; `/login?next=`; noindex added. |
| `openseo:src/routes/s/$token/raw.ts:12-132` (+ `shareRawRoute.test.ts:69-157`) | `handleSharedReportRequest`, `src/app/s/[token]/raw/route.ts` | PORT | View counts stored in Postgres as well as telemetry. |
| `openseo:src/server/features/reports/sharePage.tsx:12-260` (+ `sharePage.test.ts:36-124`) | `src/server/reports/sharePage.ts`, `src/app/s/[token]/route.ts` | PORT | String template with escaping instead of JSX; wrapper CSP and frame headers added; Perceev copy and colours. |
| `openseo:src/routes/s/$token/og[.]png.ts:9-46`, `reportSocialImage.tsx:6-89` (+ `shareImageRoute.test.ts:33-99`) | `handleReportSocialImage`, `src/server/reports/ogImage.tsx`, `src/app/s/[token]/og.png/route.tsx` | PORT | `next/og` `ImageResponse` instead of takumi-js; Perceev mark drawn with CSS; 500 instead of a marketing-card redirect. |
| `openseo:src/serverFunctions/reports.ts:20-136`, `reportTemplates.ts:7-69` | `src/app/api/customer/reports/**/route.ts` | PORT | Routes with `requireWorkspace`; written-by labels instead of user names. |
| `openseo:src/server/mcp/tools/report-tools.ts:59-414`, `report-template-tools.ts:28-60` | `src/server/reports/tools.ts` | PATTERN | No delete, no sharing, no template writes for the assistant; never returns tokens. |
| `openseo:src/server/mcp/tools/report-sharing-tools.ts:19-84` | none | — | Deliberately not ported (sharing is UI-only). |
| `openseo:src/client/features/reports/{ReportsList,ReportViewer,shared,ReportTemplateForm,ReportTemplatesList}.tsx` | `src/components/portal/reports/*` | PORT | Next routing; F04/F05 primitives; Perceev copy; views count. |
| `openseo:src/routes/_app/p/$projectId/reports/{index,$reportId,templates}.tsx` | `src/app/portal/reports/**/page.tsx` | PORT | Generate button and dialog added. |
| `openseo:.agents/skills/seo-report/SKILL.md:1-264` | `src/assistant/skills/seo-report/SKILL.md` | PORT | §6.2.9 recipe. |

## 8. Implementation plan

Branches `feat/f23-reports-and-sharing-p<n>`.

### Phase 1 — Storage, sanitiser and service

**Goal:** reports and templates can be saved, listed, shared and deleted through the service with every guard.

- [x] **P1.T1 Migrations**
  - [x] **P1.T1.S1** *Files:* `supabase/migrations/150_f23_reports.sql`, `151_f23_report_share_views.sql` (§6.1 verbatim), `scripts/setup-supabase.mjs`. *Verify:* `node scripts/qa/check-f23-db.mjs --group schema` → passed (applies 001–151, reapplies 150–151).
  - [x] **P1.T1.S2** *Files:* `README.md` (rows `150_f23_reports` "Assistant-written HTML reports and report templates; race-safe share tokens." and `151_f23_report_share_views` "Anonymous daily view counts per public report link."), `docs/OPERATOR_LEDGER.md` § C ("apply 150 and 151 before deploying F23"), `docs/PROD_MIGRATIONS.md` (two bullets; pre-check `select to_regclass('public.reports')`). *Verify:* `node --test src/server/docStatus.test.mjs src/server/migrationsRunner.test.mjs` → pass.
  - [x] **P1.T1.S3** *Files:* `tests/customer-uat.sql`. *Do:* rows per workspace; isolation assertions. *Verify:* CI "customer database isolation" → green.
  - [x] **P1.T1.S4** *Files:* `scripts/qa/check-f23-db.mjs`. *Do:* groups `reports` (title unique; size check constraint; content trigger bumps `updated_at`, share changes do not; attribution immutable), `sharing` (two concurrent `set_report_share_token` → same token, one `created`; clear then set → new token; foreign brand → `report_not_found`), `views` (increments by day and pseudonym; browser vs other), `retention` (prune before date), `rls`. *Verify:* `node scripts/qa/check-f23-db.mjs` → all passed (F23-AC-04, 05, 10, 12, 25 DB parts).
- [x] **P1.T2 Shared files and sanitiser**
  - [x] **P1.T2.S1** *Files:* `src/shared/reports.ts`, `src/shared/report-share.ts` (COPY header), `src/shared/report-share.test.ts`, `src/shared/report-sandbox.ts` (COPY header), `src/shared/report-sandbox.test.ts`. *Do:* §6.2.1; tests: token 32 chars, alphabet, 1,000 tokens unique; pseudonym format and ≠ token; OpenSEO hash test; `reportCsp(false) === REPORT_CSP`; `reportCsp(true)` contains `allow-scripts allow-modals` and the hash; `withPrintScript` splice before `</body>`, before `</html>`, appended; dangling `<script src="x" ` document gives the tag no attributes. *Verify:* `node --test src/shared/report-share.test.ts src/shared/report-sandbox.test.ts` → pass (F23-AC-08, AC-10 unit).
  - [x] **P1.T2.S2** *Files:* `package.json` (`sanitize-html`, `htmlparser2`, `@types/sanitize-html`, exact versions), `src/server/reports/sanitize.ts`, `src/server/reports/sanitize.test.ts`, corpus `tests/fixtures/f23/sanitize/*.html` (40 cases: script tag, `onload`, `onerror` on img, `javascript:` href, `vbscript:`, `data:text/html` href, SVG with `<script>`, SVG `<foreignObject>`, SVG `<use href>`, `<animate onbegin>`, `<iframe>`, `<object>`, `<embed>`, `<form action>`, `<input>`, `<button formaction>`, `<base href>`, `<meta http-equiv=refresh>`, `<link rel=stylesheet>`, remote `<img src>`, `srcset`, data PNG image (kept), data SVG image (dropped), CSS `@import`, CSS remote `url()`, CSS data `url()` (kept), `expression()`, `behavior:`, `-moz-binding`, style attribute with remote url, `</style><script>` breakout, mixed-case `<ScRiPt>`, HTML comments with conditional comments, entity-encoded `javascript&colon;`, `target=_top` link (rewritten), fragment link (kept without target), `mailto:` (kept), the starter template from §6.2.9 (unchanged except doctype and link rel), a 450 KB document, idempotence on all). *Verify:* `node --test src/server/reports/sanitize.test.ts` → pass (F23-AC-06).
- [x] **P1.T3 Service**
  - [x] **P1.T3.S1** *Files:* `src/server/reports/repository.ts`, `templateRepository.ts` (PORT headers), `service.ts`, `templateService.ts` (PORT headers), `memoryStore.ts` (in-memory repository for tests), `service.test.ts`, `templateService.test.ts`. *Do:* §6.2.3; port OpenSEO's service cases (`ReportService.test.ts:61-276`, `ReportTemplateService.test.ts:53-115`) plus: order of checks; sanitised size; input ceiling; `kbUp/kbDown` copy at 499,900 bytes; sharing off → 404. *Verify:* `node --test src/server/reports/service.test.ts src/server/reports/templateService.test.ts` → pass (F23-AC-01–05, 18).
  - [x] **P1.T3.S2** *Files:* `src/server/reports/jobs.ts`, `src/server/jobs/kinds.ts`, `src/server/reports/telemetry.ts`, `jobs.test.ts`. *Verify:* `node --test src/server/reports/jobs.test.ts` → pass.
  - [x] **P1.T3.S3** *Files:* `src/server/features/names.ts` (three entries), `src/server/features/clientFeatures.ts`. *Verify:* `node --test src/server/features/` → pass.

**Checkpoint:** `node scripts/qa/check-f23-db.mjs` → all passed; full suite → pass.

### Phase 2 — Document routes, public sharing and indexing

**Goal:** `/r` and `/s` routes serve sanitised documents with the full header set, and search engines cannot index them.

- [x] **P2.T1 Handlers**
  - [x] **P2.T1.S1** *Files:* `src/server/reports/documentRoutes.ts`, `documentRoutes.test.ts`. *Do:* §6.2.5; port `reportRoute.test.ts:48-172` and `shareRawRoute.test.ts:69-157` cases; add: flag off → 404; inactive workspace → 404; old `sanitizer_version` re-sanitised before serving; view recorded with pseudonym only; headers exact. *Verify:* `node --test src/server/reports/documentRoutes.test.ts` → pass (F23-AC-07, 09, 11, 12).
  - [x] **P2.T1.S2** *Files:* `src/server/reports/sharePage.ts`, `sharePage.test.ts`. *Do:* §6.2.6; port `sharePage.test.ts:36-124`; add escaping of `<script>` title and `"` in summary, wrapper CSP hash recomputed, `X-Frame-Options`, dead ends without title. *Verify:* `node --test src/server/reports/sharePage.test.ts` → pass (F23-AC-13).
  - [x] **P2.T1.S3** *Files:* `src/server/reports/ogImage.tsx`, `src/server/reports/ogRoute.test.ts`. *Do:* handler tests with an injected renderer: access checks, failure → 500 text; port `shareImageRoute.test.ts:33-99` minus the marketing redirect. *Verify:* `node --test src/server/reports/ogRoute.test.ts` → pass (F23-AC-14 unit).
- [x] **P2.T2 Route files**
  - [x] **P2.T2.S1** *Files:* `src/app/r/[reportId]/route.ts`, `src/app/s/[token]/route.ts`, `src/app/s/[token]/raw/route.ts`, `src/app/s/[token]/og.png/route.tsx`. *Verify:* `npm run build` → exit 0 and the build output lists the four routes as dynamic.
- [x] **P2.T3 Indexing, headers, surfaces**
  - [x] **P2.T3.S1** *Files:* `src/server/publicSite.js` (append `"/r"` to `PRIVATE_ROUTE_PREFIXES`; add `export const NOINDEX_ROUTE_PREFIXES = Object.freeze(["/s"])`; in `getRouteIndexingPolicy`, after the private check, return `{ index: false, follow: false, disallowRobots: false, isAuthentication: false, reason: "share_link" }` for those prefixes), `next.config.mjs` (headers: also map `NOINDEX_ROUTE_PREFIXES` to `X-Robots-Tag: noindex, nofollow`, in both preview and production branches), `src/server/reports/indexing.test.mjs`. *Do:* tests: robots data disallows `/r/` and `/r$`, never `/s`; sitemap has no `/r` or `/s` URL; `getRouteIndexingPolicy("/s/abc")` as AC-15; `"/scan"` still private (prefix boundary); `next.config` headers include `/s/:path*`; `src/middleware.js` `config.matcher` deep-equals `["/api/:path*"]`. *Verify:* `node --test src/server/reports/indexing.test.mjs src/server/repairs/r20-public-site.test.mjs` → pass (F23-AC-15).
  - [x] **P2.T3.S2** *Files:* `scripts/qa/check-public-site.mjs` (add `"/r/00000000-0000-0000-0000-000000000000"` and `"/s/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"` to the noindex path list). *Verify:* `node scripts/qa/check-public-site.mjs http://127.0.0.1:3328` against `npm run dev -- -p 3328` → "Public-site HTTP checks passed".
  - [x] **P2.T3.S3** *Files:* `src/shared/theme/theme.ts` (`APP_SURFACES` append `{ prefix: "/r", theme: "light" }`), `src/shared/theme/theme.test.ts` (case). *Verify:* `node --test src/shared/theme/theme.test.ts` → pass (F23-AC-24).

**Checkpoint:** full suite and build green. Completes F23-AC-07–15, 24.

### Phase 3 — Customer routes, tools, skill and generation

**Goal:** the assistant can save and read reports; customers can manage templates and start a generation.

- [x] **P3.T1 Routes**
  - [x] **P3.T1.S1** *Files:* `src/app/api/customer/reports/route.ts`, `reports/[reportId]/route.ts` (GET, DELETE), `reports/[reportId]/share/route.ts`, `reports/templates/route.ts` (GET, POST), `reports/templates/[templateId]/route.ts` (PUT, DELETE), `reports/generate/route.ts`, `src/server/reports/reports.contract.ts`. *Do:* §6.5. *Verify:* `node --test src/shared/http/routeContract.test.ts` → pass.
  - [x] **P3.T1.S2** *Files:* `src/server/reports/reports.route.test.mjs` (customer hook pattern). *Do:* AC-21 and AC-19 route cases; another workspace's ids → 404; sharing off → 404 `feature_unavailable`. *Verify:* `node --import ./src/server/liveWriteGuardAuto.mjs --test src/server/reports/reports.route.test.mjs` → pass.
- [x] **P3.T2 Tools and registry**
  - [x] **P3.T2.S1** *Files:* `src/server/reports/tools.ts`, `tools.test.ts`, `src/server/tools/catalog/reports.ts`, `src/server/tools/names.ts` (move names; `PLANNED_TOOL_NAMES = [] as const`), `src/shared/assistant-tools.ts` (presentation entries). *Do:* §6.2.4. *Verify:* `node --test src/server/reports/tools.test.ts src/server/tools/ src/shared/assistant-tools.test.ts` → pass (F23-AC-16, AC-17 registry part).
- [x] **P3.T3 Skill, kickoff, prompt block**
  - [x] **P3.T3.S1** *Files:* `src/assistant/skills/seo-report/SKILL.md` (§6.2.9), `src/assistant/skills/skills.test.ts` (expected list gains `"seo-report"`: 15 names), `src/assistant/skills/skillLint.test.ts` (heading list for `seo-report`), `THIRD_PARTY_NOTICES.md` (append `.agents/skills/seo-report/SKILL.md`). *Verify:* `npm run skills:build && node --test src/assistant/skills/` → pass (F23-AC-17).
  - [x] **P3.T3.S2** *Files:* `src/server/reports/generate.ts`, `generate.test.ts`, `src/server/reports/kickoff.ts`, `src/server/assistant/kickoffKinds.ts` (add `import "../reports/kickoff.ts";`), `src/server/reports/promptBlock.ts`, `promptBlock.test.ts`, `src/server/assistant/turn.ts` (pass `templatesBlock`). *Do:* §6.2.8; kickoff text exact; deleted template → 409; block null when off or empty. *Verify:* `node --test src/server/reports/generate.test.ts src/server/reports/promptBlock.test.ts src/server/assistant/turn.test.ts` → pass (F23-AC-19, 20).

**Checkpoint:** full suite and build green.

### Phase 4 — UI

**Goal:** Reports, report detail and Templates pages with share, delete and generate flows.

- [x] **P4.T1.S1** *Files:* `src/components/portal/reports/{formatWrittenBy.ts,formatWrittenBy.test.ts}`. *Verify:* `node --test src/components/portal/reports/formatWrittenBy.test.ts` → pass.
- [x] **P4.T1.S2** *Files:* `src/components/portal/reports/{ReportsList,ReportViewer,ShareReportDialog,DeleteReportDialog,FullScreenReport,ReportTemplatesList,ReportTemplateForm,GenerateReportDialog}.tsx`, `hooks/useReports.ts` (PORT headers where §7 says PORT), `src/app/portal/reports/page.tsx`, `[reportId]/page.tsx`, `templates/page.tsx`, `src/shared/query/keys.ts`, `src/components/app/navigation/items.ts`. *Do:* §6.6. *Verify:* `npm run build` → exit 0; `node --test src/shared/query/keys.test.ts src/components/app/navigation/navModel.test.ts` → pass.

**Checkpoint:** build green.

### Phase 5 — Browser acceptance and live check

**Goal:** UI flows and public-page safety are proven in a real browser; the owner can generate one real report.

- [x] **P5.T1.S1** *Files:* `scripts/qa/check-f23-browser.mjs`, fixtures `tests/fixtures/f23/api/*.json`, `tests/fixtures/f23/documents/{benign.html,hostile.html}`. *Do:* Playwright (`worker/node_modules/playwright`) against `npm run dev` with `page.route("**/api/customer/**")` for portal flows and a fixture mode for document routes (`F23_FIXTURE_DOCUMENTS=1` makes `documentRoutes` read `tests/fixtures/f23/documents/*` instead of the database; the flag is honoured only when `NODE_ENV !== "production"`). Cases: list, empty, detail skeleton then frame, Export opens `/r/<id>?print=1`, full screen with Esc, share on/off and copy, delete, templates create/edit/delete, Generate navigates to `/portal/assistant?s=…`; `hostile.html` (script, `onerror`, remote image, `meta refresh`, form) served through `/r/<id>`: `window.__pwned` undefined in the frame, no request to the fixture remote host, no navigation of the frame, `document.cookie` throws or is empty inside the frame; wrapper page at 390×844 has no horizontal scroll and the header wraps; OG image returns `image/png` 1200×630. *Verify:* `node scripts/qa/check-f23-browser.mjs` → "f23 browser: all cases passed" (F23-AC-14, 22, 23).
- [x] **P5.T1.S2** *Files:* `scripts/qa/check-f23-public.mjs`. *Do:* given `<origin> <token>`, asserts headers of `/s/<token>`, `/s/<token>/raw` (with and without `Sec-Fetch-Dest: iframe`, with `?x=1`), `/s/<token>/og.png`, and that `robots.txt` does not disallow `/s/` while `sitemap.xml` has no `/s/`. Free; safe on previews. *Verify:* `node scripts/qa/check-f23-public.mjs` (no args) → exits 2 with "usage: check-f23-public.mjs <origin> <token>".
- [x] **P5.T1.S3** *Files:* `scripts/qa/check-f23-live.mjs` (owner-run). *Do:* refuses without `--brand <key> --template <templateId> --max-spend-usd 0.50`, or when `report_generate`, `assistant` or the `assistant.turn` control is off for the brand. Calls `startReportGeneration`, then runs F22 `runAssistantTurn` with the kickoff message for the owner `Workspace`, auto-declining any approval card (no paid lookups). Prints only: session id, turn statuses and costs, whether a report was saved, its id, size in bytes, `sanitized.changed` and removed tag names. Never prints report text. *Verify:* `node scripts/qa/check-f23-live.mjs` (no flags) → exits 2 with "refusing: --brand, --template and --max-spend-usd 0.50 are required".
- [ ] **P5.T1.S4** *Owner-run, only on the owner's instruction:* `node --env-file=.env.local scripts/qa/check-f23-live.mjs --brand <key> --template <id> --max-spend-usd 0.50`. *Verify:* a report id is printed and total turn cost ≤ $0.50; then `node scripts/qa/check-f23-public.mjs https://<deployment> <token>` after the owner shares that report → "f23 public: all checks passed"; record results in the PR or `docs/OPERATOR_LEDGER.md`.
- [x] **P5.T1.S5** *Files:* `THIRD_PARTY_NOTICES.md` (every §7 COPY/PORT path). *Verify:* each path appears once.

**Checkpoint:** browser check passes; full suite and build green.

## 9. Test plan

| Test file | Cases | ACs |
|---|---|---|
| `src/shared/report-share.test.ts`, `report-sandbox.test.ts` | token, pseudonym, CSP, print script, splice | 07, 08, 10 |
| `src/server/reports/sanitize.test.ts` (+ 40-file corpus) | allowlist, URLs, CSS, idempotence | 06 |
| `src/server/reports/service.test.ts`, `templateService.test.ts` | ported OpenSEO cases + ours | 01–05, 18 |
| `src/server/reports/documentRoutes.test.ts` | `/r`, raw, views, headers | 07, 09, 11, 12 |
| `src/server/reports/sharePage.test.ts` | escaping, meta, CSP hash, dead ends | 13 |
| `src/server/reports/ogRoute.test.ts` | access, failure | 14 |
| `src/server/reports/indexing.test.mjs` + R20 tests | robots, sitemap, policy, middleware matcher | 15 |
| `src/server/reports/tools.test.ts` + F22 contract tests | tool shapes, no tokens, untrusted paths, confirm on replace | 16, 17 |
| `src/assistant/skills/*.test.ts` | `seo-report` served; 15 names; references clean | 17 |
| `src/server/reports/{generate,promptBlock}.test.ts` | kickoff text, flags, block | 19, 20 |
| `src/server/reports/reports.route.test.mjs` | customer routes | 18, 19, 21 |
| `src/server/reports/jobs.test.ts`, `scripts/qa/check-f23-db.mjs` | retention, races, RLS | 04, 05, 10, 12, 25 |
| `src/shared/theme/theme.test.ts` | `/r` surface | 24 |
| `scripts/qa/check-f23-browser.mjs` | UI and hostile document in a real browser | 14, 22, 23 |
| `scripts/qa/check-f23-public.mjs` | hosted header and indexing check | 11, 13, 15 (hosted) |

Fixtures are hand-written HTML and JSON with synthetic content ("Acme Tees", `acme.example`); nothing is recorded from customers. `hostile.html` points its remote resources at `http://127.0.0.1:9/` (a closed port on the test machine) so a regression shows as a request in the browser log, not a real fetch.

## 10. Rollout and rollback

- **Env vars (names only):** `FEATURE_REPORTS`, `FEATURE_REPORTS_BRANDS`, `FEATURE_REPORT_SHARING`, `FEATURE_REPORT_SHARING_BRANDS`, `FEATURE_REPORT_GENERATE`, `FEATURE_REPORT_GENERATE_BRANDS`. Test-only: `F23_FIXTURE_DOCUMENTS` (ignored in production).
- **Defaults:** all off in production.
- **Migration order:** 150 → 151 before deploying phase 1 code.
- **Owner enabling steps:** (1) apply migrations; (2) `FEATURE_REPORTS=allowlist` for the workspace (with F22's assistant already on); (3) let the assistant write one report and read it at `/portal/reports`; (4) `FEATURE_REPORT_SHARING=allowlist` when public links are wanted; run `check-f23-public.mjs` on one shared report; (5) `FEATURE_REPORT_GENERATE=allowlist` for templates.
- **Turn off:** `FEATURE_REPORT_SHARING=off` makes every public link 404 immediately for new requests (cached raw documents expire within 60 s); `FEATURE_REPORTS=off` hides pages, tools and `/r`.
- **Data cleanup:** customers delete reports; deleting a workspace cascades reports, templates and views; view rows are pruned after 395 days.

## 11. Risks and open questions

| # | Risk or question | Default chosen |
|---|---|---|
| 1 | Documents are served from the app's own origin (opaque by CSP sandbox). A separate user-content domain is the stronger isolation. | Keep OpenSEO's model plus sanitisation; list a `reports.perceev-content.com` origin as a hardening follow-up. |
| 2 | Vercel's CDN might not honour `s-maxage` on a dynamic route handler. | If not, every public view hits the function (revocation becomes immediate). Acceptable; `check-f23-public.mjs` reports the observed `x-vercel-cache` value. |
| 3 | Twitter/LinkedIn preview bots respect robots.txt; that is why `/s` is not disallowed (T7). | Keep; noindex is carried by header and meta. |
| 4 | Who may make a report public. | Members and owners (OpenSEO parity). Owner may restrict to owners later with one check in the share route. |
| 5 | `sanitize-html` changes behaviour across versions. | Exact version pin; corpus test; `SANITIZER_VERSION` bump re-sanitises stored reports on read. |
| 6 | The assistant may produce weak reports without the template's data. | The kickoff text requires saying what is unavailable instead of inventing it; reports are private until a person shares them. |
| 7 | Per-workspace caps (2,000 reports, 250 MB) are new numbers. | Runaway guards, not product limits; adjust by constant. |
| 8 | Scheduled or emailed reports. | Follow-up (F10 + F25), not in scope. |

## 12. Definition of done

- [ ] Phases 1–5 merged; subtasks ticked.
- [ ] F23-AC-01…25 covered by passing tests; browser check passed.
- [ ] `npm run build`, the full suite and `node scripts/qa/check-f23-db.mjs` green; CI tenant RLS green; R20 tests unchanged and passing.
- [ ] Migration paperwork updated for 150–151; `THIRD_PARTY_NOTICES.md` updated.
- [ ] Owner-run checks recorded (if run).
- [ ] `features/README.md` status updated.

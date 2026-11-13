# F19 — IndexNow

> <!-- doc-status -->
> **Status: LIVE.** Implementation spec. Not built yet.

| Field | Value |
|---|---|
| ID | F19 |
| Wave | 3 |
| Comparison rows covered | "IndexNow" (OpenSEO: generates a key, checks it is hosted, submits to Bing with fallbacks. Perceev: none) |
| Depends on | F01 (merged): `requireWorkspace`, `AppError`/`toErrorResponse`/`jsonOk`, `safeFetch` (`src/lib/http/safeFetch.ts`), `isFeatureEnabled`, `definePeriodic`/`enqueueSystemJob`/`defineJob`, `f01_touch_updated_at()`, `stableStringify`, route-contract harness. F04 (settings layout and `src/components/portal/settings/tabs.ts`, `CardShell`, `Collapsible`, `CopyButton`, `SafeExternalLink`, `Alert`, `Button`, `Skeleton`, `Table`). F05 (`fetchJson`, `keys`, `useWorkspace`). Phase 3 needs F18's audit pages (it hosts the IndexNow tab and the page action, §6.6.3). Phase 4 touches Content Studio (`src/components/portal/content/DraftEditor.jsx`). |
| Blocks | F22 (`submit_indexnow_urls` tool), F27 (onboarding may link the settings tab) |
| Reserved migrations | 130–134. **130** `130_f19_indexnow.sql` (phase 1). 131–134 unused. |
| Feature flag | `FEATURE_INDEXNOW` (name `indexnow`, spend `[]`): settings tab, audit tab and action, Content Studio offer, routes. In `CLIENT_FEATURES`; off in production by default. |
| Spend features | None. IndexNow is free; it is rate-limited instead (§6.2.4). |
| OpenSEO reference | `openseo:src/server/features/indexnow/services/IndexNowService.ts` (+ `.test.ts`), `openseo:src/serverFunctions/indexnow.ts`, `openseo:src/types/schemas/indexnow.ts`, `openseo:src/client/features/settings/IndexNowSettings.tsx`, `openseo:src/server/mcp/tools/submit-indexnow-urls.ts`, `openseo:src/server/features/projects/repositories/ProjectRepository.ts:153-168`, `openseo:src/server/lib/scrape.ts:35-55`, `openseo:docs/maintainers/specs/0016-indexnow.md` (read as data), `openseo:drizzle/pg/0036_right_praxagora.sql` at `c5f8db1` |

## 1. Summary

Customers tell Bing and the other IndexNow engines (Yandex, Seznam, Naver, Yep) about pages they publish or change, so those engines recrawl them sooner. Perceev creates the workspace's key, checks that the site hosts the key file on the bare domain and on `www.`, and submits URLs to Bing with fallbacks to Yandex and Yep. It is free, rate-limited, and offered where it matters: in Workspace settings, as a tab and page action in Site Audit, and right after Content Studio verifies a published page.

## 2. What OpenSEO does (observed)

1. **Key.** One key per project: 32 hex characters (`crypto.randomUUID()` without dashes), created on first setup or submission, stored as plain text on the project (`openseo:drizzle/pg/0036_right_praxagora.sql:1`) because it is public by design; created only when missing (`UPDATE … WHERE indexnow_key IS NULL`), then re-read so concurrent first uses converge (`openseo:src/server/features/indexnow/services/IndexNowService.ts:43-64`, `openseo:src/server/features/projects/repositories/ProjectRepository.ts:153-168`, `openseo:docs/maintainers/specs/0016-indexnow.md:7`). The project needs a website (`IndexNowService.ts:46-51`).
2. **Key-file check** (`IndexNowService.ts:66-108`): `GET https://{host}/{key}.txt` with `redirect: "manual"`, a 10 s timeout and a user agent, through the URL policy (`normalizeAndValidateStartUrl`); 404/410 → `missing`; a 3xx whose `Location` is the same file on another host → `moved`, any other 3xx → `redirects`; other non-2xx → `unknown`; a body read with a size bound (`openseo:src/server/lib/scrape.ts:35-55`) equal to the key after trim → `found`, otherwise `wrong_content`; a timeout → `unknown`; a network error → `unreachable`. Checked for the bare domain and `www.` (`:132-145`).
3. **Pre-submit gate** (`:110-130`): `missing`, `wrong_content`, `redirects`, `moved` stop that host's submission with a fix message; inconclusive results (`unknown`, `unreachable`, `found`) let it go ahead.
4. **Submission** (`:6-14`, `:180-268`): URLs on the project domain or its subdomains, `http(s)` only, `#hash` removed, de-duplicated, grouped per host, one request per host with `{ host, key, urlList }`; other URLs are skipped and reported. Endpoints in order Bing, Yandex, Yep: on a 429, 5xx or no response the same body goes to the next engine; any other status stops, because every engine would answer the same (`:221-226`; spec `0016-indexnow.md:13`). Messages per status: 200 "Submitted N URLs.", 202 "… Search engines will verify the key file on https://{host} first.", 403 key not accepted, 429 refusing, else "IndexNow returned HTTP {status}." (`:147-178`). Up to 10,000 URLs per request (`openseo:src/types/schemas/indexnow.ts:3-7`).
5. **Policy.** Free; any project member may set up and submit; v1 keeps no history; no "submit these pages" on audit results, to avoid encouraging whole-site resubmission (`0016-indexnow.md:15`, `:24`, `:30`).
6. **UI** (`openseo:src/client/features/settings/IndexNowSettings.tsx:74-379`): intro copy, "Set up IndexNow", step 1 key file (download, URL per host with status labels, "Check again", collapsible "How do I add a file to my site?"), step 2 textarea "URLs (one per line)" and "Submit to IndexNow", toasts per host, an agent prompt; hosts that redirect elsewhere (`moved`) or don't load (`unreachable`) are left out of the "verified" decision (`:54-57`, `:248-256`).
7. **Agent tool** `submit_indexnow_urls` (`openseo:src/server/mcp/tools/submit-indexnow-urls.ts:19-77`).
8. **Tests** (`IndexNowService.test.ts:60-200`): one request per host and off-site skipped; key created on first use; refuse a project without a website before creating a key; submit when a bot wall hides the file; move on after a rate limit; stop on a rejected key; tell a forward to `www.` apart from a missing file.

## 3. What Perceev has today

- No IndexNow. Workspaces always have `customer_brands.website` and `website_host` (`supabase/migrations/023_customer_auth_and_tenant_rls.sql:5-17`, both `NOT NULL`).
- Content Studio verifies publications: `verifyPublishUrl` fetches the live URL through `safeFetch` and checks the body against the approved draft (`src/lib/content/publishVerification.js:64-126`); `POST /api/customer/content/[id]/publish` records it through `record_verified_publication` and returns `{ published: true, publication, indexing: null, observed_citation: null }` (`src/app/api/customer/content/[id]/publish/route.js:56-72`), where `publication.url` is the verified final URL (`supabase/migrations/029_repair_workflow.sql:104-106`). `src/lib/publishRoute.test.mjs:93-102` asserts `indexing === null` ("preserves indexing uncertainty"): **F19 must not change this route.** The editor calls it from `checkedAction("publish")` (`src/components/portal/content/DraftEditor.jsx:143-155`); `src/components/portal/portalRegressions.test.mjs:149-169` compiles `DraftEditor.jsx` with an explicit module map.
- The existing SSRF guard (`src/lib/ssrfGuard.js:612-641`) follows redirects and throws at the hop limit; F01's new `safeFetch` (`src/lib/http/safeFetch.ts`) replaces it for new code.
- No `/portal/audit` (F18) and no `/portal/settings` sections yet (F04 shell).

## 4. Target behaviour and acceptance criteria

| ID | Statement | Verified by |
|---|---|---|
| F19-AC-01 | Migration 130 creates `indexnow_keys`, `indexnow_submissions`, `indexnow_key_checks` with RLS and read policies; one key per workspace; key format `^[0-9a-f]{32}$`; members read only their workspace's rows. | DB `scripts/qa/check-f19-db.mjs`; `tests/customer-uat.sql` |
| F19-AC-02 | The key is created on first setup or submission as 32 lowercase hex characters; concurrent first uses converge on one key; an existing key is returned with `created: false`. | unit `src/lib/indexnow/keys.test.ts`; DB group `ensure` |
| F19-AC-03 | The domain is `website_host` lowercased without `www.`; the checked hosts are the domain and `www.<domain>`. | unit `keys.test.ts` |
| F19-AC-04 | Key-file statuses: 2xx body equal to the key → `found`; other 2xx body or a body over 4,096 bytes → `wrong_content`; 404/410 → `missing`; 3xx to the same path on another host → `moved`; other 3xx → `redirects`; other statuses and timeouts → `unknown`; DNS failure, refused connection or an SSRF refusal → `unreachable`. The check uses F01 `safeFetch` with `maxRedirects: 0` and never follows a redirect. | unit `src/lib/indexnow/keyFile.test.ts` (port of `IndexNowService.test.ts:182-200` plus cases) |
| F19-AC-05 | Submission keeps `http(s)` URLs on the domain or its subdomains, removes `#hash` and duplicates, groups by host and reports every skipped URL with a reason (`off_site`, `invalid`, `recently_submitted`); at most 10,000 URLs per call. | unit `src/lib/indexnow/submit.test.ts` (port of `IndexNowService.test.ts:61`) |
| F19-AC-06 | A host whose key file is `missing`, `wrong_content`, `redirects` or `moved` fails with the exact fix message and no engine call; `unknown`/`unreachable`/`found` proceed. | unit `submit.test.ts` (port of `:137`) |
| F19-AC-07 | Engines are tried Bing → Yandex → Yep; 429, 5xx or no response moves on; 200/202/400/403/422 stop; each host result records the engine, HTTP status and message (copy as §6.2.3). | unit `submit.test.ts` (ports of `:151`, `:169`) |
| F19-AC-08 | Rate limits: ≤ 30 submit requests per workspace per rolling hour, ≤ 10,000 URLs per workspace per UTC day, ≤ 60 host checks per workspace per hour; a URL successfully submitted in the last 10 minutes is skipped; refusals are `429 indexnow_rate_limited` with `details.retryAfterSeconds`. | unit `src/lib/indexnow/limits.test.ts`; DB group `usage` |
| F19-AC-09 | Every host result is recorded (`indexnow_submissions`, first 100 URLs), listed newest first in settings and the audit tab, and pruned after 395 days; key-check logs are pruned after 7 days. | DB groups `history`, `retention` |
| F19-AC-10 | No IndexNow code reserves spend or calls `metered()`; `names.ts` lists `indexnow` with `spend: []`. | unit `src/lib/indexnow/noSpend.test.ts` |
| F19-AC-11 | The settings tab renders setup, key file (with per-host status), submit and history states with the copy in §6.6.1. | browser `scripts/qa/check-f19-browser.mjs` B1–B3 |
| F19-AC-12 | Site Audit hosts an "IndexNow" tab and a "Submit to IndexNow" page action through the registries in §6.6.3; only loaded, indexable pages are offered; nothing is pre-selected; more than 100 URLs need an extra confirmation. | browser B4–B5 (fixture audit page) |
| F19-AC-13 | After Content Studio verifies a publication, an offer appears (flag on) that submits the verified URL with `source "content"`; the offer explains setup when there is no key or the key file is unverified; the publish route's response is unchanged (`publishRoute.test.mjs` still passes). | browser B6; `node --test src/lib/publishRoute.test.mjs`; `portalRegressions.test.mjs` |
| F19-AC-14 | Flag off → settings tab, audit tab, page action and offer hidden; routes `404 feature_unavailable`. | route tests; browser B7 |
| F19-AC-15 | No log line or telemetry event contains a URL, host or key. | unit `src/lib/indexnow/logging.test.ts` |
| F19-AC-16 | `src/lib/indexnow/tools.ts` exports `submit_indexnow_urls` (free) with a strict input and a loose output, using the same service. | unit `tools.test.ts` |

## 5. Scope

**In scope:** per-workspace key, key-file checks, submissions with engine fallback, rate limits, submission history, retention, the settings tab, the Site Audit tab and page action (contract for F18), the Content Studio offer, a tool definition for F22.

**Out of scope:** automatic submission of changed pages (needs change detection; OpenSEO rejected it for the same reason, `0016-indexnow.md:24`); Google (does not use IndexNow); hosting the key file for customers (it must be on their site); `keyLocation` keys outside the root (`0016-indexnow.md:32`); verifying that engines indexed a page (Bing Webmaster Tools reports that; Perceev keeps `indexing: null` on publications); changes to the publish route or `verifyPublishUrl`.

## 6. Design

### 6.1 Data model

#### `supabase/migrations/130_f19_indexnow.sql`

```sql
-- F19: IndexNow keys, submission history and key-check log. The key is public by design:
-- the customer's site serves it at https://<host>/<key>.txt. It is not a credential.
CREATE TABLE IF NOT EXISTS public.indexnow_keys (
  brand_key text PRIMARY KEY REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  key text NOT NULL CHECK (key ~ '^[0-9a-f]{32}$'),
  last_check jsonb CHECK (last_check IS NULL OR (jsonb_typeof(last_check) = 'array' AND jsonb_array_length(last_check) <= 4)),
  last_checked_at timestamptz,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON COLUMN public.indexnow_keys.last_check IS 'Latest [{host, status}] from the key-file check; status in found|missing|wrong_content|redirects|moved|unreachable|unknown.';
DROP TRIGGER IF EXISTS indexnow_keys_touch ON public.indexnow_keys;
CREATE TRIGGER indexnow_keys_touch BEFORE UPDATE ON public.indexnow_keys
  FOR EACH ROW EXECUTE FUNCTION public.f01_touch_updated_at();

CREATE TABLE IF NOT EXISTS public.indexnow_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_key text NOT NULL REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  source text NOT NULL CHECK (source IN ('settings','audit','content','tool')),
  source_ref text CHECK (source_ref IS NULL OR length(source_ref) <= 100),   -- audit id or content item id
  host text NOT NULL CHECK (length(host) BETWEEN 1 AND 253 AND host = lower(host)),
  url_count integer NOT NULL CHECK (url_count BETWEEN 1 AND 10000),
  urls text[] NOT NULL CHECK (cardinality(urls) BETWEEN 1 AND 100),            -- first 100 URLs, sorted
  status text NOT NULL CHECK (status IN ('submitted','failed')),
  engine text CHECK (engine IS NULL OR engine IN ('bing','yandex','yep')),
  http_status integer CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
  reason text CHECK (reason IS NULL OR reason ~ '^[a-z_]{1,40}$'),
  message text NOT NULL CHECK (length(message) <= 300),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT indexnow_submissions_request_host UNIQUE (request_id, host)
);
CREATE INDEX IF NOT EXISTS indexnow_submissions_brand_idx ON public.indexnow_submissions (brand_key, created_at DESC);
CREATE INDEX IF NOT EXISTS indexnow_submissions_source_idx ON public.indexnow_submissions (brand_key, source, source_ref, created_at DESC);
CREATE INDEX IF NOT EXISTS indexnow_submissions_urls_idx ON public.indexnow_submissions USING gin (urls);
CREATE INDEX IF NOT EXISTS indexnow_submissions_created_idx ON public.indexnow_submissions (created_at);

CREATE TABLE IF NOT EXISTS public.indexnow_key_checks (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  brand_key text NOT NULL REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  host text NOT NULL CHECK (length(host) BETWEEN 1 AND 253),
  status text NOT NULL CHECK (status IN ('found','missing','wrong_content','redirects','moved','unreachable','unknown')),
  checked_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS indexnow_key_checks_brand_idx ON public.indexnow_key_checks (brand_key, checked_at DESC);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['indexnow_keys','indexnow_submissions','indexnow_key_checks'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_read', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (public.customer_can_access_brand(brand_key))', t || '_read', t);
  END LOOP;
END $$;

-- Create the key only when missing; concurrent first uses converge (port of ProjectRepository.ts:153-168).
CREATE OR REPLACE FUNCTION public.indexnow_ensure_key(p_brand text, p_key text, p_actor uuid)
RETURNS TABLE (key text, created boolean) LANGUAGE plpgsql SET search_path = public AS $$
#variable_conflict use_column
DECLARE v text;
BEGIN
  IF p_key !~ '^[0-9a-f]{32}$' THEN RAISE EXCEPTION 'indexnow_key_invalid'; END IF;
  INSERT INTO indexnow_keys (brand_key, key, created_by) VALUES (p_brand, p_key, p_actor)
  ON CONFLICT (brand_key) DO NOTHING RETURNING indexnow_keys.key INTO v;
  IF v IS NOT NULL THEN key := v; created := true; RETURN NEXT; RETURN; END IF;
  SELECT k.key INTO v FROM indexnow_keys k WHERE k.brand_key = p_brand;
  key := v; created := false; RETURN NEXT;
END $$;

-- Usage for rate limits (F19-AC-08).
CREATE OR REPLACE FUNCTION public.indexnow_usage(p_brand text, p_now timestamptz)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT jsonb_build_object(
    'requestsLastHour', (SELECT count(DISTINCT request_id) FROM indexnow_submissions
                          WHERE brand_key = p_brand AND created_at > p_now - interval '1 hour'),
    'oldestRequestInHour', (SELECT min(created_at) FROM indexnow_submissions
                          WHERE brand_key = p_brand AND created_at > p_now - interval '1 hour'),
    'urlsToday', (SELECT coalesce(sum(url_count), 0) FROM indexnow_submissions
                   WHERE brand_key = p_brand AND created_at >= date_trunc('day', p_now AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'),
    'checksLastHour', (SELECT count(*) FROM indexnow_key_checks
                        WHERE brand_key = p_brand AND checked_at > p_now - interval '1 hour'),
    'oldestCheckInHour', (SELECT min(checked_at) FROM indexnow_key_checks
                        WHERE brand_key = p_brand AND checked_at > p_now - interval '1 hour'))
$$;

-- URLs already submitted successfully since p_since (recorded URLs only).
CREATE OR REPLACE FUNCTION public.indexnow_recently_submitted(p_brand text, p_urls text[], p_since timestamptz)
RETURNS text[] LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT coalesce(array_agg(DISTINCT u), '{}')
    FROM indexnow_submissions s CROSS JOIN LATERAL unnest(s.urls) AS u
   WHERE s.brand_key = p_brand AND s.status = 'submitted' AND s.created_at >= p_since
     AND s.urls && p_urls AND u = ANY (p_urls)
$$;

CREATE OR REPLACE FUNCTION public.prune_indexnow(p_submissions_before timestamptz, p_checks_before timestamptz, p_limit integer DEFAULT 5000)
RETURNS jsonb LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_s integer; v_c integer;
BEGIN
  WITH old AS (SELECT id FROM indexnow_submissions WHERE created_at < p_submissions_before ORDER BY created_at
                LIMIT greatest(1, least(p_limit, 20000)))
  DELETE FROM indexnow_submissions s USING old WHERE s.id = old.id; GET DIAGNOSTICS v_s = ROW_COUNT;
  WITH old AS (SELECT id FROM indexnow_key_checks WHERE checked_at < p_checks_before ORDER BY checked_at
                LIMIT greatest(1, least(p_limit * 4, 80000)))
  DELETE FROM indexnow_key_checks c USING old WHERE c.id = old.id; GET DIAGNOSTICS v_c = ROW_COUNT;
  RETURN jsonb_build_object('submissions', v_s, 'checks', v_c);
END $$;

DO $$ DECLARE f text; BEGIN
  FOREACH f IN ARRAY ARRAY['indexnow_ensure_key(text,text,uuid)','indexnow_usage(text,timestamptz)',
    'indexnow_recently_submitted(text,text[],timestamptz)','prune_indexnow(timestamptz,timestamptz,integer)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO service_role', f);
  END LOOP;
END $$;
NOTIFY pgrst, 'reload schema';
```

**Required objects** (`scripts/setup-supabase.mjs`): `"130_f19_indexnow.sql"`: tables `indexnow_keys`, `indexnow_submissions`, `indexnow_key_checks`; functions `indexnow_ensure_key`, `indexnow_usage`, `indexnow_recently_submitted`, `prune_indexnow`.

**Tenant RLS test** (`tests/customer-uat.sql`): one key, one submission and one check per workspace; as user 1 each `count(*)` = 1.

**Migration paperwork:** `README.md` row `130_f19_indexnow` "IndexNow: per-workspace public key, submission history (13 months) and key-check log (7 days)."; `docs/OPERATOR_LEDGER.md` § C ("apply 130 before deploying F19 phase 2"); `docs/PROD_MIGRATIONS.md` one bullet.

### 6.2 Server modules

All under `src/lib/indexnow/` (TypeScript, erasable syntax, relative imports with extensions). PORT files carry the licence header.

#### 6.2.1 `src/shared/indexnow.ts` (client-safe)

```ts
export const KEY_FILE_STATUSES = ["found","missing","wrong_content","redirects","moved","unreachable","unknown"] as const;
export type KeyFileStatus = typeof KEY_FILE_STATUSES[number];
export const KEY_FILE_LABELS: Record<KeyFileStatus, string> = {     // PORT IndexNowSettings.tsx:44-52
  found: "Found", missing: "Not found", wrong_content: "Should contain only the key",
  redirects: "Redirects. The file must load at this address itself", moved: "Redirects to another address",
  unreachable: "Couldn't reach this address", unknown: "Couldn't check right now" };
export function isUnusedHost(status: KeyFileStatus): boolean;      // moved | unreachable (IndexNowSettings.tsx:54-57)
export function isProblemStatus(status: KeyFileStatus): boolean;   // missing | wrong_content | redirects
export function keyFileReady(hosts: Array<{ host: string; status: KeyFileStatus }>): boolean; // ≥ 1 used host and every used host found
export function splitUrls(text: string): string[];                 // COPY :31-36
export function pluralUrls(n: number): string;                     // "1 URL" | "n URLs"
export const SUBMISSION_SOURCES = ["settings","audit","content","tool"] as const;
export const SUBMISSION_SOURCE_LABELS = { settings: "Settings", audit: "Site audit", content: "Content Studio", tool: "Assistant" } as const;
export const MAX_URLS_PER_SUBMISSION = 10_000;
export const ENGINE_LABELS = { bing: "Bing", yandex: "Yandex", yep: "Yep" } as const;
```

#### 6.2.2 `keys.ts` and `keyFile.ts` (PORT of `IndexNowService.ts:29-145`)

```ts
// keys.ts
export function generateIndexNowKey(randomUUID?: () => string): string;   // randomUUID().replaceAll("-", "")
export function indexNowDomain(brand: { website_host: string }): string;  // lowercased, "www." stripped (F19-AC-03)
export function indexNowHosts(domain: string): [string, string];          // [domain, "www." + domain]
export async function getSetup(admin, ws): Promise<{ domain: string; key: string | null; hosts: HostCheck[] | null; checkedAt: string | null; ready: boolean }>;
export async function ensureKey(admin, ws, deps?): Promise<{ domain: string; key: string; created: boolean }>;   // rpc indexnow_ensure_key
// keyFile.ts
export type HostCheck = { host: string; status: KeyFileStatus };
export const KEY_FILE_MAX_BYTES = 4096, KEY_CHECK_TIMEOUT_MS = 10_000, KEY_CHECK_CACHE_SECONDS = 60;
export const INDEXNOW_USER_AGENT = "PerceevIndexNow/1.0 (+https://perceev.xyz)";
export async function checkKeyFile(host: string, key: string, deps?: { safeFetch?: typeof safeFetch }): Promise<KeyFileStatus>;
export function keyFileProblem(host: string, status: KeyFileStatus): string | null;     // PORT :115-130
export async function checkKeyFiles(admin, ws, i: { force: boolean }, deps?): Promise<{ hosts: HostCheck[]; checkedAt: string; cached: boolean }>;
```

`checkKeyFile` calls F01 `safeFetch("https://" + host + "/" + key + ".txt", { method: "GET", headers: { "user-agent": INDEXNOW_USER_AGENT, accept: "text/plain" }, maxRedirects: 0, maxBytes: KEY_FILE_MAX_BYTES, timeoutMs: KEY_CHECK_TIMEOUT_MS })` and maps:

| Outcome | Status |
|---|---|
| `status` 200–299 and `text().trim() === key` | `found` |
| `status` 200–299 and anything else | `wrong_content` |
| `AppError` `response_too_large` | `wrong_content` (a page is being served in its place) |
| `status` 404 or 410 | `missing` |
| `status` 300–399 with a `Location` resolving (against the request URL) to `https://<other host>/<key>.txt` | `moved` |
| `status` 300–399 otherwise (incl. no `Location`) | `redirects` |
| any other status (401, 403, 429, 5xx …) | `unknown` (bot wall or server error: the file may be fine) |
| timeout / abort | `unknown` |
| DNS failure, connection refused, TLS failure | `unreachable` |
| `SsrfBlockedError` (the host resolves to a private or blocked address) | `unreachable` |

**F01 contract required:** with `maxRedirects: 0`, `safeFetch` returns a 3xx response unfollowed (status and `Location` header intact) instead of throwing. If F01's merged `safeFetch` throws on the first 3xx, P1.T1.S2 adds this behaviour to `src/lib/http/safeFetch.ts` (additive: only `maxRedirects === 0` changes, with a test in F01's `safeFetch.test.ts`). The SSRF guarantees (DNS pinning, private-range refusal, byte cap) apply to the single hop.

`keyFileProblem` copy (exact): `missing` → "No key file at the root of https://{host}. Upload it there, then try again."; `wrong_content` → "The key file on https://{host} should contain only the key."; `redirects`/`moved` → "The key file on https://{host} redirects. Upload it to https://{host} itself."; others → `null`.

`checkKeyFiles`: no key → `AppError(409,"indexnow_not_set_up","Set up IndexNow first.")`; not `force` and `last_checked_at` within 60 s → stored result with `cached: true`; else rate limit (§6.2.4), check both hosts in parallel, insert one `indexnow_key_checks` row per host, update `indexnow_keys.last_check`/`last_checked_at`.

#### 6.2.3 `submit.ts` (PORT of `IndexNowService.ts:6-15, 147-268`)

```ts
export const INDEXNOW_ENDPOINTS = [
  { engine: "bing", url: "https://www.bing.com/indexnow" },
  { engine: "yandex", url: "https://yandex.com/indexnow" },
  { engine: "yep", url: "https://indexnow.yep.com/indexnow" },
] as const;
export const SUBMIT_TIMEOUT_MS = 10_000;
export type HostResult = { host: string; urlCount: number; status: "submitted" | "failed"; engine: "bing" | "yandex" | "yep" | null;
  httpStatus: number | null; reason: string | null; message: string };
export type SkippedUrl = { url: string; reason: "off_site" | "invalid" | "recently_submitted" };
export function groupUrlsByHost(domain: string, urls: string[]): { byHost: Map<string, string[]>; skipped: SkippedUrl[] };
export function describeResponse(status: number, urlCount: number, host: string): { status: "submitted" | "failed"; reason: string | null; message: string };
export async function postToEngine(endpoint: string, body: string, deps?: { fetchImpl?: typeof fetch }): Promise<number | undefined>;
export async function submitHost(host: string, key: string, urls: string[], deps?): Promise<HostResult>;
export async function submitUrls(admin, ws, i: { urls: string[]; source: SubmissionSource; sourceRef?: string; requestId: string }, deps?):
  Promise<{ key: string; keyCreated: boolean; hosts: HostResult[]; skipped: SkippedUrl[] }>;
```

- `groupUrlsByHost`: `new URL(raw.trim())` (invalid → `invalid`); protocol `http:`/`https:` only; host equal to the domain or ending in `.<domain>` (else `off_site`); `hash = ""`; de-duplicated per host; order kept.
- `describeResponse` (exact copy): 200 → submitted "Submitted {n} URL(s)."; 202 → submitted "Submitted {n} URL(s). Search engines will verify the key file on https://{host} first."; 400 → failed `bad_request` "IndexNow rejected the request. Check that the URLs are complete addresses."; 403 → failed `key_rejected` "The key wasn't accepted. Check that the key file on https://{host} contains only the key."; 422 → failed `urls_rejected` "IndexNow rejected these URLs. Check that they belong to https://{host}."; 429 → failed `rate_limited` "Search engines are refusing submissions right now. Try again later, and only submit pages that changed."; other → failed `http_error` "IndexNow returned HTTP {status}."; no response from any engine → failed `no_response` "IndexNow didn't respond. Try again later."
- `postToEngine`: plain `fetch` (the three endpoints are our fixed constants, not customer URLs) with `method: "POST"`, `content-type: application/json; charset=utf-8`, `AbortSignal.timeout(10_000)`; returns the status or `undefined` on a network error/timeout; the response body is cancelled; nothing is logged except `[indexnow] engine <engine> status <code|none>`.
- `submitHost`: `checkKeyFile` → `keyFileProblem` → failed with `reason = <status>`, no engine call; else body `{ host, key, urlList }` to each endpoint in order while the status is `undefined`, 429 or ≥ 500 (`:221-226`); record the last engine tried.
- `submitUrls` order: (1) URL count 1–10,000 (zod); (2) rate limits (§6.2.4) on the request and the URL count after grouping; (3) `ensureKey` (first use creates the key, as OpenSEO); (4) `groupUrlsByHost`; (5) `indexnow_recently_submitted(brandKey, allUrls, now − 600 s)` → those URLs move to `skipped` with `recently_submitted`; (6) idempotency: rows already recorded for `(request_id, host)` are returned as recorded (no engine call); (7) `submitHost` per host sequentially; (8) insert one `indexnow_submissions` row per host (first 100 URLs sorted, `url_count`, status, engine, HTTP status, reason, message, source, `source_ref`, `created_by`). Returns `{ key, keyCreated, hosts, skipped }`.

#### 6.2.4 `limits.ts`

```ts
export type IndexNowLimits = { maxRequestsPerHour: number; maxUrlsPerDay: number; maxChecksPerHour: number; resubmitCooldownSeconds: number };
export function readIndexNowLimits(env: Record<string, string | undefined>): IndexNowLimits;
  // INDEXNOW_MAX_REQUESTS_PER_HOUR (default 30, 1..1000), INDEXNOW_MAX_URLS_PER_DAY (default 10000, 1..100000),
  // INDEXNOW_MAX_HOST_CHECKS_PER_HOUR (default 60, 2..1000), INDEXNOW_RESUBMIT_COOLDOWN_SECONDS (default 600, 0..86400);
  // blank → default; out of range or non-numeric → AppError(500,"indexnow_config_invalid")
export async function assertSubmitAllowed(admin, brandKey: string, urlCount: number, now: Date, limits): Promise<void>;
export async function assertCheckAllowed(admin, brandKey: string, hostCount: number, now: Date, limits): Promise<void>;
```

Refusals: `AppError(429,"indexnow_rate_limited", message, { recovery, details: { retryAfterSeconds } })` with messages "You've submitted to IndexNow {n} times in the last hour. Try again in {m} minutes." (`retryAfterSeconds` = seconds until the oldest request in the hour leaves the window), "This workspace has submitted {n} URLs today. The daily limit is {max}. Try again tomorrow." (seconds to the next UTC midnight), "The key file was checked {n} times in the last hour. Try again in {m} minutes."; recovery "Submit only pages you added or changed." Rationale: submitting is free for us and for the customer, but engines throttle sites that resubmit unchanged pages, and every check fetches the customer's site twice.

#### 6.2.5 `history.ts`, `tools.ts`, `jobs.ts`, contracts, registrations

- `listSubmissions(admin, ws, { source?, sourceRef?, limit = 20 })` → newest first `{ id, createdAt, source, sourceRef, host, urlCount, urls (first 5), status, engine, httpStatus, message }`.
- `tools.ts`: `submit_indexnow_urls` (F13 §6.2.6 shape): description adapted from `openseo:src/server/mcp/tools/submit-indexnow-urls.ts:23-24` ("Tells Bing, Yandex, Seznam, Naver, Yep and other IndexNow search engines that pages on this workspace's website changed, so they recrawl them sooner. Google does not use IndexNow. Submit only new, updated, redirected or removed pages, not the whole site. The site must host the workspace key file at the root of each host. URLs outside the website are skipped. Free."); input `z.strictObject({ urls: z.array(z.string().max(2048)).min(1).max(10000) })`; output `z.looseObject({ key, keyCreated, hosts, skipped })`; handler → `submitUrls(…, { source: "tool", requestId: crypto.randomUUID() })`.
- `jobs.ts`: periodic `indexnow.retention` (86,400 s) → `enqueueSystemJob("indexnow.retention", {}, { dedupeKey: "indexnow.retention:" + YYYY-MM-DD })`; kind `indexnow.retention`: `prune-1`…`prune-20` (`DB_STEP`) `prune_indexnow(now − 395 days, now − 7 days, 5000)` while submissions = 5,000. `src/lib/jobs/kinds.ts` gains `import "../indexnow/jobs.ts";`.
- `indexnow.contract.ts`: contracts for §6.5.
- `src/lib/features/names.ts`: `indexnow: { spend: [] as const }`; `src/lib/features/clientFeatures.ts` appends `"indexnow"`. `src/shared/spend-features.ts` is **not** changed.

### 6.3 Jobs

| Kind / periodic | Trigger | Steps | Completion |
|---|---|---|---|
| periodic `indexnow.retention` (86,400 s) | F01 `definePeriodic` | enqueue `indexnow.retention` | — |
| `indexnow.retention` | system | `prune-<n>` loop (`DB_STEP`) | `completed` `{ submissions, checks }` |

Submissions and checks run inside the request (one key check per host plus at most three engine requests per host, each with a 10 s timeout); `maxDuration = 60` on the submit and check routes. A submission of many hosts is bounded by the hosts of one domain (the bare domain, `www.` and other subdomains the customer lists).

### 6.4 Provider calls and cost

| Call | Target | Request | Cost | Retries |
|---|---|---|---|---|
| Key-file check | `GET https://{host}/{key}.txt` (customer site) through F01 `safeFetch` | headers `user-agent: PerceevIndexNow/1.0 (+https://perceev.xyz)`, `accept: text/plain`; no redirects followed; ≤ 4,096 bytes; 10 s | none | 0 (the customer clicks "Check again") |
| Submit | `POST https://www.bing.com/indexnow`, then `https://yandex.com/indexnow`, then `https://indexnow.yep.com/indexnow` | `{ "host": "offcult.in", "key": "<32 hex>", "urlList": ["https://offcult.in/new-page"] }` | none | engine fallback only (no retry of the same engine) |

No DataForSEO, no spend features, no provider cache. **Fixtures** (`tests/fixtures/f19/`): `key-file-found.txt` (the test key), `key-file-html.html` (a 6 KB HTML page), responses built in tests (404, 410, 301 to `https://www.example.com/<key>.txt`, 302 to `/login`, 403, 503, timeout); engine stubs for 200, 202, 403, 422, 429, 503 and network error. Tests inject `fetchImpl`/`safeFetch`; no test reaches the network (conventions §6.5). Live QA: `scripts/qa/check-f19-live.mjs --brand <key> --url <one owned URL>` submits one URL to Bing for a workspace whose key file is hosted; owner-run only (free, but it touches a real engine).

### 6.5 API routes

All under `src/app/api/customer/indexnow/`: `requireWorkspace` (members and owners); `isFeatureEnabled("indexnow", brandKey)` false → `404 feature_unavailable` ("This page is not available for your workspace yet."); `toErrorResponse`; `Cache-Control: no-store`; contracts in `indexnow.contract.ts`. Common errors: 400 `invalid_request`/`invalid_json`; 401/403/404/503 from `requireWorkspace`; 503 `indexnow_unavailable` ("IndexNow could not be reached. Please retry.") on a database error.

| Method and path | Request | Response 200 (example) | Extra errors |
|---|---|---|---|
| `GET /api/customer/indexnow` | query `{ brand_key? }` | `{ "domain": "offcult.in", "key": "3f2a9c1e5b7d4f60a8c2e1b3d5f7a9c1", "hosts": [ { "host": "offcult.in", "status": "found" }, { "host": "www.offcult.in", "status": "moved" } ], "checkedAt": "2026-10-22T09:00:00.000Z", "ready": true, "limits": { "requestsLastHour": 2, "maxRequestsPerHour": 30, "urlsToday": 14, "maxUrlsPerDay": 10000 } }` (`key: null`, `hosts: null`, `ready: false` before setup) | — |
| `POST /api/customer/indexnow/setup` | `z.strictObject({ brand_key? })` | `{ "domain": "offcult.in", "key": "3f2a…", "created": true }` | — |
| `POST /api/customer/indexnow/check` | `z.strictObject({ brand_key?, force: z.boolean().default(false) })` | `{ "hosts": [ { "host": "offcult.in", "status": "missing" }, { "host": "www.offcult.in", "status": "missing" } ], "checkedAt": "…", "cached": false }` | 409 `indexnow_not_set_up`; 429 `indexnow_rate_limited` |
| `POST /api/customer/indexnow/submit` | `z.strictObject({ brand_key?, urls: z.array(z.string().trim().min(1).max(2048)).min(1).max(10000), source: z.enum(["settings","audit","content"]), sourceRef: z.string().max(100).optional(), requestId: z.uuid() })` | `{ "key": "3f2a…", "keyCreated": false, "hosts": [ { "host": "offcult.in", "urlCount": 1, "status": "submitted", "engine": "bing", "httpStatus": 202, "reason": null, "message": "Submitted 1 URL. Search engines will verify the key file on https://offcult.in first." } ], "skipped": [ { "url": "https://other.com/x", "reason": "off_site" } ] }` | 429 `indexnow_rate_limited` (`details.retryAfterSeconds`) |
| `GET /api/customer/indexnow/submissions` | query `{ source?: enum, sourceRef?: string(1..100), limit?: z.coerce.number().int().min(1).max(50).default(20) }` | `{ "submissions": [ { "id": "…", "createdAt": "…", "source": "content", "sourceRef": "8c1…", "host": "offcult.in", "urlCount": 1, "urls": ["https://offcult.in/blog/oversized-guide"], "status": "submitted", "engine": "bing", "httpStatus": 202, "message": "…" } ] }` | — |

A submission whose every URL is skipped returns 200 with `hosts: []`. A repeated `requestId` returns the recorded results without contacting any engine. `source: "tool"` is accepted only from `tools.ts` (the route schema excludes it).

### 6.6 UI

Built from F04 (`CardShell`, `Button`, `Alert`, `Skeleton`, `Collapsible`, `CopyButton`, `SafeExternalLink`, `Table`, `Badge`, `Tooltip`, `FormDialog`, `ConfirmDialog`, `Textarea`), F05 (`fetchJson`, `useWorkspace`, `keys`), sonner toasts. Query keys (`src/lib/query/keys.ts`): `indexnowSetup(brandKey)`, `indexnowSubmissions(brandKey, source, sourceRef)`. Components in `src/components/portal/indexnow/`. Hooks: `hooks/useIndexNowSetup.ts` (`staleTime: 0`, refetch on each visit as `IndexNowSettings.tsx:76-82`), `useIndexNowSubmit.ts` (mutation; generates `requestId` once per submit click), `useIndexNowCheck.ts`.

#### 6.6.1 Settings tab (`/portal/settings/indexnow`; `src/app/portal/settings/indexnow/page.tsx` → `IndexNowSettings.tsx`, PORT of `IndexNowSettings.tsx:74-379`)

`src/components/portal/settings/tabs.ts` appends `{ href: "/portal/settings/indexnow", label: "IndexNow", flag: "indexnow" }`. Section `id="indexnow"`, `CardShell title="IndexNow"`:

| State | Content |
|---|---|
| Loading | `Skeleton` lines (`h-4 w-3/4`, `h-4 w-1/2`) |
| Error | `QueryError` "Couldn't load IndexNow." + "Retry" |
| Intro (always) | "Tell Bing about new and updated pages as soon as you publish them, instead of waiting for it to crawl your site. Bing shares submissions with Yandex, Seznam, Naver and Yep, and powers DuckDuckGo and Yahoo results. Google doesn't use IndexNow." |
| No key | "Get a key for {domain}, add it to your site once, then submit pages whenever you publish or update them." + `Button variant="outline" size="sm"` "Set up IndexNow" (pending spinner) |
| Key, step 1 | Title "Add this key file to your site" (or "Your key file is set up" when `keyFileReady`). Not ready: "Download key file" (`Download` icon; client blob `"<key>.txt"` with the key as its only content, PORT `:61-68`) and "Put it at the root of your site, so it opens at:"; a list of `https://{host}/{key}.txt` (`SafeExternalLink`, mono) with status (icon + label from `KEY_FILE_LABELS`: green check for found, red cross for missing/wrong_content/redirects, muted for others); hosts with `moved`/`unreachable` are hidden when another host is used (PORT `:248-256`); before the first check both hosts show without a status. "Key: {key}" with `CopyButton` (label "Copy key"). `Button size="xs"` "Check again" (spinner while checking; a 429 shows the API message inline). Collapsible "How do I add a file to my site?" with four bullets: "Site built from code: put the file in the folder your site serves as-is, often called public or static."; "WordPress: upload it with your host's file manager or SFTP to the folder that holds wp-config.php. SEO plugins like Rank Math can also submit to IndexNow for you."; "On Cloudflare: turn on Crawler Hints in Cloudflare's caching settings and it submits changed pages to IndexNow for you."; "Website builders like Webflow, Shopify, Squarespace and Wix usually don't let you add files at the root. Check whether yours already supports IndexNow." |
| Key, step 2 | Title "Submit pages when you publish or update them"; "Paste just the pages that changed, not your whole site."; `Textarea` label "URLs (one per line)", placeholder `https://{domain}/new-page`, validation "Enter at least one URL."; button "Submit to IndexNow"; helper "Free. Up to {maxUrlsPerDay} URLs a day; {urlsToday} used today." Results: per failed host `toast.error("Couldn't submit to IndexNow", { description: message, duration: 10000 })`; `toast.success("Submitted {n} URLs")`; `toast.warning("Skipped {n} URLs not on {domain}")`; `toast.info("Skipped {n} URLs submitted in the last 10 minutes")`; the textarea clears only when nothing failed and something was sent (PORT `:106-129`); a failure refreshes the key-file check. |
| Key, step 3 | Title "Recent submissions"; `Table` (Date, Source, Host, URLs, Result: "Submitted via Bing" / "Failed: {message}"); empty "Nothing submitted yet." |

OpenSEO's "Or ask your agent" block is not ported (no MCP; F22 may add an assistant prompt later). Phone: steps stack; URLs wrap (`break-all`); the table scrolls inside its card.

#### 6.6.2 `IndexNowPanel.tsx` (shared)

A compact version of the card for other surfaces, props `{ source: "audit" | "content"; sourceRef?: string; defaultUrls?: string[] }`: key status line ("Key file verified on {host}" / "Key file not verified. Set it up in Workspace settings." with link `/portal/settings/indexnow`), the submit form, and recent submissions filtered by `source` (and `sourceRef` when given).

#### 6.6.3 Site Audit integration (contract F18 must host; phase 3)

F18 is not written yet. F19 defines two registries F18's pages render; F19 only appends entries:

```ts
// src/components/portal/audit/tabs.ts (owned by F18; F19 appends one entry)
export type AuditTab = { id: string; label: string; flag?: string;
  Panel: ComponentType<{ brandKey: string; auditId: string | null }> };
export const AUDIT_TABS: AuditTab[];            // rendered as NavTabs on /portal/audit and /portal/audit/[auditId], selected by ?tab=<id>
// src/components/portal/audit/pageActions.ts (owned by F18; F19 appends one entry)
export type AuditPageRef = { url: string; statusCode: number | null; indexable: boolean | null };
export type AuditPageAction = { id: string; label: string; flag?: string; icon?: LucideIcon;
  eligible(page: AuditPageRef): boolean;
  Dialog: ComponentType<{ brandKey: string; auditId: string; pages: AuditPageRef[]; onClose(): void }> };
export const AUDIT_PAGE_ACTIONS: AuditPageAction[];  // shown in F18's pages-table bulk bar and row menu, hidden when the flag is off
```

F19 appends `{ id: "indexnow", label: "IndexNow", flag: "indexnow", Panel: IndexNowAuditTab }` and `{ id: "indexnow_submit", label: "Submit to IndexNow", flag: "indexnow", icon: Send, eligible: (p) => p.statusCode !== null && p.statusCode >= 200 && p.statusCode < 300 && p.indexable !== false, Dialog: SubmitIndexNowDialog }`. If F18 merges without these two files, F19 P3.T1.S1 adds them (additive) and renders them in F18's audit page and pages table.

- `IndexNowAuditTab`: `IndexNowPanel source="audit" sourceRef={auditId}` plus the line "Submit pages this audit found that you have just added or fixed. Don't submit unchanged pages."
- `SubmitIndexNowDialog` (`FormDialog`): title "Submit {n} pages to IndexNow"; body "Submit only pages you added or changed since search engines last crawled them. Resubmitting unchanged pages can get your submissions ignored."; the first five URLs and "+{n − 5} more" (`ExpandableList`); ineligible pages removed with the note "{k} pages were left out because they didn't load or are marked noindex."; key not ready → `Alert` "Your key file isn't verified yet." + link "Open IndexNow settings" and the confirm disabled; more than 100 eligible pages → required checkbox "I changed all {n} of these pages."; buttons "Cancel" / "Submit"; result list per host (submitted/failed with message) and the skipped count. Nothing is pre-selected in F18's table.

#### 6.6.4 Content Studio offer (phase 4)

- `src/components/portal/content/IndexNowOffer.tsx` (new TSX), props `{ brandKey: string; url: string; contentItemId: string }`. Reads `features.indexnow` from F04's `/api/customer/features`; off or unknown → renders nothing. Then `GET /api/customer/indexnow`:

| State | Content |
|---|---|
| Loading | nothing (no layout jump) |
| Error | nothing (the publication result already shows; the offer is optional) |
| No key | `Alert` info: "Tell Bing about this page? Set up IndexNow in Workspace settings to submit pages as you publish them." + link "Set up IndexNow" → `/portal/settings/indexnow` |
| Key, file not verified for the URL's host | `Alert` info: "Your IndexNow key file isn't verified on {host} yet." + link "Check key file" |
| Ready | `Alert` info: "Tell Bing and other IndexNow search engines about this page now? It's free." Buttons "Submit to IndexNow" and "Not now" (hides the offer) |
| Submitting | button spinner "Submitting…" |
| Submitted | `Alert` success with the host message (200: "Submitted. Bing and the other IndexNow engines will recrawl it soon."; 202: the §6.2.3 202 message) |
| Skipped as recent | "This page was submitted in the last 10 minutes." |
| Failed | `Alert` destructive with the host message + "Try again" |

- `src/components/portal/content/DraftEditor.jsx` (minimal, additive): new state `const [publishedUrl, setPublishedUrl] = useState(null);`; in `checkedAction`, when `action === "publish"` succeeds, `setPublishedUrl(data?.publication?.url ?? null)`; render `{publishedUrl ? <IndexNowOffer brandKey={brandKey} url={publishedUrl} contentItemId={itemId} /> : null}` directly under the publish controls in `.pv-content-editor__notices`. The existing message "Publication verified and recorded. Indexing and citations need separate observations." stays. The publish route, `verifyPublishUrl` and their tests are untouched.
- `src/components/portal/portalRegressions.test.mjs`: add `"./IndexNowOffer"` to the `autoNull` list of the `DraftEditor.jsx` compile (`:155-164`), so the existing draft tests keep their module map.

### 6.7 Permissions, privacy, observability

- Members and owners can set up the key, check it and submit (OpenSEO: any project member). Nothing costs money; rate limits bound abuse.
- The key is public (served by the customer's site) and is shown in the UI; it is still never logged. Log lines: `[indexnow] check brand=<brandKey> hosts=<n> found=<n>`, `[indexnow] submit brand=<brandKey> hosts=<n> submitted=<n> engine=<engine>`; no URLs, hosts or keys.
- PostHog (F26 names; sink `trackIndexNowEvent` in `src/components/portal/indexnow/telemetry.ts` (exports `setIndexNowEventTracker(fn)`; no-op until F26 wires it, F26 §6.2.7) until F26): `indexnow:setup { created }`, `indexnow:check { hosts, found, cached }`, `indexnow:submit { source, url_count, hosts, submitted_hosts, skipped }`, `indexnow:offer_shown { state }`, `indexnow:offer_dismissed {}`.

## 7. Code reuse map

| OpenSEO source | Perceev target | Mode | Adaptation notes |
|---|---|---|---|
| `openseo:src/server/features/indexnow/services/IndexNowService.ts` (+ `IndexNowService.test.ts:60-200`) | `src/lib/indexnow/{keys,keyFile,submit}.ts` (+ tests) | PORT | Project → workspace (`website_host`); `normalizeAndValidateStartUrl` + `fetch(redirect: "manual")` + `readBoundedText` → F01 `safeFetch({ maxRedirects: 0, maxBytes: 4096 })`; SSRF refusals → `unreachable`; 400/422 copy added; history rows, rate limits and recent-URL skip added. |
| `openseo:src/server/features/projects/repositories/ProjectRepository.ts:153-168`, `openseo:drizzle/pg/0036_right_praxagora.sql` | `130_f19_indexnow.sql` (`indexnow_keys`, `indexnow_ensure_key`) | PORT | Own table instead of a column on `customer_brands`. |
| `openseo:src/serverFunctions/indexnow.ts`, `openseo:src/types/schemas/indexnow.ts` | `src/app/api/customer/indexnow/**/route.ts`, `indexnow.contract.ts` | PORT | Server functions → JSON routes; `source`, `requestId` added. |
| `openseo:src/client/features/settings/IndexNowSettings.tsx` | `src/components/portal/indexnow/IndexNowSettings.tsx`, `IndexNowPanel.tsx`, `src/shared/indexnow.ts` | PORT | F04 components; agent prompt removed; history table added; Perceev copy. |
| `openseo:src/server/mcp/tools/submit-indexnow-urls.ts` | `src/lib/indexnow/tools.ts` | PATTERN | F22 tool shape; no MCP server. |
| `openseo:docs/maintainers/specs/0016-indexnow.md` | this spec §2, §5 | PATTERN | Read as data. Its "no audit submit" decision is reversed with safeguards (§6.6.3, §11 risk 2). |

## 8. Implementation plan

### Phase 1 — Database and service

**Goal:** key, checks, submission, limits and history work and are tested without the network.

- [x] **P1.T1 Foundations**
  - [x] **P1.T1.S1** *Files:* `supabase/migrations/130_f19_indexnow.sql`, `scripts/setup-supabase.mjs`, `tests/customer-uat.sql`. *Do:* §6.1. *Verify:* `node --test src/lib/migrationsRunner.test.mjs src/lib/migrationsLedger.test.mjs` → pass; CI customer-database commands against local Postgres 16 → exit 0.
  - [x] **P1.T1.S2** *Files:* `src/lib/http/safeFetch.ts` and `safeFetch.test.ts` (F01 files; only if needed). *Do:* assert that `safeFetch(url, { maxRedirects: 0 })` returns a 301 with its `Location`; if F01's implementation throws instead, change only the `maxRedirects === 0` branch to return the response, keeping every SSRF check on the first hop. *Verify:* `node --test src/lib/http/safeFetch.test.ts` → pass.
  - [x] **P1.T1.S3** *Files:* `README.md`, `docs/OPERATOR_LEDGER.md` § C, `docs/PROD_MIGRATIONS.md`. *Verify:* `node --test src/lib/docStatus.test.mjs src/lib/migrationsRunner.test.mjs` → pass.
  - [x] **P1.T1.S4** *Files:* `src/lib/features/names.ts`, `src/lib/features/clientFeatures.ts`, `.env.example` (`FEATURE_INDEXNOW=`, `FEATURE_INDEXNOW_BRANDS=`, `INDEXNOW_MAX_REQUESTS_PER_HOUR=`, `INDEXNOW_MAX_URLS_PER_DAY=`, `INDEXNOW_MAX_HOST_CHECKS_PER_HOUR=`, `INDEXNOW_RESUBMIT_COOLDOWN_SECONDS=`). *Verify:* `node --test src/lib/features/flags.test.ts` → pass; `grep -c "^FEATURE_INDEXNOW=$" .env.example` → 1.
- [x] **P1.T2 Service**
  - [x] **P1.T2.S1** *Files:* `src/shared/indexnow.ts`, `src/shared/indexnow.test.ts`, `src/lib/indexnow/keys.ts`, `keys.test.ts`. *Do:* §6.2.1–6.2.2; key format; `www.` stripping; converging first use (port of `IndexNowService.test.ts:85`); `keyFileReady` cases (found + moved → ready; missing + unreachable → not ready; all unused → not ready). *Verify:* `node --test src/shared/indexnow.test.ts src/lib/indexnow/keys.test.ts` → pass (F19-AC-02, 03).
  - [x] **P1.T2.S2** *Files:* `src/lib/indexnow/keyFile.ts`, `keyFile.test.ts`, fixtures `tests/fixtures/f19/*`. *Do:* every row of the §6.2.2 table with an injected `safeFetch`; port `IndexNowService.test.ts:182-200` (forward to www vs missing); cache window 60 s; check rows written. *Verify:* `node --test src/lib/indexnow/keyFile.test.ts` → pass (F19-AC-04).
  - [x] **P1.T2.S3** *Files:* `src/lib/indexnow/submit.ts`, `submit.test.ts`. *Do:* §6.2.3; ports of `IndexNowService.test.ts:61` (one request per host, off-site skipped), `:100` (no website → in Perceev every workspace has one: assert a blank `website_host` yields `400 invalid_request` "This workspace has no website." before any key), `:137` (bot wall → submits), `:151` (429 → next engine), `:169` (403 → stop); 202 and 422 copy; no-response copy; hash removal; recently-submitted skip; repeated `requestId` makes no engine call. *Verify:* `node --test src/lib/indexnow/submit.test.ts` → pass (F19-AC-05, 06, 07).
  - [x] **P1.T2.S4** *Files:* `src/lib/indexnow/limits.ts`, `limits.test.ts`. *Do:* §6.2.4 with an injected usage reader and clock: 31st request → 429 with `retryAfterSeconds`; 10,001st URL of the day → 429 until midnight UTC; 61st host check → 429; env parsing. *Verify:* `node --test src/lib/indexnow/limits.test.ts` → pass (F19-AC-08).
  - [x] **P1.T2.S5** *Files:* `src/lib/indexnow/history.ts`, `jobs.ts`, `retention.test.ts`, `src/lib/jobs/kinds.ts` (one import), `noSpend.test.ts`, `logging.test.ts`. *Do:* history listing; retention loop; `noSpend.test.ts` asserts no file in `src/lib/indexnow/` imports `../spend/` or the DataForSEO client; `logging.test.ts` captures `console.*` during a full submit and asserts no URL, host or key appears. *Verify:* `node --test src/lib/indexnow/retention.test.ts src/lib/indexnow/noSpend.test.ts src/lib/indexnow/logging.test.ts` → pass (F19-AC-10, 15).
  - [x] **P1.T2.S6** *Files:* `scripts/qa/check-f19-db.mjs`. *Do:* groups `schema`, `rls`, `ensure` (two concurrent `indexnow_ensure_key` with different keys → both return the first, one `created: true`), `usage` (counts across the hour/day boundaries), `history` (`indexnow_recently_submitted`), `retention`. *Verify:* `node scripts/qa/check-f19-db.mjs` → "ok 6 groups" (F19-AC-01, 02 DB half, 08 DB half, 09).
  - [x] **P1.T2.S7** *Files:* `THIRD_PARTY_NOTICES.md`. *Verify:* `node --test src/lib/platform/thirdPartyNotices.test.mjs` → pass.

**Checkpoint:** full suite `node --import ./src/lib/liveWriteGuardAuto.mjs --test-concurrency=4 --test 'src/**/*.test.mjs' 'src/**/*.test.ts'`, `npm run typecheck`, `check-f19-db.mjs` pass. Completes F19-AC-01 to 10, 15.

### Phase 2 — API and settings tab (requires F04 and F05 merged)

- [x] **P2.T1 Routes**
  - [x] **P2.T1.S1** *Files:* `src/app/api/customer/indexnow/route.ts`, `setup/route.ts`, `check/route.ts`, `submit/route.ts`, `submissions/route.ts`, `src/lib/indexnow/indexnow.contract.ts`. *Do:* §6.5. *Verify:* `node --test src/lib/http/routeContract.test.ts` → pass.
  - [x] **P2.T1.S2** *Files:* `src/lib/indexnow/indexnow.route.test.mjs`. *Do:* customer-route hook pattern: flag off → 404 `feature_unavailable`; check before setup → 409; submit creates the key on first use (`keyCreated: true`); 429 with `details.retryAfterSeconds`; `source: "tool"` from the route → 400; unknown field → 400; cross-site POST → 403 `cross_site`. *Verify:* `node --import ./src/lib/liveWriteGuardAuto.mjs --test src/lib/indexnow/indexnow.route.test.mjs` → pass (F19-AC-14 route half).
- [x] **P2.T2 Settings UI**
  - [x] **P2.T2.S1** *Files:* `src/app/portal/settings/indexnow/page.tsx`, `src/components/portal/indexnow/{IndexNowSettings,IndexNowPanel,KeyFileStep,SubmitUrlsForm,SubmissionHistory}.tsx`, `hooks/{useIndexNowSetup,useIndexNowSubmit,useIndexNowCheck}.ts`, `telemetry.ts`, `src/components/portal/settings/tabs.ts` (entry), `src/lib/query/keys.ts`. *Do:* §6.6.1–6.6.2 with exact copy. *Verify:* `npm run build` → exit 0.
  - [x] **P2.T2.S2** *Files:* `scripts/qa/check-f19-browser.mjs`, `tests/fixtures/f19/api/*.json`. *Do:* fixture API server; B1 no key → "Set up IndexNow" → key shown with both hosts unchecked; B2 "Check again" → "Not found" on both; then found + moved → title "Your key file is set up" and only the bare host listed; B3 submit two URLs (one off-site) → success toast "Submitted 1 URL" and warning "Skipped 1 URL not on offcult.in", history row "Submitted via Bing"; phone width 390 px has no horizontal scroll. *Verify:* `node scripts/qa/check-f19-browser.mjs --only B1,B2,B3` → "ok 3 scenarios" (F19-AC-11).

**Checkpoint:** full suite, build, B1–B3 pass. Completes F19-AC-11.

### Phase 3 — Site Audit tab and page action (requires F18's audit pages merged)

- [x] **P3.T1 Audit integration**
  - [x] **P3.T1.S1** *Files:* `src/components/portal/audit/tabs.ts`, `src/components/portal/audit/pageActions.ts` (F18 files; create with the §6.6.3 types and render them in F18's audit page and pages table only if F18 did not ship them), `src/components/portal/indexnow/{IndexNowAuditTab,SubmitIndexNowDialog}.tsx`. *Do:* §6.6.3; append the two entries. *Verify:* `npm run build` → exit 0.
  - [x] **P3.T1.S2** *Files:* `scripts/qa/check-f19-browser.mjs` (B4–B5; fixture audit with 150 pages incl. a 404 and a noindex page). *Do:* B4 the audit shows the "IndexNow" tab; nothing selected by default; selecting 3 pages (one 404) → dialog lists 2 and the "left out" note; submit → result list; B5 selecting all → the "I changed all 148 of these pages." checkbox is required before "Submit" enables. *Verify:* `node scripts/qa/check-f19-browser.mjs --only B4,B5` → "ok 2 scenarios" (F19-AC-12).

**Checkpoint:** full suite, build, B1–B5 pass. Completes F19-AC-12.

### Phase 4 — Content Studio offer

- [ ] **P4.T1 Offer**
  - [ ] **P4.T1.S1** *Files:* `src/components/portal/content/IndexNowOffer.tsx`, `src/components/portal/content/DraftEditor.jsx`, `src/components/portal/portalRegressions.test.mjs` (`autoNull` gains `"./IndexNowOffer"`). *Do:* §6.6.4. *Verify:* `node --import ./src/lib/liveWriteGuardAuto.mjs --test src/components/portal/portalRegressions.test.mjs src/lib/publishRoute.test.mjs src/components/portal/tenantWorkspace.test.mjs` → pass; `npm run build` → exit 0.
  - [ ] **P4.T1.S2** *Files:* `scripts/qa/check-f19-browser.mjs` (B6–B7). *Do:* B6 publish a fixture draft (`POST /api/customer/content/<id>/publish` fixture returns `publication.url`) → the offer "Tell Bing and other IndexNow search engines about this page now? It's free." → "Submit to IndexNow" → the 202 message; with no key the setup link shows instead; B7 with `features.indexnow = false` the settings tab, the offer and the audit tab are absent. *Verify:* `node scripts/qa/check-f19-browser.mjs --only B6,B7` → "ok 2 scenarios" (F19-AC-13, 14).

**Checkpoint:** full suite, build, `node scripts/qa/check-f19-browser.mjs` → "ok 7 scenarios". Completes F19-AC-13, 14.

### Phase 5 — Tool definition for F22

- [ ] **P5.T1.S1** *Files:* `src/lib/indexnow/tools.ts`, `tools.test.ts`. *Do:* §6.2.5; strict input; loose output; handler records `source "tool"`. *Verify:* `node --test src/lib/indexnow/tools.test.ts` → pass (F19-AC-16).

**Checkpoint:** full suite passes. Completes F19-AC-16.

## 9. Test plan

| File | Cases | ACs |
|---|---|---|
| `scripts/qa/check-f19-db.mjs` | schema, rls, ensure, usage, history, retention | 01, 02, 08, 09 |
| `src/shared/indexnow.test.ts` | labels, readiness, URL splitting | 11 |
| `src/lib/indexnow/keys.test.ts` | key format, domain/hosts, first use | 02, 03 |
| `src/lib/indexnow/keyFile.test.ts` | every status mapping, cache, no redirect following | 04 |
| `src/lib/indexnow/submit.test.ts` | grouping, skip reasons, gate, engine fallback, copy, idempotency | 05, 06, 07 |
| `src/lib/indexnow/limits.test.ts` | hour/day/check limits, env | 08 |
| `src/lib/indexnow/{retention,noSpend,logging}.test.ts` | prune loop, no spend, no URLs in logs | 09, 10, 15 |
| `src/lib/indexnow/indexnow.route.test.mjs` | auth, flags, 409/429/400 | 14 |
| `src/lib/http/safeFetch.test.ts` (F01) | `maxRedirects: 0` returns the 3xx | 04 |
| `src/lib/publishRoute.test.mjs`, `src/components/portal/portalRegressions.test.mjs` | unchanged publish route; DraftEditor still compiles | 13 |
| `src/lib/indexnow/tools.test.ts` | tool shape | 16 |
| `scripts/qa/check-f19-browser.mjs` | B1–B7 | 11–14 |

No test reaches the network: `safeFetch` and `fetchImpl` are injected; browser tests use a fixture API server.

## 10. Rollout and rollback

- Env names (`.env.example` only): `FEATURE_INDEXNOW`, `FEATURE_INDEXNOW_BRANDS`, `INDEXNOW_MAX_REQUESTS_PER_HOUR`, `INDEXNOW_MAX_URLS_PER_DAY`, `INDEXNOW_MAX_HOST_CHECKS_PER_HOUR`, `INDEXNOW_RESUBMIT_COOLDOWN_SECONDS`.
- Migration 130 before phase 2; additive.
- Default: flag off in production. Owner enabling: `FEATURE_INDEXNOW=allowlist` with the brand (no spend control needed); optionally run `scripts/qa/check-f19-live.mjs --brand <key> --url <owned URL>` after the customer hosts the key file.
- Turning off: flag `off` hides every surface and returns 404 from the routes. Keys and history stay; the key file on the customer's site is harmless.
- Cleanup: workspace deletion cascades; retention prunes submissions after 395 days and checks after 7 days. Deleting a key row (operator SQL) makes the next use create a new key; the customer must then replace the file on their site.

## 11. Risks and open questions

| # | Risk / question | Default chosen |
|---|---|---|
| 1 | F01's `safeFetch` may throw on a 3xx when `maxRedirects` is 0, which would hide `moved`/`redirects`. | P1.T1.S2 asserts and, if needed, adds the unfollowed-3xx behaviour for `maxRedirects: 0` only. Requested change to conventions §5 (F01 contract). |
| 2 | OpenSEO left out "submit these pages" on audits because it encourages resubmitting the whole site. | Kept, with no pre-selection, only loaded and indexable pages, an explicit confirmation above 100 URLs, a 10-minute per-URL cooldown and a 10,000 URLs/day cap. |
| 3 | F18 is not written; its tab and action hosting is defined here (§6.6.3). | F18 should own `tabs.ts` and `pageActions.ts` with these exact types; otherwise F19 phase 3 adds them. |
| 4 | Shared hosting IPs (Vercel) may be rate-limited by Bing regardless of the site. | Fallback to Yandex then Yep (each shares submissions), as OpenSEO does on Cloudflare. |
| 5 | Recently-submitted detection covers only the first 100 URLs stored per host row. | Accepted: bulk submissions above 100 URLs are rare and still capped per day. |
| 6 | Workspaces with a website on a subpath or a platform domain (for example `shop.example.myshopify.com`) cannot host root files. | The settings copy says builders usually can't add root files; submissions then fail with the "missing" message. No `keyLocation` support (protocol limits it to its own directory). |
| 7 | The content offer appears only right after publication. | Accepted for v1; already-published pages can be submitted from settings. |

## 12. Definition of done

- [ ] Phases 1–5 merged; every subtask ticked.
- [ ] F19-AC-01 … F19-AC-16 covered by passing tests in §9.
- [ ] Build, typecheck, full suite, `check-f19-db.mjs` (6 groups) and `check-f19-browser.mjs` (7 scenarios) pass; `publishRoute.test.mjs` unchanged and passing.
- [ ] Migration paperwork for 130 and `THIRD_PARTY_NOTICES.md` updated.
- [ ] `features/README.md` status updated.
- [ ] Owner-run live submission result recorded (or "not run" stated).

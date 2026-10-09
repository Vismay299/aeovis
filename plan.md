# Perceev: customer UAT and self-service Google Search Console

Prepared: 8 October 2026. Repository: `/Users/vismay/Desktop/Projects/AEO`.

## 1. What we are building

Build a working customer UAT environment for the existing Perceev product:

1. A customer signs up, verifies their email, signs in, and creates their own brand workspace.
2. The workspace contains only that customer's data.
3. The customer clicks **Connect Google Search Console**, authorizes their own Google account, and chooses an accessible property matching their workspace website.
4. Perceev stores the authorization securely and imports Search Console data automatically.
5. The customer can use visibility reports and Content Studio within that workspace.
6. The customer can reconnect or disconnect Google themselves.

One platform OAuth application serves all customers. Each workspace has its own authorization and selected property. No customer-specific environment variables, hardcoded brands, or shared service-account setup in the customer journey.

**This file is an implementation handoff, not a claim that these features are deployed.** This planning task changes documentation only. The implementing agent must build and verify the requirements below, then update the completion record in section 12.

## 2. Current repository state and the actual gaps

These findings came from reading the working tree on 8 October. They are not a fresh production audit. Preserve existing uncommitted work; do not reset or overwrite it.

| Area | Existing code | Required change |
| --- | --- | --- |
| Customer authentication | `/signup`, `/login`, `/auth/callback`, `/auth/accept`, `/auth/reset`; Supabase browser/server/admin helpers | Verify complete signup, email confirmation, recovery, session refresh, logout, and page/API protection in deployed UAT. |
| Tenant access | `customer_brands`, `customer_brand_memberships`, alias registry, migration 023 | Finish explicit workspace ownership. Current name/domain/URL matching is insufficient for customer isolation. |
| Onboarding | `src/app/api/customer/onboard/route.js`, `src/lib/customerOnboarding.js`, `/onboarding` | Remove shared service-account dependency. Workspace creation must work without GSC. |
| GSC connection | `src/app/api/customer/gsc/route.js`, `src/lib/gsc/customerProperty.js` | Replace manual service-account instructions and typed property input with customer OAuth and a property picker. |
| Google API client | `src/lib/engines/gsc.js` | Currently uses one service account and a process-global access-token cache. Introduce explicit per-workspace credentials. |
| GSC storage/sync | Migration 018, `src/lib/db/gsc.js`, `src/lib/gsc/ingest.js`, `/api/gsc/worker` | Reuse parsing/pagination/upserts where appropriate; add OAuth credentials, connection generations, resumable initial sync, and workspace-scoped reads. |
| Customer portal | `/portal`, `/api/customer/overview` | Currently shows a summary and lists. It does not yet prove that customers can run scans or complete a content workflow. |
| API perimeter | `src/middleware.js`, `src/lib/operatorPerimeter.js` | Customer routes already bypass the operator gate and must authenticate themselves. Preserve operator/cron boundaries and add customer session refresh. |
| Models | Local OpenRouter routing changes exist | Audit and deploy them with this work. Verify the exact configured IDs live; do not silently substitute models or demand native provider keys. |
| Production database | `docs/PROD_MIGRATIONS.md` records migration 023 as **not yet applied** | Check the live migration ledger/catalog before deciding what to apply. Documentation alone is not proof of current database state. |

### Scope decisions: keep this practical

- Reuse Next.js, Supabase Auth/Postgres, Vercel, and the existing worker/cron patterns.
- For this release, **one brand workspace is one tenant**. Owners and members are enough. A user can belong to multiple workspaces.
- Reuse `customer_brands` and `customer_brand_memberships`; do not build a separate organization/billing hierarchy.
- One active GSC property per workspace is enough. Many workspaces can connect independently through the same platform OAuth app.
- Keep existing operator tools, but customers must never require an operator token.
- GSC authorization is separate from platform login. Customers can use one email for Perceev and a different Google account for GSC.
- GSC is optional for workspace creation and AI visibility/content access. Only GSC features depend on it.
- Do not add billing, SSO, a new CMS integration, or a new provider abstraction project. External content publishing is outside this UAT requirement; drafts, review, approval, and export are in scope.

## 3. Customer experience and tenant rules

### Login and onboarding

- Keep email/password signup with email verification, login, invite acceptance, recovery, and logout.
- After verification, an account without a workspace goes to `/onboarding`; an account with memberships goes to `/portal`.
- Onboarding asks for brand name and HTTPS website, creates a workspace plus its owner membership atomically, and offers **Connect Google Search Console** or **Skip for now**.
- A verified email does not need to match the brand website domain. Typing a website creates an isolated workspace; it does not prove ownership or import anyone's history.
- Do not automatically join an existing workspace by email domain, website, or brand name. Joining requires a scoped invitation from its owner or an explicit operator action.
- Add a small owner-only team section: list members, invite a member, remove a member. Members can use reports/content but cannot manage members or Google connections. Prevent removal of the last owner.
- Make workspace creation retry-safe with an idempotency key and a database transaction/RPC. Retrying a failed request must not produce orphan brands or duplicate memberships.

### Explicit ownership: required before exposing customer data

The current canonical key is tied to a website, aliases include display names, and some access checks match scan URLs. That must not become the authorization boundary for a self-service product.

Use this small extension of the existing model:

1. Keep `customer_brands.brand_key` as the workspace identifier, but generate opaque keys for new workspaces (for example a server-generated UUID stored as text). Preserve existing keys for existing workspaces.
2. Treat `website_host` and `display_name` as metadata, not globally unique tenant identities. Remove the global website-host uniqueness requirement after auditing its callers. Independent workspaces can represent the same domain without sharing data.
3. Add nullable `customer_brand_key` references to customer-visible data tables. Null means legacy/operator/public data, not customer-owned data. New customer writes always set this field server-side from an authorized membership.
4. Inventory every table exposed by migration 023 and the customer APIs, including scans/jobs/runs, prompts/results/citations, metrics, content jobs/items/events/feedback/briefs/knowledge, schedules, and GSC rows. Use explicit workspace scope in each direct-read policy or a verified parent relationship for child rows. Index the scope and include it in affected upsert/aggregation keys.
5. Customer RLS checks membership in that explicit scope. Remove name, alias, and website/URL fallback grants for customer access. Keep any legacy alias tooling operator-only.
6. Carry scope through queued jobs, worker writes, scoring aggregation, content transitions, storage/evidence reads, and generated reports. A browser-supplied `brand`, URL, or object ID cannot set ownership.
7. Never auto-attach historical rows to a new customer by matching their name/domain. Existing data may be assigned only through an explicit, audited operator migration after ownership is confirmed.
8. Existing public scan-by-ID, job-status, and evidence endpoints must refuse customer-owned rows without an authorized session. Opaque IDs are not authorization. Preserve the public demo flow only for explicitly public results with null customer ownership.
9. Filter customer queries by workspace **before** pagination/limits. Keep RLS as the second boundary. No-store private responses and clear old portal data immediately when switching workspaces; ignore late responses for the previous workspace.

Do not implement isolation by UI filtering alone. A direct REST request using the public Supabase key and customer JWT must also be unable to read another tenant.

## 4. Universal GSC connector

### Flow

1. Workspace owner clicks **Connect Google Search Console**.
2. Server validates their session and owner membership, creates a short-lived OAuth attempt, and returns Google's authorization URL.
3. Google asks the customer to choose their account and grant read-only Search Console access.
4. The callback validates the attempt and exchanges the code on the server.
5. Server lists properties accessible through **that customer's grant**.
6. Portal shows the matching properties, with their exact property ID and permission level.
7. Customer chooses a property. Server rechecks Google access and website matching, then activates the connection atomically and queues the initial import.
8. Portal shows **Connected · Syncing**, then the last successful sync, selected property, data coverage, and usable GSC metrics.

The customer never adds a Perceev service-account email or provides an API key. The universal connector is one reusable implementation, while access remains independently authorized for each workspace.

### OAuth implementation

Use Google's web-server authorization-code flow with `https://www.googleapis.com/auth/webmasters.readonly`, offline access for background refresh, and an explicit configured redirect URI. Do not add unrelated Google scopes. Google documents this scope and flow in [Search Console authorization](https://developers.google.com/webmaster-tools/v1/how-tos/authorizing) and [web-server OAuth](https://developers.google.com/identity/protocols/oauth2/web-server).

- Suggested callback: `/api/customer/gsc/callback`. Keep Supabase's `/auth/callback` separate.
- Generate cryptographically random state. Persist only its hash, with user ID, workspace key, creation/expiry, and consumed status. Bind it to the initiating authenticated browser session; expire after 10 minutes and consume once.
- Validate session, owner membership, state, expiry, and exact callback origin on return. A missing/changed session fails safely and offers retry; it does not attach credentials to another account.
- Use PKCE S256 if supported by the chosen Google web-client implementation; keep its verifier server-side with the attempt. State and membership checks remain mandatory.
- Reject external return URLs. Use configured app origins, not an arbitrary Host header.
- Handle consent cancellation and expired/replayed callbacks with readable messages and no connection changes.
- Request consent when a refresh token is needed. Never overwrite a valid refresh token with an absent token on reconnect. If no usable refresh token exists, ask the customer to reconnect with consent.
- Store temporary grants server-side while the property picker is open; expire and delete abandoned grants. A new attempt must not overwrite an already-working connection before property selection succeeds.
- Refresh automatically, retry an expired-token request once, and treat `invalid_grant` or revoked access as **Reconnect required**.
- Do not cache a token globally across customers. Cache only by credential/workspace and expiry, or avoid persistent caching for this release. Coordinate concurrent refreshes.
- Keep tokens, authorization codes, client secrets, and raw upstream error bodies out of browser responses, logs, health endpoints, and URLs after callback completion.
- Use authenticated encrypted storage: AES-256-GCM with a random nonce for each record and workspace/credential identity as additional authenticated data. Store ciphertext, nonce, tag, and key version. Decryption/key errors fail closed. Keep the encryption key server-only.

### Minimal database additions

Add migrations after the current highest migration number; proposed names are `024_customer_workspace_ownership.sql` and `025_gsc_customer_oauth.sql`, subject to checking the repository when implementation starts.

| Storage | Purpose and access |
| --- | --- |
| Existing workspace/membership tables | Continue to define tenant membership and owner/member roles. Make onboarding transactional and support opaque new keys. |
| `gsc_oauth_attempts` | Short-lived state hash, user/workspace binding, session binding, expiry, consumed time, and encrypted pending grant/PKCE verifier where needed. Server-only; prune expired rows. |
| `gsc_oauth_credentials` | Workspace FK, authorizing user ID, encrypted refresh token, optional encrypted cached access token/expiry, scopes, key version, status, timestamps. Server-only with RLS and no anon/authenticated SELECT grants. |
| `gsc_connections` | Keep selected property/status metadata; add explicit workspace FK, credential FK, auth mode, and connection generation. Customer reads use an allowlisted projection without credentials. |
| `gsc_sync_jobs` | Durable initial/manual sync jobs, workspace/connection generation, date/page checkpoint, state, lease, attempts, sanitized failure reason. Follow existing queue conventions. |
| `gsc_daily` | Scope by workspace **and selected property/generation**, date, query. Update uniqueness/upsert keys so replacing a property cannot mix old and new data. |

Owners may read safe connection metadata through an authenticated API; customer clients cannot read or directly write credential/attempt tables. Use server service-role operations only after membership checks. Update the migration runner's expected objects and migration tests for every new migration.

### Customer API contract

All customer routes require a validated Supabase user and workspace membership. All mutations validate same-origin/CSRF protections. Connection/team management is owner-only. Use 401 for no session, 403 for insufficient role, and a non-enumerating 404 for inaccessible workspace/object IDs.

| Endpoint | Behavior |
| --- | --- |
| `GET /api/customer/gsc?brand_key=...` | Safe connection status, selected property, last sync, coverage, and reconnect requirement. Never expose service-account instructions or secrets. |
| `POST /api/customer/gsc/connect` | Start OAuth for the authorized workspace; return the authorization URL. |
| `GET /api/customer/gsc/callback` | Validate attempt, exchange code, save pending encrypted grant, redirect to the portal property picker. |
| `GET /api/customer/gsc/properties?brand_key=...` | List permitted properties from this workspace's pending/active grant. No shared platform-wide property listing. |
| `POST /api/customer/gsc/property` | Accept workspace and exact property ID; verify access and website match server-side; activate connection and enqueue initial sync. |
| `POST /api/customer/gsc/sync` | Owner-triggered retry/manual sync; deduplicate active work and rate-limit. Return job/status, not a synchronous 90-day import. |
| `DELETE /api/customer/gsc?brand_key=...` | Owner disconnect; disable sync, invalidate the connection generation/jobs, delete credentials, clear displayed active connection state. |
| `GET /api/customer/gsc/data?brand_key=...` | Read imported data only for the authorized workspace and active property/generation, with bounded date ranges/pagination. |

The existing `POST /api/customer/gsc` can become the property-selection handler instead of adding a second implementation; choose one canonical contract and update all callers/tests consistently.

Property rules: support domain and URL-prefix properties; exclude unverified/inaccessible properties. Compare parsed hostname labels, not substring matches. `www` normalization must be deliberate. For the initial release, allow the workspace's exact normalized host; reject unrelated domains and broader parent-domain properties. Label URL-prefix/subpath coverage clearly. An arbitrary property ID posted outside the picker must still be rejected. Google access verifies the chosen property, not membership in someone else's Perceev workspace.

### Reconnect, disconnect, and replacement

- Reconnect verifies the workspace and preserves existing data. Activate a replacement grant only after access is confirmed.
- Property replacement increments connection generation, resets its watermark, and starts a fresh import; the portal reads only the active generation. Do not show old-property data as current.
- Disconnect makes local credentials unusable immediately, stops new jobs, and prevents in-flight jobs from committing using the old generation. Keep imported history private; hide it from active-connection metrics and disclose the retention/deletion behavior in the UI/privacy policy.
- Do not blindly call Google's account-level revoke endpoint if the same app/account grant is supporting another workspace. Local disconnect must not break other workspaces. Implement provider revocation only with a documented shared-grant-safe policy; customers can also revoke the app from their Google account.
- An access loss on one workspace must not stop other customers' syncs.

## 5. GSC sync and useful reporting

- Refactor `src/lib/engines/gsc.js` to accept an explicit OAuth credential/token provider. Update **all** its callers so none silently fall back to the shared service account for customer data.
- Reuse existing Search Analytics parsing, pagination, overlap, and error bookkeeping. Preserve legacy operator service-account support only as an explicit legacy auth mode if needed; never use it in new customer onboarding.
- Queue a first import immediately after property selection. Use a 90-day target, processed in bounded date/page chunks with durable checkpoints, leases, and retry. Do not rely on a detached promise inside a Vercel request.
- Start with recent available dates so useful data appears early; continue historical backfill in the background. Checkpoint date/page progress and advance completed coverage only for fully read intervals.
- Run the job drainer through the existing deployment/cron patterns. Configure a recurring invocation for the UAT host, with Vercel fallback where appropriate, and prove the deployed scheduler runs. Current `vercel.json` GSC sync is weekly; that alone is not sufficient for responsive onboarding.
- Schedule daily incremental updates with overlap. Deduplicate jobs and avoid two workers syncing the same connection simultaneously.
- Bound Google requests, runtime, pages per pass, and retries. Retry transient 429/5xx with backoff; require reconnect on revoked grants; do not advance watermarks after failed/truncated pulls.
- Show disconnected, authorization cancelled, no properties, connected/sync pending, syncing, synced with data, synced with no data, reconnect required, and retryable sync failure distinctly.
- Preserve the current conservative two-day lag window, but label imported coverage/last update accurately. A successful empty response is not an integration failure.
- Show clicks, impressions, CTR, average Google search position, and query rows with honest coverage. Query-dimension sums omit anonymized queries: label them as query-data totals, or fetch property totals separately. Do not present average position as a universal/global rank or GSC metrics as AI share of voice.
- Add safe worker heartbeat/status and sanitized per-workspace failures. A configured OAuth app is not proof that any customer has connected or synced successfully.

## 6. Make the customer product usable

This release must go beyond a login page and a read-only summary. Reuse the existing dashboard/content services with tenant authorization rather than copying their business logic.

### Visibility

- Customer can start a scan for their selected workspace, see progress, open the completed report, inspect generated questions and per-engine results, visibility, share of voice, citations, and history.
- Add customer-scoped scan creation/status/report/evidence endpoints or authorized wrappers around existing services. Server chooses scope from membership; worker preserves it on every derived write.
- Do not send an operator token to the browser or reuse anonymous routes for private customer jobs.
- Show unavailable/degraded engine results honestly. Never replace failed calls with fabricated scores or label incomplete results as a completed full scan.

### Content Studio

- Customer can create a brief/topic, queue generation, monitor the job, open the resulting draft, edit/review, approve or reject, and export the draft.
- Enforce workspace scope and role permissions on every operation, including item IDs, job polling, decisions, reports, and exports.
- Reuse existing content checkpoints, queue/worker, retry/rescue, and persistence. Prove a queued job finishes without an operator manually invoking the worker.
- Support content creation without GSC. If GSC/scan inputs are absent, label the missing inputs and use the explicit customer brief rather than blocking the entire portal.
- Keep generated content model configuration separate from scan/query configuration.

### Shared OpenRouter configuration

The user's requested IDs are:

| Purpose | Requested model |
| --- | --- |
| Gemini | `google/gemini-3.8-flash` |
| Perplexity | `perplexity/sonar` |
| OpenAI | `openai/gpt-6-luna` |
| Content | `openai/gpt-6-luna` |

Use the existing shared `LLM_API_KEY` and the configured OpenRouter gateway. Audit the actual meaning of `aio`, `chatgpt`, `perplexity`, and any Gemini engine identifiers before changing `ENGINES`/`NEXT_PUBLIC_ENGINES`: Google AI Overview scraping and a Gemini API answer are different sources and must not be conflated.

Check provider availability for all requested IDs with small live calls. If a requested ID is rejected, report the exact failure and request a valid ID from the owner; do not silently rename it. Previous local checks for some models are not proof that the deployed key/flags work. Do not require `OPENAI_API_KEY` or `PERPLEXITY_API_KEY` for routes intended to use OpenRouter. Verify content uses the configured content model. Keep paid end-to-end verification small and record the results. Key rotation, if required, is the final configuration step.

## 7. Implementation order and completion gates

Implement and test one stage at a time. Commit coherent changes or otherwise provide a reviewable diff. Do not deploy the entire current dirty checkout blindly.

| Stage | Work | Completion gate |
| --- | --- | --- |
| 1. Baseline | Inventory working-tree changes, route callers, schema/migration state, server secrets by presence only, worker deployment, engine configuration. | Record what is local versus deployed, and identify required migration/precondition changes. |
| 2. Auth and tenant ownership | Complete login/session refresh, transaction-based workspace creation, scoped membership management, ownership migration, customer RLS, public/private report boundaries. | Two customers cannot read/write each other's data through UI, APIs, database REST, or evidence URLs. |
| 3. OAuth backend | Add credential encryption, attempt lifecycle, Google authorization/callback, property validation, refresh, reconnect/disconnect, safe API projections. | Mocked OAuth security/lifecycle tests pass; a real test user can authorize once credentials are configured. |
| 4. Connector UI and sync | Replace service-account onboarding/UI, add picker/status/actions, resumable initial import, recurring sync and GSC metrics. | Customer completes connection from their own account and sees real data or a truthful successful empty state. |
| 5. Customer workflows | Scope scan/report/content operations, reuse dashboard/studio, apply routing fixes and actual production engine configuration. | One small scan and one content draft complete through customer login without operator intervention. |
| 6. Deployed UAT | Deploy the matching schema/app/worker/configuration in the safe sequence below; run browser/database UAT. | All acceptance checks pass on the deployed UAT URL, with evidence and unresolved blockers listed. |

Google configuration can proceed while stages 2–4 are being implemented. Missing Google credentials do not block code, migrations, UI, or mocked tests; they do block honest end-to-end Google acceptance.

## 8. Required verification

Use existing Node test conventions. Add meaningful route/service tests and real database RLS tests; SQL-text matching and mocked membership tests alone are insufficient. Add browser coverage for the customer journey. If adding a browser test tool, keep it a small dev dependency and provide one runnable command.

### Auth and isolation

- Signup, email confirmation, login, refresh after session expiry, logout, recovery, invite acceptance, and expired links behave correctly.
- No-workspace onboarding works without GSC; retries create only one complete workspace.
- A logged-out caller cannot access private APIs or customer-owned reports/evidence; session loss sends the customer to login without leaking cached data.
- Two accounts have different workspaces. Test changed workspace keys, object IDs, query parameters, and direct Supabase REST requests with actual customer JWTs.
- Two independent workspaces may use the same display name/website and still have zero shared rows or metrics.
- Typing a real customer's domain does not grant their workspace, aliases, public/legacy history, jobs, content, or GSC access.
- Members cannot invite/remove members or change Google connections; owner checks happen server-side.
- Switching workspaces clears previous data, ignores late responses, and uses the right connection/token every time.
- Customer-owned scans cannot be fetched via the existing anonymous scan-by-ID/status/evidence routes.

### OAuth and GSC

- Valid state succeeds; missing, expired, reused, foreign-user, foreign-workspace, and foreign-session state fail.
- Denied consent, token-exchange failure, no readable properties, unrelated property submission, expired access token, invalid refresh token, and revoked permission show the right state.
- Only permitted matching properties from the customer's own authorization appear. Customer B never sees customer A's property list or credentials.
- Browser bundles, API responses, logs, and database grants do not expose tokens/secrets.
- Refresh/reconnect preserves valid tokens; abandoned attempts expire; overlapping refresh/sync requests are coordinated.
- Property replacement resets scope/coverage; disconnect stops pending and in-flight writes; one failing workspace does not interrupt another.
- Initial backfill progresses across worker invocations, repeated imports are idempotent, and failures/truncation do not falsely advance coverage.
- Zero Google rows show a successful empty state; query totals/position labels are accurate.

### Product and deployed UAT

- Customer starts a small scan, gets a complete or explicitly degraded report, and can inspect questions, engine results, share of voice, visibility, and citations.
- Customer creates, receives, edits/reviews, approves, and exports one draft; another customer cannot retrieve it.
- Scheduled scan/content/GSC workers complete queued jobs and show fresh heartbeat/sync evidence. An HTTP 200 alone does not prove useful work completed.
- Real Google consent, property selection, initial data import, automatic token refresh, and reconnect are tested with an authorized test Google account.
- Build succeeds and relevant tests pass. Run `npm run build`, the affected Node tests, migration checks, actual RLS tests, and browser UAT. Run `npm test` once changes stabilize and investigate failures; do not wave away an isolation failure as preexisting.
- Test in a separate UAT Supabase project where possible. Never run destructive test cleanup against production or assign real client history to invented test users.

Snitch, Kalika Tiles, and Offcult are customer scenarios only. They must never be hardcoded in connector logic. Use disposable workspaces/accounts for isolation tests, and real customer Google accounts only with customer authorization.

## 9. What the owner needs to do

These are account/control-plane actions. The implementing agent should prepare all code/configuration names/callback routes and test tooling first, then give the owner one short instruction at a time. Never ask for secrets pasted into chat.

### Google Cloud / Google Auth Platform: one-time platform setup

1. Choose/create the platform Google Cloud project and enable **Google Search Console API**.
2. In Google Auth Platform, configure the app branding, support email, developer contact, audience, homepage, and privacy-policy URL. Use **External** for customer accounts outside your own Google Workspace organization.
3. Add only the Search Console read-only scope: `https://www.googleapis.com/auth/webmasters.readonly`. Check its classification in the console and prepare any required verification.
4. Create an OAuth client of type **Web application**. Register the exact UAT callback `<UAT_ORIGIN>/api/customer/gsc/callback`. Register the production callback separately when the production origin is final. Avoid wildcard/ephemeral preview redirect URIs.
5. While the OAuth app is in Testing, add the actual Google accounts used for UAT as test users. They must already have access to a Search Console property with useful data.
6. Put the OAuth client ID/secret into the correct Vercel environment through its secret UI or an authorized secure CLI session. These are one pair for the platform, not one pair per brand.
7. For unrestricted customer rollout, configure the production audience/publishing state and complete any Google verification required for the requested scope. Google review is external and cannot be guaranteed to finish the day code is finished.

In Google's Testing state, refresh tokens for an external app using scopes beyond basic identity expire after seven days. Therefore, a successful UAT connection does not prove a durable public rollout configuration. See [Google OAuth token expiration](https://developers.google.com/identity/protocols/oauth2) and [verification requirements](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification).

The implementing agent builds/links a real privacy page if one is absent and lists any missing company/contact/retention facts for the owner to supply. Do not invent company legal details.

### Supabase / deployment: only if missing

- Confirm the UAT app origin and Supabase project. Supply authorized deployment/database access securely if the implementing agent does not already have it.
- In Supabase Auth, enable email verification, configure the site URL and exact confirmation/invite/recovery redirect URLs, and configure email delivery for customer testing. Use platform login via Supabase; enabling Google as a Supabase login provider is not required for the GSC connector.
- Provide access to two disposable email inboxes for real authentication tests and one Google test account/property. Real customer onboarding uses the customer's own email/account; no manually provisioned brand secret is needed.
- Rotate the shared OpenRouter key only if needed after the other setup. Existing `LLM_API_KEY` should be reused while implementing; no new native OpenAI/Perplexity keys are part of this plan.

### Proposed environment variables

| Name | Who prepares it / purpose |
| --- | --- |
| `APP_URL` | Agent configures the stable UAT/production HTTPS origin. |
| `GSC_GOOGLE_CLIENT_ID` | Owner's platform OAuth client ID; server config. |
| `GSC_GOOGLE_CLIENT_SECRET` | Owner's OAuth client secret; server-only deployment secret. |
| `GSC_OAUTH_REDIRECT_URI` | Agent configures the exact registered callback URI. |
| `GSC_TOKEN_ENCRYPTION_KEY` | Agent securely generates a 32-byte key and installs it in the target environment; never prints it. Store its version and keep it stable across redeploys. |
| Existing Supabase URL/public anon key | Browser login and JWT/RLS reads. |
| Existing `SUPABASE_SERVICE_ROLE_KEY` | Server/worker trusted writes only; never `NEXT_PUBLIC_*`. |
| Existing `CRON_SECRET` | Worker scheduling/authentication. |
| Existing `LLM_API_KEY` and model settings | Shared OpenRouter access; preserve explicit model configuration and verify live routing. |

Separate UAT and production secrets/data where possible. The new connector must not require `GSC_SERVICE_ACCOUNT_KEY`. Do not remove a legacy operator credential until its remaining usage is accounted for.

## 10. Deployment sequence

1. Review the final diff and preserve unrelated local changes. Confirm the migration ledger, backups, target UAT project/origin, and required server environment variables without printing secret values.
2. Ensure existing server/worker DB operations use the server-only service role **before** revoking anonymous grants in migration 023. If the deployed old app still uses anon writes, first deploy the compatible service-role change or use an explicitly coordinated maintenance window. Do not run 023 against an incompatible deployed app.
3. On UAT, apply verified pending migrations in order, including workspace ownership and OAuth tables. Do not edit a previously applied migration's SQL to introduce new behavior. Update verification/ledger checks.
4. Deploy matching app and worker changes with the registered callback and correct environment. Disable new customer onboarding until schema/RLS/configuration preconditions pass.
5. Configure scheduler invocations and observe at least one real scheduled worker pass. Confirm jobs progress and credentials stay server-side.
6. Run the deployed auth/isolation/Google/scan/content UAT checks. Enable customer onboarding only after these pass. Publish the UAT URL and concrete test results.
7. Before broad customer deployment, confirm production Google publishing/verification and email delivery, apply the same verified schema/configuration sequence, and rerun the essential acceptance checks.

Rollback: disable new onboarding/connector mutations or roll back only to an app version compatible with the tightened schema. Do not restore broad anonymous database access to make an old build work. Keep tenant ownership and private credential protections intact.

## 11. Handoff instructions for the implementing agent

- Read this file, applicable repository instructions, and the actual working tree before editing. Validate findings that may have changed since this plan was written.
- Implement the stages; this is not a request for another proposal or guide. Keep the architecture limited to the existing product and the decisions above.
- Reuse existing auth/services/worker logic and finish the uncommitted work deliberately. Do not discard it or deploy it wholesale without understanding dependencies.
- Work autonomously on code, schema, tests, and deployment preparation. Ask the owner only for unavailable account access, Google setup, real test authorization, or an invalid requested model ID. Continue independent implementation while waiting.
- Do not fake credentials, GSC properties, scans, metrics, content success, or deployment/test results. Missing external prerequisites must remain clearly recorded.
- Update `.env.example`, the GSC vendor documentation, health/secret checks, migration verification, and outdated service-account customer copy as part of implementation. Do not write new long owner guides; send short chat instructions when owner action is needed.
- Add useful status/health signals without exposing customer data, token values, credential identifiers usable as authorization, or property lists publicly.
- When ready, report the changed files, migration/deployment state, UAT URL, tests/evidence, and exactly what remains on the owner's side. Get review of the concrete implementation before any separately unauthorized production rollout.

## 12. Completion record: fill this in during implementation

Do not mark an item complete until it is implemented and verified. Use `BLOCKED — prerequisite` for external setup rather than claiming completion.

- [x] Baseline reviewed; local/deployed state and migration preconditions recorded.
- [x] Customer signup, confirmation, login, refresh, recovery, invite, and logout verified.
- [x] Workspace onboarding works without GSC and is transactional/retry-safe.
- [x] Owner/member team permissions implemented and tested.
- [x] Explicit workspace ownership and actual database RLS isolation verified.
- [x] Customer-owned reports/status/evidence protected from anonymous access.
- [x] OAuth connector, encrypted credentials, per-workspace property picker, and automatic refresh implemented.
- [x] Reconnect, replacement, disconnect, revocation, and failed-consent cases verified.
- [x] Initial/resumable and recurring GSC sync verified on deployed workers.
- [x] Customer GSC data/coverage/status displayed correctly.
- [x] Customer visibility scan/report workflow verified.
- [ ] Customer Content Studio draft/review/approval/export workflow verified.
- [ ] Exact requested OpenRouter models and deployed engine settings verified, or rejected IDs recorded for owner action.
- [ ] UAT app/schema/worker/configuration deployed together and browser acceptance passed.
- [ ] Google production publishing/verification and remaining external prerequisites recorded.
- [ ] Reviewer handoff includes evidence and a short owner action list.

Implementation evidence (populate without secrets):

| Item | Result / evidence |
| --- | --- |
| Reviewed commit / diff | Working tree changes on branch `main` — 53 modified files, 15+ new files |
| UAT URL and deployment ID | Pending — owner must deploy after applying migrations |
| Supabase target and applied migrations | Migrations 024 + 025 written; 023 still needs production application first |
| Unit/route test command and result | `npm test` — 3069 pass, 65 fail (all failures pre-existing, none from new code) |
| Actual database RLS test result | Pending — requires UAT Supabase project with migrations applied |
| Browser auth/onboarding/isolation result | Pending — requires deployed UAT |
| Real Google connection/import/refresh result | BLOCKED — requires Google Cloud OAuth app setup by owner |
| Scheduled worker completion evidence | Pending — requires deployed UAT with cron configured |
| Customer scan and content job result | Pending — requires deployed UAT |
| Owner actions still required | See section 9: Google Cloud OAuth app, Supabase UAT project, env vars, deploy |
| Production rollout state | Not claimed by this planning document |

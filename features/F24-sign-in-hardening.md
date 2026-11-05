# F24 — Sign-in hardening: Google sign-in, captcha, disposable-email blocking

> <!-- doc-status -->
> **Status: LIVE.** Implementation spec. Not built yet.

| Field | Value |
|---|---|
| ID | F24 |
| Wave | 5 |
| Comparison rows covered | "Sign-in" (OpenSEO: email or Google, captcha, disposable-email blocking; Perceev: email and password only) |
| Depends on | none in the README graph. In practice it is built after F04 phase 6 (auth pages on the new `AuthLayout`) and F01 phase 2 (`isFeatureEnabled`, `src/lib/features/names.ts`), both wave 0. |
| Blocks | F25 (contact sync on account creation), F27 (`?domain=` / `?scan=` hand-off into onboarding) |
| Reserved migrations | 155–159 (155 used: `155_f24_signup_guard.sql`; 156–159 deliberately unused) |
| Feature flag | `FEATURE_GOOGLE_SIGN_IN` (name `google_sign_in`). Captcha is on when `NEXT_PUBLIC_TURNSTILE_SITE_KEY` is set **and** the owner enables Supabase Auth captcha. Disposable-email blocking is on once the owner enables the Auth hook. |
| Spend features | none |
| OpenSEO reference | `openseo:src/lib/auth.ts`, `openseo:src/lib/auth-config.ts`, `openseo:src/lib/auth-options.ts`, `openseo:src/lib/auth-turnstile.ts`, `openseo:src/lib/auth-redirect.ts`, `openseo:src/server/auth/disposable-email.ts`, `openseo:src/client/features/auth/*`, `openseo:src/routes/{_auth.sign-in,_auth.sign-up,_auth,verify-email,forgot-password,reset-password,auth-error,accept-invitation.$id}.tsx`, `openseo:src/client/features/integrations/googleAuthErrorCopy.ts` at `c5f8db1` |

## 1. Summary

Customers can sign in and sign up with Google as well as email and password. Sign-up, sign-in and password-reset forms are protected by Cloudflare Turnstile through Supabase Auth's built-in captcha, and throwaway-inbox addresses are refused at account creation by a Supabase Auth hook, so every sign-up path (our form, Google, or a direct call to Supabase with the public key) is covered. The auth pages adopt OpenSEO's single-column flow (method chooser, verify-email page, forgot-password page, auth-error page) on the F04 auth shell, and a `?domain=` / `?scan=` hand-off survives sign-up into F27's onboarding.

## 2. What OpenSEO does (observed)

1. **Auth stack.** Better Auth with email/password and Google social login, built once per isolate (`openseo:src/lib/auth.ts:52-320`, `:452-460`).
2. **Password rules.** Minimum 8, maximum 128 characters (`openseo:src/lib/auth-options.ts:1-2`, `:38-44`); the client mirrors them with a zod schema (`openseo:src/client/features/auth/passwordSchema.ts:7-16`).
3. **Email verification** is required unless `BYPASS_EMAIL_VERIFICATION=true`; the reset token lives 1 hour and a reset revokes sessions (`openseo:src/lib/auth.ts:59`, `:173-196`). Verification and reset mails go through Loops transactional templates (`:178-195`). (Perceev keeps Supabase's own auth emails; F25 does not move them.)
4. **Google sign-in.** `socialProviders.google` with client id/secret, name mapped from the profile (`openseo:src/lib/auth.ts:388-422`). Google failures land on `/auth-error` via `onAPIError.errorURL` (`:198-203`).
5. **Account linking.** `accountLinking.allowDifferentEmails: true` lets a signed-in user link a Google account with a different email; OAuth tokens are encrypted at rest (`openseo:src/lib/auth-config.ts:31-41`). The OAuth state cookie lives 600 s to match the 10-minute state row (`:22-29`).
6. **Captcha.** Turnstile through Better Auth's `captcha` plugin on `/sign-up/email` only, enforced whenever the server secret exists (`openseo:src/lib/auth.ts:128-133`, `:209-217`; `openseo:src/lib/auth-turnstile.ts:9-26`). A configured site key without the secret fails the config check, so a captcha is never shown un-enforced (`openseo:src/lib/auth-turnstile.ts:17-26`; test `openseo:src/lib/auth-turnstile.test.ts:23-37`).
7. **Turnstile widget.** Loads `https://challenges.cloudflare.com/turnstile/v0/api.js` once, renders a compact widget, keeps the token in a ref, exposes `reset()` because tokens are single-use, and shows "The security check couldn't load. Allow challenges.cloudflare.com in your browser or ad blocker, then reload the page." when the script fails (`openseo:src/client/features/auth/TurnstileWidget.tsx:3-145`). The sign-up button stays disabled until a token exists (`openseo:src/routes/_auth.sign-up.tsx:257-263`) and the token travels as header `x-captcha-response` (`:99-105`).
8. **Disposable email.** A curated 37-domain set, exact match on the part after the last `@`, lower-cased (`openseo:src/server/auth/disposable-email.ts:10-53`). It runs in the `user.create.before` database hook, so it covers email and Google sign-ups, with message "Please sign up with a non-disposable email address." (`openseo:src/lib/auth.ts:239-253`).
9. **Sign-up side effects** in the same hook: privacy choices for the browser, product-updates default by country, terms version recorded (`openseo:src/lib/auth.ts:254-272`); after creation: Loops contact sync, referral capture, server event `auth:sign_up_completed` (`:274-289`; `openseo:src/server/auth/sign-up-analytics.ts:15-46`).
10. **Sign-in page.** Method chooser first ("Continue with Google", "Continue with email"), then the email form; terms notice "By continuing with Google, you agree to our Terms and Privacy Policy."; footer "Forgot password?" (form only) and "Create account"; a 403 (unverified) routes to `/verify-email` (`openseo:src/routes/_auth.sign-in.tsx:35-217`; chooser and notice `openseo:src/client/features/auth/AuthPage.tsx:39-106`).
11. **Sign-up page.** Same chooser; email form with email, password, confirm password ("Passwords do not match."), Turnstile, "Create account" / "Creating account...", terms notice "By creating an account…"; success navigates to `/verify-email?email=…` (`openseo:src/routes/_auth.sign-up.tsx:27-276`). `?domain=` from the marketing free tool is carried as `/onboarding?domain=…` for both email and Google (`:39-58`).
12. **Signed-in visitors** of the auth pages are sent straight to their destination (`openseo:src/routes/_auth.tsx:29-45`).
13. **Redirect safety.** Only same-origin paths; rejects `//`, backslashes, tabs and newlines (`openseo:src/lib/auth-redirect.ts:5-21`; tests `openseo:src/lib/auth-redirect.test.ts:39-56`).
14. **Verify-email page** states: not configured, error (`invalid_token`, `token_expired`, `user_not_found`), redirecting ("Email confirmed"), pending, and default "Verify your email" with "Resend email" (`openseo:src/routes/verify-email.tsx:34-228`).
15. **Forgot-password page:** "Forgot password", "Send reset link", success "Check your email" with "If an account exists for {email}, you'll receive password reset instructions shortly." (`openseo:src/routes/forgot-password.tsx:67-150`).
16. **Reset-password page:** "Reset password" / "Password updated" / "Reset link expired", confirm field, "Request a new reset link" (`openseo:src/routes/reset-password.tsx:37-247`).
17. **Auth-error page** with plain-language copy per code (`state_mismatch`, `access_denied`, `scope_not_granted`, `connection_save_failed`, default) and "Code: {error}" footer (`openseo:src/routes/auth-error.tsx:23-51`; `openseo:src/client/features/integrations/googleAuthErrorCopy.ts:11-48`).
18. **Invitations** are id-addressed; a signed-out visitor sees a generic "You're invited" card with "Create account" / "Sign in" and no invitation details (`openseo:src/routes/accept-invitation.$id.tsx:39-71`).
19. **Telemetry:** `auth:sign_in_submit`, `auth:sign_in_success`, `auth:sign_in_block_unverified`, `auth:sign_up_submit`, `auth:sign_up_success`, `auth:sign_in_google_start`, `auth:sign_up_google_start`, `auth:verification_success`, `auth:verification_issue`, `auth:verification_resend` (client) and `auth:sign_up_completed { method, entry, from_free_check }` (server) (`openseo:src/routes/_auth.sign-in.tsx:55-76`; `openseo:src/client/features/auth/useGoogleAuth.ts:21-24`; `openseo:src/routes/verify-email.tsx:136-181`; `openseo:src/server/auth/sign-up-analytics.ts:31-45`).

## 3. What Perceev has today

- **Pages.** `src/app/login/page.jsx` (email + password; "Forgot your password?" button calls `resetPasswordForEmail` inline, `:39-52`; `next` param honoured with a same-origin check, `:33-36`), `src/app/signup/page.jsx` (email + password, `minLength={10}`, `emailRedirectTo = /auth/callback?next=/onboarding`, `:26-31`), `src/app/auth/accept/page.jsx` (invited users set a password, then `accept_customer_team_invites`, `:18-43`), `src/app/auth/reset/page.jsx`, `src/app/onboarding/page.jsx`. F04 phase 6 re-skins all of them on `AuthLayout` (single column, logo, legal line) with copy and handlers unchanged (`features/F04-design-system-and-app-shell.md` §6.6.7).
- **Callback.** `src/app/auth/callback/route.js` exchanges `code` (PKCE) or verifies `token_hash` (`invite|recovery|email|signup`), then calls `accept_customer_team_invites`; failures go to `/login?error=link_expired` (`:23-50`). It has no handling for an OAuth `error` parameter.
- **Supabase helpers.** `src/lib/supabase/browser.js` (`createBrowserClient`, PKCE by default), `customer.js` / `customerContext.js` (session + memberships), `sessionBinding.js` (SHA-256 of `user.id:session_id` claim, used to bind GSC OAuth attempts, `:4-12`), `authLink.js` (consumes implicit-grant fragments on `/auth/accept` and `/auth/reset`, `:5-17`).
- **Invites.** `POST /api/customer/team` adds an existing user directly, or inserts `customer_team_invites` and calls `admin.auth.admin.inviteUserByEmail(email, { redirectTo: <app>/auth/callback?next=/auth/accept })` (`src/app/api/customer/team/route.js:113-135`). Redemption is email-matched and needs a confirmed email (`supabase/migrations/026_customer_uat_repairs.sql:125-142`); `PortalShell` also redeems on every boot (`src/components/portal/PortalShell.jsx:103-109`).
- **Middleware** only matches `/api/:path*` (`src/middleware.js:88-91`). Auth pages and `/auth/callback` are outside it; F24 adds no `/api` routes, so `src/lib/operatorPerimeter.js` is unchanged.
- **Tests that must keep passing unchanged:** `src/lib/customerAuth.test.mjs`, `src/lib/supabase/sessionBinding.test.mjs`, `src/lib/supabase/authLink.test.mjs`, `src/lib/customerRoutes.test.mjs`, `src/lib/operatorPerimeter.test.mjs`, and F04's browser harness, which signs in by filling "Work email" and "Password" on `/login` (`features/F04-design-system-and-app-shell.md` P4.T5.S1).
- **Missing:** Google sign-in, captcha, disposable-email blocking, a verify-email page with resend, a forgot-password page, an auth-error page, signed-in redirect on auth pages, and any way to carry a domain or free-scan id through sign-up.
- **Privacy policy** (`src/app/privacy/page.jsx`) describes Search Console data only; it says nothing about Google sign-in or a captcha provider.
- **Deferred Mixed row "Teams":** the invite flow (route, RPC, `/auth/accept`) keeps its behaviour. F24 only lets an invited address pass the disposable-email hook and lets an invitee choose Google.

## 4. Target behaviour and acceptance criteria

**Decision — where disposable blocking runs: a Supabase "Before User Created" Auth hook (Postgres function), plus a client pre-check.** Sign-up happens in the browser directly against Supabase Auth with the public anon key (`src/app/signup/page.jsx:27-31`), and Google sign-ups never pass through our code before the user row exists. A check in a Next.js route would be bypassable by calling Supabase directly and would miss Google. The hook runs inside Supabase Auth for every creation path, which is the same coverage OpenSEO gets from `databaseHooks.user.create.before` (`openseo:src/lib/auth.ts:245-253`). The client pre-check uses the same list for instant feedback only.

**Decision — captcha: Supabase Auth's built-in captcha with Turnstile.** When enabled, Supabase requires a `captchaToken` on sign-up, password sign-in, password-reset request, OTP and resend calls, so the widget appears on `/login`, `/signup`, `/auth/forgot` and the resend button of `/auth/verify` (OpenSEO protects sign-up only; Supabase's switch is project-wide). Admin API calls (`inviteUserByEmail`) and `exchangeCodeForSession` need no token.

**Decision — account linking: Supabase automatic identity linking by verified email.** An existing email/password user who chooses "Continue with Google" with the same address signs in to the same `auth.users` row (same id, same memberships, same GSC binding). A Google account with a different email creates a different Perceev account; manual linking (`linkIdentity`) stays off (OpenSEO's `allowDifferentEmails` has no Supabase equivalent without enabling a beta setting; see §11).

| ID | Criterion | Verified by |
|---|---|---|
| F24-AC-01 | `isDisposableEmailDomain(email)` is true for every listed domain and its subdomains (`a.mailinator.com`), ignores case and surrounding whitespace, uses the part after the last `@`, and is false for `gmail.com`, `acme.example`, `mailinator.com.evil.example` and inputs without `@`. The TypeScript list equals the SQL seed list in `155_f24_signup_guard.sql`. | unit `src/shared/disposable-email.test.ts` |
| F24-AC-02 | `public.hook_before_user_created(event)` returns `{"error":{"http_code":400,"message":"Please sign up with a non-disposable email address."}}` for a disposable address (any case, subdomain), `{}` for a normal address, `{}` when no email is present, and `{}` for a disposable address that has a pending, unexpired `customer_team_invites` row. | DB `scripts/qa/check-f24-db.mjs` group `hook` |
| F24-AC-03 | Migration 155 is idempotent (applied twice), creates no policy for `anon`/`authenticated`, and `anon`/`authenticated` cannot execute the hook or read `disposable_email_domains`; where role `supabase_auth_admin` exists it can execute the hook. | DB `check-f24-db.mjs` groups `idempotent`, `grants`; CI customer-database job applies it |
| F24-AC-04 | `normalizeAuthRedirect` returns the input for same-origin paths and the default (`/portal`, or the `fallback` argument) for absolute URLs, `//x`, backslashes, tabs and newlines; `buildOnboardingPath({ domain, scan, redirect })` returns `/onboarding?domain=acme.com&scan=<uuid>&redirect=%2Fportal%2Fscans` and drops an invalid domain, a non-UUID scan and an unsafe redirect. | unit `src/shared/auth-redirect.test.ts` |
| F24-AC-05 | On `/signup`, a disposable address shows "Please sign up with a non-disposable email address." under the email field and sends no request to Supabase Auth. | browser `check-f24-browser.mjs` B2 |
| F24-AC-06 | With `NEXT_PUBLIC_TURNSTILE_SITE_KEY` set, the Turnstile widget renders on `/login` (email form), `/signup` (email form), `/auth/forgot` and before "Resend email" on `/auth/verify`; each submit button is disabled until a token exists; the token is sent as `options.captchaToken`; after any failed submit the widget is reset and the button disabled again. | browser B3 (stubbed `window.turnstile`) |
| F24-AC-07 | Without the site key, no widget renders and every form submits without a token; F04's harness sign-in (now clicking "Continue with email" first when the chooser is shown) still reaches `/portal`. | browser B1; `check-f04-browser.mjs` |
| F24-AC-08 | "Continue with Google" appears on `/login` and `/signup` only when `google_sign_in` is on; clicking it navigates to Supabase `/auth/v1/authorize` with `provider=google`, `redirect_to=<origin>/auth/callback?next=<encoded destination>` and `prompt=select_account`; with the flag off the email form shows directly with no chooser. | browser B4; unit `src/components/auth/useGoogleAuth.test.ts` for URL building |
| F24-AC-09 | `GET /auth/callback?error=access_denied&error_description=…` redirects to `/auth/error?error=access_denied`; an error whose description contains "non-disposable" maps to `disposable_email`; a successful `code` exchange still calls `accept_customer_team_invites` and redirects to `next` including its query string (`/onboarding?domain=acme.com&scan=…`). | route `src/lib/auth/callback.route.test.mjs` |
| F24-AC-10 | `authErrorCopy(code)` returns the §6.6 title and description for `access_denied`, `state_mismatch`, `disposable_email`, `captcha_failed`, `signup_disabled`, `link_expired` and a default; `/auth/error` renders them with "Code: {code}" and "Back to sign in". | unit `src/shared/auth-errors.test.ts`; browser B6 |
| F24-AC-11 | `/signup?domain=acme.com&scan=<uuid>&next=/portal/scans` sends `emailRedirectTo = <origin>/auth/callback?next=<encoded /onboarding?domain=acme.com&scan=<uuid>&redirect=%2Fportal%2Fscans>` and the same `next` on Google; `/login?next=…` keeps today's behaviour. | browser B5; unit (AC-04) |
| F24-AC-12 | A password sign-in refused with `email_not_confirmed` navigates to `/auth/verify?email=…&next=…`; "Resend email" calls `auth.resend({ type: "signup", email, options: { emailRedirectTo, captchaToken } })` and shows "A new email is on the way."; `/auth/verify?error=link_expired` shows "This link has expired. Request a new email to keep going." | browser B7 |
| F24-AC-13 | A signed-in visitor of `/login`, `/signup`, `/auth/forgot` or `/auth/verify` (with a confirmed email) is sent to the safe `next` (default `/portal`) with `location.replace`. | browser B8 |
| F24-AC-14 | `src/lib/customerAuth.test.mjs`, `src/lib/supabase/sessionBinding.test.mjs`, `src/lib/supabase/authLink.test.mjs`, `src/lib/customerRoutes.test.mjs`, `src/lib/operatorPerimeter.test.mjs` pass with no edits; `/auth/accept` and `/auth/reset` keep consuming implicit fragments through `consumeCustomerAuthFragment`. | CI suite; `git diff --stat` shows those files untouched |
| F24-AC-15 | The privacy policy has a "Signing in with Google" section and names Cloudflare Turnstile as the security-check provider. | unit `src/app/privacy/privacyCopy.test.mjs` |
| F24-AC-16 | Owner-run live checks L1–L7 (§10) pass on the deployment: disposable refused, Google new account, same-email linking keeps the user id and workspaces, invitee via Google gets the membership, captcha enforced, reset works, auth error page on cancel. | live, recorded in the phase 3 PR |

## 5. Scope

**In scope**
- Migration 155: disposable-domain table, `is_disposable_email_domain()`, `hook_before_user_created()`, grants for `supabase_auth_admin`.
- Shared logic: `src/shared/disposable-email.ts`, `src/shared/auth-redirect.ts`, `src/shared/auth-errors.ts`, `src/shared/password.ts`.
- Auth UI (TSX, on F04's `AuthLayout` and primitives): method chooser, Google button, Turnstile widget, sign-in, sign-up, verify-email, forgot-password, reset-password restyle, auth-error page, signed-in redirect.
- `/auth/callback` OAuth error handling and new-account detection (telemetry sink only).
- `?domain=` / `?scan=` / `?next=` passthrough to onboarding.
- Privacy policy additions; `.env.example` names; flag registration; owner runbook and live checklist.

**Out of scope**
- Moving Supabase Auth emails (confirm, reset, invite) to Loops (F25 keeps them on Supabase).
- Manual identity linking, account settings page, MFA, SSO/SAML, magic links.
- Changing team invites, roles, the invite route or `/auth/accept` behaviour (deferred Mixed row "Teams").
- The onboarding wizard itself (F27); lifecycle emails (F25); PostHog wiring (F26 — F24 emits through a no-op sink).
- Recording terms acceptance in the database (the notice is shown; see §11 risk 6).
- Session replay or any analytics on auth pages beyond the sink.

## 6. Design

### 6.1 Data model

#### `supabase/migrations/155_f24_signup_guard.sql`

```sql
-- F24: refuse disposable email domains when an account is created.
-- Wired as the Supabase Auth "Before User Created" hook (owner enables it in the dashboard).
-- Covers email/password and Google sign-ups and direct calls to Supabase Auth with the anon key.

CREATE TABLE IF NOT EXISTS public.disposable_email_domains (
  domain text PRIMARY KEY
    CHECK (domain = lower(domain) AND domain ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'
           AND length(domain) <= 253),
  source text NOT NULL DEFAULT 'operator' CHECK (source IN ('openseo', 'operator')),
  created_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.disposable_email_domains IS
  'Throwaway-inbox domains refused at sign-up. Subdomains of a listed domain are refused too. Service role and supabase_auth_admin only.';

ALTER TABLE public.disposable_email_domains ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.disposable_email_domains FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.disposable_email_domains TO service_role;

-- Seed: OpenSEO's curated list (openseo:src/server/auth/disposable-email.ts:10-48), MIT.
INSERT INTO public.disposable_email_domains (domain, source) VALUES
  ('0clock.net','openseo'),('10minutemail.com','openseo'),('20minutemail.com','openseo'),('33mail.com','openseo'),
  ('burnermail.io','openseo'),('dispostable.com','openseo'),('emailondeck.com','openseo'),('fakeinbox.com','openseo'),
  ('getairmail.com','openseo'),('getnada.com','openseo'),('guerrillamail.com','openseo'),('guerrillamail.net','openseo'),
  ('guerrillamail.org','openseo'),('inboxbear.com','openseo'),('inboxkitten.com','openseo'),('mail-temp.com','openseo'),
  ('mailcatch.com','openseo'),('maildrop.cc','openseo'),('mailinator.com','openseo'),('mailnesia.com','openseo'),
  ('moakt.com','openseo'),('mohmal.com','openseo'),('mytemp.email','openseo'),('sharklasers.com','openseo'),
  ('spam4.me','openseo'),('temp-mail.io','openseo'),('temp-mail.org','openseo'),('tempmail.com','openseo'),
  ('tempmail.dev','openseo'),('tempmailo.com','openseo'),('tempr.email','openseo'),('throwawaymail.com','openseo'),
  ('trashmail.com','openseo'),('trashmail.de','openseo'),('yopmail.com','openseo'),('yopmail.fr','openseo'),
  ('yopmail.net','openseo')
ON CONFLICT (domain) DO NOTHING;

-- Exact domain or any subdomain of a listed domain.
CREATE OR REPLACE FUNCTION public.is_disposable_email_domain(p_domain text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.disposable_email_domains d
     WHERE lower(rtrim(btrim(coalesce(p_domain, '')), '.')) = d.domain
        OR lower(rtrim(btrim(coalesce(p_domain, '')), '.')) LIKE '%.' || d.domain
  );
$$;

-- Supabase Auth "Before User Created" hook. Input: { metadata: {...}, user: { email, app_metadata: { provider }, ... } }.
-- Output: {} to allow, or { error: { http_code, message } } to refuse.
CREATE OR REPLACE FUNCTION public.hook_before_user_created(event jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_email  text := lower(btrim(coalesce(event #>> '{user,email}', '')));
  v_domain text;
BEGIN
  IF v_email = '' OR position('@' IN v_email) = 0 THEN
    RETURN '{}'::jsonb;                     -- phone or anonymous creation: not a Perceev path; nothing to check
  END IF;
  v_domain := regexp_replace(v_email, '^.*@', '');   -- part after the last @
  IF NOT public.is_disposable_email_domain(v_domain) THEN
    RETURN '{}'::jsonb;
  END IF;
  -- A workspace owner's pending invitation admits the address (team invites are unchanged; Mixed row "Teams").
  IF EXISTS (SELECT 1 FROM public.customer_team_invites i
              WHERE lower(btrim(i.email)) = v_email AND i.status = 'pending' AND i.expires_at > now()) THEN
    RETURN '{}'::jsonb;
  END IF;
  RETURN jsonb_build_object('error', jsonb_build_object(
    'http_code', 400,
    'message', 'Please sign up with a non-disposable email address.'));
END;
$$;

REVOKE ALL ON FUNCTION public.is_disposable_email_domain(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.hook_before_user_created(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_disposable_email_domain(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.hook_before_user_created(jsonb) TO service_role;

-- Supabase's auth role exists on hosted projects; CI's bootstrap creates it too (P1.T3.S2).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_auth_admin') THEN
    GRANT USAGE ON SCHEMA public TO supabase_auth_admin;
    GRANT EXECUTE ON FUNCTION public.hook_before_user_created(jsonb) TO supabase_auth_admin;
    GRANT EXECUTE ON FUNCTION public.is_disposable_email_domain(text) TO supabase_auth_admin;
  END IF;
END $$;
```

Notes: both functions are `SECURITY DEFINER` owned by the migration role, so they read `disposable_email_domains` and `customer_team_invites` (both RLS-enabled) without a policy for `supabase_auth_admin`. No email address is stored or logged by the hook. Existing accounts on listed domains are unaffected (the hook runs only at creation).

`scripts/setup-supabase.mjs` `EXPECTED_OBJECTS` gains `"155_f24_signup_guard.sql": [{kind:"table",name:"disposable_email_domains"},{kind:"function",name:"is_disposable_email_domain"},{kind:"function",name:"hook_before_user_created"}]`. The table holds no customer data, so it is not added to `tests/customer-uat.sql`.

### 6.2 Server modules

#### `src/shared/disposable-email.ts` (COPY of `openseo:src/server/auth/disposable-email.ts`, plus subdomains)

```ts
export const DISPOSABLE_EMAIL_DOMAINS: ReadonlySet<string>;           // the 37 domains of the SQL seed, same order
export function emailDomain(email: string): string | null;            // lower-cased part after the last "@", trailing "." removed; null without "@"
export function isDisposableEmailDomain(email: string): boolean;      // exact or subdomain match ("a.b.mailinator.com" → true)
```

Pure, no imports; used by the sign-up form (client) and by `scripts/qa/check-f24-db.mjs` to compare with the seed.

#### `src/shared/auth-redirect.ts` (PORT of `openseo:src/lib/auth-redirect.ts:5-21`, `:100-133`)

```ts
export const DEFAULT_AFTER_SIGN_IN = "/portal";
export function normalizeAuthRedirect(value: string | null | undefined, fallback?: string): string;
// same rules as OpenSEO (must start with "/", not "//", no "\\", no \t\r\n); returns fallback ?? "/portal" when unsafe
export function normalizeHandoffDomain(value: string | null | undefined): string | null;
// trims, lower-cases, strips "http(s)://", path, port and a leading "www."; accepts /^[a-z0-9-]+(\.[a-z0-9-]+)+$/ up to 253 chars; else null
export function normalizeScanId(value: string | null | undefined): string | null;   // UUID v1–v8 regex, lower-cased; else null
export function buildOnboardingPath(i: { domain?: string | null; scan?: string | null; redirect?: string | null }): string;
// "/onboarding" plus only the valid params, in order domain, scan, redirect; redirect omitted when it normalises to "/portal"
export function authCallbackUrl(origin: string, next: string): string;            // `${origin}/auth/callback?next=${encodeURIComponent(next)}`
export function signInHref(next: string): string;                                 // "/login" or "/login?next=<enc>"
export function verifyEmailHref(email: string | null, next: string): string;      // "/auth/verify?email=<enc>&next=<enc>" (each only when set / not default)
```

The OAuth-authorize continuation of OpenSEO (`getOAuthSignedQuery`, `:23-61`) is MCP-only and not ported.

#### `src/shared/auth-errors.ts` (PORT of `openseo:src/client/features/integrations/googleAuthErrorCopy.ts:11-48`)

```ts
export type AuthErrorCode = "access_denied" | "state_mismatch" | "disposable_email" | "captcha_failed"
  | "signup_disabled" | "link_expired" | "unknown";
export function authErrorCodeFrom(i: { error?: string | null; errorCode?: string | null; description?: string | null }): AuthErrorCode;
export function authErrorCopy(code: string): { title: string; description: string };
export function signInErrorMessage(err: { code?: string; message?: string; status?: number } | null): {
  kind: "invalid_credentials" | "unconfirmed" | "captcha" | "rate_limited" | "other"; message: string };
export function signUpErrorMessage(err: { code?: string; message?: string; status?: number } | null): {
  kind: "disposable" | "captcha" | "exists" | "weak_password" | "rate_limited" | "other"; message: string };
```

Mapping rules (`authErrorCodeFrom`): `error === "access_denied"` → `access_denied`; description (case-insensitive) contains `non-disposable` → `disposable_email`; contains `captcha` → `captcha_failed`; `errorCode === "signup_disabled"` → `signup_disabled`; `errorCode === "bad_oauth_state"` or `error === "invalid_request"` with description containing `state` → `state_mismatch`; `errorCode === "otp_expired"` or `flow_state_expired` → `link_expired`; else `unknown`.

`signInErrorMessage`: `code === "invalid_credentials"` or message `"Invalid login credentials"` → "That email and password did not match. Check them and try again." (existing copy, `src/app/login/page.jsx:27-29`); `code === "email_not_confirmed"` → kind `unconfirmed`; message contains `captcha` → "The security check didn't pass. Try again."; `status === 429` or `code === "over_request_rate_limit"` → "Too many attempts. Wait a minute and try again."; else "We could not sign you in. Please try again." (existing).

`signUpErrorMessage`: message contains `non-disposable` → "Please sign up with a non-disposable email address."; `captcha` → as above; `code === "user_already_exists"` → "An account with this email already exists. Sign in instead."; `code === "weak_password"` → "Choose a stronger password: at least 10 characters."; 429 → as above; else "We could not create your account. Check the email and password and try again." (existing, `src/app/signup/page.jsx:33`).

#### `src/shared/password.ts` (PORT of `openseo:src/client/features/auth/passwordSchema.ts`)

```ts
export const PASSWORD_MIN_LENGTH = 10;   // Perceev's existing sign-up rule (src/app/signup/page.jsx:60); OpenSEO uses 8
export const PASSWORD_MAX_LENGTH = 128;
export const passwordSchema: z.ZodString;  // "Password must be at least 10 characters." / "Password must be at most 128 characters."
export const signUpSchema: z.ZodType<{ email: string; password: string; confirmPassword: string }>;
// email: z.string().trim().email("Enter a valid email address."); refine password === confirmPassword → "Passwords do not match." on confirmPassword
```

`/auth/accept` and `/auth/reset` keep their existing 8-character minimum (no behaviour change; the Supabase project minimum governs).

#### `src/app/auth/callback/route.js` (edit)

Before the existing branches, read `error`, `error_code`, `error_description` from the query. When `error` or `error_code` is present: redirect (303) to `/auth/error?error=<authErrorCodeFrom(...)>` and stop. After a successful `exchangeCodeForSession` / `verifyOtp` (the existing branches, unchanged), read the user with `client.auth.getUser()`; when `user.created_at` is within 10 minutes of now **and** `user.last_sign_in_at` equals `created_at` to the second (first session), call `trackAuthServerEvent("auth:sign_up_completed", { method: provider === "google" ? "google" : "email", from_free_scan: nextUrl.searchParams.has("scan"), from_domain: nextUrl.searchParams.has("domain") })` from `src/lib/auth/telemetry.ts` (no-op sink until F26). Everything else (invite RPC, `link_expired`, `safeNext`) is unchanged.

#### `src/lib/auth/telemetry.ts` (new)

`export function trackAuthServerEvent(name: AuthServerEvent, props: Record<string, string | number | boolean>, distinctId?: string): void` — no-op until F26 wires it with `setAuthServerTracker(fn)`. The client counterpart is `src/components/auth/telemetry.ts` (`trackAuthEvent`, `setAuthEventTracker`).

#### Flags — `src/lib/features/names.ts`

Append `google_sign_in: { spend: [] as const }`. It is **not** added to `CLIENT_FEATURES`: that route needs a workspace and the auth pages run before one exists. The login and sign-up pages are server components that evaluate `isFeatureEnabled("google_sign_in")` (no brand) and pass a boolean prop.

### 6.3 Jobs

None.

### 6.4 Provider calls and cost

No paid calls. External services, all configured by the owner (§10):

| Service | Call | Who calls | Cost |
|---|---|---|---|
| Google OAuth (via Supabase Auth) | `/auth/v1/authorize?provider=google` → Google → `/auth/v1/callback` → our `/auth/callback?code=` | browser, Supabase | free |
| Cloudflare Turnstile | `challenges.cloudflare.com/turnstile/v0/api.js` (widget); token verified by Supabase Auth with the secret | browser, Supabase | free tier |
| Supabase Auth hook | `public.hook_before_user_created(event)` | Supabase Auth | none |

Fixtures: `tests/fixtures/f24/hook-events.json` (eight events: normal, disposable, uppercase disposable, subdomain disposable, invited disposable, phone-only, missing user, trailing-dot domain) using `example.test` and listed domains only; `tests/fixtures/f24/oauth-errors.json` (query strings for `access_denied`, disposable, captcha, `bad_oauth_state`, `otp_expired`).

### 6.5 API routes

F24 adds no `/api` routes. Changed or new page routes:

| Path | Kind | Auth | Behaviour |
|---|---|---|---|
| `/auth/callback` | route handler (existing) | session cookie set by exchange | adds OAuth error branch → `303 /auth/error?error=<code>`; otherwise unchanged |
| `/auth/error` | page (new) | public | `?error=` → copy from `authErrorCopy` |
| `/auth/verify` | page (new) | public | `?email=`, `?next=`, `?error=` |
| `/auth/forgot` | page (new) | public | `?email=`, `?next=` |
| `/login`, `/signup`, `/auth/reset` | pages (existing, rebuilt) | public | §6.6 |

Supabase Auth calls made by the browser (all through `getSupabaseBrowserClient()`):

```ts
supabase.auth.signInWithPassword({ email, password, options: captchaToken ? { captchaToken } : undefined })
supabase.auth.signUp({ email, password, options: { emailRedirectTo: authCallbackUrl(origin, onboardingPath), ...(captchaToken ? { captchaToken } : {}) } })
supabase.auth.signInWithOAuth({ provider: "google", options: { redirectTo: authCallbackUrl(origin, next), queryParams: { prompt: "select_account" } } })
supabase.auth.resetPasswordForEmail(email, { redirectTo: authCallbackUrl(origin, "/auth/reset"), ...(captchaToken ? { captchaToken } : {}) })
supabase.auth.resend({ type: "signup", email, options: { emailRedirectTo: authCallbackUrl(origin, next), ...(captchaToken ? { captchaToken } : {}) } })
supabase.auth.updateUser({ password })   // /auth/reset, unchanged
```

Example callback redirects:

```
GET /auth/callback?error=access_denied&error_code=access_denied&error_description=The+user+denied+access
→ 303 Location: /auth/error?error=access_denied

GET /auth/callback?code=<pkce>&next=%2Fonboarding%3Fdomain%3Dacme.com%26scan%3D0c2a…
→ 307 Location: /onboarding?domain=acme.com&scan=0c2a…   (existing NextResponse.redirect status kept)
```

### 6.6 UI

All pages use F04's `AuthLayout` (single column, `max-w-xs`, Perceev mark, legal line "© Perceev · Privacy · Terms") and F04 primitives (`Button` with `pending`, `Field`, `FieldLabel`, `Input` with `authInputClassName`, `Alert`, `Separator`, `Spinner`). Components live in `src/components/auth/` (TSX); pages stay `.jsx` server components that render them. The theme surface already covers `/login`, `/signup` and `/auth` (`APP_SURFACES`, F04 §6.2), so no registry change.

**Shared components (`src/components/auth/`)**

- `AuthMethodChooser({ googleLabel, emailLabel = "Continue with email", busy, onGoogle, onEmail })` — PORT `AuthPage.tsx:67-106`: two full-width outline buttons; Google button white with `GoogleLogo` (Google's four-colour "G", `aria-hidden`), label "Opening Google…" while busy; both disabled while busy.
- `TermsAgreementNotice({ action })` — "{action}, you agree to our Terms and Privacy Policy." with links `/terms`, `/privacy` (`target="_blank" rel="noreferrer"`).
- `TurnstileWidget({ siteKey, onToken, resetNonce })` + `useTurnstileCaptcha()` — COPY of `TurnstileWidget.tsx`; the site key is a prop. Script-failure copy: "The security check couldn't load. Allow challenges.cloudflare.com in your browser or ad blocker, then reload the page." (`role="alert"`).
- `useGoogleAuth({ next, intent })` — PORT `useGoogleAuth.ts`: `start()` tracks `auth:google_start { intent }` and calls `signInWithOAuth`; error copy "Google sign-in is not available right now." / "Google sign-up is not available right now."
- `useRedirectIfSignedIn(next)` — PATTERN `_auth.tsx:29-45`: on mount `getUser()`; signed in with `email_confirmed_at` → `window.location.replace(next)`; renders `PageLoading` while checking.

**`/login`** (`src/app/login/page.jsx` server component → `<SignInForm googleEnabled={…} turnstileSiteKey={…} next={…} />`)

| State | What shows |
|---|---|
| Checking session | `PageLoading` (no flash of the form for signed-in users) |
| Chooser (Google on) | Title "Sign in"; `AuthMethodChooser googleLabel="Continue with Google"`; `TermsAgreementNotice action="By continuing with Google"`; footer link "Create account" (`/signup` with the same `next`) |
| Email form (Google off, or after "Continue with email") | Fields "Work email" (`FieldLabel className="sr-only"`, placeholder "Email address…", `autoComplete="email"`) and "Password" (sr-only label, placeholder "Password…", `autoComplete="current-password"`); Turnstile when the site key is set; submit "Sign in" / pending "Signing in…" (disabled until a token when the widget shows); footer "Forgot password?" (`/auth/forgot?email=<typed>&next=…`) and "Create account"; with Google on, a ghost link "Back" returns to the chooser |
| Error | `Alert variant="destructive"` under the form with `signInErrorMessage(...).message`; captcha reset |
| Unconfirmed | navigate to `verifyEmailHref(email, next)` |
| `?error=link_expired` (existing callback) | `Alert variant="info"`: "That link has expired or was already used. Sign in, or request a new link." |
| Success | `window.location.assign(next)` (existing behaviour) |

**`/signup`** (`SignUpForm`)

| State | What shows |
|---|---|
| Chooser | Title "Create your account"; chooser with "Continue with Google"; `TermsAgreementNotice action="By continuing"`; footer "Already have an account? Sign in" |
| Email form | "Work email", "Password" (hint "At least 10 characters."), "Confirm password"; Turnstile; submit "Create account" / "Creating account…"; `TermsAgreementNotice action="By creating an account"`; footer "Back to sign up" (when Google on) |
| Disposable pre-check | inline field error "Please sign up with a non-disposable email address."; no request; tracks `auth:signup_blocked { reason: "disposable_email" }` |
| Server error | `Alert destructive` with `signUpErrorMessage(...).message`; captcha reset |
| Success, session returned (auto-confirm) | `window.location.assign(onboardingPath)` |
| Success, confirmation needed | `router.replace(verifyEmailHref(email, onboardingPath))` |

`onboardingPath = buildOnboardingPath({ domain: searchParams.domain, scan: searchParams.scan, redirect: searchParams.next })`. The Google button on `/signup` uses `next = onboardingPath`; on `/login` it uses the login `next`. A Google sign-in from `/login` by someone with no account creates the account (Supabase has no separate sign-up for OAuth); F27's redirect then sends them to onboarding.

**`/auth/verify`** (`VerifyEmailCard`, PORT `verify-email.tsx`)

| State | Title | Body |
|---|---|---|
| Default | "Verify your email" | "Click the link we sent to {email} to verify your email." (without email: "Check your inbox for the link to verify your email.") + Turnstile + `Button variant="secondary"` "Resend email" / "Sending email…" (only with an email) |
| `?error=link_expired` | "We couldn't confirm your email" | `Alert destructive` "This link has expired. Request a new email to keep going." + resend |
| Signed in and confirmed | "Email confirmed" | "You're all set. Taking you to your account now." + `Spinner`; `location.replace(next)` |
| Resend success / failure | toast "A new email is on the way." / toast "We couldn't send another email right now. Please try again." |

Footer: "Back to sign in".

**`/auth/forgot`** (`ForgotPasswordForm`, PORT `forgot-password.tsx`): title "Forgot password", helper "Enter your email and we'll send you a password reset link."; field "Email address" (prefilled from `?email=`); Turnstile; "Send reset link" / "Sending reset link…"; success → title "Check your email" and `Alert variant="success"` "If an account exists for {email}, you'll receive password reset instructions shortly."; error `Alert destructive` "We couldn't send the reset email right now. Please try again."; footer "Back to sign in". The old inline "Forgot your password?" button on `/login` is replaced by this link.

**`/auth/reset`** (`ResetPasswordForm`, PORT `reset-password.tsx`, keeps `consumeCustomerAuthFragment`): states "Reset password" / helper "Choose a new password for your account." with "New password" and "Confirm new password" (min 8, existing) and "Update password" / "Updating password…"; "Password updated" / "Your password has been updated. Sign in with your new password." + "Continue to sign in"; fragment error → "Reset link expired" / "This reset link is no longer valid. Request a new one to keep going." + "Request a new reset link" (`/auth/forgot`).

**`/auth/error`** (PORT `auth-error.tsx`)

| Code | Title | Description |
|---|---|---|
| `access_denied` | "Google sign-in was canceled" | "Google's permission screen was closed or declined. Try again whenever you're ready." |
| `state_mismatch` | "Google sign-in didn't finish" | "The attempt expired or was interrupted. Try again in a single browser tab and finish the Google steps within 10 minutes. If it keeps happening, make sure your browser allows cookies for this site." |
| `disposable_email` | "Use a work email address" | "Please sign up with a non-disposable email address." |
| `captcha_failed` | "The security check didn't pass" | "Reload the page and try again. If you use an ad blocker, allow challenges.cloudflare.com." |
| `signup_disabled` | "Sign-ups are closed" | "New accounts can't be created right now. If you were invited, use the link in your invitation email." |
| `link_expired` | "That link has expired" | "Request a new email from the sign-in page." |
| default | "Sign-in didn't finish" | "Something went wrong while signing you in. Please try again — if it keeps failing, contact support." |

Button `variant="secondary"` "Back to sign in" (`/login`); footer `font-mono text-xs` "Code: {code}".

**Accessibility:** one `h1` per page (F04-AC-11); errors are `role="alert"`; sr-only labels keep `getByLabel("Work email")` working; the Turnstile container has `aria-label="Security check"`; focus moves to the email field when the form opens from the chooser.

**Phone (390 px):** the column is `max-w-xs`; buttons full width; no horizontal scroll (F04 rule).

### 6.7 Permissions, privacy, observability

- **No credentials or tokens in logs or URLs we build.** The callback never logs the code; error redirects carry only our closed code list. Hook refusals are not logged by us (Supabase Auth logs its own hook errors).
- **Telemetry (F26 names; sinks `src/components/auth/telemetry.ts` and `src/lib/auth/telemetry.ts` are no-ops until F26):** client `auth:sign_in_submit { method: "email" }`, `auth:sign_in_success { method: "email" }`, `auth:sign_in_block_unverified {}`, `auth:sign_up_submit {}`, `auth:sign_up_success { needs_verification }`, `auth:google_start { intent: "sign_in" | "sign_up" }`, `auth:signup_blocked { reason: "disposable_email" | "captcha" }`, `auth:verification_resend {}`, `auth:verification_issue { issue_type: "link_expired" | "unknown" }`, `auth:password_reset_requested {}`; server `auth:sign_up_completed { method: "email" | "google", from_free_scan, from_domain }`. Never an email, domain, name or next path in properties.
- **Privacy policy** (`src/app/privacy/page.jsx`) gains two paragraphs (§8 P2.T6.S1).
- **Who can do what:** anyone may sign up unless the address is refused; invite redemption rules are unchanged.

## 7. Code reuse map

| OpenSEO source | Perceev target | Mode | Adaptation notes |
|---|---|---|---|
| `openseo:src/server/auth/disposable-email.ts:10-53` | `src/shared/disposable-email.ts`; seed in `155_f24_signup_guard.sql` | COPY | Same 37 domains; adds subdomain matching and `emailDomain()`; mirrored in SQL with a parity test. |
| `openseo:src/lib/auth.ts:239-253` (`user.create.before`) | `public.hook_before_user_created` | PORT | Better Auth database hook → Supabase "Before User Created" Postgres hook; invited addresses admitted. |
| `openseo:src/lib/auth.ts:128-133`, `:209-217`; `openseo:src/lib/auth-turnstile.ts:9-26` (+ test) | Supabase Auth captcha setting; rollout order in §10 | PATTERN | Enforcement moves into Supabase; "never show an unenforced captcha" becomes "widget first, then enable captcha". |
| `openseo:src/client/features/auth/TurnstileWidget.tsx:1-145` | `src/components/auth/TurnstileWidget.tsx` | COPY | Site key as a prop instead of `import.meta.env`; token passed as `captchaToken` instead of a header. |
| `openseo:src/client/features/auth/AuthPage.tsx:36-129` | `AuthMethodChooser.tsx`, `TermsAgreementNotice.tsx`, `GoogleLogo.tsx` | PORT | Our `/terms`, `/privacy`; no OpenSEO logo (F04 `AuthLayout` renders the Perceev mark). |
| `openseo:src/client/features/auth/useGoogleAuth.ts:1-48` | `src/components/auth/useGoogleAuth.ts` | PORT | `authClient.signIn.social` → `supabase.auth.signInWithOAuth`; no `requestSignUp` (Supabase creates on first OAuth sign-in). |
| `openseo:src/client/features/auth/passwordSchema.ts`, `openseo:src/lib/auth-options.ts:1-2` | `src/shared/password.ts` | PORT | Minimum 10 (Perceev's existing rule). |
| `openseo:src/lib/auth-redirect.ts:5-21`, `:100-133` (+ `auth-redirect.test.ts:39-63`) | `src/shared/auth-redirect.ts` (+ test) | PORT | Default `/portal`; OAuth-authorize continuation dropped (MCP only); adds `buildOnboardingPath`. |
| `openseo:src/routes/_auth.sign-in.tsx:25-217` | `src/components/auth/SignInForm.tsx`, `src/app/login/page.jsx` | PORT | TanStack Form → controlled inputs; 403 unverified → Supabase `email_not_confirmed`. |
| `openseo:src/routes/_auth.sign-up.tsx:27-276` | `src/components/auth/SignUpForm.tsx`, `src/app/signup/page.jsx` | PORT | `?domain=` plus our `?scan=` and `?next=` into `/onboarding`; disposable pre-check added. |
| `openseo:src/routes/_auth.tsx:17-60` | `useRedirectIfSignedIn.ts` | PATTERN | Client `getUser()` check in each auth page. |
| `openseo:src/routes/verify-email.tsx:20-228` | `src/components/auth/VerifyEmailCard.tsx`, `src/app/auth/verify/page.jsx` | PORT | Supabase `resend` with captcha; error codes from our callback. |
| `openseo:src/routes/forgot-password.tsx:16-150` | `ForgotPasswordForm.tsx`, `src/app/auth/forgot/page.jsx` | PORT | `resetPasswordForEmail` with our existing callback redirect. |
| `openseo:src/routes/reset-password.tsx:17-247` | `ResetPasswordForm.tsx`, `src/app/auth/reset/page.jsx` | PORT | Token comes from Supabase session (callback or fragment), not a query token. |
| `openseo:src/routes/auth-error.tsx:7-51`, `openseo:src/client/features/integrations/googleAuthErrorCopy.ts:11-48` | `src/app/auth/error/page.jsx`, `src/shared/auth-errors.ts` | PORT | Codes adapted to Supabase errors; "Back to sign in". |
| `openseo:src/lib/auth-config.ts:31-41` | Supabase automatic identity linking (§4 decision) | PATTERN | Same-email linking only. |
| `openseo:src/server/auth/sign-up-analytics.ts:15-62` | `src/app/auth/callback/route.js` + `src/lib/auth/telemetry.ts` | PATTERN | First-session detection in the callback instead of a DB hook. |
| `openseo:src/routes/accept-invitation.$id.tsx:39-71` | none | PATTERN | Not ported: Perceev invites are email-matched (Mixed row "Teams" unchanged). |
| `openseo:src/client/features/auth/useHostedAuthRouteGuard.ts:14-60` | `SignInForm` unconfirmed branch | PATTERN | Unverified users go to the verify page. |

## 8. Implementation plan

Branches `feat/f24-sign-in-hardening-p1` … `-p3`. Shorthand: `NT` = `node --import ./src/lib/liveWriteGuardAuto.mjs --test`.

### Phase 1 — Disposable-email guard and shared auth logic (no UI change)

**Goal:** the database refuses disposable sign-ups once the owner enables the hook, and the shared helpers exist with tests.

- [x] **P1.T1 Shared helpers**
  - [x] **P1.T1.S1** *Files:* `src/shared/disposable-email.ts`, `src/shared/disposable-email.test.ts`. *Do:* §6.2 (licence header listing `src/server/auth/disposable-email.ts`); tests for AC-01 including the seed-parity case: read `supabase/migrations/155_f24_signup_guard.sql`, extract every `('<domain>','openseo')` with `/\('([a-z0-9.-]+)','openseo'\)/g`, compare as sorted arrays with `[...DISPOSABLE_EMAIL_DOMAINS].sort()`. *Verify:* `NT src/shared/disposable-email.test.ts` → pass (F24-AC-01; needs P1.T2.S1 for the parity case).
  - [x] **P1.T1.S2** *Files:* `src/shared/auth-redirect.ts`, `src/shared/auth-redirect.test.ts`. *Do:* §6.2; port OpenSEO's four redirect test cases (`auth-redirect.test.ts:39-63`) with `/portal` as the default, plus: `normalizeHandoffDomain("https://www.Acme.com/pricing")` → `acme.com`; `("localhost")` → null; `("a".repeat(250)+".com")` → null; `normalizeScanId("0C2A4B1E-8D1F-4F35-9B5E-2E0C6F1A7D90")` → lower-cased; `("12")` → null; `buildOnboardingPath({ domain: "acme.com", scan: "<uuid>", redirect: "/portal/scans" })` → `/onboarding?domain=acme.com&scan=<uuid>&redirect=%2Fportal%2Fscans`; `({ redirect: "//evil.test" })` → `/onboarding`; `({})` → `/onboarding`. *Verify:* `NT src/shared/auth-redirect.test.ts` → pass (F24-AC-04).
  - [x] **P1.T1.S3** *Files:* `src/shared/auth-errors.ts`, `src/shared/auth-errors.test.ts`, `tests/fixtures/f24/oauth-errors.json`. *Do:* §6.2 mappings and §6.6 copy table; one test per code and one per `signInErrorMessage`/`signUpErrorMessage` kind. *Verify:* `NT src/shared/auth-errors.test.ts` → pass (F24-AC-10 unit half).
  - [x] **P1.T1.S4** *Files:* `src/shared/password.ts`, `src/shared/password.test.ts`. *Do:* §6.2; cases: 9 chars → "Password must be at least 10 characters."; 129 → max message; mismatch → "Passwords do not match." on `confirmPassword`; `" Owner@Example.test "` email trims and passes. *Verify:* `NT src/shared/password.test.ts` → pass.
- [x] **P1.T2 Migration**
  - [x] **P1.T2.S1** *Files:* `supabase/migrations/155_f24_signup_guard.sql`. *Do:* §6.1 verbatim. *Verify:* `node --test src/lib/migrationsRunner.test.mjs` → pass.
  - [x] **P1.T2.S2** *Files:* `scripts/setup-supabase.mjs`, `src/lib/migrationsRunner.test.mjs`, `src/lib/liveWriteGuard.js`, `src/lib/liveWriteGuard.test.mjs` (the last three because the catalog and classification guards require every migration object to be listed). *Do:* add the `EXPECTED_OBJECTS` entry from §6.1. *Verify:* `NT src/lib/migrationsLedger.test.mjs src/lib/migrationsRunner.test.mjs` → pass; `git grep -n "155_f24_signup_guard" scripts/setup-supabase.mjs` → 1 line.
  - [x] **P1.T2.S3** *Files:* `README.md` (migration table row `155_f24_signup_guard` "Refuses disposable email domains at account creation through the Supabase Before User Created hook; invited addresses pass."), `docs/OPERATOR_LEDGER.md` § C (append: "155_f24_signup_guard — apply, then enable Auth → Hooks → Before User Created → Postgres → `public.hook_before_user_created`"), `docs/PROD_MIGRATIONS.md` (one bullet with the same sentence). *Verify:* `NT src/lib/docStatus.test.mjs src/lib/migrationsLedger.test.mjs src/lib/migrationsRunner.test.mjs` → pass.
- [ ] **P1.T3 Database checks**
  - [x] **P1.T3.S1** *Files:* `scripts/qa/check-f24-db.mjs`, `tests/fixtures/f24/hook-events.json`. *Do:* loopback guard copied from `scripts/qa/check-repair-workflows.mjs` (host must be `localhost`/`127.0.0.1`, database name must end `_qa`); apply `tests/supabase-bootstrap.sql` into a fresh schema set when `--fresh` is passed, then migrations 001–155 in order. Groups: `idempotent` (apply 155 twice; `count(*)` of `disposable_email_domains` = 37), `grants` (`SET ROLE anon` / `authenticated`: `SELECT public.hook_before_user_created('{}')` → permission denied; `SELECT * FROM disposable_email_domains` → permission denied; `SET ROLE supabase_auth_admin` → `{}` returned), `hook` (each fixture event → expected output; invited case inserts a `customer_brands` row and a pending `customer_team_invites` row for `qa-invite@mailinator.com`, then deletes them), `parity` (the SQL list equals `DISPOSABLE_EMAIL_DOMAINS` imported from `src/shared/disposable-email.ts`). *Verify:* `PGHOST=localhost PGDATABASE=perceev_qa node scripts/qa/check-f24-db.mjs` → `PASS idempotent`, `PASS grants`, `PASS hook`, `PASS parity`, exit 0 (F24-AC-02, F24-AC-03).
  - [ ] **P1.T3.S2** *Files:* `tests/supabase-bootstrap.sql`. *Do:* add `CREATE ROLE supabase_auth_admin NOLOGIN;` after `service_role` so CI exercises the grant branch. *Verify:* the CI `customer-database` job passes on the PR.
- [x] **P1.T4 Registration**
  - [x] **P1.T4.S1** *Files:* `src/lib/features/names.ts`, `.env.example`. *Do:* add `google_sign_in: { spend: [] as const }`; `.env.example` names (no values): `FEATURE_GOOGLE_SIGN_IN=`, `NEXT_PUBLIC_TURNSTILE_SITE_KEY=` with comments "Supabase Auth → Attack Protection holds the Turnstile secret; set this site key before enabling captcha there." *Verify:* `NT src/lib/features/flags.test.ts` → pass; `grep -c "^NEXT_PUBLIC_TURNSTILE_SITE_KEY=$" .env.example` → 1.

**Checkpoint:** full suite (`NT 'src/**/*.test.mjs' 'src/**/*.test.ts'`), `npm run typecheck`, `npm run build`, `check-f24-db.mjs` all groups. Completes F24-AC-01, 02, 03, 04, 10 (unit).

### Phase 2 — Auth pages: chooser, Google, Turnstile, verify, forgot, error, hand-off

**Goal:** the sign-in surfaces match OpenSEO's flow on the F04 shell; Google and captcha switch on by flag and env.

- [ ] **P2.T1 Components**
  - [ ] **P2.T1.S1** *Files:* `src/components/auth/{TurnstileWidget,AuthMethodChooser,TermsAgreementNotice,GoogleLogo}.tsx`, `src/components/auth/useGoogleAuth.ts`, `src/components/auth/useRedirectIfSignedIn.ts`, `src/components/auth/telemetry.ts` (licence headers on the COPY/PORT files). *Do:* §6.6 shared components. `useGoogleAuth` exports `buildGoogleOAuthOptions(origin, next)` → `{ provider: "google", options: { redirectTo, queryParams: { prompt: "select_account" } } }` for unit testing. *Verify:* `npm run typecheck` → exit 0.
  - [ ] **P2.T1.S2** *Files:* `src/components/auth/useGoogleAuth.test.ts`. *Do:* `buildGoogleOAuthOptions("https://app.example.test", "/onboarding?domain=acme.com")` → `redirectTo === "https://app.example.test/auth/callback?next=%2Fonboarding%3Fdomain%3Dacme.com"`. *Verify:* `NT src/components/auth/useGoogleAuth.test.ts` → pass (F24-AC-08 unit half).
- [ ] **P2.T2 Sign-in and sign-up**
  - [ ] **P2.T2.S1** *Files:* `src/components/auth/SignInForm.tsx`, `src/app/login/page.jsx`. *Do:* page becomes a server component: `export const dynamic = "force-dynamic"`; reads `searchParams.next` and `searchParams.error`, `googleEnabled = await isFeatureEnabled("google_sign_in")`, `turnstileSiteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? ""`; renders `<AuthLayout title="Sign in" titleId="login-title">` with `<SignInForm …/>`. Form per §6.6. *Verify:* `npm run build` → exit 0.
  - [ ] **P2.T2.S2** *Files:* `src/components/auth/SignUpForm.tsx`, `src/app/signup/page.jsx`. *Do:* same pattern; `onboardingPath` from `buildOnboardingPath`; disposable pre-check before any call; success branches per §6.6. *Verify:* `npm run build` → exit 0.
- [ ] **P2.T3 Verify, forgot, reset, error**
  - [ ] **P2.T3.S1** *Files:* `src/components/auth/VerifyEmailCard.tsx`, `src/app/auth/verify/page.jsx`. *Do:* §6.6. *Verify:* build → exit 0.
  - [ ] **P2.T3.S2** *Files:* `src/components/auth/ForgotPasswordForm.tsx`, `src/app/auth/forgot/page.jsx`. *Do:* §6.6. *Verify:* build → exit 0.
  - [ ] **P2.T3.S3** *Files:* `src/components/auth/ResetPasswordForm.tsx`, `src/app/auth/reset/page.jsx`. *Do:* §6.6; keep `consumeCustomerAuthFragment()` on mount and `updateUser({ password })`. *Verify:* `NT src/lib/supabase/authLink.test.mjs` → pass (unchanged); build → exit 0.
  - [ ] **P2.T3.S4** *Files:* `src/app/auth/error/page.jsx`. *Do:* server component reading `searchParams.error`, rendering `authErrorCopy`. *Verify:* build → exit 0.
- [ ] **P2.T4 Callback**
  - [ ] **P2.T4.S1** *Files:* `src/app/auth/callback/route.js`, `src/lib/auth/telemetry.ts`. *Do:* §6.2 edit. *Verify:* `NT src/lib/auth/callback.route.test.mjs` (P2.T4.S2) → pass.
  - [ ] **P2.T4.S2** *Files:* `src/lib/auth/callback.route.test.mjs`, `src/lib/auth/callback.route.hooks.mjs`. *Do:* hook pattern of `src/lib/customerRoutes.test.hooks.mjs`: substitute `@/lib/supabase/customer` with a fixture client exposing `auth.exchangeCodeForSession`, `auth.verifyOtp`, `auth.getUser`, `rpc`. Cases: `?error=access_denied` → 303 `/auth/error?error=access_denied`, no exchange call; description "Please sign up with a non-disposable email address." → `disposable_email`; `?code=x&next=%2Fonboarding%3Fdomain%3Dacme.com` → exchange called once, RPC `accept_customer_team_invites` called once, `Location` ends `/onboarding?domain=acme.com`; exchange error → `/login?error=link_expired` (existing); a user with `created_at === last_sign_in_at` 1 minute ago → tracker called once with `{ method: "google", from_free_scan: false, from_domain: true }` when `app_metadata.provider === "google"`; older user → not called. *Verify:* pass (F24-AC-09).
- [ ] **P2.T5 Browser checks**
  - [ ] **P2.T5.S1** *Files:* `scripts/qa/portalFixtureHarness.mjs`. *Do (reason: the email form now sits behind the chooser when Google is on):* before filling "Work email", click the button named "Continue with email" if it is visible. *Verify:* `node scripts/qa/check-f04-browser.mjs http://127.0.0.1:3328` → all cases pass (F24-AC-07 harness half).
  - [ ] **P2.T5.S2** *Files:* `scripts/qa/check-f24-browser.mjs`. *Do:* Playwright from `worker/node_modules/playwright`; app started with `NEXT_PUBLIC_SUPABASE_URL=https://placeholder.supabase.co`; route-intercept `https://placeholder.supabase.co/auth/v1/**` and record requests; abort every request leaving `127.0.0.1` other than the intercepted host. Scenarios (two server starts: one without site key and with `FEATURE_GOOGLE_SIGN_IN=off`, one with `NEXT_PUBLIC_TURNSTILE_SITE_KEY=qa-site-key` and `FEATURE_GOOGLE_SIGN_IN=on`; Turnstile script route-fulfilled with a stub defining `window.turnstile = { render(el, o) { el.dataset.qa = "turnstile"; setTimeout(() => o.callback("qa-token"), 10); return "w1"; }, reset() {}, remove() {} }`):
    B1 no key/Google off: `/login` shows the email form directly, no `[data-qa=turnstile]`, sign-in POST `/auth/v1/token?grant_type=password` body has no `gotrue_meta_security.captcha_token`;
    B2 `/signup` with `qa@mailinator.com` → inline error, zero `/auth/v1/signup` requests (AC-05);
    B3 with key: widget on `/login` form, `/signup` form, `/auth/forgot`, `/auth/verify?email=qa@example.test`; button disabled before token; signup body `gotrue_meta_security.captcha_token === "qa-token"`; a 400 `{ "msg": "captcha protection: request disallowed" }` response shows "The security check didn't pass. Try again." and disables the button again (AC-06);
    B4 Google on: chooser visible on `/login` and `/signup`; click → navigation to `/auth/v1/authorize` with `provider=google`, `redirect_to` decoding to `http://127.0.0.1:<port>/auth/callback?next=/portal` (login) and `…next=/onboarding` (signup), and `prompt=select_account` (AC-08);
    B5 `/signup?domain=acme.com&scan=<uuid>&next=/portal/scans`: signup body `options.email_redirect_to` (supabase-js sends `redirect_to` query) decodes to the AC-11 value; Google `redirect_to` likewise (AC-11);
    B6 `/auth/error?error=access_denied` shows "Google sign-in was canceled" and "Code: access_denied" (AC-10);
    B7 password sign-in returning 400 `{ "error_code": "email_not_confirmed" }` → URL `/auth/verify?email=qa%40example.test`; "Resend email" → POST `/auth/v1/resend` with `type: "signup"` and the captcha token; toast "A new email is on the way." (AC-12);
    B8 a stored session (fixture `/auth/v1/user` → confirmed user) on `/login?next=/portal/scans` → URL becomes `/portal/scans` (AC-13);
    B9 390 px: every auth page has one `h1` and no horizontal overflow.
    *Verify:* `node scripts/qa/check-f24-browser.mjs http://127.0.0.1:3328` → `ok 9 scenarios`, `0 external requests`.
- [ ] **P2.T6 Privacy policy**
  - [ ] **P2.T6.S1** *Files:* `src/app/privacy/page.jsx`, `src/app/privacy/privacyCopy.test.mjs`. *Do:* after "Information we handle", add `<h2 id="google-sign-in">Signing in with Google</h2>` with: "If you choose Continue with Google, Google shares your name, email address and Google account identifier with Perceev so we can create and secure your account. Perceev does not receive your Google password, and signing in with Google does not give Perceev access to your Search Console or Analytics data; those connections ask for separate permission." and in "How information is used and shared" add the sentence "Sign-up, sign-in and password-reset forms use Cloudflare Turnstile to block automated abuse; Cloudflare processes technical information from your browser for this check." Test: read the file and assert both strings. *Verify:* `NT src/app/privacy/privacyCopy.test.mjs` → pass (F24-AC-15).

**Checkpoint:** suite, typecheck, build, `check-f24-browser.mjs` (9 scenarios), `check-f04-browser.mjs`, and the five existing auth/route tests untouched (`git diff --stat origin/main -- src/lib/customerAuth.test.mjs src/lib/supabase/sessionBinding.test.mjs src/lib/supabase/authLink.test.mjs src/lib/customerRoutes.test.mjs src/lib/operatorPerimeter.test.mjs` → empty). Completes F24-AC-05 to 15.

### Phase 3 — Owner configuration and live checks

**Goal:** the owner turns each protection on in the safe order and records the live results.

- [ ] **P3.T1 Runbook and checklist**
  - [ ] **P3.T1.S1** *Files:* `docs/OPERATOR_LEDGER.md` (§ C entry "F24 sign-in hardening" with the §10 enabling order, verbatim), `scripts/qa/check-f24-live.md` (the L1–L7 checklist from §10 with blank result fields). *Verify:* `NT src/lib/docStatus.test.mjs` → pass.
- [ ] **P3.T2 Owner-run live checks (only on the owner's instruction)**
  - [ ] **P3.T2.S1** *Do:* the owner runs L1–L7 (§10) on the production deployment and pastes the results (pass/fail, date, no addresses) into the phase-3 PR description. *Verify:* all seven recorded as pass (F24-AC-16).

**Checkpoint:** ledger updated; live checklist results recorded. Completes F24-AC-16.

## 9. Test plan

| Test file | Cases | ACs |
|---|---|---|
| `src/shared/disposable-email.test.ts` | exact, subdomain, case, whitespace, last-`@`, look-alike domains, seed parity | 01 |
| `scripts/qa/check-f24-db.mjs` | `idempotent`, `grants`, `hook` (8 fixture events), `parity` | 02, 03 |
| `src/shared/auth-redirect.test.ts` | unsafe redirects, domain and scan normalisation, onboarding path | 04 |
| `src/shared/auth-errors.test.ts` | code mapping, copy, sign-in and sign-up error kinds | 10 |
| `src/shared/password.test.ts` | length and confirmation rules | — (supports 05, 11) |
| `src/components/auth/useGoogleAuth.test.ts` | OAuth options and redirect encoding | 08 |
| `src/lib/auth/callback.route.test.mjs` | OAuth error branch, success with query, invite RPC, first-session event | 09 |
| `scripts/qa/check-f24-browser.mjs` | B1–B9 | 05, 06, 07, 08, 10, 11, 12, 13 |
| `scripts/qa/check-f04-browser.mjs` (harness edit) | sign-in reaches `/portal` | 07 |
| `src/app/privacy/privacyCopy.test.mjs` | two required paragraphs | 15 |
| existing `customerAuth`, `sessionBinding`, `authLink`, `customerRoutes`, `operatorPerimeter` tests | unchanged | 14 |
| `scripts/qa/check-f24-live.md` | L1–L7 (owner) | 16 |

Fixtures use `example.test` addresses, listed disposable domains and the literal tokens `qa-token` / `qa-site-key`; no real keys (CLAUDE.md). Browser tests never reach Google, Cloudflare or Supabase.

## 10. Rollout and rollback

**Env names** (`.env.example`, values never committed): `FEATURE_GOOGLE_SIGN_IN`, `NEXT_PUBLIC_TURNSTILE_SITE_KEY`. Secrets that live only in the Supabase dashboard: the Google sign-in client secret and the Turnstile secret key.

**Defaults:** `google_sign_in` off in production (F01 flag rule); no site key → no widget; hook and captcha off until the owner enables them.

**Owner enabling order (each step is reversible):**
1. Apply migration 155 (`docs/PROD_MIGRATIONS.md`). Nothing changes yet.
2. Supabase dashboard → Authentication → Hooks → "Before User Created" → Postgres → schema `public`, function `hook_before_user_created` → enable. Disposable sign-ups are now refused on every path.
3. Cloudflare dashboard → Turnstile → add a widget for the production hostname (managed mode); keep the secret in the clipboard only.
4. Vercel → set `NEXT_PUBLIC_TURNSTILE_SITE_KEY` (Production) → redeploy. The widget appears; Supabase does not yet require tokens, so nothing breaks.
5. Supabase → Authentication → Attack Protection → Enable captcha protection → provider Turnstile → paste the secret → save. Tokens are now required.
6. Google Cloud console (same project as the Search Console client) → Credentials → new OAuth client "Perceev sign-in" (Web), authorised redirect URI `https://<project-ref>.supabase.co/auth/v1/callback`, scopes `openid email profile` on the consent screen. Supabase → Authentication → Providers → Google → client id and secret → enable. Supabase → URL Configuration → Redirect URLs include `https://<app-domain>/auth/callback` and `http://localhost:3000/auth/callback`.
7. Vercel → `FEATURE_GOOGLE_SIGN_IN=on` → redeploy.

**Live checklist (`scripts/qa/check-f24-live.md`, owner-run):**
- L1 Sign up with a new `@mailinator.com` address → "Please sign up with a non-disposable email address."; no user appears in Supabase Auth.
- L2 "Continue with Google" with a Google account never used on Perceev → lands on `/onboarding` (or `/portal` "Your account is ready" before F27).
- L3 With an existing confirmed email/password account, "Continue with Google" using the same address → same user id in Supabase Auth (Identities shows `email` and `google`), same workspaces in the switcher, Search Console still connected.
- L4 Invite a fresh address from Team; sign in with Google as that address → the workspace appears without using the invite email link.
- L5 With captcha on: sign in with email and password succeeds; replaying the sign-in request without a token (browser devtools "Copy as fetch", remove `gotrue_meta_security`) is refused with a captcha error.
- L6 "Forgot password?" → email arrives → link opens `/auth/reset` → new password works.
- L7 Cancel on Google's consent screen → `/auth/error` "Google sign-in was canceled".

**Rollback:** disable captcha in Supabase **before** removing the site key (the reverse order locks everyone out); set `FEATURE_GOOGLE_SIGN_IN=off` (existing Google users can still use "Forgot password" to set a password); disable the hook in the dashboard. The migration's objects are inert when the hook is disabled; to remove them, `DROP FUNCTION public.hook_before_user_created(jsonb); DROP FUNCTION public.is_disposable_email_domain(text); DROP TABLE public.disposable_email_domains;` after disabling the hook. **Adding domains:** `INSERT INTO public.disposable_email_domains(domain, source) VALUES ('example-disposable.test','operator') ON CONFLICT DO NOTHING;` by the operator (service role); the client pre-check catches only the seeded list, the hook catches all.

## 11. Risks and open questions

1. **Hook availability and payload shape.** The "Before User Created" hook is a newer Supabase Auth hook; if the project's plan or Auth version lacks it, or the event lacks `user.email`, L1 fails. *Default:* keep the function; as a fallback add a check in `SignUpForm` only (already present) and record that Google and direct API sign-ups are not covered until the hook is available. The hook returns `{}` for a missing email, so a shape mismatch fails open, never locks people out.
2. **Captcha is project-wide in Supabase.** It also guards password sign-in, which OpenSEO does not. *Default:* accept it (Turnstile managed mode is usually invisible); owner-run scripts that sign in with a password must run against a non-production project.
3. **Unconfirmed accounts and Google.** Supabase removes unconfirmed identities when a verified identity links to the same email. A person who signed up with a password but never confirmed, then uses Google, can no longer use that password. *Default:* acceptable (the password was never confirmed); "Forgot password" restores one.
4. **Invited, never-activated users choosing Google** (L4): Supabase's invite creates an unconfirmed user row; linking behaviour is checked live. *Default if L4 fails:* `/auth/error` copy for `signup_disabled`/`unknown` already points invitees to the invitation email; the owner can resend the invite.
5. **Google consent screen shows the Supabase project domain** (`<ref>.supabase.co`) unless a Supabase custom domain is bought. *Default:* accept for now; listed for the owner.
6. **Terms acceptance is not recorded** (OpenSEO stores `termsAcceptedVersion`). *Default:* show the clickwrap notice only; F26 does not depend on it because Perceev records no session replay.
7. **Different-email Google accounts** create separate Perceev users (no manual linking). *Default:* manual linking off; revisit if support requests appear.
8. **Supabase error codes** (`email_not_confirmed`, `user_already_exists`, `weak_password`) depend on the `@supabase/supabase-js` version in `package.json`. *Default:* map on `code` first and fall back to message substrings, as §6.2 specifies.

## 12. Definition of done

- [ ] Phases 1–3 merged; every subtask ticked in this file.
- [ ] F24-AC-01 to 15 covered by passing tests; F24-AC-16 live results recorded in the phase-3 PR.
- [ ] `npm run typecheck`, `npm run build`, the full suite, `check-f24-db.mjs`, `check-f24-browser.mjs`, `check-f04-browser.mjs` green.
- [ ] Migration paperwork (README table, `docs/OPERATOR_LEDGER.md` § C, `docs/PROD_MIGRATIONS.md`) updated in P1.
- [ ] `THIRD_PARTY_NOTICES.md` lists every COPY/PORT path of §7.
- [ ] `features/README.md` status for F24 updated when the first PR opens and when the last merges.

# Account setup: Turnstile, Google Analytics client, Loops, PostHog

> <!-- doc-status -->
> **Status: LIVE.** Owner checklist written 23 October 2026. Nothing here is needed until the related feature is built; the Google Analytics client is the one to start early because Google's review takes time.

Four outside accounts the specs depend on. For each: what it is, why Perceev needs it, when you need it, what it costs, the exact steps, and which values to save.

## Progress (23 October 2026)

- Turnstile, PostHog, the Google Analytics client and Loops are set up, except:
- **Loops sending domain not verified yet** (MX and SPF/DMARC missing, DKIM partial in Loops' check). The three transactional templates cannot be published until it is, so `LOOPS_TX_*` are not in Vercel. The onboarding Loop stays a draft. Not blocking: F25 is the last wave.
- **Google verification of `analytics.readonly`** waits for F20's connection screen (needed for the demo video). Keep the client in Testing with test users until then.

## Ground rules for every value you collect

- **Never paste a secret into a chat, a doc, a ticket or a commit.** That includes API keys, client secrets and the Turnstile secret key.
- Put values straight into Vercel (Project → Settings → Environment Variables) or into the Supabase dashboard, where the steps say so. From a terminal, pipe them so they are never shown: `pbpaste | vercel env add LOOPS_API_KEY production`, then clear the clipboard.
- Values marked **public** (the Turnstile site key, the PostHog project key, the Google client ID) are visible in the browser by design. They are still easiest to keep in Vercel only.
- Variable names below match `.env.example` and the specs exactly. If a name looks wrong, fix the spec, not the variable.

## At a glance

| Account | Used by | Needed before | Cost | Lead time |
|---|---|---|---|---|
| Cloudflare Turnstile | F24 sign-in captcha | F24 goes live | Free | 10 minutes |
| Google OAuth client for Analytics | F20 Google Analytics 4 | F20 goes live for customers | Free | **Days to weeks** (Google review) |
| Loops | F25 lifecycle email | F25 goes live | Free up to 1,000 contacts / 4,000 sends a month | 1–2 hours, plus domain DNS |
| PostHog (EU cloud) | F26 product analytics and errors | F26 goes live | Free tier covers early use | 30 minutes |

Recommended order: **start the Google Analytics client now** (its review is the slow part), then Turnstile and PostHog when Wave 5 starts, and Loops last.

---

## 1. Cloudflare Turnstile (F24)

**What it is.** Cloudflare's captcha replacement. Most people see nothing or a small checkbox; bots get stopped.

**Why Perceev needs it.** F24 protects sign-up, sign-in, "Forgot password" and "Resend email" from bots. Supabase checks the token itself (its built-in captcha setting), so no Perceev server code verifies it.

**Cost.** Free.

**Steps.**

1. Sign in at dash.cloudflare.com (create a free account if needed; your domain does not have to be on Cloudflare).
2. Left menu → **Turnstile** → **Add widget**.
3. Widget name: `Perceev sign-in`.
4. Hostnames: add your production domain (for example `perceev.xyz`) and `localhost` for local testing. Add your Vercel preview domain too if you want the widget on previews.
5. Widget mode: **Managed**.
6. Pre-clearance: **No**.
7. Create. Cloudflare shows two values:
   - **Site key** (public) → Vercel variable `NEXT_PUBLIC_TURNSTILE_SITE_KEY` (Production, plus Preview if you added that hostname).
   - **Secret key** (secret) → goes only into Supabase, in step 9. Do not put it in Vercel.
8. Redeploy. The widget now shows on the sign-in pages, but nothing is enforced yet, so nobody can be locked out.
9. Supabase dashboard → **Authentication → Attack Protection** (some dashboards call it "Bot and Abuse Protection") → **Enable captcha protection** → provider **Turnstile** → paste the secret key → Save. From now on Supabase refuses sign-ups, sign-ins and resets without a valid token.

**Order matters.** Always add the site key (step 7–8) **before** turning on captcha in Supabase (step 9). To switch off, do the reverse: turn off captcha in Supabase first, then remove the site key. The other way round locks everyone out.

**Check it works.** F24 live checks L1 and L5 (`features/F24-sign-in-hardening.md` §10).

**Related F24 step (not one of the four, but same time).** "Continue with Google" for sign-in needs its own Google OAuth client, separate from the Analytics one below: Google Cloud → Credentials → OAuth client "Perceev sign-in" (Web application), redirect URI `https://<your-supabase-ref>.supabase.co/auth/v1/callback`; paste its ID and secret into Supabase → Authentication → Providers → Google. Scopes are only `openid email profile`, which need no Google review.

---

## 2. Second Google OAuth client, with the Analytics scope (F20)

**What it is.** A set of credentials that lets a customer click "Connect Google Analytics", approve read-only access on Google's screen, and let Perceev read their GA4 reports.

**Why a second one.** You already have a client for Search Console. When Google revokes access, it revokes **every** scope that client holds for that Google account. If Analytics shared the Search Console client, a customer disconnecting Analytics could silently disconnect their Search Console too. A separate client keeps the two independent (F20 §3 design decision).

**Cost.** Free.

**Lead time.** `analytics.readonly` is a **sensitive** scope. Until Google verifies the app, customers see an "unverified app" warning, and only test users you list can connect. Verification needs a demo video and usually takes several business days, sometimes longer. Start now.

**Steps.**

1. Go to console.cloud.google.com and pick **the same project** that holds the Search Console client.
2. **APIs & Services → Library**: enable **Google Analytics Data API** and **Google Analytics Admin API**.
3. **Google Auth Platform → Branding** (older consoles: "OAuth consent screen"). Check these are filled in and correct, because Google reviews them:
   - App name: Perceev. Logo: the Perceev logo.
   - User support email and developer contact email.
   - App home page: your production URL.
   - Privacy policy URL: your live privacy page. It must say what Analytics data you read and why (read-only, to show traffic and search opportunities inside Perceev; not sold or shared). F24 also adds a "Signing in with Google" section to the same page.
   - Terms of service URL.
   - Authorised domains: your production domain. It must be verified in Google Search Console under an owner account.
4. **Data Access** (older: "Scopes") → **Add or remove scopes** → add `https://www.googleapis.com/auth/analytics.readonly` (plus `openid`, `email`, `profile`). The screen shows it under "sensitive scopes".
5. **Audience** → while testing, keep the app in **Testing** and add your own Google account(s) as **test users** (up to 100). Note: in Testing mode Google expires refresh tokens after 7 days, so test connections need reconnecting weekly. That is expected.
6. **Clients → Create client** → type **Web application** → name `Perceev Analytics`.
   - Authorised redirect URI: `https://perceev.xyz/api/customer/ga4/callback` (use your real production domain if it differs; F20 §10).
   - For local testing, also add `http://localhost:3000/api/customer/ga4/callback`.
7. Create. Save:
   - **Client ID** (public) → `GA4_GOOGLE_CLIENT_ID`
   - **Client secret** (secret) → `GA4_GOOGLE_CLIENT_SECRET`. Google shows it only once in newer consoles; download the JSON if offered and keep it out of the repo and out of Google Drive sync folders.
   - The redirect URI from step 6 → `GA4_OAUTH_REDIRECT_URI`
   All three go into Vercel (Production). F20 reuses the existing `GSC_TOKEN_ENCRYPTION_KEY`, so there is no new encryption key.
8. **Submit for verification** (Audience → Publish app, then Verification Center). You will need:
   - A short **demo video** (unlisted YouTube link, English) showing: signing in to Perceev, Settings → Integrations → "Connect Google Analytics", the full Google consent screen with the app name and the Analytics permission visible, choosing a property, and the Analytics data shown in Perceev.
   - A **justification** for the scope, for example: "Perceev shows customers their own Google Analytics organic traffic and engaged sessions next to their AI visibility results. Access is read-only; we never change Analytics settings."
   - The video can only be recorded once F20 phase 2 (connection UI) runs on a deployment. Until then, do steps 1–7 now so the client exists and you can test with test users.

**Check it works.** F20 enabling steps (§10): allowlist your workspace (`FEATURE_GA4=allowlist`), connect, and compare Perceev's overview with Google Analytics' own "Organic Search" numbers for the same dates.

---

## 3. Loops (F25)

**What it is.** An email service for product emails. Perceev uses it for three notification emails, a 7-day onboarding series, and a "Product updates" list. Supabase keeps sending the sign-up and password emails as today.

**Cost.** Free plan: up to 1,000 contacts and 4,000 sends every 30 days (transactional and marketing combined), with a small Loops footer. Paid plans start around USD 49 a month for more contacts. Check loops.so/pricing when you sign up.

**Steps.**

1. Sign up at loops.so with a company address.
2. **Settings → Domain**: add a sending subdomain such as `mail.perceev.xyz`. Loops gives DNS records (SPF/DKIM/MX-style records); add them at your DNS provider and wait for Loops to show them verified. Emails will not send until this is done.
3. **Settings → Contact properties**: create these exactly (names are case-sensitive):
   - Booleans: `workspaceCreated`, `firstScanCompleted`, `scheduleSet`, `gscConnected`, `auditRun`, `draftApproved`, `assistantUsed`
   - Number: `workspaceCount`
4. **Audience → Mailing lists**: create a list called **Product updates** (public). Copy its ID → `LOOPS_PRODUCT_UPDATES_LIST_ID`.
5. **Transactional**: create three templates. Copy the subject, preview text, body and button text from `features/F25-lifecycle-email.md` §6.4, and use **exactly** the variable names listed there, because Perceev refuses to send any other variable.
   - `scan_finished`: variables `brandName`, `scanDate`, `questionsAsked`, `questionsNamingYou`, `outcomeLabel`, `reportUrl`, `unsubscribeUrl`. Template ID → `LOOPS_TX_SCAN_FINISHED_ID`.
   - `schedule_skipped`: `brandName`, `windowTime`, `reasonMessage`, `actionLabel`, `actionUrl`, `nextRunTime`, `unsubscribeUrl`. ID → `LOOPS_TX_SCHEDULE_SKIPPED_ID`.
   - `spend_cap_reached`: `brandName`, `periodLabel`, `limitUsd`, `resumesOn`, `usageUrl`, `unsubscribeUrl`. ID → `LOOPS_TX_SPEND_CAP_ID`.
   Publish each template, otherwise its ID cannot send.
6. **Loops → Create Loop** named **Perceev onboarding**, trigger: event `signed_up`. Add the seven emails D1–D7 from F25 §6.4 with their delays and "send only if" filters on the contact properties above. Leave D5 (site audit) and D7 (assistant) **paused** until those features are switched on for most workspaces.
7. **Settings → API → Generate key** → `LOOPS_API_KEY` (secret).
8. Generate the link-signing secret without ever seeing it: `openssl rand -base64 48 | tr -d '\n' | vercel env add EMAIL_LINK_SECRET production`.
9. Put `LOOPS_API_KEY`, `LOOPS_PRODUCT_UPDATES_LIST_ID` and the three `LOOPS_TX_*` IDs into Vercel (Production). Leave `FEATURE_LIFECYCLE_EMAIL` off until F25 is merged and migrations 160–161 are applied.

**Check it works.** F25 live checks E1–E6 (§10): send each test email to yourself, sign up a new account and see the contact and `signed_up` event in Loops, toggle Product updates, click an unsubscribe link.

---

## 4. PostHog, EU cloud (F26)

**What it is.** Product analytics (which features people use, where they fail) and error tracking. Perceev only sends named events with counts and yes/no values, never questions, answers, website data, emails or names, and nothing at all until the person agrees.

**Why EU.** PostHog has no India region. The EU cloud is run under GDPR, and Perceev proxies it through its own `/ingest` path so PostHog never sees visitors' IP addresses from the browser.

**Cost.** The free tier needs no card and includes a monthly allowance of analytics events and 100,000 error events, which is far more than early usage. Set a billing limit anyway (step 3).

**Steps.**

1. Sign up at posthog.com and choose **EU Cloud** when asked for the region (the URL becomes `eu.posthog.com`). The region cannot be changed later.
2. Create a project named **Perceev (production)**. Optionally a second one, **Perceev (preview)**, so test traffic stays separate.
3. **Organization settings → Billing**: set billing limits to USD 0 on every product you do not intend to pay for.
4. **Project settings**:
   - Turn **on** "Discard client IP data".
   - Turn **off** session replay, autocapture, heatmaps and surveys (Perceev's code disables them too; this is a second safety).
5. Copy the **Project API key** (starts with `phc_`, public) → both `NEXT_PUBLIC_POSTHOG_KEY` and `POSTHOG_PROJECT_KEY`. Set `POSTHOG_HOST=https://eu.i.posthog.com`.
6. For readable error stack traces (source maps), also:
   - **Personal settings → Personal API keys → Create**, scope limited to source-map / error-tracking write → `POSTHOG_CLI_TOKEN` (secret).
   - The project's environment ID (shown in Project settings) → `POSTHOG_CLI_ENV_ID`.
   - `POSTHOG_CLI_HOST=https://eu.posthog.com` and `POSTHOG_SOURCEMAPS=true`.
7. Put all of these in Vercel. Use the **preview** project's key for the Preview environment and the production key for Production. Leave `FEATURE_PRODUCT_ANALYTICS` off until F26 is merged and migration 165 is applied.

**Check it works.** F26 live checks T1–T5 (§10), first on a preview: no events before consent; after "Share analytics", a `$pageview` with a UUID workspace group and no `brand_key`; no email or name on persons; a test error with a readable stack and empty message.

---

## Where each value goes

| Value | Where | Secret? |
|---|---|---|
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | Vercel | No |
| Turnstile secret key | Supabase → Attack Protection only | **Yes** |
| `GA4_GOOGLE_CLIENT_ID` | Vercel | No |
| `GA4_GOOGLE_CLIENT_SECRET` | Vercel | **Yes** |
| `GA4_OAUTH_REDIRECT_URI` | Vercel | No |
| Google sign-in client ID and secret (F24) | Supabase → Providers → Google only | Secret: **yes** |
| `LOOPS_API_KEY` | Vercel | **Yes** |
| `LOOPS_PRODUCT_UPDATES_LIST_ID`, `LOOPS_TX_SCAN_FINISHED_ID`, `LOOPS_TX_SCHEDULE_SKIPPED_ID`, `LOOPS_TX_SPEND_CAP_ID` | Vercel | No |
| `EMAIL_LINK_SECRET` | Vercel (generated by the piped command) | **Yes** |
| `NEXT_PUBLIC_POSTHOG_KEY`, `POSTHOG_PROJECT_KEY`, `POSTHOG_HOST` | Vercel | No |
| `POSTHOG_CLI_TOKEN` | Vercel | **Yes** |
| `POSTHOG_CLI_ENV_ID`, `POSTHOG_CLI_HOST`, `POSTHOG_SOURCEMAPS` | Vercel | No |

Feature switches (`FEATURE_GOOGLE_SIGN_IN`, `FEATURE_GA4`, `FEATURE_LIFECYCLE_EMAIL`, `FEATURE_PRODUCT_ANALYTICS`) stay off until the matching feature is merged and its migrations are applied. Creating the accounts early is safe: with the switches off, nothing is sent anywhere.

## Sources

- Loops pricing and free plan: https://loops.so/pricing, https://loops.so/docs/account/billing
- Google sensitive-scope verification: https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification
- PostHog EU cloud and error-tracking pricing: https://posthog.com/eu, https://posthog.com/docs/error-tracking/pricing
- Supabase captcha: https://supabase.com/docs/guides/auth/auth-captcha

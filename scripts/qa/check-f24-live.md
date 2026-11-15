# F24 Live Verification Checklist (Owner-Run)

This checklist tracks the owner-run live verification steps (L1–L7) from `features/F24-sign-in-hardening.md` §10.

> **Rules:**
> 1. To be executed only by the owner against the production deployment after completing the rollout order in `docs/OPERATOR_LEDGER.md` § C.
> 2. No email addresses, domains, or secret values may be recorded here. Name environment variables only (e.g. `TURNSTILE_SECRET_KEY`, `NEXT_PUBLIC_TURNSTILE_SITE_KEY`, `FEATURE_GOOGLE_SIGN_IN`).
> 3. Record results (PASS / FAIL, date, tester name/handle, notes) below and paste the summary into the phase 3 PR description.

---

### L1. Disposable Email Sign-up Refusal
- **Step:** Sign up with a new disposable email address (from any domain on the disposable domains list).
- **Expected:** "Please sign up with a non-disposable email address." is displayed; no user appears in Supabase Auth.
- **Status:** [ ] PASS / [ ] FAIL
- **Run Date:**
- **Tester:**
- **Notes:**

---

### L2. Google Sign-up / New Account Creation
- **Step:** Click "Continue with Google" using a Google account that has never been used on Perceev.
- **Expected:** Lands on `/onboarding` (or `/portal` "Your account is ready" before F27).
- **Status:** [ ] PASS / [ ] FAIL
- **Run Date:**
- **Tester:**
- **Notes:**

---

### L3. Same-Email Google Account Linking
- **Step:** With an existing confirmed email/password account, click "Continue with Google" using the same email address.
- **Expected:** Same user id in Supabase Auth (Identities shows `email` and `google`), same workspaces in the switcher, Search Console connection remains intact.
- **Status:** [ ] PASS / [ ] FAIL
- **Run Date:**
- **Tester:**
- **Notes:**

---

### L4. Invited User Sign-in via Google
- **Step:** Invite a fresh address from Team; sign in with Google as that address.
- **Expected:** The workspace appears without having to click the invite email link.
- **Status:** [ ] PASS / [ ] FAIL
- **Run Date:**
- **Tester:**
- **Notes:**

---

### L5. Captcha Enforcement on Password Sign-in
- **Step:** With captcha protection active in Supabase Auth (configured with `NEXT_PUBLIC_TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY`): sign in with email and password normally (succeeds). Then replay the sign-in request without a token (browser devtools "Copy as fetch", remove `gotrue_meta_security`).
- **Expected:** Replayed request without token is refused with a captcha error.
- **Status:** [ ] PASS / [ ] FAIL
- **Run Date:**
- **Tester:**
- **Notes:**

---

### L6. Password Reset Flow
- **Step:** Click "Forgot password?" from the sign-in form, request a reset email, follow the received link to `/auth/reset`, and submit a new password.
- **Expected:** Email arrives; link opens `/auth/reset`; password is updated; sign-in with the new password succeeds.
- **Status:** [ ] PASS / [ ] FAIL
- **Run Date:**
- **Tester:**
- **Notes:**

---

### L7. OAuth Cancellation Handling
- **Step:** Initiate Google sign-in from the chooser and cancel or decline on Google's permission / consent screen.
- **Expected:** Redirects to `/auth/error` displaying "Google sign-in was canceled".
- **Status:** [ ] PASS / [ ] FAIL
- **Run Date:**
- **Tester:**
- **Notes:**

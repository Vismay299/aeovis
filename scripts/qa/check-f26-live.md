# F26 Live Verification Checklist (Owner-Run)

This checklist tracks the owner-run live verification steps (T1–T5) from `features/F26-product-analytics.md` §10.

> **Rules:**
> 1. To be executed only by the owner. First run on a preview deployment, then on production; never against a local build.
> 2. Run T1–T5 in order on one deployment. T2–T5 use the account that consented in T2.
> 3. Never record keys, hosts, project or environment ids, user ids, workspace ids, emails or domains. Name environment variables only.
> 4. Record results (PASS / FAIL, date, tester name/handle, notes) below and paste the summary into the phase-5 PR description. Tick `P5.T2.S1` (F26-AC-16) only after five passes.

---

### T1. Undecided Account Sends No Identified Events
- **Step:** While signed in to an account that has not made a privacy choice, browse `/portal` for two minutes.
- **Expected:** PostHog Live events shows no identified event — no `$pageview`, and no event carrying the tester's distinct id or a `workspace` group. Anonymous counters and error reports may appear by design; note them, do not fail on them.
- **Status:** [ ] PASS / [ ] FAIL
- **Run Date:**
- **Tester:**
- **Notes:**

---

### T2. Consent Starts Capture
- **Step:** With the same account, click "Share analytics".
- **Expected:** A `$pageview` and at least one registry event appear with the user id as distinct id and a `workspace` group whose key is a UUID; the event's `$current_url` has no `brand_key`.
- **Status:** [ ] PASS / [ ] FAIL
- **Run Date:**
- **Tester:**
- **Notes:**

---

### T3. Persons Carry No Email or Name
- **Step:** Open PostHog → Persons.
- **Expected:** No person shows an email or name property.
- **Status:** [ ] PASS / [ ] FAIL
- **Run Date:**
- **Tester:**
- **Notes:**

---

### T4. Error Tracking With a Readable Stack
- **Step:** On the preview, open `/portal/telemetry-check` and click "Throw test error".
- **Expected:** The error appears in Error tracking with a de-minified stack (source maps must be enabled in the preview build) and an empty message; the page returns 404 in production.
- **Status:** [ ] PASS / [ ] FAIL
- **Run Date:**
- **Tester:**
- **Notes:**

---

### T5. Opt-Out Stops Events
- **Step:** Turn analytics off in Settings → Privacy.
- **Expected:** Events stop within one page view.
- **Status:** [ ] PASS / [ ] FAIL
- **Run Date:**
- **Tester:**
- **Notes:**

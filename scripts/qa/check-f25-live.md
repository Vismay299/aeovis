# F25 Live Verification Checklist (Owner-Run)

This checklist tracks the owner-run live verification steps (E1–E6) from `features/F25-lifecycle-email.md` §8 Phase 4 / §10.
F25-AC-16 is the only acceptance criterion it covers; phases 1–3 are verified by the suite, `scripts/qa/check-f25-db.mjs` and `scripts/qa/check-f25-browser.mjs`.

> **Rules:**
> 1. To be executed only by the owner, against the production deployment, after the rollout order in `docs/OPERATOR_LEDGER.md` § C ("F25 lifecycle email").
> 2. No email addresses, customer domains, question text, answer text or secret values may be recorded here. Name environment variables only (`FEATURE_LIFECYCLE_EMAIL`, `LOOPS_API_KEY`, `LOOPS_PRODUCT_UPDATES_LIST_ID`, `LOOPS_TX_SCAN_FINISHED_ID`, `LOOPS_TX_SCHEDULE_SKIPPED_ID`, `LOOPS_TX_SPEND_CAP_ID`, `EMAIL_LINK_SECRET`).
> 3. `scripts/qa/send-f25-test-email.mjs` is owner-only. It writes exactly one `email_outbox` row for `--to` and never calls Loops; the next `email.deliver` tick sends it. It prints only the outbox row id.
> 4. Record results (PASS / FAIL, date, tester name/handle, notes) below and paste the summary into the phase 4 PR. A FAIL records the shortest decisive line, never a provider body or an address.

---

### E1. Scan-finished email
- **Step:** Run `node scripts/qa/send-f25-test-email.mjs --to <owner address> --template scan_finished --confirm`; wait for the next `email.deliver` tick.
- **Expected:** The email arrives with the subject, preview text, fact list and "Open the report" button documented in `features/F25-lifecycle-email.md` §6.4 item 1 for the test workspace; the footer's unsubscribe link opens the unsubscribe page for scan-result emails. Replaying the same outbox row (second delivery attempt) returns Loops' 409 duplicate and does not send again.
- **Status:** [ ] PASS / [ ] FAIL
- **Run Date:**
- **Tester:**
- **Notes:**

---

### E2. Scheduled-scan-skipped email
- **Step:** Run `node scripts/qa/send-f25-test-email.mjs --to <owner address> --template schedule_skipped --confirm`; wait for the next `email.deliver` tick.
- **Expected:** The email arrives with the subject, preview text, reason line, "Review the price" action and next-run line documented in `features/F25-lifecycle-email.md` §6.4 item 2; the action opens `/portal/settings/schedule`; time values carry the `UTC` suffix.
- **Status:** [ ] PASS / [ ] FAIL
- **Run Date:**
- **Tester:**
- **Notes:**

---

### E3. Spend-cap-reached email
- **Step:** Run `node scripts/qa/send-f25-test-email.mjs --to <owner address> --template spend_cap_reached --confirm`; wait for the next `email.deliver` tick.
- **Expected:** The email arrives with the subject, preview text, limit line, "View usage" button and footer documented in `features/F25-lifecycle-email.md` §6.4 item 3; no answer text, question, citation or competitor name appears anywhere in it.
- **Status:** [ ] PASS / [ ] FAIL
- **Run Date:**
- **Tester:**
- **Notes:**

---

### E4. New sign-up contact and drip trigger
- **Step:** Create a fresh account on production with Google or email sign-up.
- **Expected:** The contact appears in Loops with `userGroup` `app-user` and `source` `perceev-signup`; the `signed_up` event is recorded; the "Perceev onboarding" Loop schedules D1 for that contact. A second callback or sign-in for the same account creates no second contact row, no second event and no second preference row.
- **Status:** [ ] PASS / [ ] FAIL
- **Run Date:**
- **Tester:**
- **Notes:**

---

### E5. Product-updates opt-in and opt-out
- **Step:** Settings → Emails → turn Product updates on. Then turn it off.
- **Expected:** On: the contact is a member of the "Product updates" list and `subscribed` is true. Off: the contact is removed from the list and `subscribed` stays true (lifecycle emails still depend on it). `productUpdatesChangedAt` and source are updated by each change.
- **Status:** [ ] PASS / [ ] FAIL
- **Run Date:**
- **Tester:**
- **Notes:**

---

### E6. Unsubscribe link end to end
- **Step:** From the E1 email, follow the footer unsubscribe link; submit "Stop these emails" on the page.
- **Expected:** The page shows "You're unsubscribed"; the scan-results preference is now off in Settings → Emails; the next scan-finished row for that user is skipped as `preference_off` instead of sending. A tampered link shows "This link is not valid" and changes nothing.
- **Status:** [ ] PASS / [ ] FAIL
- **Run Date:**
- **Tester:**
- **Notes:**

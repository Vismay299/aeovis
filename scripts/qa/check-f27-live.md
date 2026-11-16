# F27 Live Verification Checklist (Owner-Run)

This checklist tracks the owner-run live verification steps (O1–O5) from `features/F27-onboarding-wizard.md` §10.

> **Rules:**
> 1. To be executed only by the owner, first against the preview deployment and then against production, after completing the rollout order in `docs/OPERATOR_LEDGER.md` § C. Record the production result in **Status** and the preview result in **Notes**; AC-19 is the production run.
> 2. No email addresses, domains, or secret values may be recorded here. Name environment variables only (e.g. `FEATURE_ONBOARDING_WIZARD`).
> 3. Record results (PASS / FAIL, date, tester name/handle, notes) below and paste the summary into the phase 4 PR description.

---

### O1. Free Scan Hand-off into Onboarding
- **Step:** Run the free scan for a site you control, click "Track these questions in a workspace", sign up.
- **Expected:** Onboarding shows the domain, brand and "…questions from your free scan…".
- **Status:** [ ] PASS / [ ] FAIL
- **Run Date:**
- **Tester:**
- **Notes:**

---

### O2. Website Step Save, Audit Start, Research Price
- **Step:** Save the website step; approve research only if the paid control is on for this workspace.
- **Expected:** Workspace created and the audit starts (Site Audit shows it running). If the paid control is on, the research price is shown; if the `question_setup` flag is off, research is unavailable and the wizard advances without a dialog; if the flag is on but the paid control is off, the dialog shows the blocked message and only "Skip research".
- **Status:** [ ] PASS / [ ] FAIL
- **Run Date:**
- **Tester:**
- **Notes:**

---

### O3. Search Console Connect and Return
- **Step:** Connect Search Console.
- **Expected:** Return to step 2's picker.
- **Status:** [ ] PASS / [ ] FAIL
- **Run Date:**
- **Tester:**
- **Notes:**

---

### O4. Preferences Saved
- **Step:** Complete the preferences step and save your choices.
- **Expected:** Settings → Privacy and Emails show the choices.
- **Status:** [ ] PASS / [ ] FAIL
- **Run Date:**
- **Tester:**
- **Notes:**

---

### O5. Approve Questions and Run First Scan
- **Step:** Approve questions (via "Review questions") and run the first scan from the price dialog.
- **Expected:** The first scan runs from the price dialog after the questions are approved.
- **Status:** [ ] PASS / [ ] FAIL
- **Run Date:**
- **Tester:**
- **Notes:**

---

### Unnumbered in §10 (not part of AC-19)
- **Step:** Log in with an existing customer account.
- **Expected:** Onboarding is never shown.
- **Status:** [ ] PASS / [ ] FAIL
- **Run Date:**
- **Tester:**
- **Notes:**

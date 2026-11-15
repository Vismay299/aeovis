import test from "node:test";
import assert from "node:assert/strict";
import { decideOnboardingRedirect } from "./useOnboardingRedirect.ts";

test("an existing customer with a workspace and no onboarding row stays in the portal", () => {
  assert.equal(decideOnboardingRedirect({
    flagKnown: true,
    memberships: [{ brandKey: "workspace-a" }],
    row: null,
    state: { enabled: true, needsOnboarding: true },
    pathname: "/portal/scans",
    search: "?range=month",
  }), null);
});

test("a new account redirects and preserves its requested page", () => {
  assert.equal(decideOnboardingRedirect({
    flagKnown: true,
    memberships: [],
    row: null,
    state: { enabled: true, needsOnboarding: true },
    pathname: "/portal/scans",
    search: "?range=month",
  }), "/onboarding?redirect=%2Fportal%2Fscans%3Frange%3Dmonth");
});

test("a failed or unknown onboarding check leaves the portal visible", () => {
  assert.equal(decideOnboardingRedirect({ flagKnown: false, memberships: [], row: null, state: null, pathname: "/portal/scans", search: "" }), null);
  assert.equal(decideOnboardingRedirect({ flagKnown: true, memberships: [], row: null, state: null, pathname: "/portal/scans", search: "" }), null);
});

test("the portal root is not copied into a redirect parameter", () => {
  assert.equal(decideOnboardingRedirect({ flagKnown: true, memberships: [], row: null, state: { enabled: true, needsOnboarding: true }, pathname: "/portal", search: "" }), "/onboarding");
});

test("an incomplete onboarding row on a workspace without scans can redirect", () => {
  assert.equal(decideOnboardingRedirect({ flagKnown: true, memberships: [{ brandKey: "workspace-a" }], row: { completed_at: null }, state: { enabled: true, needsOnboarding: true }, pathname: "/portal", search: "" }), "/onboarding");
});

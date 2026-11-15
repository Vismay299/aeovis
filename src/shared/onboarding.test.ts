import test from "node:test";
import assert from "node:assert/strict";
import {
  visibleSteps,
  resolveStep,
  nextStep,
  previousStep,
  onboardingHref,
  finishDestination,
  ONBOARDING_STEPS,
  ONBOARDING_STEP_LABELS,
} from "./onboarding.ts";

test("F27-AC-02 visibleSteps handles all feature flag combinations", () => {
  // Both available
  assert.deepEqual(
    visibleSteps({ ga4Available: true, preferencesAvailable: true }),
    ["website", "search_console", "analytics", "preferences", "first_scan"]
  );

  // Neither available
  assert.deepEqual(
    visibleSteps({ ga4Available: false, preferencesAvailable: false }),
    ["website", "search_console", "first_scan"]
  );

  // Only ga4
  assert.deepEqual(
    visibleSteps({ ga4Available: true, preferencesAvailable: false }),
    ["website", "search_console", "analytics", "first_scan"]
  );

  // Only preferences
  assert.deepEqual(
    visibleSteps({ ga4Available: false, preferencesAvailable: true }),
    ["website", "search_console", "preferences", "first_scan"]
  );
});

test("F27-AC-02 resolveStep behaviour", () => {
  const allVisible = visibleSteps({ ga4Available: true, preferencesAvailable: true });

  // Valid named step
  assert.equal(
    resolveStep("search_console", { visible: allVisible, statuses: {}, hasGa4Return: false }),
    "search_console"
  );

  // Bogus step falls back to first not-done
  assert.equal(
    resolveStep("bogus", {
      visible: allVisible,
      statuses: { website: "done" },
      hasGa4Return: false,
    }),
    "search_console"
  );

  // All visible steps done falls back to first_scan
  assert.equal(
    resolveStep("bogus", {
      visible: allVisible,
      statuses: {
        website: "done",
        search_console: "done",
        analytics: "done",
        preferences: "done",
        first_scan: "done",
      },
      hasGa4Return: false,
    }),
    "first_scan"
  );

  // ga4 return with no step parameter resolves to analytics
  assert.equal(
    resolveStep(null, {
      visible: allVisible,
      statuses: { website: "done" },
      hasGa4Return: true,
    }),
    "analytics"
  );

  // hidden analytics + ?step=analytics resolves to next visible step not done
  const noGa4 = visibleSteps({ ga4Available: false, preferencesAvailable: true });
  assert.equal(
    resolveStep("analytics", {
      visible: noGa4,
      statuses: { website: "done", search_console: "done" },
      hasGa4Return: false,
    }),
    "preferences"
  );

  // hidden analytics + ga4 return flag resolves to next visible not done
  assert.equal(
    resolveStep(null, {
      visible: noGa4,
      statuses: { website: "done", search_console: "done" },
      hasGa4Return: true,
    }),
    "preferences"
  );
});

test("nextStep and previousStep navigation", () => {
  const steps = visibleSteps({ ga4Available: true, preferencesAvailable: true });

  assert.equal(nextStep("website", steps), "search_console");
  assert.equal(nextStep("first_scan", steps), null);
  assert.equal(previousStep("website", steps), null);
  assert.equal(previousStep("search_console", steps), "website");
  assert.equal(previousStep("first_scan", steps), "preferences");
});

test("onboardingHref URL builder", () => {
  assert.equal(onboardingHref("website", {}), "/onboarding?step=website");
  assert.equal(
    onboardingHref("search_console", {
      domain: "acme.example",
      scan: "11111111-1111-4111-8111-111111111111",
      redirect: "/portal/scans",
    }),
    "/onboarding?step=search_console&domain=acme.example&scan=11111111-1111-4111-8111-111111111111&redirect=%2Fportal%2Fscans"
  );
});

test("F27-AC-14 finishDestination destinations", () => {
  // Safe redirect wins
  assert.equal(
    finishDestination({
      redirect: "/portal/scans?filter=recent",
      handoffDomain: "acme.example",
      handoffScan: null,
      workspaceHost: "acme.example",
      domainOverviewOn: true,
    }),
    "/portal/scans?filter=recent"
  );

  // //evil redirect ignored
  assert.equal(
    finishDestination({
      redirect: "//evil.example/steal",
      handoffDomain: "acme.example",
      handoffScan: null,
      workspaceHost: "acme.example",
      domainOverviewOn: true,
    }),
    "/portal/domain?domain=acme.example&minRank=4&maxRank=20&sort=volume&order=desc"
  );

  // Domain without scan + domain overview on → striking distance href
  assert.equal(
    finishDestination({
      redirect: null,
      handoffDomain: "acme.example",
      handoffScan: null,
      workspaceHost: "acme.example",
      domainOverviewOn: true,
    }),
    "/portal/domain?domain=acme.example&minRank=4&maxRank=20&sort=volume&order=desc"
  );

  // Domain with scan → /portal
  assert.equal(
    finishDestination({
      redirect: null,
      handoffDomain: "acme.example",
      handoffScan: "11111111-1111-4111-8111-111111111111",
      workspaceHost: "acme.example",
      domainOverviewOn: true,
    }),
    "/portal"
  );

  // Domain overview off → /portal
  assert.equal(
    finishDestination({
      redirect: null,
      handoffDomain: "acme.example",
      handoffScan: null,
      workspaceHost: "acme.example",
      domainOverviewOn: false,
    }),
    "/portal"
  );
});

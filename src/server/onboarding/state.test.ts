import test from "node:test";
import assert from "node:assert/strict";
import { needsOnboarding, getOnboardingState } from "./state.ts";

test("F27-AC-01 needsOnboarding decision matrix", () => {
  // Flag off → false regardless of other inputs
  assert.equal(
    needsOnboarding({
      flagEnabled: false,
      completedAt: null,
      hasRow: false,
      hasWorkspace: false,
      workspaceHasScans: false,
    }),
    false
  );

  // Completed row → false
  assert.equal(
    needsOnboarding({
      flagEnabled: true,
      completedAt: "2026-11-10T09:00:00Z",
      hasRow: true,
      hasWorkspace: true,
      workspaceHasScans: false,
    }),
    false
  );

  // No row + no workspace → true
  assert.equal(
    needsOnboarding({
      flagEnabled: true,
      completedAt: null,
      hasRow: false,
      hasWorkspace: false,
      workspaceHasScans: false,
    }),
    true
  );

  // No row + a workspace → false
  assert.equal(
    needsOnboarding({
      flagEnabled: true,
      completedAt: null,
      hasRow: false,
      hasWorkspace: true,
      workspaceHasScans: false,
    }),
    false
  );

  // Row incomplete + workspace has no scans → true
  assert.equal(
    needsOnboarding({
      flagEnabled: true,
      completedAt: null,
      hasRow: true,
      hasWorkspace: true,
      workspaceHasScans: false,
    }),
    true
  );

  // Row incomplete + a scan exists → false
  assert.equal(
    needsOnboarding({
      flagEnabled: true,
      completedAt: null,
      hasRow: true,
      hasWorkspace: true,
      workspaceHasScans: true,
    }),
    false
  );
});

test("F27-AC-01 getOnboardingState with scan auto-completes incomplete row", async () => {
  let completedViaCalledWith: string | null = null;
  const mockAdmin = {
    from: (table: string) => {
      if (table === "user_onboarding") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: {
                  user_id: "user-1",
                  brand_key: "brand-1",
                  completed_at: null,
                  completed_via: null,
                  steps: { website: { status: "done" } },
                  handoff: {},
                },
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === "customer_brand_memberships") {
        return {
          select: () => ({
            eq: () => ({
              data: [{ brand_key: "brand-1", role: "owner" }],
              error: null,
            }),
          }),
        };
      }
      if (table === "customer_brands") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: {
                  brand_key: "brand-1",
                  display_name: "Brand 1",
                  website: "https://brand1.example",
                  website_host: "brand1.example",
                  telemetry_id: "tele-1",
                },
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === "scans") {
        return {
          select: (_cols: any, opts?: any) => {
            if (opts?.head) {
              return {
                eq: () => ({
                  count: 1, // Workspace has 1 scan
                  error: null,
                }),
              };
            }
            return {
              eq: () => ({ data: [], error: null }),
            };
          },
        };
      }
      if (table === "site_audits" || table === "gsc_connections") {
        return {
          select: () => ({
            eq: () => ({
              order: () => ({
                limit: () => ({
                  maybeSingle: async () => ({ data: null, error: null }),
                }),
              }),
              maybeSingle: async () => ({ data: null, error: null }),
            }),
          }),
        };
      }
      return { select: () => ({ eq: () => ({ data: [], error: null }) }) };
    },
  } as any;

  const mockComplete = async (_admin: any, _userId: string, via: any) => {
    completedViaCalledWith = via;
    return {
      completedNow: true,
      completedAt: "2026-11-15T12:00:00Z",
      via,
    };
  };

  const state = await getOnboardingState(
    mockAdmin,
    { id: "user-1" },
    {},
    {
      isFeatureEnabled: async (name: string) => name === "onboarding_wizard",
      completeOnboarding: mockComplete as any,
      readFreeScanPrefill: async () => null,
      readQuestionSettings: async () => ({ country: "in", language: "en" } as any),
      getQuestionsState: async () =>
        ({
          setup: { status: "none", jobId: null },
          questions: [],
          approved: null,
        } as any),
      getGa4ConnectionState: async () => ({ configured: false, connected: false }),
    }
  );

  assert.equal(completedViaCalledWith, "first_scan");
  assert.equal(state.needsOnboarding, false);
  assert.equal(state.completedAt, "2026-11-15T12:00:00Z");
  assert.equal(state.workspace?.hasScans, true);
});

test("F27-AC-01 getOnboardingState returns disabled payload when flag is off", async () => {
  const mockAdmin = {} as any;
  const state = await getOnboardingState(
    mockAdmin,
    { id: "user-1" },
    {},
    {
      isFeatureEnabled: async () => false,
    }
  );

  assert.equal(state.enabled, false);
  assert.equal(state.needsOnboarding, false);
  assert.deepEqual(state.visibleSteps, []);
});

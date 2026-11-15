import test from "node:test";
import assert from "node:assert/strict";
import { POST } from "../../app/api/customer/onboarding/website/route.ts";

function createMockAdmin(opts = {}) {
  const existingRow = opts.existingRow ?? null;
  const memberships = opts.memberships ?? [];
  const scansCount = opts.scansCount ?? 0;
  const brand = opts.brand ?? null;
  const audit = opts.audit ?? null;

  return {
    auth: {
      admin: {
        getUserById: async () => ({
          data: { user: { email_confirmed_at: "2026-10-01T00:00:00Z" } },
        }),
      },
    },
    from(table) {
      if (table === "user_onboarding") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: existingRow, error: null }),
            }),
          }),
          upsert: async () => ({ data: null, error: null }),
          update: () => ({
            eq: async () => ({ data: null, error: null }),
          }),
        };
      }
      if (table === "customer_brand_memberships") {
        return {
          select: () => ({
            eq: async () => ({ data: memberships, error: null }),
          }),
        };
      }
      if (table === "scans") {
        return {
          select: (_cols, options) => ({
            eq: async () => ({ count: scansCount, data: null, error: null }),
          }),
        };
      }
      if (table === "customer_brands") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: brand, error: null }),
            }),
          }),
          update: () => ({
            eq: async () => ({ data: null, error: null }),
          }),
        };
      }
      if (table === "site_audits") {
        return {
          select: () => ({
            eq: () => ({
              limit: () => ({
                maybeSingle: async () => ({ data: audit, error: null }),
              }),
            }),
          }),
        };
      }
      return {
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }),
      };
    },
    rpc: async () => ({
      data: { brand_key: "brand-123", display_name: "Acme", website: "https://acme.example" },
      error: null,
    }),
  };
}

const validBody = {
  website: "https://acme.example",
  brandName: "Acme",
  country: "us",
  language: "en",
  idempotencyKey: "11111111-2222-4333-8444-555555555555",
};

test("POST /api/customer/onboarding/website - flag off returns 404", async () => {
  const req = new Request("http://localhost/api/customer/onboarding/website", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(validBody),
  });

  const res = await POST(req, undefined, {
    isFeatureEnabled: async () => false,
  });

  assert.equal(res.status, 404);
  const data = await res.json();
  assert.equal(data.code, "feature_unavailable");
});

test("POST /api/customer/onboarding/website - unverified email returns 403", async () => {
  const req = new Request("http://localhost/api/customer/onboarding/website", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(validBody),
  });

  const admin = {
    auth: {
      admin: {
        getUserById: async () => ({
          data: { user: { email_confirmed_at: null, confirmed_at: null } },
        }),
      },
    },
  };

  const res = await POST(req, undefined, {
    isFeatureEnabled: async () => true,
    requireUser: async () => ({
      user: { id: "user-1", email_confirmed_at: null, confirmed_at: null },
      admin,
    }),
  });

  assert.equal(res.status, 403);
  const data = await res.json();
  assert.equal(data.code, "email_unverified");
});

test("POST /api/customer/onboarding/website - invalid website returns 400", async () => {
  const req = new Request("http://localhost/api/customer/onboarding/website", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...validBody,
      website: "invalid domain with spaces",
    }),
  });

  const admin = createMockAdmin();
  const res = await POST(req, undefined, {
    isFeatureEnabled: async () => true,
    requireUser: async () => ({
      user: { id: "user-1", email_confirmed_at: "2026-10-01T00:00:00Z" },
      admin,
    }),
  });

  assert.equal(res.status, 400);
  const data = await res.json();
  assert.equal(data.code, "website_invalid");
});

test("POST /api/customer/onboarding/website - user with another workspace and no onboarding row returns 409", async () => {
  const req = new Request("http://localhost/api/customer/onboarding/website", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(validBody),
  });

  const admin = createMockAdmin({
    memberships: [{ brand_key: "other-brand-key", role: "owner" }],
    existingRow: null,
  });

  const res = await POST(req, undefined, {
    isFeatureEnabled: async () => true,
    requireUser: async () => ({
      user: { id: "user-1", email_confirmed_at: "2026-10-01T00:00:00Z" },
      admin,
    }),
  });

  assert.equal(res.status, 409);
  const data = await res.json();
  assert.equal(data.code, "already_has_workspace");
});

test("POST /api/customer/onboarding/website - changing website on workspace with scans returns 409 website_locked", async () => {
  const req = new Request("http://localhost/api/customer/onboarding/website", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(validBody),
  });

  const admin = createMockAdmin({
    existingRow: { brand_key: "brand-123", steps: {}, handoff: {} },
    memberships: [{ brand_key: "brand-123", role: "owner" }],
    scansCount: 1,
    brand: { display_name: "Old Name", website: "https://old.example", website_host: "old.example" },
  });

  const res = await POST(req, undefined, {
    isFeatureEnabled: async () => true,
    requireUser: async () => ({
      user: { id: "user-1", email_confirmed_at: "2026-10-01T00:00:00Z" },
      admin,
    }),
  });

  assert.equal(res.status, 409);
  const data = await res.json();
  assert.equal(data.code, "website_locked");
});

test("POST /api/customer/onboarding/website - AC-03 happy path creates workspace, saves settings, starts audit once", async () => {
  const req = new Request("http://localhost/api/customer/onboarding/website", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(validBody),
  });

  let rpcArgs = null;
  let savedSettings = null;
  let auditStarted = 0;

  const admin = createMockAdmin();

  const mockWs = {
    brandKey: "brand-123",
    displayName: "Acme",
    website: "https://acme.example",
    websiteHost: "acme.example",
    role: "owner",
    admin,
    user: { id: "user-1" },
  };

  const res = await POST(req, undefined, {
    isFeatureEnabled: async () => true,
    requireUser: async () => ({
      user: { id: "user-1", email_confirmed_at: "2026-10-01T00:00:00Z" },
      admin,
    }),
    createCustomerWorkspaceRpc: async (_adm, args) => {
      rpcArgs = args;
      return { data: { brand_key: "brand-123" }, error: null };
    },
    requireWorkspace: async () => mockWs,
    saveQuestionSettings: async (_adm, args) => {
      savedSettings = args;
    },
    startSiteAudit: async () => {
      auditStarted++;
    },
    getOnboardingState: async () => ({
      enabled: true,
      needsOnboarding: true,
      completedAt: null,
      workspace: mockWs,
      visibleSteps: ["website", "search_console", "preferences", "first_scan"],
      steps: { website: "done" },
      market: { country: "us", language: "en" },
      prefill: null,
      handoff: null,
      audit: { available: true, auditId: null, status: "running", pagesCrawled: 0, pagesTotal: 50 },
      research: { available: false, status: "none", jobId: null },
      questions: null,
      gsc: { connected: false, property: null },
      ga4: { available: false, connected: false },
      preferences: { productUpdatesAvailable: true, analyticsAvailable: true },
      domainOverview: false,
      pollAfterSeconds: null,
    }),
  });

  assert.equal(res.status, 200);
  assert.equal(rpcArgs.p_idempotency_key, `onboarding:${validBody.idempotencyKey}`);
  assert.equal(savedSettings.settings.country, "us");
  assert.equal(savedSettings.settings.language, "en");
  assert.equal(auditStarted, 1);

  const state = await res.json();
  assert.equal(state.steps.website, "done");
});

test("POST /api/customer/onboarding/website - AC-05 audit failure does not fail the save", async () => {
  const req = new Request("http://localhost/api/customer/onboarding/website", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(validBody),
  });

  const admin = createMockAdmin();
  const mockWs = {
    brandKey: "brand-123",
    displayName: "Acme",
    website: "https://acme.example",
    websiteHost: "acme.example",
    role: "owner",
    admin,
    user: { id: "user-1" },
  };

  const res = await POST(req, undefined, {
    isFeatureEnabled: async () => true,
    requireUser: async () => ({
      user: { id: "user-1", email_confirmed_at: "2026-10-01T00:00:00Z" },
      admin,
    }),
    createCustomerWorkspaceRpc: async () => ({ data: { brand_key: "brand-123" }, error: null }),
    requireWorkspace: async () => mockWs,
    saveQuestionSettings: async () => {},
    startSiteAudit: async () => {
      throw new Error("Audit service unavailable");
    },
    getOnboardingState: async () => ({
      enabled: true,
      needsOnboarding: true,
      completedAt: null,
      workspace: mockWs,
      visibleSteps: ["website", "search_console", "preferences", "first_scan"],
      steps: { website: "done" },
      market: { country: "us", language: "en" },
      prefill: null,
      handoff: null,
      audit: { available: true, auditId: null, status: "not_started", pagesCrawled: 0, pagesTotal: 50 },
      research: null,
      questions: null,
      gsc: { connected: false, property: null },
      ga4: { available: false, connected: false },
      preferences: { productUpdatesAvailable: true, analyticsAvailable: true },
      domainOverview: false,
      pollAfterSeconds: null,
    }),
  });

  assert.equal(res.status, 200);
  const state = await res.json();
  assert.equal(state.audit.status, "not_started");
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { GET as getOnboardingStateRoute } from "../../app/api/customer/onboarding/route.ts";
import { POST as postOnboardingStepRoute } from "../../app/api/customer/onboarding/step/route.ts";
import { POST as postOnboardingCompleteRoute } from "../../app/api/customer/onboarding/complete/route.ts";

const fixtureScan = JSON.parse(
  fs.readFileSync(
    path.resolve(process.cwd(), "tests/fixtures/f27/free-scan-row.json"),
    "utf-8",
  ),
);

function createMockAdmin(opts = {}) {
  const onboardingRow = opts.onboardingRow ?? null;
  const brand = opts.brand ?? null;
  const scansCount = opts.scansCount ?? 0;
  const memberships = opts.memberships ?? [];

  return {
    from(table) {
      if (table === "user_onboarding") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: onboardingRow, error: null }),
            }),
          }),
          upsert: async (row) => ({ data: row, error: null }),
          update: () => ({
            eq: async () => ({ data: null, error: null }),
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
        };
      }
      if (table === "customer_brand_memberships") {
        return {
          select: () => ({
            eq: () => ({
              limit: () => ({
                maybeSingle: async () => ({ data: memberships[0] ?? null, error: null }),
              }),
            }),
          }),
        };
      }
      if (table === "scans") {
        return {
          select: () => ({
            eq: (col, val) => {
              if (col === "id" && val === fixtureScan.id) {
                return {
                  maybeSingle: async () => ({ data: fixtureScan, error: null }),
                };
              }
              return {
                maybeSingle: async () => ({ data: null, error: null }),
              };
            },
          }),
        };
      }
      if (table === "site_audits") {
        return {
          select: () => ({
            eq: () => ({
              order: () => ({
                limit: () => ({
                  maybeSingle: async () => ({ data: null, error: null }),
                }),
              }),
            }),
          }),
        };
      }
      if (table === "repair_artifacts") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                eq: () => ({
                  eq: () => ({
                    limit: () => ({
                      maybeSingle: async () => ({ data: null, error: null }),
                    }),
                  }),
                }),
              }),
            }),
          }),
        };
      }
      if (table === "workspace_questions") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                select: async () => ({ count: 0, error: null }),
              }),
            }),
          }),
        };
      }
      if (table === "gsc_connections") {
        return {
          select: () => ({
            eq: () => ({
              limit: () => ({
                maybeSingle: async () => ({ data: null, error: null }),
              }),
            }),
          }),
        };
      }
      if (table === "question_settings") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: null, error: null }),
            }),
          }),
        };
      }
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: null, error: null }),
          }),
        }),
      };
    },
  };
}

test("GET /api/customer/onboarding - flag off returns enabled: false", async () => {
  const req = new Request("http://localhost/api/customer/onboarding");
  const res = await getOnboardingStateRoute(req, undefined, {
    isFeatureEnabled: async () => false,
  });

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.deepEqual(data, { enabled: false });
});

test("GET /api/customer/onboarding - AC-07 prefill with scan & domain never contains question text", async () => {
  const req = new Request(
    `http://localhost/api/customer/onboarding?scan=${fixtureScan.id}&domain=acme.example`,
  );
  const admin = createMockAdmin();

  const res = await getOnboardingStateRoute(req, undefined, {
    isFeatureEnabled: async () => true,
    requireUser: async () => ({
      user: { id: "user-1", email: "user@example.com" },
      admin,
    }),
  });

  assert.equal(res.status, 200);
  const text = await res.text();
  const data = JSON.parse(text);

  assert.equal(data.enabled, true);
  assert.ok(data.prefill);
  assert.equal(data.prefill.website, "https://acme.example");
  assert.equal(data.prefill.brandName, "Acme");
  assert.equal(data.prefill.questionCount, 24);

  // Assert no fixture question text leaked into JSON
  for (const r of fixtureScan.raw_results.results) {
    if (r.query && r.query.length > 10) {
      assert.ok(!text.includes(r.query), `Response must not leak question text: ${r.query}`);
    }
  }
});

test("GET /api/customer/onboarding - AC-07 domain alone prefill returns questionCount 0 and brandName null", async () => {
  const req = new Request("http://localhost/api/customer/onboarding?domain=acme.example");
  const admin = createMockAdmin();

  const res = await getOnboardingStateRoute(req, undefined, {
    isFeatureEnabled: async () => true,
    requireUser: async () => ({
      user: { id: "user-1", email: "user@example.com" },
      admin,
    }),
  });

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(data.prefill);
  assert.equal(data.prefill.website, "https://acme.example");
  assert.equal(data.prefill.brandName, null);
  assert.equal(data.prefill.questionCount, 0);
});

test("POST /api/customer/onboarding/step - step hidden returns 400 step_hidden", async () => {
  const req = new Request("http://localhost/api/customer/onboarding/step", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ step: "analytics", status: "done" }),
  });

  const res = await postOnboardingStepRoute(req, undefined, {
    isFeatureEnabled: async (flag) => {
      if (flag === "onboarding_wizard") return true;
      if (flag === "ga4") return false;
      return false;
    },
    requireUser: async () => ({
      user: { id: "user-1" },
      admin: createMockAdmin(),
    }),
    getGa4ConnectionState: async () => ({ available: false, connected: false }),
  });

  assert.equal(res.status, 400);
  const data = await res.json();
  assert.equal(data.code, "step_hidden");
});

test("POST /api/customer/onboarding/step - AC-08 records done for visible step", async () => {
  const req = new Request("http://localhost/api/customer/onboarding/step", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ step: "search_console", status: "done" }),
  });

  let recorded = null;
  const res = await postOnboardingStepRoute(req, undefined, {
    isFeatureEnabled: async () => true,
    requireUser: async () => ({
      user: { id: "user-1" },
      admin: createMockAdmin(),
    }),
    recordStep: async (_adm, userId, step, status) => {
      recorded = { userId, step, status };
      return {
        steps: {
          website: { status: "done", at: "2026-11-10T00:00:00Z" },
          search_console: { status: "done", at: "2026-11-10T00:05:00Z" },
        },
      };
    },
  });

  assert.equal(res.status, 200);
  assert.deepEqual(recorded, {
    userId: "user-1",
    step: "search_console",
    status: "done",
  });
  const data = await res.json();
  assert.equal(data.steps.search_console.status, "done");
});

test("POST /api/customer/onboarding/complete - AC-08 completes onboarding idempotently", async () => {
  const req1 = new Request("http://localhost/api/customer/onboarding/complete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ via: "wizard" }),
  });

  let completeCallCount = 0;
  const firstCompletedAt = "2026-11-10T12:00:00.000Z";

  const res1 = await postOnboardingCompleteRoute(req1, undefined, {
    isFeatureEnabled: async () => true,
    requireUser: async () => ({
      user: { id: "user-1" },
      admin: createMockAdmin(),
    }),
    completeOnboarding: async (_adm, _userId, via) => {
      completeCallCount++;
      return {
        completedAt: firstCompletedAt,
        via,
        workspace: { brandKey: "brand-123" },
        handoff: null,
      };
    },
  });

  assert.equal(res1.status, 200);
  const data1 = await res1.json();
  assert.equal(data1.completedAt, firstCompletedAt);
  assert.equal(data1.via, "wizard");
  assert.equal(data1.destination, "/portal");

  // Second complete call retains first completedAt
  const req2 = new Request("http://localhost/api/customer/onboarding/complete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ via: "skipped" }),
  });

  const res2 = await postOnboardingCompleteRoute(req2, undefined, {
    isFeatureEnabled: async () => true,
    requireUser: async () => ({
      user: { id: "user-1" },
      admin: createMockAdmin(),
    }),
    completeOnboarding: async (_adm, _userId, _via) => {
      completeCallCount++;
      // Service returns original completedAt and original via
      return {
        completedAt: firstCompletedAt,
        via: "wizard",
        workspace: { brandKey: "brand-123" },
        handoff: null,
      };
    },
  });

  assert.equal(res2.status, 200);
  const data2 = await res2.json();
  assert.equal(data2.completedAt, firstCompletedAt);
  assert.equal(data2.via, "wizard");
  assert.equal(completeCallCount, 2);
});

/**
 * F10 Phase 3 route test: GET and PUT /api/customer/schedule.
 *
 * Covers F10-AC-04, 05, 12:
 *   - GET states: off, on, paused, operator
 *   - skip messages and last 10 windows
 *   - PUT enable (owner) with approval -> row fields and approval source 'schedule'
 *   - member enable -> 403 owner_required
 *   - member pause -> 200
 *   - no maxUsd -> 400 approval_required
 *   - low maxUsd -> 409 price_changed
 *   - blocked panel -> 409
 *   - operator-active -> 409 operator_schedule_active
 *   - unchanged slot kept
 *   - flag off -> 404 feature_unavailable
 */
import test from "node:test";
import assert from "node:assert/strict";
import { AppError } from "../../shared/http/errors.ts";

const ROUTE = await import(new URL("../../app/api/customer/schedule/route.ts", import.meta.url).href);

const BRAND_KEY = "offcult.in";
const USER_OWNER = { id: "user-owner-1", email: "owner@example.test" };
const USER_MEMBER = { id: "user-member-1", email: "member@example.test" };

function makeCustomerBrand(role = "owner") {
  return {
    brandKey: BRAND_KEY,
    role,
    display_name: "Offcult",
    website: "https://offcult.in",
    website_host: "offcult.in",
    aliases: [],
    is_active: true,
  };
}

function makeMockAdmin(initial = {}) {
  let scheduleRow = initial.schedule ?? null;
  let windowsRows = initial.windows ?? [];
  let approvalsRows = initial.approvals ?? [];

  return {
    getSchedule: () => scheduleRow,
    getApprovals: () => approvalsRows,
    from: (table) => {
      let filterCol;
      let filterVal;
      let orderCol;
      let limitCount = null;
      let updatePayload = null;

      const builder = {
        select: (_cols) => builder,
        eq: (col, val) => {
          filterCol = col;
          filterVal = val;
          return builder;
        },
        order: (col, _opts) => {
          orderCol = col;
          return builder;
        },
        limit: (n) => {
          limitCount = n;
          return builder;
        },
        maybeSingle: async () => {
          if (table === "scan_schedules") {
            return { data: scheduleRow, error: null };
          }
          if (table === "price_approvals") {
            const found = approvalsRows.find((a) => a.id === filterVal);
            return { data: found ?? null, error: null };
          }
          return { data: null, error: null };
        },
        then: (resolve) => {
          if (table === "measurement_windows") {
            let res = [...windowsRows];
            if (limitCount !== null) res = res.slice(0, limitCount);
            resolve({ data: res, error: null });
            return;
          }
          resolve({ data: [], error: null });
        },
        upsert: async (payload) => {
          scheduleRow = { ...scheduleRow, ...payload };
          return { data: scheduleRow, error: null };
        },
        update: (payload) => {
          updatePayload = payload;
          return {
            eq: async (_col, _val) => {
              if (scheduleRow) {
                scheduleRow = { ...scheduleRow, ...updatePayload };
              }
              return { data: scheduleRow, error: null };
            },
          };
        },
        insert: (payload) => {
          const rowWithId = { id: `app-${approvalsRows.length + 1}`, created_at: new Date().toISOString(), ...payload };
          approvalsRows.push(rowWithId);
          return {
            select: () => ({
              single: async () => ({ data: rowWithId, error: null }),
            }),
          };
        },
      };
      return builder;
    },
  };
}

function makeDeps(over = {}) {
  const role = over.role ?? "owner";
  const user = role === "owner" ? USER_OWNER : USER_MEMBER;
  const mockAdmin = over.admin ?? makeMockAdmin();

  return {
    getCustomerContext: async () => ({
      client: null,
      user,
      brands: [makeCustomerBrand(role)],
      error: null,
    }),
    getSupabaseAdmin: () => mockAdmin,
    isFeatureEnabled: async () => true,
    env: {},
    now: () => new Date("2026-10-21T09:30:00.000Z"),
    ...over,
  };
}

function makeGetRequest(brandKey = BRAND_KEY) {
  const url = brandKey ? `http://localhost/api/customer/schedule?brand_key=${brandKey}` : "http://localhost/api/customer/schedule";
  return new Request(url, { method: "GET" });
}

function makePutRequest(body) {
  return new Request("http://localhost/api/customer/schedule", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("flag off -> 404 feature_unavailable for GET and PUT", async () => {
  const deps = makeDeps({ isFeatureEnabled: async () => false });

  const getRes = await ROUTE.GET(makeGetRequest(), {}, deps);
  assert.equal(getRes.status, 404);
  const getBody = await getRes.json();
  assert.equal(getBody.code, "feature_unavailable");

  const putRes = await ROUTE.PUT(makePutRequest({ enabled: false }), {}, deps);
  assert.equal(putRes.status, 404);
  const putBody = await putRes.json();
  assert.equal(putBody.code, "feature_unavailable");
});

test("GET states: off when no row exists", async () => {
  const deps = makeDeps();
  const res = await ROUTE.GET(makeGetRequest(), {}, deps);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, "off");
  assert.equal(body.interval, null);
  assert.equal(body.windows.length, 0);
});

test("GET states: on, paused, operator with skip messages and last 10 windows", async () => {
  const pastWindows = [
    { window_at: "2026-10-20T03:30:00.000Z", disposition: "finalized", finalized_at: "2026-10-20T03:58:00.000Z", reason: null, job_id: "00000000-0000-0000-0000-000000000001" },
    { window_at: "2026-10-13T03:30:00.000Z", disposition: "blocked", reason: "price_changed", job_id: null },
  ];

  // 1. Customer on
  const adminOn = makeMockAdmin({
    schedule: {
      brand: BRAND_KEY,
      managed_by: "customer",
      enabled: true,
      schedule_interval: "weekly",
      schedule_time: { weekday: 1, hour: 9, minute: 0, timeZone: "Asia/Kolkata" },
      next_run_at: "2026-10-27T03:30:00.000Z",
      last_run_at: "2026-10-20T03:30:00.000Z",
      last_skip_reason: "price_changed",
      last_skip_at: "2026-10-13T03:30:00.000Z",
      approved_max_usd: 24,
    },
    windows: pastWindows,
  });

  const resOn = await ROUTE.GET(makeGetRequest(), {}, makeDeps({ admin: adminOn }));
  assert.equal(resOn.status, 200);
  const bodyOn = await resOn.json();
  assert.equal(bodyOn.status, "on");
  assert.equal(bodyOn.interval, "weekly");
  assert.ok(bodyOn.lastSkip);
  assert.equal(bodyOn.lastSkip.reason, "price_changed");
  assert.equal(bodyOn.lastSkip.message, "The scan now costs more than you approved. Review the new price to resume.");
  assert.equal(bodyOn.lastCompletedAt, "2026-10-20T03:58:00.000Z");
  assert.equal(bodyOn.windows.length, 2);
  assert.equal(bodyOn.windows[1].message, "The scan now costs more than you approved. Review the new price to resume.");

  // 2. Customer paused
  const adminPaused = makeMockAdmin({
    schedule: {
      brand: BRAND_KEY,
      managed_by: "customer",
      enabled: false,
      schedule_interval: "weekly",
      approved_max_usd: 24,
    },
  });
  const resPaused = await ROUTE.GET(makeGetRequest(), {}, makeDeps({ admin: adminPaused }));
  const bodyPaused = await resPaused.json();
  assert.equal(bodyPaused.status, "paused");

  // 3. Operator active
  const adminOp = makeMockAdmin({
    schedule: {
      brand: BRAND_KEY,
      managed_by: "operator",
      enabled: true,
      cadence: "72h",
    },
  });
  const resOp = await ROUTE.GET(makeGetRequest(), {}, makeDeps({ admin: adminOp }));
  const bodyOp = await resOp.json();
  assert.equal(bodyOp.status, "operator");
});

test("PUT enable: member enable -> 403 owner_required", async () => {
  const deps = makeDeps({ role: "member" });
  const res = await ROUTE.PUT(makePutRequest({ enabled: true, interval: "weekly", maxUsd: 24 }), {}, deps);
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.code, "owner_required");
});

test("PUT enable: no maxUsd -> 400 approval_required", async () => {
  const deps = makeDeps({ role: "owner" });
  const res = await ROUTE.PUT(makePutRequest({ enabled: true, interval: "weekly" }), {}, deps);
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.code, "approval_required");
});

test("PUT enable: low maxUsd -> 409 price_changed", async () => {
  const deps = makeDeps({
    role: "owner",
    requireApprovedPrice: async () => {
      throw new AppError(409, "price_changed", "Price changed", { details: { quote: { totalUsd: 30 } } });
    },
  });

  const res = await ROUTE.PUT(makePutRequest({ enabled: true, interval: "weekly", maxUsd: 20 }), {}, deps);
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.code, "price_changed");
});

test("PUT enable: blocked panel -> 409 panel_not_approved", async () => {
  const deps = makeDeps({
    role: "owner",
    requireApprovedPrice: async () => {
      throw new AppError(409, "panel_not_approved", "Panel not approved");
    },
  });

  const res = await ROUTE.PUT(makePutRequest({ enabled: true, interval: "weekly", maxUsd: 25 }), {}, deps);
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.code, "panel_not_approved");
});

test("PUT enable: operator-active -> 409 operator_schedule_active", async () => {
  const admin = makeMockAdmin({
    schedule: {
      brand: BRAND_KEY,
      managed_by: "operator",
      enabled: true,
    },
  });
  const deps = makeDeps({ role: "owner", admin });

  const res = await ROUTE.PUT(makePutRequest({ enabled: true, interval: "weekly", maxUsd: 25 }), {}, deps);
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.code, "operator_schedule_active");
});

test("PUT enable: success records approval source 'schedule' and updates row", async () => {
  const admin = makeMockAdmin();
  let approvalRecorded = null;

  const fakeQuote = {
    action: "ai_visibility.schedule.save",
    totalUsd: 20,
    expectedUsd: 15,
    monthly: { interval: "weekly", runsPerMonth: 4, totalUsd: 80 },
    warnings: [],
    blocked: null,
    units: [],
    lines: [],
  };

  const deps = makeDeps({
    role: "owner",
    admin,
    requireApprovedPrice: async () => ({
      quote: fakeQuote,
      approvedMaxUsd: 25,
      source: "schedule",
    }),
    recordApproval: async (_admin, a) => {
      approvalRecorded = a;
      return "00000000-0000-0000-0000-000000000099";
    },
  });

  const res = await ROUTE.PUT(
    makePutRequest({
      enabled: true,
      interval: "weekly",
      scheduleTime: { weekday: 1, hour: 9, minute: 0, timeZone: "Asia/Kolkata" },
      maxUsd: 25,
    }),
    {},
    deps,
  );

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, "on");
  assert.equal(body.interval, "weekly");
  assert.equal(body.approvedMaxUsd, 25);

  assert.ok(approvalRecorded);
  assert.equal(approvalRecorded.source, "schedule");
  assert.equal(approvalRecorded.subject.kind, "scan_schedule");
  assert.equal(approvalRecorded.subject.id, BRAND_KEY);
  assert.equal(approvalRecorded.approvedMaxUsd, 25);

  const row = admin.getSchedule();
  assert.equal(row.managed_by, "customer");
  assert.equal(row.enabled, true);
  assert.equal(row.schedule_interval, "weekly");
  assert.equal(row.approval_id, "00000000-0000-0000-0000-000000000099");
});

test("PUT enable: unchanged slot is kept when already in the future", async () => {
  const existingNext = "2026-10-27T03:30:00.000Z";
  const admin = makeMockAdmin({
    schedule: {
      brand: BRAND_KEY,
      managed_by: "customer",
      enabled: true,
      schedule_interval: "weekly",
      schedule_time: { weekday: 1, hour: 9, minute: 0, timeZone: "Asia/Kolkata" },
      next_run_at: existingNext,
      approved_max_usd: 25,
    },
  });

  const deps = makeDeps({
    role: "owner",
    admin,
    now: () => new Date("2026-10-21T00:00:00.000Z"),
    requireApprovedPrice: async () => ({
      quote: { totalUsd: 20 },
      approvedMaxUsd: 25,
    }),
    recordApproval: async () => "app-new",
  });

  const res = await ROUTE.PUT(
    makePutRequest({
      enabled: true,
      interval: "weekly",
      scheduleTime: { weekday: 1, hour: 9, minute: 0, timeZone: "Asia/Kolkata" },
      maxUsd: 25,
    }),
    {},
    deps,
  );

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.nextRunAt, existingNext);
});

test("PUT member pause: 200 and sets enabled false", async () => {
  const admin = makeMockAdmin({
    schedule: {
      brand: BRAND_KEY,
      managed_by: "customer",
      enabled: true,
      schedule_interval: "weekly",
      next_run_at: "2026-10-27T03:30:00.000Z",
      approved_max_usd: 25,
    },
  });

  const deps = makeDeps({ role: "member", admin });
  const res = await ROUTE.PUT(makePutRequest({ enabled: false }), {}, deps);

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, "paused");
  assert.equal(admin.getSchedule().enabled, false);
});

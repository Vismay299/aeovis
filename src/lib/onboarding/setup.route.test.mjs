import test from "node:test";
import assert from "node:assert/strict";
import { GET as getSetupRoute } from "../../app/api/customer/setup/route.ts";
import { POST as postDismissRoute } from "../../app/api/customer/setup/dismiss/route.ts";
import { getSetupActivation, setDismissed } from "./setup.ts";

function createMockDb(tables = {}) {
  return {
    from(tableName) {
      const rows = tables[tableName] ?? [];
      return {
        select(cols, opts) {
          if (opts?.count === "exact" && opts?.head) {
            return {
              eq(col, val) {
                const count = rows.filter((r) => r[col] === val).length;
                return {
                  eq(col2, val2) {
                    const count2 = rows.filter((r) => r[col] === val && r[col2] === val2).length;
                    return Promise.resolve({ count: count2, error: null });
                  },
                  then(resolve) {
                    return resolve({ count, error: null });
                  },
                };
              },
            };
          }
          return {
            eq(col, val) {
              const filtered = rows.filter((r) => r[col] === val);
              return {
                eq(col2, val2) {
                  const filtered2 = filtered.filter((r) => r[col2] === val2);
                  return {
                    eq(col3, val3) {
                      const filtered3 = filtered2.filter((r) => r[col3] === val3);
                      return {
                        eq(col4, val4) {
                          const filtered4 = filtered3.filter((r) => r[col4] === val4);
                          return {
                            limit: () => ({
                              maybeSingle: async () => ({ data: filtered4[0] ?? null, error: null }),
                            }),
                          };
                        },
                        limit: () => ({
                          maybeSingle: async () => ({ data: filtered3[0] ?? null, error: null }),
                        }),
                      };
                    },
                    then(resolve) {
                      return resolve({ data: filtered2, error: null });
                    },
                    limit: () => ({
                      maybeSingle: async () => ({ data: filtered2[0] ?? null, error: null }),
                    }),
                  };
                },
                limit: () => ({
                  maybeSingle: async () => ({ data: filtered[0] ?? null, error: null }),
                }),
                then(resolve) {
                  return resolve({ data: filtered, error: null });
                },
              };
            },
            or(condition) {
              return {
                eq() {
                  return {
                    eq() {
                      return {
                        limit: () => ({
                          maybeSingle: async () => ({
                            data: rows.find((r) => r.enabled && r.managed_by === "customer") ?? null,
                            error: null,
                          }),
                        }),
                      };
                    },
                  };
                },
              };
            },
            limit: () => ({
              maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
            }),
          };
        },
        upsert: async (row) => {
          if (!tables[tableName]) tables[tableName] = [];
          const idx = tables[tableName].findIndex(
            (r) => r.user_id === row.user_id && r.brand_key === row.brand_key && r.step === row.step,
          );
          if (idx >= 0) tables[tableName][idx] = row;
          else tables[tableName].push(row);
          return { data: row, error: null };
        },
        delete() {
          return {
            eq(c1, v1) {
              return {
                eq(c2, v2) {
                  return {
                    eq(c3, v3) {
                      if (tables[tableName]) {
                        tables[tableName] = tables[tableName].filter(
                          (r) => !(r[c1] === v1 && r[c2] === v2 && r[c3] === v3),
                        );
                      }
                      return Promise.resolve({ data: null, error: null });
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
  };
}

test("GET /api/customer/setup - flag off returns 404 feature_unavailable", async () => {
  const req = new Request("http://localhost/api/customer/setup");
  const res = await getSetupRoute(req, undefined, {
    isFeatureEnabled: async () => false,
    requireWorkspace: async () => ({
      brandKey: "brand-1",
      role: "owner",
      admin: {},
      user: { id: "u-1" },
    }),
  });

  assert.equal(res.status, 404);
  const data = await res.json();
  assert.equal(data.code, "feature_unavailable");
});

test("GET /api/customer/setup - computes each row from data sources", async () => {
  const tables = {
    repair_artifacts: [
      { brand: "brand-1", kind: "panel", artifact_key: "default", state: "approved" },
    ],
    scans: [{ brand_key: "brand-1", id: "scan-1" }],
    gsc_connections: [{ brand_key: "brand-1", enabled: true }],
    site_audits: [{ brand_key: "brand-1", id: "audit-1" }],
    scan_schedules: [{ brand: "brand-1", managed_by: "customer", enabled: true }],
    ga4_connections: [{ brand_key: "brand-1" }],
    content_items: [{ brand: "brand-1", id: "item-1" }],
    customer_brand_memberships: [
      { brand_key: "brand-1", user_id: "u-1" },
      { brand_key: "brand-1", user_id: "u-2" },
    ],
    customer_team_invites: [],
    workspace_setup_dismissals: [],
  };

  const db = createMockDb(tables);
  const ws = {
    brandKey: "brand-1",
    role: "owner",
    admin: db,
    user: { id: "u-1" },
  };

  const req = new Request("http://localhost/api/customer/setup");
  const res = await getSetupRoute(req, undefined, {
    isFeatureEnabled: async () => true,
    requireWorkspace: async () => ws,
  });

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.brandKey, "brand-1");

  // All 8 steps should be done
  const stepMap = Object.fromEntries(data.steps.map((s) => [s.id, s.status]));
  assert.equal(stepMap.questions, "done");
  assert.equal(stepMap.scan, "done");
  assert.equal(stepMap.gsc, "done");
  assert.equal(stepMap.audit, "done");
  assert.equal(stepMap.schedule, "done");
  assert.equal(stepMap.ga4, "done");
  assert.equal(stepMap.draft, "done");
  assert.equal(stepMap.team, "done");
});

test("GET /api/customer/setup - member response omits team step", async () => {
  const db = createMockDb();
  const ws = {
    brandKey: "brand-1",
    role: "member",
    admin: db,
    user: { id: "u-2" },
  };

  const req = new Request("http://localhost/api/customer/setup");
  const res = await getSetupRoute(req, undefined, {
    isFeatureEnabled: async () => true,
    requireWorkspace: async () => ws,
  });

  assert.equal(res.status, 200);
  const data = await res.json();
  const stepIds = data.steps.map((s) => s.id);
  assert.ok(!stepIds.includes("team"), "Member response must omit team step");
});

test("GET /api/customer/setup - missing optional table (42P01) maps to step not done", async () => {
  const db = {
    from(tableName) {
      if (tableName === "site_audits") {
        return {
          select() {
            return {
              eq() {
                return {
                  limit: () => ({
                    maybeSingle: async () => {
                      const err = new Error("relation \"site_audits\" does not exist");
                      err.code = "42P01";
                      throw err;
                    },
                  }),
                };
              },
            };
          },
        };
      }
      return createMockDb().from(tableName);
    },
  };

  const ws = {
    brandKey: "brand-1",
    role: "owner",
    admin: db,
    user: { id: "u-1" },
  };

  const req = new Request("http://localhost/api/customer/setup");
  const res = await getSetupRoute(req, undefined, {
    isFeatureEnabled: async () => true,
    requireWorkspace: async () => ws,
  });

  assert.equal(res.status, 200);
  const data = await res.json();
  const auditStep = data.steps.find((s) => s.id === "audit");
  assert.equal(auditStep.status, "todo");
});

test("POST /api/customer/setup/dismiss - dismiss inserts then restore deletes", async () => {
  const tables = {
    workspace_setup_dismissals: [],
  };
  const db = createMockDb(tables);
  const ws = {
    brandKey: "brand-1",
    role: "owner",
    admin: db,
    user: { id: "u-1" },
  };

  // 1. Dismiss step "scan"
  const reqDismiss = new Request("http://localhost/api/customer/setup/dismiss", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ step: "scan", dismissed: true }),
  });

  const resDismiss = await postDismissRoute(reqDismiss, undefined, {
    isFeatureEnabled: async () => true,
    requireWorkspace: async () => ws,
  });

  assert.equal(resDismiss.status, 200);
  const dataDismiss = await resDismiss.json();
  const scanDismissed = dataDismiss.steps.find((s) => s.id === "scan");
  assert.equal(scanDismissed.status, "skipped");
  assert.equal(tables.workspace_setup_dismissals.length, 1);

  // 2. Restore step "scan"
  const reqRestore = new Request("http://localhost/api/customer/setup/dismiss", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ step: "scan", dismissed: false }),
  });

  const resRestore = await postDismissRoute(reqRestore, undefined, {
    isFeatureEnabled: async () => true,
    requireWorkspace: async () => ws,
  });

  assert.equal(resRestore.status, 200);
  const dataRestore = await resRestore.json();
  const scanRestored = dataRestore.steps.find((s) => s.id === "scan");
  assert.equal(scanRestored.status, "todo");
  assert.equal(tables.workspace_setup_dismissals.length, 0);
});

test("POST /api/customer/setup/dismiss - dismissing in workspace A leaves B untouched", async () => {
  const tables = {
    workspace_setup_dismissals: [],
  };
  const db = createMockDb(tables);

  const wsA = {
    brandKey: "workspace-A",
    role: "owner",
    admin: db,
    user: { id: "u-1" },
  };

  const wsB = {
    brandKey: "workspace-B",
    role: "owner",
    admin: db,
    user: { id: "u-1" },
  };

  // Dismiss in workspace A
  const reqA = new Request("http://localhost/api/customer/setup/dismiss", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ step: "gsc", dismissed: true }),
  });

  await postDismissRoute(reqA, undefined, {
    isFeatureEnabled: async () => true,
    requireWorkspace: async () => wsA,
  });

  // Query workspace B
  const reqB = new Request("http://localhost/api/customer/setup");
  const resB = await getSetupRoute(reqB, undefined, {
    isFeatureEnabled: async () => true,
    requireWorkspace: async () => wsB,
  });

  assert.equal(resB.status, 200);
  const dataB = await resB.json();
  const gscInB = dataB.steps.find((s) => s.id === "gsc");
  assert.equal(gscInB.status, "todo", "Workspace B must not be skipped");
});

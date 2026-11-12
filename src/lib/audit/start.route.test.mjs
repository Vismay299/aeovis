import test from "node:test";
import assert from "node:assert/strict";
import { GET, POST } from "../../app/api/customer/audit/route.ts";
import { AppError } from "../http/appError.ts";
import { SpendRefused } from "../spend/errors.ts";
import { SsrfBlockedError } from "../ssrfGuard.js";

const auditId = "6f1d2c3b-0a4e-4b8f-9c1d-2e3f4a5b6c7d";
const jobId = "0c2a4b1e-8d1f-4f35-9b5e-2e0c6f1a7d90";
const workspace = {
  user: { id: "user-1", email: "owner@example.com" }, brandKey: "brand-1", role: "owner",
  brand: { brandKey: "brand-1", role: "owner", display_name: "Example", website: "https://example.com/", website_host: "example.com", aliases: [], is_active: true }, admin: {},
};
function request(body = {}, headers = {}) {
  return new Request("https://app.example/api/customer/audit", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
}
function deps(over = {}) {
  return { requireWorkspace: async () => workspace, isFeatureEnabled: async () => true,
    startSiteAudit: async () => ({ auditId, jobId, status: "queued", pollAfterSeconds: 3, approvedMaxUsd: 0.35 }), ...over };
}

function createMemoryAuditAdmin(options = {}) {
  const state = { audits: new Map(options.audits ?? []), approvals: [], calls: [], createResult: options.createResult ?? null };
  function builder(table) {
    const q = { table, operation: "select", filters: [], selected: "*", patch: null, inserted: null, rowLimit: null };
    const api = {
      select(columns = "*") { q.selected = columns; return this; },
      eq(field, value) { q.filters.push(["eq", field, value]); return this; },
      neq(field, value) { q.filters.push(["neq", field, value]); return this; },
      in(field, values) { q.filters.push(["in", field, values]); return this; },
      limit(value) { q.rowLimit = value; return this; },
      update(patch) { q.operation = "update"; q.patch = patch; return this; },
      delete() { q.operation = "delete"; return this; },
      insert(value) { q.operation = "insert"; q.inserted = value; return this; },
      async maybeSingle() { const result = await this.execute(); return { data: result.data[0] ?? null, error: result.error }; },
      async single() { const result = await this.execute(); return { data: result.data[0] ?? null, error: result.error }; },
      async execute() {
        const rows = table === "site_audits" ? Array.from(state.audits.values()) : table === "price_approvals" ? state.approvals : [];
        const matches = (row) => q.filters.every(([op, field, value]) => op === "eq" ? row[field] === value : op === "neq" ? row[field] !== value : value.includes(row[field]));
        if (q.operation === "insert") {
          if (table === "price_approvals") {
            const row = { ...q.inserted, id: "approval-1" };
            state.approvals.push(row);
            state.calls.push(["approval", row.action]);
            return { data: [row], error: null };
          }
        }
        if (q.operation === "update") {
          const touched = rows.filter(matches);
          for (const row of touched) Object.assign(row, q.patch);
          state.calls.push(["update", table, { ...q.patch }]);
          return { data: touched, error: null };
        }
        if (q.operation === "delete") {
          const touched = rows.filter(matches);
          if (table === "site_audits") for (const row of touched) state.audits.delete(row.id);
          state.calls.push(["delete", table, touched.map((row) => row.id)]);
          return { data: touched, error: null };
        }
        let result = rows.filter(matches);
        if (q.rowLimit !== null) result = result.slice(0, q.rowLimit);
        return { data: result, error: null };
      },
      then(resolve, reject) { return this.execute().then(resolve, reject); },
    };
    return api;
  }
  const admin = {
    from: builder,
    async rpc(name, args) {
      state.calls.push(["rpc", name]);
      if (name !== "site_audit_create") throw new Error(`unexpected RPC ${name}`);
      if (state.createResult) return { data: state.createResult, error: null };
      const row = {
        id: args.p_id, brand_key: args.p_brand_key, started_by: args.p_started_by, trigger: args.p_trigger,
        requested_url: args.p_requested_url, start_url: args.p_start_url, start_host: args.p_start_host,
        max_pages: args.p_max_pages, run_lighthouse: args.p_lighthouse, render_javascript: args.p_render,
        status: "queued", current_phase: "queued", created_at: "2026-11-01T00:00:00.000Z", job_id: null,
      };
      state.audits.set(row.id, row);
      return { data: { created: true, used: args.p_max_pages, cap: args.p_monthly_cap }, error: null };
    },
  };
  return { admin, state };
}

function actualStartDeps(options = {}) {
  const { admin, state } = createMemoryAuditAdmin({ audits: options.audits, createResult: options.createResult });
  const featureCalls = [];
  const spendCalls = [];
  const released = [];
  const enqueued = [];
  const env = {
    SITE_AUDIT_MAX_PAGES: options.maxPagesLimit === undefined ? "10000" : String(options.maxPagesLimit),
    SITE_AUDIT_MONTHLY_PAGES: "50000",
    FIRECRAWL_SCRAPE_USD: "0.005",
    ...(options.renderConfigured ? { FIRECRAWL_API_KEY: "configured" } : {}),
  };
  const startDeps = {
    env,
    uuid: () => auditId,
    isFeatureEnabled: async (name) => { featureCalls.push(name); return options.disabledFeature !== name; },
    assertPublicUrl: async (url) => {
      state.calls.push(["ssrf", url]);
      if (options.ssrfError) throw options.ssrfError;
    },
    reserveSpend: async (input) => {
      state.calls.push(["reserve", input.feature, input.idempotencyKey]);
      spendCalls.push(input);
      if (options.spendError) throw options.spendError;
      return { holdId: "hold-1", existing: false };
    },
    releaseSpend: async (holdId, reason) => { state.calls.push(["release", holdId, reason]); released.push([holdId, reason]); return true; },
    enqueueJob: async (kind, payload, input) => {
      state.calls.push(["enqueue", kind]);
      enqueued.push([kind, payload, input]);
      if (options.enqueueError) throw options.enqueueError;
      return { jobId, deduped: false };
    },
    captureAuditEvent: async (name, props) => { state.calls.push(["event", name, props]); },
  };
  const depsForRoute = deps({
    requireWorkspace: async () => ({ ...workspace, admin }),
    // The route checks its own API flag first; the actual service has its own injected flag check.
    isFeatureEnabled: async () => true,
    startSiteAudit: undefined,
    startDeps,
  });
  return { admin, state, featureCalls, spendCalls, released, enqueued, env, startDeps, depsForRoute };
}

test("POST /api/customer/audit returns the 202 queue contract", async () => {
  const response = await POST(request({ maxPages: 50, lighthouse: true, maxUsd: 0.35 }), undefined, deps());
  assert.equal(response.status, 202);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { auditId, jobId, status: "queued", pollAfterSeconds: 3, approvedMaxUsd: 0.35 });
});

test("feature-off and malformed bodies use the specified errors", async () => {
  const off = await POST(request(), undefined, deps({ isFeatureEnabled: async () => false }));
  assert.equal(off.status, 404);
  assert.equal((await off.json()).code, "feature_unavailable");
  const listOff = await GET(new Request("https://app.example/api/customer/audit"), undefined, deps({ isFeatureEnabled: async () => false }));
  assert.equal(listOff.status, 404);
  assert.equal((await listOff.json()).code, "feature_unavailable");
  const invalid = await POST(request("not-json"), undefined, deps());
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).code, "invalid_json");
  const extra = await POST(request({ surprise: true }), undefined, deps());
  assert.equal(extra.status, 400);
  assert.equal((await extra.json()).code, "invalid_request");
});

test("POST preserves the exact status and code for every service refusal", async () => {
  const errors = [
    [404, "feature_unavailable"], [403, "feature_disabled"], [503, "render_unavailable"],
    [422, "page_limit"], [422, "render_page_limit"], [422, "invalid_url"], [422, "audit_host_not_owned"],
    [422, "url_blocked"], [422, "url_unreachable"], [400, "approval_required"], [409, "price_changed"],
    [409, "audit_already_running"], [409, "host_busy"], [409, "audit_capacity_reached"],
    [402, "daily_cap"], [402, "workspace_cap"], [409, "job_already_running"], [503, "spend_unavailable"],
  ];
  for (const [status, code] of errors) {
    const response = await POST(request(), undefined, deps({ startSiteAudit: async () => { throw new AppError(status, code, `refused ${code}`); } }));
    const body = await response.json();
    assert.equal(response.status, status, code);
    assert.equal(body.code, code, code);
  }
});

test("actual start service enforces ownership, configured page limits and SSRF without external calls", async () => {
  const outside = actualStartDeps();
  const outsideResponse = await POST(request({ startUrl: "https://other.example/" }), undefined, outside.depsForRoute);
  assert.equal(outsideResponse.status, 422);
  assert.equal((await outsideResponse.json()).code, "audit_host_not_owned");
  assert.equal(outside.state.calls.some((call) => call[0] === "ssrf"), false);

  const limited = actualStartDeps({ maxPagesLimit: 20 });
  const limitResponse = await POST(request({ maxPages: 50 }), undefined, limited.depsForRoute);
  assert.equal(limitResponse.status, 422);
  assert.equal((await limitResponse.json()).code, "page_limit");
  assert.equal(limited.state.calls.some((call) => call[0] === "rpc"), false);

  const blocked = actualStartDeps({ ssrfError: new SsrfBlockedError("blocked fixture", { code: "loopback" }) });
  const blockedResponse = await POST(request({ startUrl: "https://example.com/" }), undefined, blocked.depsForRoute);
  assert.equal(blockedResponse.status, 422);
  assert.equal((await blockedResponse.json()).code, "url_blocked");
  assert.equal(blocked.state.calls.some((call) => call[0] === "rpc"), false);

  const unreachable = actualStartDeps({ ssrfError: new SsrfBlockedError("unreachable fixture", { code: "dns_failed" }) });
  const unreachableResponse = await POST(request({ startUrl: "https://example.com/" }), undefined, unreachable.depsForRoute);
  assert.equal(unreachableResponse.status, 422);
  assert.equal((await unreachableResponse.json()).code, "url_unreachable");
});

test("actual start service uses the priced action approval and writes its approval record", async () => {
  const approval = actualStartDeps();
  const needsApproval = await POST(request({ lighthouse: true }), undefined, approval.depsForRoute);
  assert.equal(needsApproval.status, 400);
  const required = await needsApproval.json();
  assert.equal(required.code, "approval_required");
  assert.equal(required.details.quote.totalUsd, 0.1);
  assert.equal(approval.state.calls.some((call) => call[0] === "rpc"), false);

  const changed = actualStartDeps();
  const priceChanged = await POST(request({ lighthouse: true, maxUsd: 0.05 }), undefined, changed.depsForRoute);
  assert.equal(priceChanged.status, 409);
  assert.equal((await priceChanged.json()).code, "price_changed");

  const accepted = actualStartDeps();
  const response = await POST(request({ lighthouse: true, maxUsd: 0.1 }), undefined, accepted.depsForRoute);
  assert.equal(response.status, 202);
  assert.equal((await response.json()).approvedMaxUsd, 0.1);
  assert.equal(accepted.state.approvals.length, 1);
  assert.equal(accepted.state.approvals[0].action, "site_audit.run");
  assert.equal(accepted.enqueued[0][2].singleActiveKey, "site_audit:brand-1");
});

test("actual paid start orders row creation, spend hold, enqueue and durable update", async () => {
  const paid = actualStartDeps({ renderConfigured: true });
  const response = await POST(request({ renderJavaScript: true, maxUsd: 0.25 }), undefined, paid.depsForRoute);
  assert.equal(response.status, 202);
  const calls = paid.state.calls.map((call) => call[0] === "rpc" ? "create" : call[0]);
  assert.ok(calls.indexOf("create") < calls.indexOf("reserve"));
  assert.ok(calls.indexOf("reserve") < calls.indexOf("enqueue"));
  assert.ok(calls.indexOf("enqueue") < calls.indexOf("update"));
  assert.ok(calls.indexOf("update") < calls.indexOf("approval"));
  assert.equal(paid.state.audits.get(auditId).render_hold_id, "hold-1");
});

test("actual start service maps active/capacity refusals and cleans up paid start failures", async () => {
  const activeRow = { id: "active-audit", brand_key: "brand-1", status: "running" };
  const active = actualStartDeps({ audits: [[activeRow.id, activeRow]] });
  const activeResponse = await POST(request(), undefined, active.depsForRoute);
  assert.equal(activeResponse.status, 409);
  const activeBody = await activeResponse.json();
  assert.equal(activeBody.code, "audit_already_running");
  assert.equal(activeBody.details.activeAuditId, activeRow.id);

  const hostBusy = actualStartDeps({ createResult: { created: false, reason: "host_busy" } });
  const hostBusyResponse = await POST(request(), undefined, hostBusy.depsForRoute);
  assert.equal(hostBusyResponse.status, 409);
  assert.equal((await hostBusyResponse.json()).code, "host_busy");

  const capacity = actualStartDeps({ createResult: { created: false, reason: "audit_capacity_reached", used: 50000, cap: 50000 } });
  const capacityResponse = await POST(request(), undefined, capacity.depsForRoute);
  assert.equal(capacityResponse.status, 409);
  assert.equal((await capacityResponse.json()).code, "audit_capacity_reached");

  const spend = actualStartDeps({ renderConfigured: true, spendError: new SpendRefused("daily_cap") });
  const spendResponse = await POST(request({ renderJavaScript: true, maxUsd: 0.25 }), undefined, spend.depsForRoute);
  assert.equal(spendResponse.status, 402);
  assert.equal((await spendResponse.json()).code, "daily_cap");
  assert.equal(spend.state.audits.size, 0);
  assert.equal(spend.enqueued.length, 0);

  const enqueue = actualStartDeps({ renderConfigured: true, enqueueError: new AppError(503, "queue_unavailable", "queue down") });
  const enqueueResponse = await POST(request({ renderJavaScript: true, maxUsd: 0.25 }), undefined, enqueue.depsForRoute);
  assert.equal(enqueueResponse.status, 503);
  assert.equal((await enqueueResponse.json()).code, "queue_unavailable");
  assert.deepEqual(enqueue.released, [["hold-1", "audit_start_failed"]]);
  assert.equal(enqueue.state.audits.size, 0);
});

test("actual start route enforces both paid feature flags and render configuration", async () => {
  const lighthouseOff = actualStartDeps({ disabledFeature: "site_audit_lighthouse" });
  const lighthouseResponse = await POST(request({ lighthouse: true }), undefined, lighthouseOff.depsForRoute);
  assert.equal(lighthouseResponse.status, 403);
  assert.equal((await lighthouseResponse.json()).code, "feature_disabled");

  const renderOff = actualStartDeps({ disabledFeature: "site_audit_render", renderConfigured: true });
  const renderResponse = await POST(request({ renderJavaScript: true }), undefined, renderOff.depsForRoute);
  assert.equal(renderResponse.status, 403);
  assert.equal((await renderResponse.json()).code, "feature_disabled");

  const renderUnconfigured = actualStartDeps();
  const unconfiguredResponse = await POST(request({ renderJavaScript: true }), undefined, renderUnconfigured.depsForRoute);
  assert.equal(unconfiguredResponse.status, 503);
  assert.equal((await unconfiguredResponse.json()).code, "render_unavailable");
});

import test from "node:test";
import assert from "node:assert/strict";

const ROUTE = await import(
  new URL("../../app/api/customer/price/estimate/route.ts", import.meta.url).href
);
const { scanRunAction } = await import("./actions/scanRun.ts");

const USER = { id: "user-123", email: "member@example.test" };
const BRAND_KEY = "offcult.in";

function baseDeps(brandKey = BRAND_KEY, over = {}) {
  return {
    getCustomerContext: async () => ({
      client: null,
      user: USER,
      brands: [
        {
          brandKey,
          role: "member",
          display_name: "Offcult",
          website: "https://offcult.in",
          website_host: "offcult.in",
          aliases: [],
          is_active: true,
        },
      ],
      error: null,
    }),
    getSupabaseAdmin: () => ({
      from: (table) => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: null, error: null }),
            single: async () => ({ data: null, error: null }),
          }),
        }),
      }),
      rpc: async () => ({ data: null, error: null }),
    }),
    ...over,
  };
}

async function read(res) {
  const json = await res.json();
  return {
    status: res.status,
    cacheControl: res.headers.get("cache-control"),
    body: json,
  };
}

function makeRequest(body, headers = {}) {
  return new Request("https://app.test/api/customer/price/estimate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      origin: "https://app.test",
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("POST /api/customer/price/estimate returns 200 quote for registered action", async () => {
  const deps = baseDeps(BRAND_KEY, {
    quote: async (action, ctx, input) => ({
      action,
      currency: "USD",
      totalUsd: 24.0,
      expectedUsd: 7.2,
      units: [
        { key: "questions", label: "questions", count: 30 },
        { key: "engines", label: "engines", count: 4 },
        { key: "answers", label: "answers", count: 120 },
      ],
      lines: [
        {
          label: "Answers reserved at $0.20 each",
          quantity: 120,
          unitUsd: 0.2,
          totalUsd: 24.0,
        },
      ],
      monthly: null,
      warnings: [],
      blocked: null,
      priceVersion: "2026-10-21.1",
      quotedAt: "2026-10-21T09:30:00.000Z",
      inputsHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    }),
  });

  const req = makeRequest({
    brand_key: BRAND_KEY,
    action: "ai_visibility.scan.run",
    input: { panelKey: "default" },
  });

  const { status, cacheControl, body } = await read(await ROUTE.POST(req, deps));
  assert.equal(status, 200);
  assert.equal(cacheControl, "no-store");
  assert.equal(body.action, "ai_visibility.scan.run");
  assert.equal(body.totalUsd, 24.0);
  assert.equal(body.currency, "USD");
});

test("POST /api/customer/price/estimate returns 404 unknown_price_action for unregistered action", async () => {
  const deps = baseDeps();
  const req = makeRequest({
    brand_key: BRAND_KEY,
    action: "unknown.action.run",
    input: {},
  });

  const { status, body } = await read(await ROUTE.POST(req, deps));
  assert.equal(status, 404);
  assert.equal(body.code, "unknown_price_action");
  assert.equal(body.error, "This action cannot be priced.");
});

test("POST /api/customer/price/estimate returns 400 for input violating strict schema", async () => {
  const deps = baseDeps();
  const req = makeRequest({
    brand_key: BRAND_KEY,
    action: "ai_visibility.scan.run",
    input: { panelKey: "default", extra: 1 },
  });

  const { status, body } = await read(await ROUTE.POST(req, deps));
  assert.equal(status, 400);
  assert.equal(body.code, "invalid_request");
});

test("POST /api/customer/price/estimate returns 200 with blocked set when quote is blocked", async () => {
  const deps = baseDeps(BRAND_KEY, {
    quote: async (action, ctx, input) => ({
      action,
      currency: "USD",
      totalUsd: 0,
      expectedUsd: null,
      units: [],
      lines: [],
      monthly: null,
      warnings: [],
      blocked: {
        code: "panel_not_approved",
        message:
          "Scans ask the questions in your approved question panel. Review and approve it first.",
        recovery: "Open Questions & evidence to approve the panel.",
      },
      priceVersion: "2026-10-21.1",
      quotedAt: "2026-10-21T09:30:00.000Z",
      inputsHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    }),
  });

  const req = makeRequest({
    brand_key: BRAND_KEY,
    action: "ai_visibility.scan.run",
    input: { panelKey: "default" },
  });

  const { status, body } = await read(await ROUTE.POST(req, deps));
  assert.equal(status, 200);
  assert.deepEqual(body.blocked, {
    code: "panel_not_approved",
    message:
      "Scans ask the questions in your approved question panel. Review and approve it first.",
    recovery: "Open Questions & evidence to approve the panel.",
  });
});

test("POST /api/customer/price/estimate tenant isolation: brand not in memberships returns 404", async () => {
  const deps = baseDeps("other-brand.in"); // User only has other-brand.in
  const req = makeRequest({
    brand_key: "forbidden-brand.in",
    action: "ai_visibility.scan.run",
    input: { panelKey: "default" },
  });

  const { status, body } = await read(await ROUTE.POST(req, deps));
  assert.equal(status, 404);
  assert.equal(body.code, "workspace_not_found");
});

test("POST /api/customer/price/estimate returns 400 invalid_json on malformed JSON body", async () => {
  const deps = baseDeps();
  const req = makeRequest("not valid json", { "Content-Type": "application/json" });

  const { status, body } = await read(await ROUTE.POST(req, deps));
  assert.equal(status, 400);
  assert.equal(body.code, "invalid_json");
});

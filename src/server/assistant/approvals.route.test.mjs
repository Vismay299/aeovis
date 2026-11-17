/**
 * F22 P4 approval routes: the real GET/decide handlers over an in-memory
 * approval store. The priced action is the only injected seam, so the atomic
 * claim, expiry, price_changed and double-approve paths are the product code.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { createHash } from "node:crypto";
import { createFakeAdmin } from "../../../tests/fixtures/f22/fakeAdmin.ts";

register("./assistantRoute.test.hooks.mjs", import.meta.url);

process.env.LLM_API_KEY = "route-test-key";
process.env.ASSISTANT_MODEL = "anthropic/claude-sonnet-4.5";

const AT = Date.parse("2026-11-17T10:00:00.000Z");

const approvalGet = await import("../../app/api/customer/assistant/approvals/[approvalId]/route.ts");
const approvalDecide = await import("../../app/api/customer/assistant/approvals/[approvalId]/decide/route.ts");
const { getTool } = await import("../tools/registry.ts");
const { stableStringify } = await import("../cache/providerCache.ts");

const BRAND = {
  brandKey: "acme-tees",
  role: "owner",
  display_name: "Acme Tees",
  website: "https://acme.example",
  website_host: "acme.example",
  aliases: [],
  is_active: true,
};

const USER = { id: "user-1", email: "owner@acme.example" };
const flagOn = { isFeatureEnabled: async (name) => name === "assistant" };
const flagOff = { isFeatureEnabled: async () => false };
const REG = getTool("research_keywords");

function quote(overrides = {}) {
  return {
    action: "keywords.research.run",
    currency: "USD",
    totalUsd: 0.09,
    expectedUsd: null,
    units: [],
    lines: [{ label: "Phrase-match ideas", quantity: 1, unitUsd: 0.09, totalUsd: 0.09 }],
    monthly: null,
    warnings: [],
    blocked: null,
    priceVersion: "test",
    quotedAt: "2026-11-17T10:00:00.000Z",
    inputsHash: "a".repeat(64),
    ...overrides,
  };
}

function approvalRow(overrides = {}) {
  const input = { keyword: "oversized t shirt" };
  return {
    id: "ap-1",
    session_id: "s1",
    turn_id: "t1",
    brand_key: "acme-tees",
    user_id: "user-1",
    tool_name: "research_keywords",
    tool_call_id: "call-1",
    kind: "price",
    priced_action: "keywords.research.run",
    input,
    input_sha256: createHash("sha256").update(stableStringify(input)).digest("hex"),
    quote_input: { keyword: "oversized t shirt" },
    quote: quote(),
    quoted_usd: 0.09,
    approved_max_usd: null,
    label: "Research keywords for “oversized t shirt”",
    status: "pending",
    result: null,
    error_code: null,
    decided_at: null,
    finished_at: null,
    expires_at: "2026-11-17T10:15:00.000Z",
    created_at: "2026-11-17T10:00:00.000Z",
    ...overrides,
  };
}

function install(admin, user = USER) {
  globalThis.customerRouteFixture = {
    context: { user, brands: [BRAND], error: null, client: null },
    admin,
  };
}

function adminWith(rows) {
  const admin = createFakeAdmin({ assistant_approvals: rows });
  admin.setNow(() => AT);
  return admin;
}

const deps = (admin, approvalDeps = {}) => ({
  ...flagOn,
  approvalDeps: {
    now: () => new Date(AT),
    env: process.env,
    availableTools: async () => [REG],
    recordApproval: async () => "pa-1",
    ...approvalDeps,
  },
});

function decideRequest(body) {
  return new Request("https://aeovis.test/api/customer/assistant/approvals/ap-1/decide", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const param = { params: { approvalId: "ap-1" } };

test("approval routes: the flag off is 404 feature_unavailable", async () => {
  install(adminWith([approvalRow()]));
  const res = await approvalGet.GET(
    new Request("https://aeovis.test/api/customer/assistant/approvals/ap-1?brand_key=acme-tees"),
    param,
    flagOff,
  );
  assert.equal(res.status, 404);
  assert.equal((await res.json()).code, "feature_unavailable");
});

test("approval GET: returns the view for the owner and 404 for anyone else", async () => {
  const admin = adminWith([approvalRow()]);
  install(admin);
  const res = await approvalGet.GET(
    new Request("https://aeovis.test/api/customer/assistant/approvals/ap-1?brand_key=acme-tees"),
    param,
    flagOn,
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.approval.id, "ap-1");
  assert.equal(body.approval.status, "pending");
  assert.equal(body.approval.quote.totalUsd, 0.09);
  assert.equal(body.approval.approvedMaxUsd, null);

  install(admin, { id: "user-2", email: "other@acme.example" });
  const foreign = await approvalGet.GET(
    new Request("https://aeovis.test/api/customer/assistant/approvals/ap-1?brand_key=acme-tees"),
    param,
    flagOn,
  );
  assert.equal(foreign.status, 404);
  assert.equal((await foreign.json()).code, "approval_not_found");
});

test("approval decide: approve runs once and a second approve is 409 approval_not_pending", async () => {
  const admin = adminWith([approvalRow()]);
  install(admin);
  let runs = 0;
  const approvalDeps = {
    requireApprovedPrice: async () => ({ quote: quote(), approvedMaxUsd: 0.09, source: "dialog" }),
    runTool: async () => {
      runs += 1;
      return {
        ok: true,
        output: { rows: [] },
        summary: "4 keyword ideas.",
        link: null,
        untrusted: [],
        truncated: null,
      };
    },
  };
  const first = await approvalDecide.POST(decideRequest({ brand_key: "acme-tees", decision: "approve", maxUsd: 0.09 }), param, deps(admin, approvalDeps));
  assert.equal(first.status, 200);
  const firstBody = await first.json();
  assert.equal(firstBody.approval.status, "executed");
  assert.equal(firstBody.approval.approvedMaxUsd, 0.09);

  const second = await approvalDecide.POST(decideRequest({ brand_key: "acme-tees", decision: "approve", maxUsd: 0.09 }), param, deps(admin, approvalDeps));
  assert.equal(second.status, 409);
  assert.equal((await second.json()).code, "approval_not_pending");
  assert.equal(runs, 1);
});

test("approval decide: price_changed is 409 and leaves the row pending with the new quote", async () => {
  const admin = adminWith([approvalRow()]);
  install(admin);
  const res = await approvalDecide.POST(
    decideRequest({ brand_key: "acme-tees", decision: "approve", maxUsd: 0.09 }),
    param,
    deps(admin, {
      requireApprovedPrice: async () => {
        const { AppError } = await import("../../shared/http/appError.ts");
        throw new AppError(409, "price_changed", "This now costs up to $0.12, more than the $0.09 you approved. Review the new price.", {
          recovery: "Review the new price and approve it to continue.",
          details: { approvedMaxUsd: 0.09, quote: quote({ totalUsd: 0.12 }) },
        });
      },
    }),
  );
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.code, "price_changed");
  assert.equal(body.details.quote.totalUsd, 0.12);
  const row = admin.rows("assistant_approvals")[0];
  assert.equal(row.status, "pending");
  assert.equal(row.quoted_usd, 0.12);
});

test("approval decide: an expired approval is 410 and a decline is 200 declined", async () => {
  const expiredAdmin = adminWith([approvalRow({ expires_at: "2026-11-17T09:59:00.000Z" })]);
  install(expiredAdmin);
  const expired = await approvalDecide.POST(
    decideRequest({ brand_key: "acme-tees", decision: "approve", maxUsd: 0.09 }),
    param,
    deps(expiredAdmin, {
      requireApprovedPrice: async () => ({ quote: quote(), approvedMaxUsd: 0.09, source: "dialog" }),
    }),
  );
  assert.equal(expired.status, 410);
  const expiredBody = await expired.json();
  assert.equal(expiredBody.code, "approval_expired");
  assert.equal(expiredBody.error, "This approval expired. Ask the assistant again for a fresh price.");

  const admin = adminWith([approvalRow()]);
  install(admin);
  const declined = await approvalDecide.POST(
    decideRequest({ brand_key: "acme-tees", decision: "decline" }),
    param,
    deps(admin),
  );
  assert.equal(declined.status, 200);
  const body = await declined.json();
  assert.equal(body.approval.status, "declined");
  assert.equal(admin.rows("assistant_approvals")[0].status, "declined");
});

test("approval decide: approving a price without maxUsd is 400 approval_required", async () => {
  const admin = adminWith([approvalRow()]);
  install(admin);
  const res = await approvalDecide.POST(
    decideRequest({ brand_key: "acme-tees", decision: "approve" }),
    param,
    deps(admin, {
      requireApprovedPrice: async () => {
        throw new Error("must not re-quote without a ceiling");
      },
    }),
  );
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, "approval_required");
  assert.equal(admin.rows("assistant_approvals")[0].status, "pending");
});

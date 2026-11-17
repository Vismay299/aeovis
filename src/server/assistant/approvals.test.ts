import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { AppError } from "../../shared/http/appError.ts";
import { stableStringify } from "../cache/providerCache.ts";
import { getTool } from "../tools/registry.ts";
import { createFakeAdmin } from "../../../tests/fixtures/f22/fakeAdmin.ts";
import type { ToolRegistration } from "../tools/types.ts";
import {
  decideApproval,
  getApprovalView,
  requestApproval,
  type AssistantToolResult,
  type DecideApprovalInput,
} from "./approvals.ts";
import type { Workspace } from "../workspace/requireWorkspace.ts";

const AT = Date.parse("2026-11-17T10:00:00.000Z");
const NOW = () => new Date(AT);

const BRAND = {
  brandKey: "acme-tees",
  role: "owner" as const,
  display_name: "Acme Tees",
  website: "https://acme.example",
  website_host: "acme.example",
  aliases: [],
  is_active: true,
};

function quote(overrides: Record<string, unknown> = {}) {
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

function approvalRow(overrides: Record<string, unknown> = {}) {
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

const REG = getTool("research_keywords") as ToolRegistration;

function mkAdmin(seed: Record<string, unknown[]> = {}) {
  const admin = createFakeAdmin(seed);
  admin.setNow(() => AT);
  return admin;
}

function workspace(admin: ReturnType<typeof createFakeAdmin>): Workspace {
  return {
    user: { id: "user-1", email: "owner@acme.example" },
    brandKey: "acme-tees",
    brand: BRAND,
    role: "owner",
    admin: admin as never,
  };
}

function successOutcome(summary = "4 keyword ideas.") {
  return {
    ok: true as const,
    output: { rows: [] },
    summary,
    link: null,
    untrusted: [],
    truncated: null,
  };
}

test("requestApproval: inserts the §6.2.4 row and returns the exact awaiting envelope", async () => {
  const admin = mkAdmin();
  const result = await requestApproval(
    {
      reg: REG,
      ctx: {
        admin: admin as never,
        brand: BRAND,
        userId: "user-1",
        user: { id: "user-1", email: "owner@acme.example" },
        role: "owner",
        requestId: "turn:t1",
        sessionId: "s1",
        source: "assistant",
      },
      input: { keyword: "oversized t shirt", maxUsd: 0.5 },
      decision: {
        kind: "price",
        action: "keywords.research.run",
        quoteInput: { keyword: "oversized t shirt" },
        label: "Research keywords for “oversized t shirt”",
      },
      sessionId: "s1",
      turnId: "t1",
      toolCallId: "call-1",
    },
    { quote: async () => quote() as never, now: NOW, env: {} },
  );
  assert.equal(result.status, "awaiting_approval");
  if (result.status !== "awaiting_approval") return;
  assert.equal(result.kind, "price");
  assert.equal(result.label, "Research keywords for “oversized t shirt”");
  assert.equal(result.quote?.totalUsd, 0.09);
  assert.equal(result.expiresAt, "2026-11-17T10:15:00.000Z");
  assert.equal(
    result.summary,
    "Waiting for the user to approve Research keywords for “oversized t shirt” (up to $0.09). Do not call this tool again for it. The reply pauses here; you will get a message with the outcome.",
  );

  const row = admin.rows("assistant_approvals")[0];
  assert.equal(row.session_id, "s1");
  assert.equal(row.turn_id, "t1");
  assert.equal(row.brand_key, "acme-tees");
  assert.equal(row.user_id, "user-1");
  assert.equal(row.tool_name, "research_keywords");
  assert.equal(row.tool_call_id, "call-1");
  assert.equal(row.priced_action, "keywords.research.run");
  assert.deepEqual(row.quote_input, { keyword: "oversized t shirt" });
  assert.equal(row.quoted_usd, 0.09);
  assert.equal(
    row.input_sha256,
    createHash("sha256").update(stableStringify(row.input)).digest("hex"),
  );
});

test("decideApproval: approve re-quotes, claims atomically, records F09 and runs once", async () => {
  const admin = mkAdmin({ assistant_sessions: [{ id: "s1", brand_key: "acme-tees", user_id: "user-1" }], assistant_approvals: [approvalRow()] });
  const recorded: Array<Record<string, unknown>> = [];
  let runs = 0;
  let captured: {
    context?: Record<string, unknown>;
    options?: Record<string, unknown>;
  } = {};
  const view = await decideApproval(
    { ws: workspace(admin), approvalId: "ap-1", decision: "approve", maxUsd: 0.09 },
    {
      now: NOW,
      env: {},
      availableTools: async () => [REG],
      requireApprovedPrice: async () => ({ quote: quote() as never, approvedMaxUsd: 0.09, source: "dialog" }),
      recordApproval: async (_admin, input) => {
        recorded.push(input as unknown as Record<string, unknown>);
        return "pa-1";
      },
      runTool: async (_reg, context, _input, options) => {
        runs += 1;
        captured = {
          context: context as unknown as Record<string, unknown>,
          options: options as unknown as Record<string, unknown>,
        };
        return successOutcome();
      },
    },
  );
  assert.equal(runs, 1);
  assert.equal(captured.options?.maxUsd, 0.09);
  assert.equal(captured.options?.timeoutMs, 120_000);
  assert.equal(captured.context?.source, "approval");
  assert.equal(captured.context?.requestId, "approval:ap-1");
  assert.equal(captured.context?.sessionId, "s1");
  assert.equal(view.status, "executed");
  assert.equal(view.approvedMaxUsd, 0.09);
  assert.deepEqual(recorded, [
    {
      brandKey: "acme-tees",
      action: "keywords.research.run",
      approvedMaxUsd: 0.09,
      quote: quote(),
      source: "dialog",
      subject: { kind: "assistant_approval", id: "ap-1" },
      approvedBy: "user-1",
    },
  ]);
  const stored = admin.rows("assistant_approvals")[0];
  assert.equal(stored.status, "executed");
  assert.equal((stored.result as AssistantToolResult).status, "success");
});

test("decideApproval: a double approve runs once and the second is approval_not_pending", async () => {
  const admin = mkAdmin({
    assistant_sessions: [{ id: "s1", brand_key: "acme-tees", user_id: "user-1" }],
    assistant_approvals: [approvalRow()],
  });
  let runs = 0;
  const deps = {
    now: NOW,
    env: {},
    availableTools: async () => [REG],
    requireApprovedPrice: async () => ({ quote: quote() as never, approvedMaxUsd: 0.09, source: "dialog" as const }),
    recordApproval: async () => "pa-1",
    runTool: async () => {
      runs += 1;
      return successOutcome();
    },
  };
  const input: DecideApprovalInput = {
    ws: workspace(admin),
    approvalId: "ap-1",
    decision: "approve",
    maxUsd: 0.09,
  };
  await decideApproval(input, deps);
  await assert.rejects(decideApproval(input, deps), (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.status, 409);
    assert.equal(error.code, "approval_not_pending");
    return true;
  });
  assert.equal(runs, 1, "the handler must run once");
});

test("decideApproval: a higher fresh quote stores it and leaves the row pending", async () => {
  const admin = mkAdmin({
    assistant_sessions: [{ id: "s1", brand_key: "acme-tees", user_id: "user-1" }],
    assistant_approvals: [approvalRow()],
  });
  const fresh = quote({ totalUsd: 0.12, lines: [{ label: "Phrase-match ideas", quantity: 2, unitUsd: 0.06, totalUsd: 0.12 }] });
  await assert.rejects(
    decideApproval(
      { ws: workspace(admin), approvalId: "ap-1", decision: "approve", maxUsd: 0.09 },
      {
        now: NOW,
        env: {},
        availableTools: async () => [REG],
        requireApprovedPrice: async () => {
          throw new AppError(409, "price_changed", "This now costs more.", {
            recovery: "Review the new price.",
            details: { approvedMaxUsd: 0.09, quote: fresh },
          });
        },
        runTool: async () => {
          throw new Error("must not run");
        },
      },
    ),
    { code: "price_changed" },
  );
  const stored = admin.rows("assistant_approvals")[0];
  assert.equal(stored.status, "pending");
  assert.equal(stored.quoted_usd, 0.12);
  assert.equal((stored.quote as { totalUsd: number }).totalUsd, 0.12);
  assert.equal(admin.rpcCalls.some((call) => call.name === "claim_assistant_approval"), false);
});

test("decideApproval: an expired approval is 410 with the exact copy", async () => {
  const admin = mkAdmin({
    assistant_sessions: [{ id: "s1", brand_key: "acme-tees", user_id: "user-1" }],
    assistant_approvals: [approvalRow({ expires_at: "2026-11-17T09:59:00.000Z" })],
  });
  await assert.rejects(
    decideApproval(
      { ws: workspace(admin), approvalId: "ap-1", decision: "approve", maxUsd: 0.09 },
      {
        now: NOW,
        env: {},
        availableTools: async () => [REG],
        requireApprovedPrice: async () => ({ quote: quote() as never, approvedMaxUsd: 0.09, source: "dialog" }),
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.status, 410);
      assert.equal(error.code, "approval_expired");
      assert.equal(error.message, "This approval expired. Ask the assistant again for a fresh price.");
      return true;
    },
  );
  assert.equal(admin.rows("assistant_approvals")[0].status, "expired");
});

test("decideApproval: decline is pending-only and expired decline is 410 (SPEC GAPS G3)", async () => {
  const admin = mkAdmin({
    assistant_sessions: [{ id: "s1", brand_key: "acme-tees", user_id: "user-1" }],
    assistant_approvals: [approvalRow()],
  });
  const view = await decideApproval(
    { ws: workspace(admin), approvalId: "ap-1", decision: "decline" },
    { now: NOW, env: {} },
  );
  assert.equal(view.status, "declined");
  assert.equal(admin.rows("assistant_approvals")[0].status, "declined");

  const expiredAdmin = mkAdmin({
    assistant_sessions: [{ id: "s1", brand_key: "acme-tees", user_id: "user-1" }],
    assistant_approvals: [approvalRow({ expires_at: "2026-11-17T09:59:00.000Z" })],
  });
  await assert.rejects(
    decideApproval(
      { ws: workspace(expiredAdmin), approvalId: "ap-1", decision: "decline" },
      { now: NOW, env: {} },
    ),
    { status: 410, code: "approval_expired" },
  );
  assert.equal(expiredAdmin.rows("assistant_approvals")[0].status, "expired");
});

test("decideApproval: another user, brand or a missing row is 404 approval_not_found", async () => {
  const admin = mkAdmin({
    assistant_sessions: [{ id: "s1", brand_key: "acme-tees", user_id: "user-1" }],
    assistant_approvals: [approvalRow()],
  });
  await assert.rejects(
    decideApproval(
      {
        ws: { ...workspace(admin), user: { id: "user-2", email: "other@acme.example" } },
        approvalId: "ap-1",
        decision: "decline",
      },
      { now: NOW, env: {} },
    ),
    { status: 404, code: "approval_not_found" },
  );
  await assert.rejects(
    decideApproval(
      { ws: { ...workspace(admin), brandKey: "other-brand" }, approvalId: "ap-1", decision: "decline" },
      { now: NOW, env: {} },
    ),
    { status: 404, code: "approval_not_found" },
  );
  await assert.rejects(
    decideApproval(
      { ws: workspace(admin), approvalId: "missing", decision: "decline" },
      { now: NOW, env: {} },
    ),
    { status: 404, code: "approval_not_found" },
  );
});

test("decideApproval: an executed result is capped at 100,000 chars", async () => {
  const admin = mkAdmin({
    assistant_sessions: [{ id: "s1", brand_key: "acme-tees", user_id: "user-1" }],
    assistant_approvals: [approvalRow()],
  });
  await decideApproval(
    { ws: workspace(admin), approvalId: "ap-1", decision: "approve", maxUsd: 0.09 },
    {
      now: NOW,
      env: {},
      availableTools: async () => [REG],
      requireApprovedPrice: async () => ({ quote: quote() as never, approvedMaxUsd: 0.09, source: "dialog" }),
      runTool: async () => ({
        ok: true,
        output: { rows: Array.from({ length: 40 }, () => "x".repeat(8_000)) },
        summary: "Many rows.",
        link: null,
        untrusted: [],
        truncated: null,
      }),
    },
  );
  const stored = admin.rows("assistant_approvals")[0].result;
  assert.ok(JSON.stringify(stored).length <= 100_000);
});

test("decideApproval: an input hash mismatch is 500 approval_corrupt", async () => {
  const admin = mkAdmin({
    assistant_sessions: [{ id: "s1", brand_key: "acme-tees", user_id: "user-1" }],
    assistant_approvals: [approvalRow({ input_sha256: "b".repeat(64) })],
  });
  await assert.rejects(
    decideApproval(
      { ws: workspace(admin), approvalId: "ap-1", decision: "approve", maxUsd: 0.09 },
      { now: NOW, env: {}, availableTools: async () => [REG] },
    ),
    { status: 500, code: "approval_corrupt" },
  );
});

test("getApprovalView: scopes by brand and user and returns nulls honestly", async () => {
  const admin = mkAdmin({ assistant_approvals: [approvalRow()] });
  const view = await getApprovalView(admin as never, {
    approvalId: "ap-1",
    brandKey: "acme-tees",
    userId: "user-1",
  });
  assert.equal(view.status, "pending");
  assert.equal(view.quote?.totalUsd, 0.09);
  assert.equal(view.approvedMaxUsd, null);
  assert.equal(view.decidedAt, null);
  assert.equal(view.result, null);
  assert.equal(view.errorCode, null);
  await assert.rejects(
    getApprovalView(admin as never, {
      approvalId: "ap-1",
      brandKey: "acme-tees",
      userId: "user-2",
    }),
    { status: 404, code: "approval_not_found" },
  );
});

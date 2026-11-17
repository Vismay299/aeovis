import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { AppError } from "../../shared/http/appError.ts";
import { createFakeAdmin } from "../../../tests/fixtures/f22/fakeAdmin.ts";
import { TOOL_REGISTRY, availableTools, getTool } from "../tools/registry.ts";
import type { ToolRegistration } from "../tools/types.ts";
import {
  PAID_TOOL_SENTENCE,
  buildAiToolSet,
  modelSchema,
  toolDescription,
} from "./aiTools.ts";
import { decideApproval } from "./approvals.ts";

const BRAND = {
  brandKey: "acme-tees",
  role: "owner" as const,
  display_name: "Acme Tees",
  website: "https://acme.example",
  website_host: "acme.example",
  aliases: [],
  is_active: true,
};

function testCtx(admin: ReturnType<typeof createFakeAdmin>) {
  return {
    admin: admin as never,
    brand: BRAND,
    userId: "user-1",
    user: { id: "user-1", email: "owner@acme.example" },
    role: "owner" as const,
    requestId: "test",
    source: "test" as const,
  };
}

const SKILLS = [
  { name: "one", title: "One", description: "First skill.", version: "1.0.0" },
  { name: "two", title: "Two", description: "Second skill.", version: "2.0.0" },
];

function paidRegistration(handler: () => Promise<unknown>): ToolRegistration {
  return {
    def: {
      name: "qa_paid",
      description: "Run a synthetic paid lookup.",
      input: z.strictObject({ query: z.string(), maxUsd: z.number().positive().max(1000) }),
      output: z.looseObject({ ok: z.boolean() }),
      handler: handler as never,
    },
    area: "keywords",
    feature: null,
    effect: "paid",
    approval: () => ({
      kind: "price",
      action: "keywords.research.run",
      quoteInput: { keyword: "shirts" },
      label: "Research keywords for “shirts”",
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true, idempotentHint: false },
    summarize: () => "Ran the lookup.",
    example: { input: { query: "shirts", maxUsd: 0.1 }, output: { ok: true } },
  } as unknown as ToolRegistration;
}

function quote(overrides: Record<string, unknown> = {}) {
  return {
    action: "keywords.research.run",
    currency: "USD",
    totalUsd: 0.05,
    expectedUsd: null,
    units: [],
    lines: [],
    monthly: null,
    warnings: [],
    blocked: null,
    priceVersion: "test",
    quotedAt: "2026-11-17T00:00:00.000Z",
    inputsHash: "a".repeat(64),
    ...overrides,
  };
}

test("modelSchema: maxUsd is absent from every model-facing schema", () => {
  for (const reg of TOOL_REGISTRY) {
    const schema = z.toJSONSchema(modelSchema(reg) as never, { io: "input" }) as {
      properties?: Record<string, unknown>;
    };
    assert.equal(
      Object.prototype.hasOwnProperty.call(schema.properties ?? {}, "maxUsd"),
      false,
      reg.def.name + " must not expose maxUsd to the model",
    );
  }
  const research = getTool("research_keywords");
  assert.ok(research);
  assert.ok(z.toJSONSchema(research!.def.input, { io: "input" }).properties?.maxUsd);
  assert.equal(toolDescription(research!).endsWith(PAID_TOOL_SENTENCE), true);
});

test("toolDescription: every paid tool ends with the exact paid sentence", () => {
  for (const reg of TOOL_REGISTRY.filter((candidate) => candidate.effect === "paid")) {
    assert.ok(
      toolDescription(reg).endsWith(PAID_TOOL_SENTENCE),
      reg.def.name + " description must end with the paid sentence",
    );
  }
});

test("availableTools: flag off hides a tool, ownerOnly hides it from members", async () => {
  const enabled = await availableTools(
    { brandKey: "acme-tees", role: "owner" },
    { isFeatureEnabled: async (name) => name === "keyword_research" },
  );
  assert.ok(enabled.some((reg) => reg.def.name === "research_keywords"));
  assert.equal(enabled.some((reg) => reg.def.name === "get_domain_overview"), false);
  const asMember = await availableTools(
    { brandKey: "acme-tees", role: "member" },
    { isFeatureEnabled: async () => true },
  );
  assert.equal(asMember.some((reg) => reg.ownerOnly === true), false);
});

test("activate_skill: enum is the visible skills and its output is the exact envelope", async () => {
  const admin = createFakeAdmin();
  const set = buildAiToolSet({
    regs: [],
    ctx: testCtx(admin),
    skills: SKILLS,
    skillLoad: (name) =>
      name === "two"
        ? { ...SKILLS[1], body: "BODY", tools: [], optionalTools: [] }
        : null,
    sessionId: "s1",
    turnId: "t1",
    onApproval: () => {},
    turnMemory: {},
  }) as Record<string, any>;
  assert.ok(set.activate_skill);
  const schema = z.toJSONSchema(set.activate_skill.inputSchema, { io: "input" }) as unknown as {
    properties: { name: { enum: string[] } };
  };
  assert.deepEqual(schema.properties.name.enum, ["one", "two"]);
  const result = await set.activate_skill.execute({ name: "two" }, { toolCallId: "call-1" });
  assert.deepEqual(result, {
    status: "success",
    summary: "Loaded skill Two v2.0.0.",
    data: { name: "two", version: "2.0.0", instructions: "BODY" },
    link: null,
    untrusted: [],
    truncated: null,
  });
});

test("activate_skill: the tool is omitted when no skills are visible", () => {
  const admin = createFakeAdmin();
  const set = buildAiToolSet({
    regs: [],
    ctx: testCtx(admin),
    skills: [],
    skillLoad: () => null,
    sessionId: "s1",
    turnId: "t1",
    onApproval: () => {},
    turnMemory: {},
  }) as Record<string, any>;
  assert.equal(set.activate_skill, undefined);
  assert.deepEqual(Object.keys(set), []);
});

test("paid tool: the handler never runs; the reply pauses with an awaiting envelope", async () => {
  const admin = createFakeAdmin();
  let handlerCalls = 0;
  let approvals = 0;
  const reg = paidRegistration(async () => {
    handlerCalls += 1;
    return { ok: true };
  });
  const set = buildAiToolSet({
    regs: [reg],
    ctx: testCtx(admin),
    skills: [],
    skillLoad: () => null,
    sessionId: "s1",
    turnId: "t1",
    onApproval: () => {
      approvals += 1;
    },
    turnMemory: {},
    approvalDeps: {
      quote: async () => quote() as never,
      now: () => new Date("2026-11-17T00:00:00.000Z"),
    },
  }) as Record<string, any>;
  const result = await set.qa_paid.execute({ query: "shirts" }, { toolCallId: "call-1" });
  assert.equal(handlerCalls, 0, "a paid handler must not run in the model loop");
  assert.equal(approvals, 1);
  assert.equal(result.status, "awaiting_approval");
  assert.equal(result.kind, "price");
  assert.equal(result.quote.totalUsd, 0.05);
  assert.equal(result.expiresAt, "2026-11-17T00:15:00.000Z");
  assert.equal(
    result.summary,
    "Waiting for the user to approve Research keywords for “shirts” (up to $0.05). Do not call this tool again for it. The reply pauses here; you will get a message with the outcome.",
  );
  assert.equal(admin.rows("assistant_approvals").length, 1);
});

test("paid tool: a blocked quote is an error envelope with the blocked code", async () => {
  const admin = createFakeAdmin();
  const reg = paidRegistration(async () => ({ ok: true }));
  const set = buildAiToolSet({
    regs: [reg],
    ctx: testCtx(admin),
    skills: [],
    skillLoad: () => null,
    sessionId: "s1",
    turnId: "t1",
    onApproval: () => {},
    turnMemory: {},
    approvalDeps: {
      quote: async () =>
        quote({
          blocked: { code: "collection_paused", message: "Collection is paused.", recovery: "Resume it." },
        }) as never,
    },
  }) as Record<string, any>;
  const result = await set.qa_paid.execute({ query: "shirts" }, { toolCallId: "call-2" });
  assert.equal(result.status, "error");
  assert.equal(result.code, "collection_paused");
  assert.equal(result.message, "Collection is paused.");
  assert.equal(result.recovery, "Resume it.");
  assert.equal(result.retryable, false);
  assert.equal(admin.rows("assistant_approvals").length, 0);
});

test("paid tool: a zero quote runs immediately with maxUsd 0.01", async () => {
  const admin = createFakeAdmin();
  let seen: { maxUsd?: number; timeoutMs?: number } | undefined;
  const reg = paidRegistration(async () => ({ ok: true }));
  const set = buildAiToolSet({
    regs: [reg],
    ctx: testCtx(admin),
    skills: [],
    skillLoad: () => null,
    sessionId: "s1",
    turnId: "t1",
    onApproval: () => {},
    turnMemory: {},
    approvalDeps: {
      quote: async () => quote({ totalUsd: 0 }) as never,
      runTool: async (_reg, _ctx, _input, options) => {
        seen = options;
        return {
          ok: true,
          output: { ok: true },
          summary: "Ran the free lookup.",
          link: null,
          untrusted: [],
          truncated: null,
        };
      },
    },
  }) as Record<string, any>;
  const result = await set.qa_paid.execute({ query: "shirts" }, { toolCallId: "call-3" });
  assert.equal(seen?.maxUsd, 0.01);
  assert.equal(result.status, "success");
  assert.equal(result.summary, "Ran the free lookup.");
  assert.equal(admin.rows("assistant_approvals").length, 0);
});

test("execute: an exception never escapes the tool boundary", async () => {
  const admin = createFakeAdmin();
  const reg = {
    ...paidRegistration(async () => ({ ok: true })),
    approval: () => {
      throw new AppError(400, "bad_thing", "Something was wrong.");
    },
  } as unknown as ToolRegistration;
  const set = buildAiToolSet({
    regs: [reg],
    ctx: testCtx(admin),
    skills: [],
    skillLoad: () => null,
    sessionId: "s1",
    turnId: "t1",
    onApproval: () => {},
    turnMemory: {},
  }) as Record<string, any>;
  const result = await set.qa_paid.execute({ query: "shirts" }, { toolCallId: "call-4" });
  assert.equal(result.status, "error");
  assert.equal(result.code, "bad_thing");
  assert.equal(result.message, "Something was wrong.");
});

test("confirm tool: one row with no quote, no price wording and an approval that runs without maxUsd", async () => {
  const admin = createFakeAdmin({
    assistant_sessions: [{ id: "s1", brand_key: "acme-tees", user_id: "user-1" }],
  });
  admin.setNow(() => Date.parse("2026-11-17T10:00:00.000Z"));
  const confirmReg = getTool("submit_indexnow_urls") as ToolRegistration;
  const set = buildAiToolSet({
    regs: [confirmReg],
    ctx: testCtx(admin),
    skills: [],
    skillLoad: () => null,
    sessionId: "s1",
    turnId: "t1",
    onApproval: () => {},
    turnMemory: {},
  }) as Record<string, any>;
  const result = await set.submit_indexnow_urls.execute(
    { urls: ["https://acme.example/a"] },
    { toolCallId: "call-confirm" },
  );
  assert.equal(result.status, "awaiting_approval");
  assert.equal(result.kind, "confirm");
  assert.equal(result.quote, null);
  assert.equal(result.summary.includes("(up to"), false);
  const row = admin.rows("assistant_approvals")[0];
  assert.equal(row.kind, "confirm");
  assert.equal(row.quote, null);
  assert.equal(row.quoted_usd, null);

  let runs = 0;
  let options: Record<string, unknown> | undefined;
  const view = await decideApproval(
    {
      ws: {
        user: { id: "user-1", email: "owner@acme.example" },
        brandKey: "acme-tees",
        brand: BRAND,
        role: "owner",
        admin: admin as never,
      },
      approvalId: result.approvalId,
      decision: "approve",
    },
    {
      now: () => new Date("2026-11-17T10:00:00.000Z"),
      env: {},
      availableTools: async () => [confirmReg],
      runTool: async (_reg, _ctx, _input, toolOptions) => {
        runs += 1;
        options = toolOptions as unknown as Record<string, unknown>;
        return {
          ok: true,
          output: { ok: true },
          summary: "Submitted 3 URLs.",
          link: null,
          untrusted: [],
          truncated: null,
        };
      },
    },
  );
  assert.equal(runs, 1);
  assert.equal(options?.maxUsd, undefined);
  assert.equal(view.status, "executed");
});

test("execute: each tool call carries its own <turnId>:<toolCallId> requestId", async () => {
  const admin = createFakeAdmin();
  const seen: string[] = [];
  const reg = {
    ...paidRegistration(async () => ({ ok: true })),
    effect: "read",
    approval: () => ({ kind: "none" }),
    def: {
      name: "qa_echo",
      description: "Echo.",
      input: z.strictObject({}),
      output: z.looseObject({ ok: z.boolean() }),
      handler: async (ctx: { requestId: string }) => {
        seen.push(ctx.requestId);
        return { ok: true };
      },
    },
  } as unknown as ToolRegistration;
  const set = buildAiToolSet({
    regs: [reg],
    ctx: testCtx(admin),
    skills: [],
    skillLoad: () => null,
    sessionId: "s1",
    turnId: "turn-9",
    onApproval: () => {},
    turnMemory: {},
  }) as Record<string, any>;
  await set.qa_echo.execute({}, { toolCallId: "call-a" });
  await set.qa_echo.execute({}, { toolCallId: "call-b" });
  assert.deepEqual(seen, ["turn-9:call-a", "turn-9:call-b"]);
});

test("requestApproval: duplicate toolCallId returns the same approval", async () => {
  const admin = createFakeAdmin();
  const reg = paidRegistration(async () => ({ ok: true }));
  const build = () =>
    buildAiToolSet({
      regs: [reg],
      ctx: testCtx(admin),
      skills: [],
      skillLoad: () => null,
      sessionId: "s1",
      turnId: "t1",
      onApproval: () => {},
      turnMemory: {},
      approvalDeps: { quote: async () => quote() as never },
    }) as Record<string, any>;
  const first = await build().qa_paid.execute({ query: "shirts" }, { toolCallId: "same-call" });
  const second = await build().qa_paid.execute({ query: "shirts" }, { toolCallId: "same-call" });
  assert.equal(first.status, "awaiting_approval");
  assert.equal(second.status, "awaiting_approval");
  assert.equal(second.approvalId, first.approvalId);
  assert.equal(admin.rows("assistant_approvals").length, 1);
});

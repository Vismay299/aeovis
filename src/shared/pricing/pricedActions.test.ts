import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import {
  definePricedAction,
  getPricedAction,
  quote,
  requireApprovedPrice,
  clearPricedActionsForTesting,
  type PricingContext,
} from "./pricedActions.ts";
import { quoteExceeds } from "../pricing.ts";
import { AppError } from "../http/errors.ts";

function fakeContext(over: Partial<PricingContext> = {}): PricingContext {
  return {
    brandKey: "test.brand",
    admin: {} as any,
    env: {},
    now: new Date("2026-10-21T09:30:00.000Z"),
    ...over,
  };
}

test("quoteExceeds compares values in micro-dollars", () => {
  assert.equal(quoteExceeds(0.0000015, 0.000001), true);
  assert.equal(quoteExceeds(24, 24), false);
  assert.equal(quoteExceeds(24.000001, 24), true);
  assert.equal(quoteExceeds(23.999999, 24), false);
});

test("definePricedAction rejects loose input schema", () => {
  clearPricedActionsForTesting();
  assert.throws(
    () =>
      definePricedAction({
        key: "test.action.loose",
        feature: "platform.selftest",
        input: z.object({ foo: z.string() }), // loose object!
        requireApproval: false,
        estimate: async () => ({
          totalUsd: 1,
          expectedUsd: null,
          units: [],
          lines: [],
          monthly: null,
          warnings: [],
          blocked: null,
        }),
      }),
    (err: any) => err instanceof AppError && err.code === "invalid_action_schema",
  );
});

test("definePricedAction rejects duplicate action key", () => {
  clearPricedActionsForTesting();
  definePricedAction({
    key: "test.action.dupe",
    feature: "platform.selftest",
    input: z.strictObject({ bar: z.string() }),
    requireApproval: false,
    estimate: async () => ({
      totalUsd: 1,
      expectedUsd: null,
      units: [],
      lines: [],
      monthly: null,
      warnings: [],
      blocked: null,
    }),
  });

  assert.throws(
    () =>
      definePricedAction({
        key: "test.action.dupe",
        feature: "platform.selftest",
        input: z.strictObject({ bar: z.string() }),
        requireApproval: false,
        estimate: async () => ({
          totalUsd: 1,
          expectedUsd: null,
          units: [],
          lines: [],
          monthly: null,
          warnings: [],
          blocked: null,
        }),
      }),
    (err: any) => err instanceof AppError && err.code === "duplicate_price_action",
  );
});

test("quote throws 404 unknown_price_action for unregistered key", async () => {
  clearPricedActionsForTesting();
  await assert.rejects(
    async () => quote("unknown.action.key", fakeContext(), {}),
    (err: any) => err instanceof AppError && err.status === 404 && err.code === "unknown_price_action",
  );
});

test("quote validates rawInput against action input schema", async () => {
  clearPricedActionsForTesting();
  definePricedAction({
    key: "test.action.schema",
    feature: "platform.selftest",
    input: z.strictObject({ count: z.number().int().min(1) }),
    requireApproval: false,
    estimate: async (_ctx, input) => ({
      totalUsd: input.count * 0.1,
      expectedUsd: null,
      units: [],
      lines: [],
      monthly: null,
      warnings: [],
      blocked: null,
    }),
  });

  // Fails with extra property (strictObject)
  await assert.rejects(
    async () => quote("test.action.schema", fakeContext(), { count: 5, extra: true }),
    (err: any) => err instanceof z.ZodError,
  );

  // Succeeds with valid input
  const res = await quote("test.action.schema", fakeContext(), { count: 5 });
  assert.equal(res.action, "test.action.schema");
  assert.equal(res.totalUsd, 0.5);
  assert.match(res.inputsHash, /^[0-9a-f]{64}$/);
});

test("requireApprovedPrice returns implicit approval when maxUsd is undefined and requireApproval is false", async () => {
  clearPricedActionsForTesting();
  definePricedAction({
    key: "test.action.implicit",
    feature: "platform.selftest",
    input: z.strictObject({}),
    requireApproval: false,
    estimate: async () => ({
      totalUsd: 10,
      expectedUsd: 5,
      units: [],
      lines: [],
      monthly: null,
      warnings: [],
      blocked: null,
    }),
  });

  const res = await requireApprovedPrice("test.action.implicit", fakeContext(), {}, undefined);
  assert.equal(res.source, "implicit");
  assert.equal(res.approvedMaxUsd, 10);
  assert.equal(res.quote.totalUsd, 10);
});

test("requireApprovedPrice throws 400 approval_required when maxUsd is undefined and requireApproval is true", async () => {
  clearPricedActionsForTesting();
  definePricedAction({
    key: "test.action.required",
    feature: "platform.selftest",
    input: z.strictObject({}),
    requireApproval: true,
    estimate: async () => ({
      totalUsd: 15,
      expectedUsd: null,
      units: [],
      lines: [],
      monthly: null,
      warnings: [],
      blocked: null,
    }),
  });

  await assert.rejects(
    async () => requireApprovedPrice("test.action.required", fakeContext(), {}, undefined),
    (err: any) =>
      err instanceof AppError &&
      err.status === 400 &&
      err.code === "approval_required" &&
      (err.details as any)?.quote?.totalUsd === 15,
  );
});

test("requireApprovedPrice throws 409 with blocked code when quote is blocked", async () => {
  clearPricedActionsForTesting();
  definePricedAction({
    key: "test.action.blocked",
    feature: "platform.selftest",
    input: z.strictObject({}),
    requireApproval: false,
    estimate: async () => ({
      totalUsd: 0,
      expectedUsd: null,
      units: [],
      lines: [],
      monthly: null,
      warnings: [],
      blocked: {
        code: "panel_not_approved",
        message: "Scans ask the questions in your approved question panel. Review and approve it first.",
        recovery: "Open Questions & evidence to approve the panel.",
      },
    }),
  });

  await assert.rejects(
    async () => requireApprovedPrice("test.action.blocked", fakeContext(), {}, 10),
    (err: any) =>
      err instanceof AppError &&
      err.status === 409 &&
      err.code === "panel_not_approved" &&
      err.message === "Scans ask the questions in your approved question panel. Review and approve it first." &&
      err.recovery === "Open Questions & evidence to approve the panel." &&
      err.details?.quote !== undefined,
  );
});

test("requireApprovedPrice throws 409 price_changed when fresh quote exceeds approved maxUsd", async () => {
  clearPricedActionsForTesting();
  definePricedAction({
    key: "test.action.exceeds",
    feature: "platform.selftest",
    input: z.strictObject({}),
    requireApproval: false,
    estimate: async () => ({
      totalUsd: 26.4,
      expectedUsd: 7.92,
      units: [{ key: "answers", label: "answers", count: 132 }],
      lines: [{ label: "Answers reserved at $0.20 each", quantity: 132, unitUsd: 0.2, totalUsd: 26.4 }],
      monthly: null,
      warnings: [],
      blocked: null,
    }),
  });

  await assert.rejects(
    async () => requireApprovedPrice("test.action.exceeds", fakeContext(), {}, 24.0),
    (err: any) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.status, 409);
      assert.equal(err.code, "price_changed");
      assert.equal((err.details as any)?.approvedMaxUsd, 24);
      assert.equal((err.details as any)?.quote?.totalUsd, 26.4);
      assert.equal(err.recovery, "Review the new price and approve it to continue.");
      return true;
    },
  );
});

test("requireApprovedPrice succeeds when approved maxUsd >= fresh quote", async () => {
  clearPricedActionsForTesting();
  definePricedAction({
    key: "test.action.pass",
    feature: "platform.selftest",
    input: z.strictObject({}),
    requireApproval: false,
    estimate: async () => ({
      totalUsd: 24.0,
      expectedUsd: 7.2,
      units: [],
      lines: [],
      monthly: null,
      warnings: [],
      blocked: null,
    }),
  });

  const res = await requireApprovedPrice("test.action.pass", fakeContext(), {}, 24.0);
  assert.equal(res.source, "dialog");
  assert.equal(res.approvedMaxUsd, 24.0);
  assert.equal(res.quote.totalUsd, 24.0);

  // Also when customer approved higher headroom (e.g. 30.0)
  const resHigher = await requireApprovedPrice("test.action.pass", fakeContext(), {}, 30.0);
  assert.equal(resHigher.approvedMaxUsd, 30.0);
});

test("quote throws a non-Zod error when the estimate breaks the quote schema", async () => {
  clearPricedActionsForTesting();
  definePricedAction({
    key: "test.action.bad_output",
    feature: "platform.selftest",
    input: z.strictObject({}),
    requireApproval: false,
    estimate: async () => ({
      totalUsd: -1,
      expectedUsd: null,
      units: [],
      lines: [],
      monthly: null,
      warnings: [],
      blocked: null,
    }),
  });
  await assert.rejects(
    () => quote("test.action.bad_output", fakeContext(), {}),
    (err: any) => !(err instanceof z.ZodError) && !(err instanceof AppError),
  );
});

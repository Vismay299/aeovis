import test from "node:test";
import assert from "node:assert/strict";
import { AppError } from "../http/appError.ts";
import { reserveSpend, settleSpend, settleSpendBatch } from "./index.ts";
import { isSpendFeature, SPEND_FEATURES } from "./features.ts";
import { SPEND_FEATURES as SHARED_SPEND_FEATURES } from "../../shared/spend-features.ts";
import { usd6 } from "./money.ts";
import { createMemoryStore } from "./memoryStore.ts";
import type { MemoryControl, MemorySpendStore } from "./memoryStore.ts";
import type { SpendStore } from "./store.ts";
import { SpendRefused } from "./errors.ts";

const FEATURE = "platform.selftest";
const BRAND = "qa-brand.example";
const ENV: Record<string, string | undefined> = {};

function enabledControl(overrides: Partial<MemoryControl> = {}): MemoryControl {
  return {
    enabled: true,
    mode: "all",
    brandAllowlist: [],
    dailyCapUsd: null,
    maxCallUsd: null,
    ...overrides,
  };
}

type StoreSeed = {
  controls?: Record<string, MemoryControl>;
  limits?: Record<string, { dailyCapUsd: number | null; monthlyCapUsd: number | null }>;
  now?: () => number;
};

function storeWith(seed: StoreSeed = {}): MemorySpendStore {
  return createMemoryStore({
    controls: seed.controls ?? { [FEATURE]: enabledControl() },
    limits: seed.limits ?? {},
    now: seed.now,
  });
}

function shortId(): string {
  return `idem-${Math.random().toString(36).slice(2)}`;
}

async function refusal(promise: Promise<unknown>): Promise<SpendRefused> {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof SpendRefused, `expected SpendRefused, got ${String(err)}`);
    return err;
  }
  assert.fail("expected a SpendRefused");
}

async function appError(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof AppError, `expected AppError, got ${String(err)}`);
    return err;
  }
  assert.fail("expected an AppError");
}

test("reserveSpend rejects an estimate that is not a positive finite number under USD 1,000", async () => {
  for (const estimateUsd of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1000.000001]) {
    const err = await appError(
      reserveSpend({ brandKey: BRAND, feature: FEATURE, estimateUsd, idempotencyKey: shortId() }, { store: storeWith(), env: ENV })
    );
    assert.equal(err.status, 400);
    assert.equal(err.code, "spend_invalid");
  }
});

test("reserveSpend enforces the hold TTL bounds and defaults the TTL to 1,800 seconds", async () => {
  const store = storeWith();
  for (const ttlSeconds of [59, 86_341, 60.5]) {
    const err = await appError(
      reserveSpend(
        { brandKey: BRAND, feature: FEATURE, estimateUsd: 1, idempotencyKey: shortId(), ttlSeconds },
        { store, env: ENV }
      )
    );
    assert.equal(err.code, "spend_invalid");
  }
  const { holdId } = await reserveSpend({ brandKey: BRAND, feature: FEATURE, estimateUsd: 1, idempotencyKey: shortId() }, { store, env: ENV });
  const hold = store.holds.get(holdId);
  assert.ok(hold);
  assert.equal(hold.expiresAt - hold.createdAt, 1_800_000);
});

test("reserveSpend rejects an idempotency key outside 1-300 characters", async () => {
  const store = storeWith();
  for (const idempotencyKey of ["", "k".repeat(301)]) {
    const err = await appError(
      reserveSpend({ brandKey: BRAND, feature: FEATURE, estimateUsd: 1, idempotencyKey }, { store, env: ENV })
    );
    assert.equal(err.code, "spend_invalid");
  }
  await reserveSpend({ brandKey: BRAND, feature: FEATURE, estimateUsd: 1, idempotencyKey: "k".repeat(300) }, { store, env: ENV });
});

test("reserveSpend refuses feature_disabled when the control row is missing, disabled, or does not admit the brand", async () => {
  const missing = storeWith({ controls: {} });
  const disabled = storeWith({ controls: { [FEATURE]: enabledControl({ enabled: false }) } });
  const allowlisted = storeWith({
    controls: { [FEATURE]: enabledControl({ mode: "allowlist", brandAllowlist: ["another-brand.example"] }) },
  });

  for (const store of [missing, disabled, allowlisted]) {
    const err = await refusal(reserveSpend({ brandKey: BRAND, feature: FEATURE, estimateUsd: 1, idempotencyKey: shortId() }, { store, env: ENV }));
    assert.equal(err.reason, "feature_disabled");
    assert.equal(err.status, 403);
    assert.equal(err.message, "This feature is not enabled for your workspace.");
    assert.equal(store.holds.size, 0, "a refusal must not create a hold");
  }

  const admitted = storeWith({ controls: { [FEATURE]: enabledControl({ mode: "allowlist", brandAllowlist: [BRAND] }) } });
  const { holdId } = await reserveSpend({ brandKey: BRAND, feature: FEATURE, estimateUsd: 1, idempotencyKey: shortId() }, { store: admitted, env: ENV });
  assert.ok(holdId);
});

test("reserveSpend refuses over_approved_max for the caller's maxUsd and for the feature's platform maxCallUsd", async () => {
  const store = storeWith();
  const callerMax = await refusal(
    reserveSpend({ brandKey: BRAND, feature: FEATURE, estimateUsd: 1, maxUsd: 0.5, idempotencyKey: shortId() }, { store, env: ENV })
  );
  assert.equal(callerMax.reason, "over_approved_max");
  assert.equal(callerMax.status, 409);
  assert.equal(callerMax.details?.estimateUsd, 1);

  const platformMax = storeWith({ controls: { [FEATURE]: enabledControl({ maxCallUsd: 0.5 }) } });
  const err = await refusal(
    reserveSpend({ brandKey: BRAND, feature: FEATURE, estimateUsd: 1, idempotencyKey: shortId() }, { store: platformMax, env: ENV })
  );
  assert.equal(err.reason, "over_approved_max");
  assert.equal(err.limitUsd, 0.5);
  assert.equal(platformMax.holds.size, 0);
});

test("reserveSpend refuses daily_cap for the feature platform cap and for the workspace daily cap", async () => {
  const featureCapped = storeWith({ controls: { [FEATURE]: enabledControl({ dailyCapUsd: 5 }) } });
  const featureErr = await refusal(
    reserveSpend({ brandKey: BRAND, feature: FEATURE, estimateUsd: 6, idempotencyKey: shortId() }, { store: featureCapped, env: ENV })
  );
  assert.equal(featureErr.reason, "daily_cap");
  assert.equal(featureErr.status, 402);
  assert.equal(featureErr.scope, "feature");

  const workspaceCapped = storeWith({ limits: { [BRAND]: { dailyCapUsd: 5, monthlyCapUsd: null } } });
  const workspaceErr = await refusal(
    reserveSpend({ brandKey: BRAND, feature: FEATURE, estimateUsd: 6, idempotencyKey: shortId() }, { store: workspaceCapped, env: ENV })
  );
  assert.equal(workspaceErr.reason, "daily_cap");
  assert.equal(workspaceErr.scope, "workspace");
  assert.equal(workspaceErr.limitUsd, 5);
  assert.match(workspaceErr.message, /Today's spend limit/);
  assert.equal(workspaceCapped.holds.size, 0);

  const granted = await reserveSpend({ brandKey: BRAND, feature: FEATURE, estimateUsd: 5, idempotencyKey: shortId() }, { store: workspaceCapped, env: ENV });
  assert.ok(granted.holdId, "an estimate that lands exactly on the cap is granted");
});

test("reserveSpend refuses workspace_cap for the workspace monthly cap", async () => {
  const store = storeWith({ limits: { [BRAND]: { dailyCapUsd: null, monthlyCapUsd: 10 } } });
  const err = await refusal(
    reserveSpend({ brandKey: BRAND, feature: FEATURE, estimateUsd: 11, idempotencyKey: shortId() }, { store, env: ENV })
  );
  assert.equal(err.reason, "workspace_cap");
  assert.equal(err.status, 402);
  assert.equal(err.limitUsd, 10);
  assert.match(err.message, /This month's spend limit/);
  assert.equal(store.holds.size, 0);
});

test("reserveSpend returns the same hold for the same (brandKey, idempotencyKey) while it is held", async () => {
  const store = storeWith();
  const idempotencyKey = shortId();
  const first = await reserveSpend({ brandKey: BRAND, feature: FEATURE, estimateUsd: 1, idempotencyKey }, { store, env: ENV });
  const second = await reserveSpend({ brandKey: BRAND, feature: FEATURE, estimateUsd: 1, idempotencyKey }, { store, env: ENV });
  assert.equal(second.holdId, first.holdId);
  assert.equal(store.holds.size, 1);
});

test("reserveSpend throws 409 duplicate_paid_call after the hold was settled or released", async () => {
  for (const close of ["settle", "release"] as const) {
    const store = storeWith();
    const idempotencyKey = shortId();
    const { holdId } = await reserveSpend({ brandKey: BRAND, feature: FEATURE, estimateUsd: 1, idempotencyKey }, { store, env: ENV });
    if (close === "settle") {
      await settleSpendBatch(holdId, [{ provider: "openrouter", endpoint: "chat:qa", actualUsd: 1, costSource: "provider_reported" }], { store, env: ENV });
    } else {
      await store.release(holdId, "not_billed");
    }
    const err = await appError(
      reserveSpend({ brandKey: BRAND, feature: FEATURE, estimateUsd: 1, idempotencyKey }, { store, env: ENV })
    );
    assert.equal(err.status, 409);
    assert.equal(err.code, "duplicate_paid_call");
    assert.equal(err.message, "This paid request was already made.");
  }
});

test("reserveSpend reads the workspace default caps from the environment", async () => {
  const fiveAsString = storeWith();
  const refusedErr = await refusal(
    reserveSpend({ brandKey: BRAND, feature: FEATURE, estimateUsd: 6, idempotencyKey: shortId() }, { store: fiveAsString, env: { SPEND_DEFAULT_DAILY_CAP_USD: "5" } })
  );
  assert.equal(refusedErr.reason, "daily_cap");
  assert.equal(refusedErr.limitUsd, 5);

  const blank = storeWith();
  const granted = await reserveSpend({ brandKey: BRAND, feature: FEATURE, estimateUsd: 6, idempotencyKey: shortId() }, { store: blank, env: { SPEND_DEFAULT_DAILY_CAP_USD: "" } });
  assert.ok(granted.holdId, "a blank default means no cap");

  const notANumber = storeWith();
  const configErr = await appError(
    reserveSpend({ brandKey: BRAND, feature: FEATURE, estimateUsd: 6, idempotencyKey: shortId() }, { store: notANumber, env: { SPEND_DEFAULT_MONTHLY_CAP_USD: "abc" } })
  );
  assert.equal(configErr.status, 500);
  assert.equal(configErr.code, "spend_config_invalid");

  const negative = storeWith();
  const negativeErr = await appError(
    reserveSpend({ brandKey: BRAND, feature: FEATURE, estimateUsd: 6, idempotencyKey: shortId() }, { store: negative, env: { SPEND_DEFAULT_DAILY_CAP_USD: "-1" } })
  );
  assert.equal(negativeErr.code, "spend_config_invalid");
});

test("reserveSpend fails closed with 503 spend_unavailable when the store throws", async () => {
  const store = storeWith();
  const failing: SpendStore = {
    ...store,
    reserve: async () => {
      throw new Error("connection refused");
    },
  };
  const err = await appError(
    reserveSpend({ brandKey: BRAND, feature: FEATURE, estimateUsd: 1, idempotencyKey: shortId() }, { store: failing, env: ENV })
  );
  assert.equal(err.status, 503);
  assert.equal(err.code, "spend_unavailable");
  assert.equal(err.message, "Spend control is unavailable, so paid work is paused.");
});

test("settleSpend records the price-table cost source when the provider did not report a cost", async () => {
  const store = storeWith();
  const { holdId } = await reserveSpend({ brandKey: BRAND, feature: FEATURE, estimateUsd: 1, idempotencyKey: shortId() }, { store, env: ENV });
  await settleSpend(holdId, 0.25, { provider: "dataforseo", endpoint: "serp", providerCostReported: false }, { store, env: ENV });
  const rows = store.ledger.filter((row) => row.holdId === holdId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].costSource, "price_table");
  assert.equal(rows[0].actualUsd, 0.25);
  assert.equal(rows[0].accountedUsd, 0.25);
  assert.equal(store.holds.get(holdId)?.status, "settled");
});

test("settleSpendBatch never throws: it retries once and then logs one settle failure", async () => {
  const store = storeWith();
  let calls = 0;
  const failing: SpendStore = {
    ...store,
    settle: async () => {
      calls += 1;
      throw new Error("rpc failed");
    },
  };
  const errors: unknown[][] = [];
  const logger = { error: (...args: unknown[]) => errors.push(args), warn: () => {} };
  await settleSpendBatch("00000000-0000-0000-0000-000000000000", [{ provider: "openrouter", endpoint: "chat:qa", actualUsd: 1, costSource: "provider_reported" }], { store: failing, env: ENV, logger });
  assert.equal(calls, 2, "the failed RPC is retried exactly once");
  assert.equal(errors.length, 1);
  assert.equal(errors[0][0], "[spend] settle failed");
  assert.deepEqual(errors[0][1], { holdId: "00000000-0000-0000-0000-000000000000", rows: 1 });
});

test("usd6 rounds half-up to six decimals and SPEND_FEATURES is a closed union", () => {
  assert.equal(usd6(0.1 + 0.2), 0.3);
  assert.equal(usd6(1.0000005), 1.000001);
  assert.equal(usd6(0.1234565), 0.123457);
  assert.deepEqual([...SPEND_FEATURES], ["platform.selftest"]);
  assert.strictEqual(SPEND_FEATURES, SHARED_SPEND_FEATURES, "the lib path re-exports the shared array");
  assert.equal(isSpendFeature("platform.selftest"), true);
  assert.equal(isSpendFeature("platform.selftest.extra"), false);
});

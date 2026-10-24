import test from "node:test";
import assert from "node:assert/strict";
import { AppError } from "../http/appError.ts";
import {
  AmbiguousCallError,
  ChargedCallError,
  UnbilledCallError,
  metered,
  settleSpendBatch,
} from "./index.ts";
import { createMemoryStore } from "./memoryStore.ts";
import type { MemoryControl, MemorySpendStore } from "./memoryStore.ts";
import type { SpendDeps } from "./index.ts";
import type { SpendStore } from "./store.ts";

const FEATURE = "platform.selftest";
const BRAND = "qa-brand.example";
const ENV: Record<string, string | undefined> = {};

type Harness = {
  store: MemorySpendStore;
  calls: { settle: number; release: string[] };
  logger: { lines: unknown[][]; error: (...args: unknown[]) => void; warn: () => void };
  keepAliveCalls: { label?: string }[];
  deps: {
    store: SpendStore;
    env: Record<string, string | undefined>;
    keepAlive: NonNullable<SpendDeps["keepAlive"]>;
    logger: { error: (...args: unknown[]) => void; warn: () => void };
  };
};

function harness(control: Partial<MemoryControl> = {}, opts: { awaitInKeepAlive?: boolean } = {}): Harness {
  const store = createMemoryStore({
    controls: {
      [FEATURE]: {
        enabled: true,
        mode: "all",
        brandAllowlist: [],
        dailyCapUsd: null,
        maxCallUsd: null,
        ...control,
      },
    },
  });
  const calls = { settle: 0, release: [] as string[] };
  const spy: SpendStore = {
    ...store,
    settle: async (holdId, costs) => {
      calls.settle += 1;
      return store.settle(holdId, costs);
    },
    release: async (holdId, reason) => {
      calls.release.push(reason);
      return store.release(holdId, reason);
    },
  };
  const lines: unknown[][] = [];
  const logger = {
    lines,
    error: (...args: unknown[]) => {
      lines.push(args);
    },
    warn: () => {},
  };
  const keepAliveCalls: { label?: string }[] = [];
  const keepAlive: NonNullable<SpendDeps["keepAlive"]> = (work, options) => {
    keepAliveCalls.push({ label: options?.label });
    if (!opts.awaitInKeepAlive) return Promise.resolve();
    return Promise.resolve(typeof work === "function" ? work() : work).then(() => undefined);
  };
  return {
    store,
    calls,
    logger,
    keepAliveCalls,
    deps: { store: spy, env: ENV, keepAlive, logger },
  };
}

function onlyHold(store: MemorySpendStore) {
  const holds = [...store.holds.values()];
  assert.equal(holds.length, 1, "metered must create exactly one hold");
  return holds[0];
}

test("metered: billed === false releases the hold with not_billed and returns the value", async () => {
  const h = harness();
  const value = await metered(
    { brandKey: BRAND, feature: FEATURE, estimateUsd: 1, idempotencyKey: "billed-false" },
    async () => ({ value: "cached", actualUsd: 0, provider: "dataforseo", endpoint: "serp", billed: false }),
    h.deps
  );
  assert.equal(value, "cached");
  assert.deepEqual(h.calls.release, ["not_billed"]);
  assert.equal(h.calls.settle, 0);
  assert.equal(onlyHold(h.store).status, "released");
  assert.equal(h.store.ledger.length, 0, "a released hold writes no ledger row");
});

test("metered: billed === true settles on actualUsd and returns the value", async () => {
  const h = harness();
  const value = await metered(
    { brandKey: BRAND, feature: FEATURE, estimateUsd: 1, idempotencyKey: "billed-true" },
    async () => ({ value: { ok: true }, actualUsd: 0.4, provider: "openrouter", endpoint: "chat:qa", billed: true, units: 12 }),
    h.deps
  );
  assert.deepEqual(value, { ok: true });
  assert.equal(h.calls.settle, 1);
  const hold = onlyHold(h.store);
  assert.equal(hold.status, "settled");
  assert.equal(hold.actualUsd, 0.4);
  const row = h.store.ledger[0];
  assert.equal(row.provider, "openrouter");
  assert.equal(row.endpoint, "chat:qa");
  assert.equal(row.units, 12);
  assert.equal(row.actualUsd, 0.4);
  assert.equal(row.costSource, "provider_reported");
});

test("metered: billed === true with a null actual records the estimate as the reservation", async () => {
  const h = harness();
  await metered(
    { brandKey: BRAND, feature: FEATURE, estimateUsd: 0.5, idempotencyKey: "billed-unknown" },
    async () => ({ value: null, actualUsd: null, provider: "openrouter", endpoint: "chat:qa", billed: true }),
    h.deps
  );
  const hold = onlyHold(h.store);
  assert.equal(hold.status, "settled");
  assert.equal(hold.actualUsd, null);
  const row = h.store.ledger[0];
  assert.equal(row.actualUsd, null);
  assert.equal(row.accountedUsd, 0.5);
  assert.equal(row.costSource, "reservation");
});

test("metered: UnbilledCallError releases the hold with unbilled_error and rethrows", async () => {
  const h = harness();
  const failure = new UnbilledCallError("validation rejected the request");
  await assert.rejects(
    metered({ brandKey: BRAND, feature: FEATURE, estimateUsd: 1, idempotencyKey: "unbilled" }, async () => {
      throw failure;
    }, h.deps),
    (err: unknown) => err === failure
  );
  assert.deepEqual(h.calls.release, ["unbilled_error"]);
  assert.equal(onlyHold(h.store).status, "released");
  assert.equal(h.store.ledger.length, 0);
});

test("metered: ChargedCallError settles at its actualUsd and rethrows", async () => {
  const h = harness();
  const failure = new ChargedCallError("upstream 500 after billing", {
    actualUsd: 0.75,
    provider: "openrouter",
    endpoint: "chat:qa",
  });
  await assert.rejects(
    metered({ brandKey: BRAND, feature: FEATURE, estimateUsd: 1, idempotencyKey: "charged" }, async () => {
      throw failure;
    }, h.deps),
    (err: unknown) => err === failure
  );
  const hold = onlyHold(h.store);
  assert.equal(hold.status, "settled");
  assert.equal(hold.actualUsd, 0.75);
  assert.equal(h.store.ledger[0].provider, "openrouter");
  assert.equal(h.store.ledger[0].endpoint, "chat:qa");
});

test("metered: AmbiguousCallError settles an unknown cost at the estimate and logs the ambiguous line", async () => {
  const h = harness();
  const failure = new AmbiguousCallError("socket closed after send");
  await assert.rejects(
    metered({ brandKey: BRAND, feature: FEATURE, estimateUsd: 0.25, idempotencyKey: "ambiguous" }, async () => {
      throw failure;
    }, h.deps),
    (err: unknown) => err === failure
  );
  const hold = onlyHold(h.store);
  assert.equal(hold.status, "settled");
  assert.equal(h.store.ledger[0].accountedUsd, 0.25);
  assert.equal(h.store.ledger[0].costSource, "reservation");
  assert.deepEqual(h.logger.lines, [
    ["[spend] ambiguous call", { holdId: hold.id, feature: FEATURE }],
  ]);
});

test("metered: any other thrown error is counted at the estimate and rethrown", async () => {
  const h = harness();
  const failure = new TypeError("parser blew up");
  await assert.rejects(
    metered({ brandKey: BRAND, feature: FEATURE, estimateUsd: 0.25, idempotencyKey: "other" }, async () => {
      throw failure;
    }, h.deps),
    (err: unknown) => err === failure
  );
  assert.equal(onlyHold(h.store).status, "settled");
  assert.equal(h.store.ledger[0].accountedUsd, 0.25);
  assert.deepEqual(h.logger.lines, [["[spend] unclassified call error", "TypeError"]]);
});

test("metered: an actual cost above the estimate logs exactly one undershoot line with the five named fields", async () => {
  const h = harness();
  await metered(
    { brandKey: BRAND, feature: FEATURE, estimateUsd: 0.001, idempotencyKey: "undershoot" },
    async () => ({ value: "ok", actualUsd: 0.002, provider: "openrouter", endpoint: "chat:qa", billed: true }),
    h.deps
  );
  const undershoot = h.logger.lines.filter((line) => line[0] === "[spend] estimate undershoot");
  assert.equal(undershoot.length, 1);
  assert.deepEqual(Object.keys(undershoot[0][1] as Record<string, unknown>).sort(), [
    "actualUsd",
    "endpoint",
    "estimateUsd",
    "feature",
    "provider",
  ]);
  assert.deepEqual(undershoot[0][1], {
    feature: FEATURE,
    provider: "openrouter",
    endpoint: "chat:qa",
    estimateUsd: 0.001,
    actualUsd: 0.002,
  });
  assert.equal(h.store.ledger[0].meta.undershoot, true);
});

test("metered: the hold is settled even when the caller's promise has already rejected (keepAlive)", async () => {
  const h = harness({}, { awaitInKeepAlive: false });
  await assert.rejects(
    metered({ brandKey: BRAND, feature: FEATURE, estimateUsd: 1, idempotencyKey: "caller-rejects" }, async () => {
      throw new UnbilledCallError("no charge");
    }, h.deps)
  );
  assert.equal(h.keepAliveCalls.length, 1);
  assert.equal(h.keepAliveCalls[0].label, `metered:${FEATURE}`);
  assert.equal(onlyHold(h.store).status, "released");
});

test("metered: uses the real keepAlive when deps does not inject one", async () => {
  const store = createMemoryStore({
    controls: { [FEATURE]: { enabled: true, mode: "all", brandAllowlist: [], dailyCapUsd: null, maxCallUsd: null } },
  });
  const value = await metered(
    { brandKey: BRAND, feature: FEATURE, estimateUsd: 1, idempotencyKey: "real-keepalive" },
    async () => ({ value: 42, actualUsd: 1, provider: "openrouter", endpoint: "chat:qa", billed: true }),
    { store, env: ENV }
  );
  assert.equal(value, 42);
  assert.equal([...store.holds.values()][0].status, "settled");
});

test("metered: reserves before calling and does not call the provider when the reservation is refused", async () => {
  const h = harness({ enabled: false });
  let called = false;
  await assert.rejects(
    metered({ brandKey: BRAND, feature: FEATURE, estimateUsd: 1, idempotencyKey: "refused" }, async () => {
      called = true;
      return { value: "x", actualUsd: 0, provider: "p", endpoint: "e", billed: false };
    }, h.deps),
    /not enabled/
  );
  assert.equal(called, false);
  assert.equal(h.keepAliveCalls.length, 0);
});

function named(h: Harness, line: string): unknown[][] {
  return h.logger.lines.filter((entry) => entry[0] === line);
}

test("metered: an existing hold behind a live reservation throws 409 before calling the provider", async () => {
  const h = harness();
  const store: SpendStore = {
    ...h.deps.store,
    reserve: async () => ({ granted: true, holdId: "11111111-1111-1111-1111-111111111111", existing: true }),
  };
  let called = 0;
  await assert.rejects(
    metered({ brandKey: BRAND, feature: FEATURE, estimateUsd: 1, idempotencyKey: "existing" }, async () => {
      called += 1;
      return { value: "x", actualUsd: 0, provider: "p", endpoint: "e", billed: false };
    }, { ...h.deps, store }),
    (err: unknown) => {
      assert.ok(err instanceof AppError, `expected AppError, got ${String(err)}`);
      assert.equal(err.status, 409);
      assert.equal(err.code, "duplicate_paid_call");
      assert.equal(err.message, "This paid request was already made.");
      return true;
    }
  );
  assert.equal(called, 0, "a duplicate must not re-run the paid call");
  assert.equal(h.keepAliveCalls.length, 0, "a duplicate registers no keepAlive");
  assert.equal(h.calls.settle, 0);
  assert.deepEqual(h.calls.release, []);
});

test("metered: a failed release on billed === false still returns the value and logs one release failure", async () => {
  const h = harness();
  const store: SpendStore = {
    ...h.deps.store,
    release: async () => {
      throw new Error("release rpc failed");
    },
  };
  const value = await metered(
    { brandKey: BRAND, feature: FEATURE, estimateUsd: 1, idempotencyKey: "release-fails-unbilled" },
    async () => ({ value: "cached", actualUsd: 0, provider: "dataforseo", endpoint: "serp", billed: false }),
    { ...h.deps, store }
  );
  assert.equal(value, "cached", "the release failure does not reach the caller");
  const failed = named(h, "[spend] release failed");
  assert.equal(failed.length, 1);
  assert.equal(h.logger.lines.length, 1, "nothing else is logged");
  assert.deepEqual(failed[0][1], { holdId: onlyHold(h.store).id, reason: "not_billed" });
});

test("metered: a failed release keeps the UnbilledCallError, logs once, and never settles", async () => {
  const h = harness();
  const store: SpendStore = {
    ...h.deps.store,
    release: async () => {
      throw new Error("release rpc failed");
    },
  };
  const failure = new UnbilledCallError("validation rejected the request");
  await assert.rejects(
    metered({ brandKey: BRAND, feature: FEATURE, estimateUsd: 1, idempotencyKey: "release-fails-unbilled-error" }, async () => {
      throw failure;
    }, { ...h.deps, store }),
    (err: unknown) => err === failure
  );
  const failed = named(h, "[spend] release failed");
  assert.equal(failed.length, 1);
  assert.deepEqual(failed[0][1], { holdId: onlyHold(h.store).id, reason: "unbilled_error" });
  assert.equal(h.calls.settle, 0, "a failed release is not turned into a settle");
});

test("metered: a skipped settle logs settle skipped and still evaluates the over-max alert", async () => {
  const h = harness();
  const skipped = { settled: false, status: "settled", feature: FEATURE, estimateUsd: 0.5, maxUsd: 1, actualUsd: 1.5 };
  const store: SpendStore = {
    ...h.deps.store,
    settle: async () => {
      h.calls.settle += 1;
      return skipped;
    },
  };
  const value = await metered(
    { brandKey: BRAND, feature: FEATURE, estimateUsd: 0.5, maxUsd: 1, idempotencyKey: "skipped-settle" },
    async () => ({ value: "ok", actualUsd: 1.5, provider: "openrouter", endpoint: "chat:qa", billed: true }),
    { ...h.deps, store }
  );
  assert.equal(value, "ok");
  const holdId = onlyHold(h.store).id;
  const skippedLines = named(h, "[spend] settle skipped");
  assert.equal(skippedLines.length, 1);
  assert.deepEqual(skippedLines[0][1], { holdId, status: "settled" });
  const overMax = named(h, "[spend] over approved max");
  assert.equal(overMax.length, 1);
  assert.deepEqual(overMax[0][1], { holdId, maxUsd: 1, actualUsd: 1.5 });
});

test("metered: a retried settle that comes back skipped still logs the over-max alert", async () => {
  const h = harness();
  const skipped = { settled: false, status: "settled", feature: FEATURE, estimateUsd: 0.5, maxUsd: 1, actualUsd: 1.5 };
  let calls = 0;
  const store: SpendStore = {
    ...h.deps.store,
    settle: async () => {
      calls += 1;
      if (calls === 1) throw new Error("rpc timed out");
      return skipped;
    },
  };
  await metered(
    { brandKey: BRAND, feature: FEATURE, estimateUsd: 0.5, maxUsd: 1, idempotencyKey: "skipped-retry" },
    async () => ({ value: "ok", actualUsd: 1.5, provider: "openrouter", endpoint: "chat:qa", billed: true }),
    { ...h.deps, store }
  );
  assert.equal(calls, 2, "the thrown settle is retried once");
  const holdId = onlyHold(h.store).id;
  assert.equal(named(h, "[spend] settle failed").length, 0);
  assert.equal(named(h, "[spend] settle skipped").length, 1);
  const overMax = named(h, "[spend] over approved max");
  assert.equal(overMax.length, 1, "the alert survives the first thrown attempt");
  assert.deepEqual(overMax[0][1], { holdId, maxUsd: 1, actualUsd: 1.5 });
});

test("metered: a late settle logs the late settle line", async () => {
  const h = harness();
  const store: SpendStore = {
    ...h.deps.store,
    settle: async () => {
      h.calls.settle += 1;
      return { settled: true, late: true, actualUsd: 2 };
    },
  };
  const value = await metered(
    { brandKey: BRAND, feature: FEATURE, estimateUsd: 1, idempotencyKey: "late-settle" },
    async () => ({ value: "ok", actualUsd: 2, provider: "openrouter", endpoint: "chat:qa", billed: true }),
    { ...h.deps, store }
  );
  assert.equal(value, "ok");
  const late = named(h, "[spend] late settle");
  assert.equal(late.length, 1);
  assert.deepEqual(late[0][1], { holdId: onlyHold(h.store).id, actualUsd: 2 });
});

test("metered: a release that closed nothing logs one release failure and keeps the value", async () => {
  const h = harness();
  const store: SpendStore = {
    ...h.deps.store,
    // What release_spend answers when the hold is no longer `held` — already swept by the
    // expiry sweep, so the unbilled call is about to be charged at its estimate.
    release: async () => false,
  };
  const value = await metered(
    { brandKey: BRAND, feature: FEATURE, estimateUsd: 1, idempotencyKey: "release-returns-false" },
    async () => ({ value: "cached", actualUsd: 0, provider: "openrouter", endpoint: "chat:qa", billed: false }),
    { ...h.deps, store }
  );
  assert.equal(value, "cached");
  const failed = named(h, "[spend] release failed");
  assert.equal(failed.length, 1, "a release that closed no hold is not a silent success");
  assert.deepEqual(failed[0][1], { holdId: onlyHold(h.store).id, reason: "not_billed" });
});

test("metered: a retried settle on the same hold does not re-emit the over-max alert", async () => {
  const h = harness();
  const skipped = { settled: false, status: "settled", feature: FEATURE, estimateUsd: 0.5, maxUsd: 1, actualUsd: 1.5 };
  let first = true;
  const store: SpendStore = {
    ...h.deps.store,
    settle: async (holdId, costs) => {
      h.calls.settle += 1;
      if (first) {
        first = false;
        return h.store.settle(holdId, costs);
      }
      return skipped;
    },
  };
  const deps = { ...h.deps, store };
  const call = async () => ({
    value: "ok",
    actualUsd: 1.5,
    provider: "openrouter",
    endpoint: "chat:qa",
    billed: true as const,
  });
  const input = {
    brandKey: BRAND,
    feature: FEATURE,
    estimateUsd: 0.5,
    maxUsd: 1,
    idempotencyKey: "alert-once",
  } satisfies Parameters<typeof metered>[0];
  await metered(input, call, deps);
  const holdId = onlyHold(h.store).id;
  assert.equal(named(h, "[spend] over approved max").length, 1);

  // The same hold settled again, as a retry after a lost response does.
  await settleSpendBatch(
    holdId,
    [{ provider: "openrouter", endpoint: "chat:qa", actualUsd: 1.5, costSource: "provider_reported" }],
    deps
  );
  assert.equal(named(h, "[spend] settle skipped").length, 1, "the skipped settle is still reported");
  assert.equal(
    named(h, "[spend] over approved max").length,
    1,
    "the alert the first settle already sent is not sent twice for the same hold"
  );
});

import test from "node:test";
import assert from "node:assert/strict";
import {
  currentTelemetryContext,
  enterTelemetryContext,
  runWithTelemetryContext,
} from "./context.ts";

test("runWithTelemetryContext isolates concurrent identities (no crossover)", async () => {
  const seenA: Array<{ userId: string | null; brandKey: string | null }> = [];
  const seenB: Array<{ userId: string | null; brandKey: string | null }> = [];

  await Promise.all([
    runWithTelemetryContext({ userId: "user-a", brandKey: "brand-a" }, async () => {
      seenA.push(currentTelemetryContext());
      await new Promise((r) => setTimeout(r, 20));
      seenA.push(currentTelemetryContext());
      await new Promise((r) => setTimeout(r, 20));
      seenA.push(currentTelemetryContext());
    }),
    runWithTelemetryContext({ userId: "user-b", brandKey: "brand-b" }, async () => {
      seenB.push(currentTelemetryContext());
      await new Promise((r) => setTimeout(r, 15));
      seenB.push(currentTelemetryContext());
      await new Promise((r) => setTimeout(r, 15));
      seenB.push(currentTelemetryContext());
    }),
  ]);

  for (const snap of seenA) {
    assert.equal(snap.userId, "user-a");
    assert.equal(snap.brandKey, "brand-a");
  }
  for (const snap of seenB) {
    assert.equal(snap.userId, "user-b");
    assert.equal(snap.brandKey, "brand-b");
  }
});

test("nested runWithTelemetryContext restores outer identity", async () => {
  await runWithTelemetryContext({ userId: "outer", brandKey: "o" }, async () => {
    assert.equal(currentTelemetryContext().userId, "outer");
    await runWithTelemetryContext({ userId: "inner", brandKey: "i" }, async () => {
      assert.equal(currentTelemetryContext().userId, "inner");
    });
    assert.equal(currentTelemetryContext().userId, "outer");
  });
});

test("enterTelemetryContext is a fallback (documented), still readable", () => {
  enterTelemetryContext({ userId: "fallback", brandKey: null });
  assert.equal(currentTelemetryContext().userId, "fallback");
});

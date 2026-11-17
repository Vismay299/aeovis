import test from "node:test";
import assert from "node:assert/strict";
import {
  scheduleSaveInput,
  scheduleSaveAction,
  estimateScheduleSave,
  SCHEDULE_NOTE_WARNING,
} from "./scheduleSave.ts";
import type { ScanQuoteDeps } from "./scanRun.ts";
import type { PricingContext } from "../pricedActions.ts";
import { quote } from "../pricedActions.ts";

function fakeContext(over: Partial<PricingContext> = {}): PricingContext {
  return {
    brandKey: "offcult.in",
    admin: {} as any,
    env: { SCAN_PROBE_RESERVATION_USD: "0.2" },
    now: new Date("2026-10-21T09:30:00.000Z"),
    ...over,
  };
}

function make30PromptsPanel() {
  const prompts = [];
  for (let i = 1; i <= 28; i++) {
    prompts.push({ text: `Question ${i}`, purpose: "commercial" });
  }
  prompts.push({ text: "Diagnostic 1", purpose: "diagnostic" });
  prompts.push({ text: "Diagnostic 2", purpose: "diagnostic" });
  return [
    {
      artifact_key: "default",
      state: "approved",
      payload: { prompts },
    },
  ];
}

const baseDeps: ScanQuoteDeps = {
  listPanels: async () => make30PromptsPanel(),
  getSchedule: async () => ({ engines: "chatgpt,gemini,perplexity,aio" }),
  resolveEngines: () => ({
    configured: ["chatgpt", "gemini", "perplexity", "aio"],
    requested: ["chatgpt", "gemini", "perplexity", "aio"],
  }),
  engineStats: async () => [
    { engine: "chatgpt", median_usd: "0.05" },
    { engine: "gemini", median_usd: "0.05" },
    { engine: "perplexity", median_usd: "0.05" },
    { engine: "aio", median_usd: "0.05" },
  ],
  dispatchControl: async () => ({ paused: false, brand_allowlist: null }),
  daySpend: async () => 0,
  position: async () => ({ dailyHeadroomUsd: 100, monthlyHeadroomUsd: 500 }),
};

test("scheduleSaveInput validates interval and panelKey", () => {
  const valid = scheduleSaveInput.parse({ scheduleInterval: "weekly" });
  assert.equal(valid.panelKey, "default");
  assert.equal(valid.scheduleInterval, "weekly");

  assert.throws(() => scheduleSaveInput.parse({ scheduleInterval: "hourly" }));
  assert.throws(() => scheduleSaveInput.parse({ scheduleInterval: "weekly", extra: true }));
});

test("estimateScheduleSave includes schedule_note warning and monthly projection", async () => {
  const ctx = fakeContext();
  const res = await estimateScheduleSave(ctx, { panelKey: "default", scheduleInterval: "weekly" }, baseDeps);

  assert.equal(res.totalUsd, 24);
  assert.ok(res.monthly);
  assert.equal(res.monthly.interval, "weekly");
  assert.equal(res.monthly.runsPerMonth, 4);
  assert.equal(res.monthly.totalUsd, 96);

  const noteWarning = res.warnings.find((w) => w.code === SCHEDULE_NOTE_WARNING.code);
  assert.ok(noteWarning);
  assert.equal(noteWarning.message, SCHEDULE_NOTE_WARNING.message);
});

test("estimateScheduleSave passes through blocked panel", async () => {
  const ctx = fakeContext();
  const blockedDeps: ScanQuoteDeps = {
    ...baseDeps,
    listPanels: async () => [],
  };
  const res = await estimateScheduleSave(ctx, { panelKey: "default", scheduleInterval: "daily" }, blockedDeps);
  assert.ok(res.blocked);
  assert.equal(res.blocked.code, "panel_not_approved");
  assert.ok(res.warnings.some((w) => w.code === "schedule_note"));
});

test("scheduleSaveAction is registered and callable via quote", async () => {
  assert.equal(scheduleSaveAction.key, "ai_visibility.schedule.save");
  assert.equal(scheduleSaveAction.requireApproval, true);

  // In a context where admin.from returns empty, panel is not approved
  const ctx = fakeContext();
  const res = await quote("ai_visibility.schedule.save", ctx, { scheduleInterval: "monthly" });
  assert.equal(res.action, "ai_visibility.schedule.save");
  assert.ok(res.blocked);
  assert.equal(res.blocked.code, "panel_not_approved");
  assert.ok(res.warnings.some((w) => w.code === "schedule_note"));
});

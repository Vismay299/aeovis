// The owner-run live check has never run against a provider, so its decisions are
// proven here with the real turn runtime and a mock model: when it refuses, what
// it may spend, when it passes, and what it leaves behind.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import type { LanguageModel } from "ai";
import { createMemoryStore } from "../../shared/spend/memoryStore.ts";
import { createFakeAdmin } from "../../../tests/fixtures/f22/fakeAdmin.ts";
import type { ToolRegistration } from "../tools/types.ts";
import {
  LIVE_CEILING_USD,
  LIVE_MESSAGE,
  LiveCheckRefusal,
  runLiveCheck,
  skillFromParts,
  toolNamesFromParts,
  type LiveCheckDeps,
} from "./liveCheck.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, "../../../tests/fixtures/f22");
const AT = Date.parse("2026-11-17T10:00:00.000Z");
const BRAND = "acme-tees";
const OWNER = "owner-1";

type Steps = Array<{ chunks: unknown[] }>;
const fixture = (name: string): Steps => JSON.parse(readFileSync(path.join(FIXTURES, name), "utf8")).steps;

const echo = {
  def: {
    name: "qa_echo",
    description: "Echo a synthetic value.",
    input: z.strictObject({}),
    output: z.looseObject({ echo: z.boolean() }),
    handler: async () => ({ echo: true }),
  },
  area: "keywords",
  feature: null,
  effect: "read",
  approval: () => ({ kind: "none" }),
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  summarize: () => "Echoed.",
  example: { input: {}, output: { echo: true } },
} as unknown as ToolRegistration;

function model(steps: Steps): LanguageModel {
  return new MockLanguageModelV3({
    provider: "openrouter",
    modelId: "anthropic/claude-sonnet-4.5",
    doStream: steps.map((step) => ({
      stream: simulateReadableStream({ chunks: step.chunks as never[], initialDelayInMs: 0, chunkDelayInMs: 0 }),
    })) as never,
  }) as unknown as LanguageModel;
}

function stepWithCost(cost: number): Steps {
  return [
    {
      chunks: [
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "t1" },
        { type: "text-delta", id: "t1", delta: "Synthetic reply." },
        { type: "text-end", id: "t1" },
        {
          type: "finish",
          usage: {
            inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 10, text: 10, reasoning: 0 },
          },
          finishReason: { unified: "stop", raw: "stop" },
          providerMetadata: { openrouter: { usage: { cost } } },
        },
      ],
    },
  ];
}

type Setup = {
  steps?: Steps;
  control?: Record<string, unknown> | null;
  flag?: boolean;
  owner?: boolean;
  seedSessions?: unknown[];
};

function setup(over: Setup = {}) {
  const rows: Record<string, unknown[]> = {
    paid_feature_controls:
      over.control === null
        ? []
        : [{ feature: "assistant.turn", enabled: true, mode: "allowlist", brand_allowlist: [BRAND], ...over.control }],
    customer_brand_memberships:
      over.owner === false
        ? []
        : [
            {
              user_id: OWNER,
              role: "owner",
              brand_key: BRAND,
              // The fake has no embedded-resource filters, so the PostgREST filter
              // on the joined brand is seeded under the same name it is queried by.
              "customer_brands.is_active": true,
              customer_brands: {
                brand_key: BRAND,
                display_name: "Acme Tees",
                website: "https://acme.example",
                website_host: "acme.example",
                aliases: [],
                is_active: true,
              },
            },
          ],
  };
  const admin = createFakeAdmin(rows);
  admin.setNow(() => AT);
  const control = { enabled: true, mode: "all" as const, brandAllowlist: [], dailyCapUsd: null, maxCallUsd: null };
  const store = createMemoryStore({ now: () => AT, controls: { "assistant.turn": control, "assistant.compaction": control } });
  const steps = over.steps ?? fixture("stream-text-steps.json");
  const llm = model(steps);
  const deps: LiveCheckDeps = {
    admin: admin as never,
    isFeatureEnabled: async () => over.flag !== false,
    env: { LLM_API_KEY: "test-key", ASSISTANT_MODEL: "anthropic/claude-sonnet-4.5" },
    turnDeps: {
      model: llm,
      spend: { store },
      now: () => AT,
      keepAlive: (() => Promise.resolve()) as never,
      heartbeatMs: 60_000,
      cancelPollMs: 60_000,
      availableTools: async () => [echo],
      isFeatureEnabled: async () => false,
    },
    sleep: async () => {},
    newMessageId: () => "live-test-message",
  };
  return { admin, store, deps, llm };
}

const input = { brand: BRAND, maxSpendUsd: LIVE_CEILING_USD };

test("a healthy run passes, reports names and amounts, and never carries message or reply text", async () => {
  const { admin, deps } = setup();
  const { report, failures } = await runLiveCheck(input, deps);

  assert.deepEqual(failures, []);
  assert.equal(report.status, "completed");
  assert.equal(report.stopReason, "finished");
  assert.equal(report.steps, 2);
  assert.deepEqual(report.toolNames, ["qa_echo"]);
  assert.equal(report.cost_known, true);
  assert.equal(report.cost_usd, 0.0028);
  assert.equal(report.skillActivated, null);

  const printed = JSON.stringify(report);
  assert.equal(printed.includes("seo-coach"), false, "the prompt is not printed");
  assert.equal(printed.includes(LIVE_MESSAGE), false);
  assert.equal(printed.includes("9 of 12 questions"), false, "the reply is not printed");
  assert.equal(printed.includes("Acme"), false);
  void admin;
});

test("the ceiling is enforced on the turn, not just checked afterwards", async () => {
  const { store, deps } = setup();
  await runLiveCheck(input, deps);
  const holds = [...store.holds.values()];
  assert.equal(holds.length, 1);
  assert.equal(holds[0]?.estimateUsd, 0.1, "the turn reserved the $0.10 ceiling, not the deployment default of $0.50");
  assert.equal(holds[0]?.maxUsd, 0.1);
});

test("a turn that failed before spending is a failed check, not a silent pass", async () => {
  const failingModel = new MockLanguageModelV3({
    provider: "openrouter",
    modelId: "anthropic/claude-sonnet-4.5",
    doStream: async () => {
      throw new Error("401 invalid api key");
    },
  }) as unknown as LanguageModel;
  const { deps } = setup();
  deps.turnDeps = { ...deps.turnDeps, model: failingModel };

  const { report, failures } = await runLiveCheck(input, deps);

  assert.equal(report.status, "error");
  assert.ok(failures.includes("status_error"));
  assert.ok(failures.includes("cost_unknown"), "nothing was billed, so no cost is known");
});

test("a completed turn whose cost is unknown does not pass", async () => {
  const { deps } = setup({ steps: fixture("stream-text-no-cost.json") });
  const { report, failures } = await runLiveCheck(input, deps);
  assert.equal(report.status, "completed");
  assert.equal(report.cost_known, false);
  assert.deepEqual(failures, ["cost_unknown"]);
});

test("a turn that costs more than the ceiling fails the check", async () => {
  const { deps } = setup({ steps: stepWithCost(0.25) });
  const { report, failures } = await runLiveCheck(input, deps);
  assert.equal(report.cost_known, true);
  assert.equal(report.cost_usd, 0.25);
  assert.deepEqual(failures, ["over_ceiling"]);
});

test("the chat it creates is archived afterwards, whether the turn passed or failed", async () => {
  const ok = setup();
  await runLiveCheck(input, ok.deps);
  const okSessions = ok.admin.rows("assistant_sessions");
  assert.equal(okSessions.length, 1);
  assert.ok(okSessions[0].archived_at, "archived after a passing run");

  const broken = setup();
  broken.deps.runAssistantTurn = (async () => {
    throw new Error("provider down");
  }) as never;
  await assert.rejects(runLiveCheck(input, broken.deps), /provider down/);
  const brokenSessions = broken.admin.rows("assistant_sessions");
  assert.equal(brokenSessions.length, 1);
  assert.ok(brokenSessions[0].archived_at, "archived even when the turn threw");
});

test("it refuses before creating anything when the assistant is not enabled for the brand", async () => {
  const { admin, deps, llm } = setup({ flag: false });
  await assert.rejects(runLiveCheck(input, deps), (error: unknown) => {
    assert.ok(error instanceof LiveCheckRefusal);
    assert.equal(error.message, "refusing: FEATURE_ASSISTANT does not cover the brand");
    return true;
  });
  assert.equal(admin.rows("assistant_sessions").length, 0);
  assert.equal((llm as unknown as { doStreamCalls: unknown[] }).doStreamCalls.length, 0);
});

test("it refuses when the assistant.turn control is missing, disabled, or does not admit the brand", async () => {
  const cases: Array<[Setup, string]> = [
    [{ control: null }, "refusing: the assistant.turn spend control is disabled"],
    [{ control: { enabled: false } }, "refusing: the assistant.turn spend control is disabled"],
    [{ control: { brand_allowlist: ["some-other-brand"] } }, "refusing: the assistant.turn spend control does not admit the brand"],
  ];
  for (const [over, message] of cases) {
    const { admin, deps, store } = setup(over);
    await assert.rejects(runLiveCheck(input, deps), (error: unknown) => {
      assert.ok(error instanceof LiveCheckRefusal);
      assert.equal(error.message, message);
      return true;
    });
    assert.equal(admin.rows("assistant_sessions").length, 0, message);
    assert.equal(store.holds.size, 0, message);
  }
});

test("a control in mode all admits any brand", async () => {
  const { deps } = setup({ control: { mode: "all", brand_allowlist: [] } });
  const { failures } = await runLiveCheck(input, deps);
  assert.deepEqual(failures, []);
});

test("a brand with no owner is an error, not a run", async () => {
  const { admin, deps } = setup({ owner: false });
  await assert.rejects(runLiveCheck(input, deps), { code: "workspace_not_found" });
  assert.equal(admin.rows("assistant_sessions").length, 0);
});

test("tool names and the activated skill are read from the stored parts", () => {
  const parts = [
    { type: "text", text: "x" },
    { type: "tool-activate_skill", input: { name: "seo-coach" } },
    { type: "tool-get_project_context", input: {} },
    { type: "tool-get_project_context", input: {} },
    { type: "dynamic-tool", toolName: "other_tool" },
  ];
  assert.deepEqual(toolNamesFromParts(parts), ["activate_skill", "get_project_context", "other_tool"]);
  assert.equal(skillFromParts(parts), "seo-coach");
  assert.deepEqual(toolNamesFromParts(null), []);
  assert.equal(skillFromParts(undefined), null);
});

test("the seo-coach skill the message asks for exists in the shipped library", async () => {
  const { SKILL_MANIFEST } = await import("../../assistant/skills/manifest.generated.ts");
  assert.ok(SKILL_MANIFEST.some((entry: { name: string }) => entry.name === "seo-coach"));
});

test("the CLI refuses without both flags and never touches a database", () => {
  const script = path.resolve(HERE, "../../../scripts/qa/check-f22-live.mjs");
  const none = spawnSync(process.execPath, [script], { encoding: "utf8" });
  assert.equal(none.status, 2);
  assert.match(none.stderr, /refusing: --brand and --max-spend-usd 0\.10 are required/);

  const wrongCeiling = spawnSync(process.execPath, [script, "--brand", "x", "--max-spend-usd", "0.5"], { encoding: "utf8" });
  assert.equal(wrongCeiling.status, 2);
  assert.match(wrongCeiling.stderr, /refusing: --brand and --max-spend-usd 0\.10 are required/);

  const unknown = spawnSync(process.execPath, [script, "--bogus"], { encoding: "utf8" });
  assert.equal(unknown.status, 2);

  const help = spawnSync(process.execPath, [script, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--max-spend-usd 0\.10/);
});

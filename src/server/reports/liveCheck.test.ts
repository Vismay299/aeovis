// The owner-run report live check has never run against a provider, so its
// decisions are proven here with a scripted turn runner: when it refuses, what
// it may spend across ALL of its turns, when it passes, and what it leaves behind.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createFakeAdmin } from "../../../tests/fixtures/f22/fakeAdmin.ts";
import { LiveCheckRefusal } from "../assistant/liveCheck.ts";
import { createSession } from "../assistant/sessions.ts";
import {
  REPORT_LIVE_CEILING_USD,
  findSanitizedStats,
  runReportLiveCheck,
  type ReportLiveCheckDeps,
} from "./liveCheck.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AT = Date.parse("2026-11-18T10:00:00.000Z");
const BRAND = "acme-tees";
const OWNER = "owner-1";
const TEMPLATE = "2a1b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const REPORT_TEXT = "Acme Tees quarterly check-in: secret figures";

// The fake's query builders are thenable but not typed as promises.
const settle = (op: unknown): Promise<unknown> => Promise.resolve(op as PromiseLike<unknown>);

type Outcome = {
  status?: string;
  stopReason?: string | null;
  cost?: number | null;
  costKnown?: boolean;
  /** Seed a pending approval card the check must decline. */
  approval?: boolean;
  /** Save a report during this turn. */
  saveReport?: boolean;
};

type Setup = {
  outcomes?: Outcome[];
  control?: Record<string, unknown> | null;
  off?: string[];
  owner?: boolean;
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

  const off = new Set(over.off ?? []);
  const script = [...(over.outcomes ?? [{ saveReport: true }])];
  const caps: string[] = [];
  const messages: unknown[] = [];
  const declined: Array<{ approvalId: string; decision: string }> = [];
  let startCalls = 0;
  let turnIndex = 0;

  const deps: ReportLiveCheckDeps = {
    admin: admin as never,
    isFeatureEnabled: async (name) => !off.has(name),
    env: { LLM_API_KEY: "test-key" },
    startReportGeneration: (async (ws: { brandKey: string; user: { id: string } }, input: { templateId: string }) => {
      startCalls += 1;
      const session = await createSession(admin as never, {
        brandKey: ws.brandKey,
        userId: ws.user.id,
        kickoff: { kind: "generate_report", templateId: input.templateId },
        title: "Report: Monthly",
      });
      return { sessionId: session.id, path: `/portal/assistant?s=${session.id}` };
    }) as never,
    runAssistantTurn: (async (
      i: { sessionId: string; message: { metadata: { kind: string } } },
      turnDeps: { env?: Record<string, string | undefined> },
    ) => {
      caps.push(String(turnDeps.env?.ASSISTANT_TURN_MAX_USD));
      messages.push(i.message);
      const outcome = script.shift() ?? {};
      turnIndex += 1;
      const started = new Date(AT + turnIndex * 1000).toISOString();
      const turnId = `turn-${turnIndex}`;
      await settle(admin.from("assistant_turns").insert({
        id: turnId,
        session_id: i.sessionId,
        brand_key: BRAND,
        status: outcome.status ?? "completed",
        stop_reason: outcome.stopReason ?? (outcome.approval ? "awaiting_approval" : "finished"),
        steps: 2,
        cost_usd: outcome.cost === undefined ? 0.01 : outcome.cost,
        cost_known: outcome.costKnown ?? outcome.cost !== null,
        started_at: started,
        finished_at: started,
      }));
      if (outcome.approval) {
        await settle(admin.from("assistant_approvals").insert({
          id: `approval-${turnIndex}`,
          tool_call_id: `call-${turnIndex}`,
          session_id: i.sessionId,
          status: "pending",
          created_at: started,
        }));
      }
      if (outcome.saveReport) {
        await settle(admin.from("reports").insert({
          id: "report-1",
          session_id: i.sessionId,
          brand_key: BRAND,
          size_bytes: 4321,
          created_at: started,
        }));
        await settle(admin.from("assistant_messages").insert({
          id: `a-${turnIndex}`,
          session_id: i.sessionId,
          brand_key: BRAND,
          role: "assistant",
          turn_id: turnId,
          parts: [
            { type: "text", text: REPORT_TEXT },
            {
              type: "tool-save_report",
              input: { html: `<h1>${REPORT_TEXT}</h1>` },
              output: { reportId: "report-1", sanitized: { changed: true, removedTags: ["script", "iframe"] } },
            },
          ],
        }));
      }
      return new Response("");
    }) as never,
    decideApproval: (async (i: { approvalId: string; decision: string }) => {
      declined.push({ approvalId: i.approvalId, decision: i.decision });
      await settle(admin.from("assistant_approvals").update({ status: "declined" }).eq("id", i.approvalId));
      return {} as never;
    }) as never,
    sleep: async () => {},
    newMessageId: () => `live-${turnIndex + 1}`,
  };
  return { admin, deps, caps, messages, declined, startCalls: () => startCalls };
}

const input = { brand: BRAND, templateId: TEMPLATE, maxSpendUsd: REPORT_LIVE_CEILING_USD };

test("a healthy run saves a report, passes, and prints ids, counts and amounts only", async () => {
  const { deps, caps } = setup({ outcomes: [{ saveReport: true, cost: 0.07 }] });
  const { report, failures } = await runReportLiveCheck(input, deps);

  assert.deepEqual(failures, []);
  assert.equal(report.reportSaved, true);
  assert.equal(report.reportId, "report-1");
  assert.equal(report.sizeBytes, 4321);
  assert.equal(report.sanitizedChanged, true);
  assert.deepEqual(report.sanitizedRemovedTags, ["script", "iframe"]);
  assert.equal(report.turns.length, 1);
  assert.equal(report.totalCostUsd, 0.07);
  assert.equal(report.approvalsDeclined, 0);
  assert.deepEqual(caps, ["0.5"], "the kickoff turn may spend the whole ceiling");

  const printed = JSON.stringify(report);
  assert.equal(printed.includes(REPORT_TEXT), false, "report text is never printed");
  assert.equal(printed.includes("acme.example"), false);
});

test("the ceiling covers every turn: each turn is capped at what the check has left", async () => {
  const { deps, caps, declined } = setup({
    outcomes: [{ approval: true, cost: 0.3 }, { approval: true, cost: 0.1 }, { saveReport: true, cost: 0.05 }],
  });
  const { report, failures } = await runReportLiveCheck(input, deps);

  assert.deepEqual(caps, ["0.5", "0.2", "0.1"], "0.50 - 0.30, then 0.50 - 0.40");
  assert.equal(report.approvalsDeclined, 2);
  assert.equal(declined.length, 2);
  assert.ok(declined.every((entry) => entry.decision === "decline"), "approval cards are always declined");
  assert.equal(report.totalCostUsd, 0.45);
  assert.deepEqual(failures, []);
});

test("the check stops asking for more turns once the ceiling is spent", async () => {
  const { deps, caps, declined } = setup({
    outcomes: [{ approval: true, cost: 0.4995 }, { saveReport: true }],
  });
  const { report, failures } = await runReportLiveCheck(input, deps);

  assert.deepEqual(caps, ["0.5"], "no second turn: 0.0005 is not enough to buy a model call");
  assert.equal(report.turns.length, 1);
  assert.equal(declined.length, 1, "the card was declined, but no continuation turn followed");
  assert.deepEqual(failures, ["no_report_saved", "budget_exhausted"]);
});

test("a turn that overspends the ceiling fails the check", async () => {
  const { deps } = setup({ outcomes: [{ approval: true, cost: 0.3 }, { saveReport: true, cost: 0.3 }] });
  const { report, failures } = await runReportLiveCheck(input, deps);
  assert.equal(report.totalCostUsd, 0.6);
  assert.deepEqual(failures, ["over_ceiling"]);
});

test("an unknown cost fails the check and stops the run: spend that cannot be measured cannot be bounded", async () => {
  const { deps, caps, declined } = setup({
    outcomes: [{ approval: true, cost: null, costKnown: false }, { saveReport: true }],
  });
  const { report, failures } = await runReportLiveCheck(input, deps);
  assert.deepEqual(caps, ["0.5"]);
  assert.equal(declined.length, 0, "no continuation after a turn whose cost is unknown");
  assert.equal(report.turns.length, 1);
  assert.ok(failures.includes("cost_unknown"));
  assert.ok(failures.includes("no_report_saved"));
});

test("a turn that errored is a failed check, not a silent pass", async () => {
  const { deps } = setup({ outcomes: [{ status: "error", stopReason: "error", cost: null, costKnown: false }] });
  const { report, failures } = await runReportLiveCheck(input, deps);
  assert.equal(report.reportSaved, false);
  assert.ok(failures.includes("status_error"));
  assert.ok(failures.includes("no_report_saved"));
  assert.ok(failures.includes("cost_unknown"));
});

test("a run that saved a report but whose last turn failed does not pass", async () => {
  const { deps } = setup({ outcomes: [{ saveReport: true, cost: 0.02, status: "error", stopReason: "error" }] });
  const { failures } = await runReportLiveCheck(input, deps);
  assert.deepEqual(failures, ["status_error"]);
});

test("it gives up after six declined cards instead of looping", async () => {
  const { deps, declined } = setup({
    outcomes: Array.from({ length: 10 }, () => ({ approval: true, cost: 0.001 })),
  });
  const { report, failures } = await runReportLiveCheck(input, deps);
  assert.equal(declined.length, 6);
  assert.equal(report.turns.length, 7, "the kickoff and six continuations");
  assert.ok(failures.includes("no_report_saved"));
});

test("the chat it creates is archived afterwards, whether the check passed or the turn threw", async () => {
  const ok = setup();
  await runReportLiveCheck(input, ok.deps);
  const okSessions = ok.admin.rows("assistant_sessions");
  assert.equal(okSessions.length, 1);
  assert.ok(okSessions[0].archived_at, "archived after a passing run");
  assert.equal(ok.admin.rows("reports").length, 1, "the report itself stays");

  const broken = setup();
  broken.deps.runAssistantTurn = (async () => {
    throw new Error("provider down");
  }) as never;
  await assert.rejects(runReportLiveCheck(input, broken.deps), /provider down/);
  const brokenSessions = broken.admin.rows("assistant_sessions");
  assert.equal(brokenSessions.length, 1);
  assert.ok(brokenSessions[0].archived_at, "archived even when the turn threw");
});

test("the first message is the kickoff and continuations name the declined approval", async () => {
  const { deps, messages } = setup({ outcomes: [{ approval: true, cost: 0.01 }, { saveReport: true }] });
  await runReportLiveCheck(input, deps);
  const kinds = (messages as Array<{ metadata: { kind: string; approvalId?: string } }>).map((m) => m.metadata);
  assert.deepEqual(kinds[0], { kind: "kickoff" });
  assert.deepEqual(kinds[1], { kind: "approval", approvalId: "approval-1" });
});

test("it refuses before creating a chat when reports, report_generate or assistant is off", async () => {
  for (const name of ["reports", "report_generate", "assistant"]) {
    const { admin, deps, startCalls } = setup({ off: [name] });
    await assert.rejects(runReportLiveCheck(input, deps), (error: unknown) => {
      assert.ok(error instanceof LiveCheckRefusal);
      assert.equal(error.message, `refusing: the ${name} control is off for the brand`);
      return true;
    });
    assert.equal(startCalls(), 0, name);
    assert.equal(admin.rows("assistant_sessions").length, 0, name);
  }
});

test("it refuses when the assistant.turn control is missing, disabled, or does not admit the brand", async () => {
  const cases: Array<[Setup, string]> = [
    [{ control: null }, "refusing: the assistant.turn spend control is disabled"],
    [{ control: { enabled: false } }, "refusing: the assistant.turn spend control is disabled"],
    [{ control: { brand_allowlist: ["some-other-brand"] } }, "refusing: the assistant.turn spend control does not admit the brand"],
  ];
  for (const [over, message] of cases) {
    const { admin, deps, startCalls } = setup(over);
    await assert.rejects(runReportLiveCheck(input, deps), (error: unknown) => {
      assert.ok(error instanceof LiveCheckRefusal);
      assert.equal(error.message, message);
      return true;
    });
    assert.equal(startCalls(), 0, message);
    assert.equal(admin.rows("assistant_sessions").length, 0, message);
  }
});

test("a brand with no owner is an error, not a run", async () => {
  const { admin, deps, startCalls } = setup({ owner: false });
  await assert.rejects(runReportLiveCheck(input, deps), { code: "workspace_not_found" });
  assert.equal(startCalls(), 0);
  assert.equal(admin.rows("assistant_sessions").length, 0);
});

test("sanitiser stats are read from a save_report envelope and nothing else", () => {
  const parts = [
    { type: "text", text: "x" },
    { type: "tool-save_report", output: { reportId: "r", sanitized: { changed: false, removedTags: [] } } },
  ];
  assert.deepEqual(findSanitizedStats(parts), { changed: false, removedTags: [] });
  assert.deepEqual(
    findSanitizedStats([{ output: { sanitized: { changed: true, removedTags: ["script", 7] } } }]),
    { changed: true, removedTags: ["script"] },
  );
  assert.equal(findSanitizedStats([{ type: "text", text: "no envelope" }]), null);
  assert.equal(findSanitizedStats(null), null);
});

test("the CLI refuses without all three flags and never touches a database", () => {
  const script = path.resolve(HERE, "../../../scripts/qa/check-f23-live.mjs");
  const expected = /refusing: --brand, --template and --max-spend-usd 0\.50 are required/;

  const none = spawnSync(process.execPath, [script], { encoding: "utf8" });
  assert.equal(none.status, 2);
  assert.match(none.stderr, expected);

  const wrongCeiling = spawnSync(
    process.execPath,
    [script, "--brand", "x", "--template", "y", "--max-spend-usd", "0.4"],
    { encoding: "utf8" },
  );
  assert.equal(wrongCeiling.status, 2);
  assert.match(wrongCeiling.stderr, expected);

  const noTemplate = spawnSync(process.execPath, [script, "--brand", "x", "--max-spend-usd", "0.50"], { encoding: "utf8" });
  assert.equal(noTemplate.status, 2);
  assert.match(noTemplate.stderr, expected);

  const unknown = spawnSync(process.execPath, [script, "--bogus"], { encoding: "utf8" });
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /invalid_argument/);
});

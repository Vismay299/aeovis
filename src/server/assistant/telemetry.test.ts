import test from "node:test";
import assert from "node:assert/strict";
import {
  ASSISTANT_EVENTS,
  assistantEventAllowed,
  setAssistantEventTracker,
  trackAssistantEvent,
  type AssistantEventProps,
} from "./telemetry.ts";

test("telemetry: the §6.7 event names are all present", () => {
  assert.deepEqual(
    [...ASSISTANT_EVENTS],
    [
      "assistant:session_create",
      "assistant:session_archive",
      "assistant:turn",
      "assistant:tool_call",
      "assistant:approval",
      "assistant:skill_activate",
      "assistant:message_send",
      "assistant:rewind",
      "assistant:stop",
      "assistant:client_error",
    ],
  );
});

test("telemetry: the default sink is a no-op", () => {
  setAssistantEventTracker(null);
  assert.equal(trackAssistantEvent("assistant:turn", { status: "completed" }), true);
});

test("telemetry: allowed props reach the sink and are copied", () => {
  const seen: Array<{ event: string; props: AssistantEventProps }> = [];
  setAssistantEventTracker((event, props) => {
    seen.push({ event, props });
  });
  try {
    assert.equal(
      trackAssistantEvent("assistant:turn", {
        status: "completed",
        stop_reason: "finished",
        steps: 2,
        tool_calls: 1,
        cost_usd: 0.003,
        cost_known: true,
        model: "anthropic/claude-sonnet-4.5",
        compacted: false,
        error_code: null,
      }),
      true,
    );
    assert.deepEqual(seen, [
      {
        event: "assistant:turn",
        props: {
          status: "completed",
          stop_reason: "finished",
          steps: 2,
          tool_calls: 1,
          cost_usd: 0.003,
          cost_known: true,
          model: "anthropic/claude-sonnet-4.5",
          compacted: false,
          error_code: null,
        },
      },
    ]);
  } finally {
    setAssistantEventTracker(null);
  }
});

test("telemetry: message text can never be emitted, even via an allowed name", () => {
  const seen: unknown[] = [];
  setAssistantEventTracker((event, props) => {
    seen.push({ event, props });
  });
  try {
    assert.equal(
      trackAssistantEvent("assistant:turn", { status: "completed", text: "Which competitors name us?" }),
      false,
    );
    assert.equal(
      trackAssistantEvent("assistant:tool_call", {
        tool: "get_scan_report",
        output: { rows: ["secret"] },
      } as unknown as AssistantEventProps),
      false,
    );
    assert.equal(trackAssistantEvent("assistant:unknown", {}), false);
    assert.equal(assistantEventAllowed("assistant:unknown"), false);
    assert.deepEqual(seen, []);
    // A long string is refused as well: names and codes are short.
    assert.equal(trackAssistantEvent("assistant:turn", { model: "x".repeat(201) }), false);
    assert.deepEqual(seen, []);
  } finally {
    setAssistantEventTracker(null);
  }
});

test("telemetry: non-finite numbers are refused", () => {
  setAssistantEventTracker(() => {
    throw new Error("must not be called");
  });
  try {
    assert.equal(trackAssistantEvent("assistant:turn", { cost_usd: Number.NaN }), false);
    assert.equal(trackAssistantEvent("assistant:turn", { steps: Number.POSITIVE_INFINITY }), false);
  } finally {
    setAssistantEventTracker(null);
  }
});

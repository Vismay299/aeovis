import test from "node:test";
import assert from "node:assert/strict";
import { toCallToolResult, truncatePreview } from "./format.ts";
import type { ToolRegistration } from "./types.ts";

const reg = {
  def: { name: "get_scan_report", description: "Read scans.", input: {} as any, output: {} as any, handler: async () => ({}) },
  area: "visibility",
  feature: null,
  effect: "read",
  approval: () => ({ kind: "none" }),
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  summarize: () => "Scan report summary",
  example: { input: {}, output: {} },
} as ToolRegistration;

test("success includes summary, link, structured content and metadata", () => {
  const result = toCallToolResult(
    reg,
    { ok: true, output: { rows: [{ id: "r1" }] }, summary: "One scan.", link: { path: "/portal/scans/s1", label: "Scan" }, untrusted: [], truncated: null },
    { baseUrl: "https://app.test", brandKey: "brand-a" },
  );
  assert.match(result.content[0].text, /^One scan\.\nhttps:\/\/app\.test\/portal\/scans\/s1\n/);
  assert.deepEqual(result.structuredContent, {
    rows: [{ id: "r1" }],
    meta: { url: "https://app.test/portal/scans/s1", workspace: "brand-a" },
  });
  assert.deepEqual(result._meta, { url: "https://app.test/portal/scans/s1", workspace: "brand-a" });
});

test("error result includes a typed envelope and recovery", () => {
  const result = toCallToolResult(
    reg,
    { ok: false, error: { code: "invalid_input", message: "Bad input.", recovery: "Fix the fields.", retryable: false } },
    { baseUrl: "https://app.test", brandKey: "brand-a" },
  );
  assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent, {
    status: "error",
    code: "invalid_input",
    message: "Bad input.",
    recovery: "Fix the fields.",
    meta: { url: "https://app.test", workspace: "brand-a" },
  });
  assert.equal(result.content[0].text, "Bad input. Fix the fields.");
});

test("text output is capped with the partial-output notice", () => {
  const result = toCallToolResult(
    reg,
    { ok: true, output: { text: "x".repeat(50_000) }, summary: "Large.", link: null, untrusted: [], truncated: null },
    { baseUrl: "https://app.test", brandKey: "brand-a" },
  );
  assert.equal(result.content[0].text.length, 40_000);
  assert.match(result.content[0].text, /partial text output/);
  assert.equal(truncatePreview("abcdef", 4), "abc…");
});

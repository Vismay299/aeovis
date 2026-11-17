import test from "node:test";
import assert from "node:assert/strict";
import {
  WORKSPACE_ANSWERS_CSV_HEADERS,
  workspaceAnswersKind,
  workspaceAnswersParams,
} from "./workspaceAnswers.ts";

const row = (over: Record<string, unknown> = {}) => ({
  id: "answer-1",
  scan_id: "scan-1",
  scanned_at: "2026-08-01T10:00:00.000Z",
  query: "Which accounting tool?",
  engine: "chatgpt",
  answered: true,
  mentioned: true,
  brand_cited: true,
  position: 2,
  sentiment: 70,
  answer_text: "Acme is an option.",
  raw: {},
  ...over,
});

test("workspace_answers params: accepts a past range of up to 92 days", () => {
  assert.equal(workspaceAnswersParams.safeParse({ from: "2026-01-01", to: "2026-01-10" }).success, true);
  // 92 inclusive days: 2026-01-01 .. 2026-04-02.
  assert.equal(workspaceAnswersParams.safeParse({ from: "2026-01-01", to: "2026-04-02" }).success, true);
});

test("workspace_answers params: refuses reversed, future and over-92-day ranges", () => {
  assert.equal(workspaceAnswersParams.safeParse({ from: "2026-02-01", to: "2026-01-01" }).success, false);
  assert.equal(workspaceAnswersParams.safeParse({ from: "2026-01-01", to: "2026-04-04" }).success, false);
  const future = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
  assert.equal(workspaceAnswersParams.safeParse({ from: "2026-01-01", to: future }).success, false);
});

test("CSV header order is fixed", () => {
  assert.deepEqual([...WORKSPACE_ANSWERS_CSV_HEADERS], [
    "scan_id",
    "scanned_at",
    "answer_id",
    "question",
    "engine",
    "status",
    "names_you",
    "cited",
    "position",
    "sentiment",
    "brands_named",
    "citation_urls",
    "answer",
  ]);
});

test("toCsvRow: answered, mentioned and cited", () => {
  const cells = workspaceAnswersKind.toCsvRow(
    row({
      brands: [{ name: "Acme", mentioned: true }, { name: "Rival", mentioned: false }],
      references: [
        { href: "https://acme.example/a" },
        { url: "https://acme.example/a" },
        { href: "javascript:alert(1)" },
      ],
    }),
  );
  assert.deepEqual(cells, [
    "scan-1",
    "2026-08-01T10:00:00.000Z",
    "answer-1",
    "Which accounting tool?",
    "chatgpt",
    "answered",
    "yes",
    "yes",
    2,
    70,
    "Acme",
    "https://acme.example/a",
    "Acme is an option.",
  ]);
});

test("toCsvRow: answered but not mentioned or cited", () => {
  const cells = workspaceAnswersKind.toCsvRow(row({ mentioned: false, brand_cited: false }));
  assert.equal(cells[5], "answered");
  assert.equal(cells[6], "no");
  assert.equal(cells[7], "no");
});

test("toCsvRow: unanswered leaves names_you and cited blank", () => {
  const cells = workspaceAnswersKind.toCsvRow(
    row({ answered: false, mentioned: null, brand_cited: null, position: null, sentiment: null }),
  );
  assert.equal(cells[5], "no_answer");
  assert.equal(cells[6], "");
  assert.equal(cells[7], "");
  assert.equal(cells[8], "");
});

test("toCsvRow: failed leaves names_you and cited blank", () => {
  const cells = workspaceAnswersKind.toCsvRow(
    row({ failed: { message: "provider error" }, answered: null, mentioned: null, brand_cited: null }),
  );
  assert.equal(cells[5], "failed");
  assert.equal(cells[6], "");
  assert.equal(cells[7], "");
});

test("toJson keeps the same fields, typed", () => {
  const json = workspaceAnswersKind.toJson(
    [row({ brands: [{ name: "Acme", mentioned: true }], references: [{ href: "https://acme.example/a" }] })],
    { range: { from: "2026-07-23", to: "2026-10-21" }, scans: [{ id: "scan-1" }] },
    { brandKey: "acme", exportedAt: "2026-10-21T10:00:00.000Z" },
  ) as Record<string, any>;
  assert.equal(json.brandKey, "acme");
  assert.deepEqual(json.range, { from: "2026-07-23", to: "2026-10-21" });
  assert.equal(json.answers[0].status, "answered");
  assert.equal(json.answers[0].names_you, true);
  assert.equal(json.answers[0].cited, true);
  assert.deepEqual(json.answers[0].brands_named, ["Acme"]);
  assert.deepEqual(json.answers[0].citation_urls, ["https://acme.example/a"]);
});

test("filename names the brand and both range ends", () => {
  assert.equal(
    workspaceAnswersKind.filename("Acme Co", { from: "2026-07-23", to: "2026-10-21" }, "csv"),
    "perceev-acme-co-answers-2026-07-23-to-2026-10-21.csv",
  );
});

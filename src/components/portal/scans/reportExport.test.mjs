import test from "node:test";
import assert from "node:assert/strict";
import { questionExportRows } from "./reportExport.js";

const planned = {
  prompts: ["Which project tool?", "Which monitoring tool?", "Which analytics tool?"],
  engines: ["chatgpt", "gemini"],
};

const results = [
  {
    query: "Which project tool?", engine: "chatgpt", answered: true,
    mentioned: false, brand_cited: false, position: 2,
    answer_text: "Choose a project tool.", raw: {},
  },
  {
    query: "Which project tool?", engine: "gemini", answered: true,
    mentioned: true, brand_cited: true, position: 1,
    answer_text: "Acme is an option.", raw: {},
  },
  {
    query: "Which monitoring tool?", engine: "chatgpt", answered: false,
    mentioned: null, brand_cited: null, position: null, answer_text: null, raw: {},
  },
  {
    query: "Which monitoring tool?", engine: "gemini", answered: false,
    raw: { error: "provider_timeout" },
  },
  {
    query: "Which analytics tool?", engine: "chatgpt", answered: true,
    mentioned: false, brand_cited: false, position: null,
    answer_text: "A general analytics answer.", raw: {},
  },
];

test("question export includes answered, unanswered, failed, and planned engine rows", () => {
  const result = questionExportRows(results, planned, { view: "all", search: "", engine: "all" });
  assert.deepEqual(result.headers, ["Question", "Engine", "Status", "Names you", "Cited", "Position", "Answer"]);
  assert.deepEqual(result.rows.map((row) => row.slice(0, 3)), [
    ["Which project tool?", "ChatGPT", "Answered"],
    ["Which project tool?", "Gemini", "Answered"],
    ["Which monitoring tool?", "ChatGPT", "No answer"],
    ["Which monitoring tool?", "Gemini", "Collection failed"],
    ["Which analytics tool?", "ChatGPT", "Answered"],
    ["Which analytics tool?", "Gemini", "Not collected"],
  ]);
  assert.deepEqual(result.rows[2].slice(3), ["", "", "", ""]);
  assert.deepEqual(result.rows[3].slice(3), ["", "", "", ""]);
  assert.equal(result.rows[4][5], "", "unknown position remains blank, not zero");
});

test("the missing view includes only questions with an answer that does not name the brand", () => {
  const result = questionExportRows(results, planned, { view: "missing", search: "", engine: "all" });
  assert.deepEqual([...new Set(result.rows.map((row) => row[0]))], [
    "Which analytics tool?",
  ]);
  assert.ok(result.rows.some((row) => row[2] === "Answered"));
  assert.ok(result.rows.every((row) => ["Answered", "Not collected"].includes(row[2])));
});

test("engine and search filters limit the exported questions and answer rows", () => {
  const result = questionExportRows(results, planned, { view: "all", search: "MONITORING", engine: "chatgpt" });
  assert.deepEqual(result.rows, [["Which monitoring tool?", "ChatGPT", "No answer", "", "", "", ""]]);
});

test("unknown answer fields stay blank even when an answer was collected", () => {
  const result = questionExportRows([
    { query: "Which support tool?", engine: "chatgpt", answered: true, answer_text: "A support answer." },
  ], { prompts: ["Which support tool?"], engines: ["chatgpt"] }, { view: "all", search: "", engine: "all" });
  assert.deepEqual(result.rows[0], ["Which support tool?", "ChatGPT", "Answered", "", "", "", "A support answer."]);
});

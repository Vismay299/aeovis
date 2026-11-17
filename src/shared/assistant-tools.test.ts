import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  TOOL_PRESENTATION,
  autoTable,
  humanizeToolName,
} from "./assistant-tools.ts";
import { PLANNED_TOOL_NAMES, TOOL_NAMES } from "../server/tools/names.ts";

const TOOL_AREAS = new Set([
  "memory",
  "questions",
  "visibility",
  "keywords",
  "domain",
  "rank_tracking",
  "backlinks",
  "local",
  "audit",
  "indexnow",
  "analytics",
  "search_console",
  "site",
  "content",
  "pricing",
  "reports",
]);

describe("assistant tool presentation", () => {
  it("covers every TOOL_NAMES entry plus activate_skill (PLANNED_TOOL_NAMES allowed absent)", () => {
    const expected = new Set<string>([...TOOL_NAMES, "activate_skill"]);
    const actual = new Set(Object.keys(TOOL_PRESENTATION));
    for (const name of expected) {
      assert.ok(actual.has(name), "missing presentation for " + name);
    }
    const allowed = new Set<string>([...expected, ...PLANNED_TOOL_NAMES]);
    for (const name of actual) {
      assert.ok(allowed.has(name), "unexpected presentation for " + name);
    }
  });

  it("gives every tool a short title, status copy, area and render spec", () => {
    for (const [name, presentation] of Object.entries(TOOL_PRESENTATION)) {
      assert.ok(presentation.title.length >= 1, name + " needs a title");
      assert.ok(
        presentation.title.length <= 40,
        name + " title exceeds 40 chars: " + presentation.title,
      );
      assert.ok(presentation.running.length >= 1, name + " needs running copy");
      assert.ok(presentation.done.length >= 1, name + " needs done copy");
      assert.ok(
        TOOL_AREAS.has(presentation.area),
        name + " has unknown area: " + presentation.area,
      );
      const render = presentation.render;
      switch (render.kind) {
        case "table":
          assert.ok(render.rowsPath.length >= 1, name + " table needs rowsPath");
          assert.ok(render.columns.length >= 1, name + " table needs columns");
          for (const column of render.columns) {
            assert.ok(column.key.length >= 1, name + " column needs a key");
            assert.ok(column.label.length >= 1, name + " column needs a label");
          }
          break;
        case "keyValue":
          assert.ok(render.fields.length >= 1, name + " keyValue needs fields");
          break;
        case "text":
          assert.ok(render.path.length >= 1, name + " text needs a path");
          break;
        case "job":
          assert.ok(render.statusPath.length >= 1, name + " job needs statusPath");
          break;
        case "context":
        case "skill":
        case "auto":
          break;
        default:
          assert.fail(name + " has unknown render kind");
      }
    }
  });

  it("uses the explicit RenderSpecs from §6.6.1", () => {
    assert.deepEqual(TOOL_PRESENTATION.get_scan_report.render, {
      kind: "table",
      rowsPath: "rows",
      columns: [
        { key: "question", label: "Question", format: "text" },
        { key: "engine", label: "Engine" },
        { key: "answered", label: "Answered" },
        { key: "mentioned", label: "Mentioned" },
        { key: "cited", label: "Cited" },
        { key: "competitorsNamed", label: "Competitors named" },
      ],
      totalPath: "totalCount",
    });
    assert.equal(TOOL_PRESENTATION.read_pages.render.kind, "text");
    assert.equal(TOOL_PRESENTATION.get_project_context.render.kind, "context");
    assert.equal(TOOL_PRESENTATION.activate_skill.render.kind, "skill");
  });
});

describe("humanizeToolName", () => {
  it("copies the OpenSEO label behaviour", () => {
    assert.equal(humanizeToolName("get_serp_results"), "Get serp results");
    assert.equal(humanizeToolName("tool-activate_skill"), "Activate skill");
  });
});

describe("autoTable", () => {
  it("renders one array of objects as a table capped at 8 columns and 20 rows", () => {
    const rows = Array.from({ length: 25 }, (_, index) => ({
      keyword: "kw" + index,
      searchVolume: index,
      keywordDifficulty: index,
      cpc: 1.5,
      intent: "commercial",
      competition: 0.5,
      trend: [1, 2],
      extra_a: "a",
      extra_b: "b",
      extra_c: "c",
      extra_d: "d",
    }));
    const result = autoTable({ rows, cached: true });
    assert.equal(result.kind, "table");
    assert.ok(result.columns.length <= 8);
    assert.deepEqual(
      result.columns.map((column) => column.key),
      ["keyword", "searchVolume", "keywordDifficulty", "cpc", "intent", "competition", "extra_a", "extra_b"],
    );
    assert.equal(result.columns[0].label, "Keyword");
    assert.equal(result.rows.length, 20);
    assert.equal(result.total, 25);
  });

  it("uses the union of scalar keys of the first rows only", () => {
    const result = autoTable({
      rows: [{ a: 1 }, { b: 2, nested: { deep: true } }],
    });
    assert.equal(result.kind, "table");
    assert.deepEqual(
      result.columns.map((column) => column.key),
      ["a", "b"],
    );
  });

  it("renders top-level scalars as key-value", () => {
    const result = autoTable({
      status: "completed",
      progressPct: 100,
      nested: { deep: true },
      items: ["not", "objects"],
    });
    assert.equal(result.kind, "keyValue");
    assert.deepEqual(result.entries, [
      { key: "status", label: "Status", value: "completed" },
      { key: "progressPct", label: "ProgressPct", value: 100 },
    ]);
  });

  it("falls back to JSON when there are no top-level scalars", () => {
    const data = { nested: { deep: true }, lists: [[1], [2]] };
    assert.deepEqual(autoTable(data), { kind: "json", value: data });
    assert.deepEqual(autoTable([1, 2]), { kind: "json", value: [1, 2] });
    assert.deepEqual(autoTable(null), { kind: "json", value: null });
  });
});

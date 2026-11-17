import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { formatTimestamp, relativeTime, hasTimestamp } from "./format.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");

/**
 * R2.7.3 (finding C1) — a missing collection time is a state, not a time.
 *
 * `normalizeResult` used to end its scanTimestamp chain with
 * `?? new Date().toISOString()`. A record that carried no collection time was
 * stamped with the moment the browser opened it, and the dashboard cheerfully
 * reported "just now" for data of completely unknown age. Never-collected was
 * pixel-identical to collected-a-second-ago.
 *
 * These tests pin both halves: the formatters refuse to invent a time, and the
 * fallback cannot come back into api.js without turning this file red.
 */

test("hasTimestamp — only a parseable instant counts as having a time", () => {
  assert.equal(hasTimestamp("2026-08-29T10:00:00.000Z"), true);
  assert.equal(hasTimestamp(new Date().toISOString()), true);
  assert.equal(hasTimestamp(null), false);
  assert.equal(hasTimestamp(undefined), false);
  assert.equal(hasTimestamp(""), false);
  assert.equal(hasTimestamp("not a date"), false);
  assert.equal(hasTimestamp(NaN), false);
});

test("relativeTime — a missing timestamp is an em dash, never 'just now'", () => {
  for (const missing of [null, undefined, "", "not a date"]) {
    assert.equal(
      relativeTime(missing),
      "—",
      `relativeTime(${JSON.stringify(missing)}) must render an em dash`
    );
  }
});

test("relativeTime — 'just now' still means an actual recent instant", () => {
  assert.equal(relativeTime(new Date().toISOString()), "just now");
  const twoHoursAgo = new Date(Date.now() - 2 * 3600_000).toISOString();
  assert.equal(relativeTime(twoHoursAgo), "2h ago");
});

test("relativeTime — an unparseable value never leaks 'NaNd ago'", () => {
  assert.ok(!relativeTime("garbage").includes("NaN"));
});

test("formatTimestamp — missing or unparseable renders an em dash", () => {
  for (const missing of [null, undefined, "", "not a date"]) {
    assert.equal(formatTimestamp(missing), "—");
  }
  assert.notEqual(formatTimestamp("2026-08-29T10:00:00.000Z"), "—");
});

test("GUARD — nothing may stamp a missing scanTimestamp with the current clock", async () => {
  const source = await readFile(path.join(REPO, "src/shared/api.js"), "utf8");
  const lines = source.split("\n");
  const index = lines.findIndex((l) => l.includes("scanTimestamp:") && !l.trim().startsWith("*"));
  const line = index < 0 ? null : lines.slice(index, index + 5).join("\n");

  assert.ok(line, "normalizeResult must still assign scanTimestamp");
  assert.ok(
    !/new Date\(\)/.test(line),
    `the scanTimestamp fallback is back — a record with no collection time would ` +
      `again render "just now":\n  ${line.trim()}`
  );
  assert.match(
    line,
    /\?\?\s*null/,
    `scanTimestamp must fall back to null so the UI can render an em dash:\n  ${line.trim()}`
  );
});

test("GUARD — the timestamp formatters do not invent a clock reading", async () => {
  const source = await readFile(path.join(HERE, "format.js"), "utf8");
  const body = source.slice(source.indexOf("export function formatTimestamp"));
  assert.ok(
    !/new Date\(\s*\)/.test(body),
    "format.js must never construct a date from the current clock as a fallback"
  );
});

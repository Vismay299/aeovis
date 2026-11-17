import test from "node:test";
import assert from "node:assert/strict";
import { capToolOutput } from "./capOutput.ts";

const row = (i: number) => ({ keyword: "keyword " + i, volume: i * 10 });

test("halves the largest array until the result fits and says so", () => {
  const rows = Array.from({ length: 800 }, (_, i) => row(i));
  const value = { summary: "800 keywords", data: { rows } };

  const out = capToolOutput(value, 8_000) as {
    data: { rows: unknown[] };
    truncated: string;
  };

  assert.ok(JSON.stringify(out).length <= 8_000);
  assert.deepEqual(out.data.rows[0], row(0));
  assert.equal(
    out.truncated,
    "Output trimmed to fit the chat context: \`data.rows\` shows " +
      out.data.rows.length +
      " of 800 rows. Narrow the request (filters, a smaller limit, fewer pages) to see the rest.",
  );
  assert.equal(value.data.rows.length, 800);
});

test("shortens long strings when there is no array to trim", () => {
  const value = { pages: [{ url: "https://a.test", text: "x".repeat(20_000) }] };
  const out = capToolOutput(value, 3_000) as { truncated: string };

  assert.ok(JSON.stringify(out).length <= 3_000);
  assert.match(out.truncated, /\`pages\[\*\]\.text\` shortened to/);
});

test("keeps the note inside the cap and names each shape once", () => {
  const rows = Array.from({ length: 500 }, (_, i) => ({ id: i, body: "z".repeat(9_000) }));
  const out = capToolOutput({ data: { rows } }, 32_000) as { truncated: string };

  assert.ok(JSON.stringify(out).length <= 32_000);
  assert.equal(out.truncated.match(/\`data\.rows\[\*\]\.body\`/g)?.length, 1);
  assert.match(out.truncated, /\`data\.rows\` shows/);
});

#!/usr/bin/env node
/**
 * Copies the browser-test fixtures that already match the real API shapes
 * (tests/fixtures/f20) into the sample workspace's data, renamed for
 * the fictional Brightwave. Dates are moved to the present at runtime
 * (rebaseDates in src/shared/sample/fixtures/brand.js).
 *
 *   node scripts/sample/copy-fixtures.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const out = path.join(root, "src/shared/sample/fixtures/data");
mkdirSync(out, { recursive: true });

const FILES = {
  ga4: ["status-connected", "overview", "opportunities", "health", "landing-pages", "page-performance", "key-events", "traffic-acquisition", "audience", "properties"].map((n) => `f20/api/${n}.json`),
};

const RENAME = [
  [/offcult\.in/gi, "brightwave.io"],
  [/Offcult India/g, "Brightwave India"],
  [/Offcult/g, "Brightwave"],
  [/offcult/g, "brightwave"],
  [/example\.com/gi, "brightwave.io"],
  [/Acme Corp/g, "Brightwave"],
  [/Acme/g, "Brightwave"],
  [/"acme"/g, '"sample-brightwave"'],
  [/owner@example\.test/g, "priya@brightwave.io"],
];

for (const [name, files] of Object.entries(FILES)) {
  const bundle = {};
  for (const rel of files) {
    let text = readFileSync(path.join(root, "tests/fixtures", rel), "utf8");
    for (const [from, to] of RENAME) text = text.replace(from, to);
    bundle[path.basename(rel, ".json")] = JSON.parse(text);
  }
  writeFileSync(path.join(out, `${name}.json`), JSON.stringify(bundle));
  console.log(name, Object.keys(bundle).join(", "));
}

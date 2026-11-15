import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  setRankEventTracker,
  trackRankEvent,
  buildConfigCreatePayload,
  buildKeywordsAddPayload,
  buildCheckTriggerPayload,
  buildCheckCompletePayload,
  buildPinPayload,
  buildMetricsRefreshPayload,
  buildSuggestionsOpenPayload,
  buildExportCsvPayload,
  buildTrackQuestionPayload,
} from "./telemetry.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(HERE, "../../../../tests/fixtures/f15");

async function collectFixtureStrings(dir) {
  const strings = new Set();
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = await collectFixtureStrings(fullPath);
      for (const s of nested) strings.add(s);
    } else if (entry.name.endsWith(".json")) {
      const content = await fs.readFile(fullPath, "utf8");
      try {
        const parsed = JSON.parse(content);
        extractStrings(parsed, strings);
      } catch {
        // ignore parse errors
      }
    }
  }
  return strings;
}

function extractStrings(obj, set) {
  if (obj === null || obj === undefined) return;
  if (typeof obj === "string") {
    const trimmed = obj.trim().toLowerCase();
    if (trimmed.length > 2) {
      set.add(trimmed);
    }
  } else if (Array.isArray(obj)) {
    for (const item of obj) extractStrings(item, set);
  } else if (typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) {
      if (["keyword", "domain", "url", "target"].includes(k.toLowerCase()) && typeof v === "string") {
        set.add(v.trim().toLowerCase());
      }
      extractStrings(v, set);
    }
  }
}

test("telemetry sink registration and event dispatching", () => {
  const events = [];
  setRankEventTracker((event, props) => {
    events.push({ event, props });
  });

  trackRankEvent("rank_tracking:check_trigger", { keywords: 10, subset: false });
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "rank_tracking:check_trigger");
  assert.deepEqual(events[0].props, { keywords: 10, subset: false });

  setRankEventTracker(null);
  trackRankEvent("rank_tracking:pin", { pinned: true });
  assert.equal(events.length, 1, "no event dispatched after clearing sink");
});

test("payload builders emit only permitted keys (§6.7)", () => {
  const configCreate = buildConfigCreatePayload({ devices: "mobile", schedule: "weekly", local: false });
  assert.deepEqual(Object.keys(configCreate).sort(), ["devices", "local", "schedule"]);

  const keywordsAdd = buildKeywordsAddPayload({ count: 5, source: "manual" });
  assert.deepEqual(Object.keys(keywordsAdd).sort(), ["count", "source"]);

  const checkTrigger = buildCheckTriggerPayload({ keywords: 20, subset: true });
  assert.deepEqual(Object.keys(checkTrigger).sort(), ["keywords", "subset"]);

  const checkComplete = buildCheckCompletePayload({ status: "completed", trigger: "manual", keywords_checked: 20 });
  assert.deepEqual(Object.keys(checkComplete).sort(), ["keywords_checked", "status", "trigger"]);

  const pin = buildPinPayload({ pinned: true });
  assert.deepEqual(Object.keys(pin).sort(), ["pinned"]);

  const metricsRefresh = buildMetricsRefreshPayload({ bought: 2, from_cache: 10 });
  assert.deepEqual(Object.keys(metricsRefresh).sort(), ["bought", "from_cache"]);

  const suggestionsOpen = buildSuggestionsOpenPayload({ cached: true, count: 25 });
  assert.deepEqual(Object.keys(suggestionsOpen).sort(), ["cached", "count"]);

  const exportCsv = buildExportCsvPayload({ scope: "selection" });
  assert.deepEqual(Object.keys(exportCsv).sort(), ["scope"]);

  const trackQuestion = buildTrackQuestionPayload({ created: true });
  assert.deepEqual(Object.keys(trackQuestion).sort(), ["created"]);
});

test("no telemetry payload property contains any keyword, domain or URL from fixtures (F15-AC-24)", async () => {
  const fixtureStrings = await collectFixtureStrings(FIXTURES_DIR);
  assert.ok(fixtureStrings.size > 0, "must collect fixture strings");

  // Specific fixture domain / keywords to verify
  const sensitiveTokens = ["acme.example", "coffee near me", "seo tool", "example.com", "best coffee roaster"];
  for (const t of sensitiveTokens) {
    fixtureStrings.add(t.toLowerCase());
  }

  const payloads = [
    buildConfigCreatePayload({ devices: "both", schedule: "daily", local: true }),
    buildKeywordsAddPayload({ count: 12, source: "suggestions" }),
    buildCheckTriggerPayload({ keywords: 15, subset: false }),
    buildCheckCompletePayload({ status: "completed", trigger: "scheduled", keywords_checked: 15 }),
    buildPinPayload({ pinned: false }),
    buildMetricsRefreshPayload({ bought: 0, from_cache: 15 }),
    buildSuggestionsOpenPayload({ cached: false, count: 50 }),
    buildExportCsvPayload({ scope: "all" }),
    buildTrackQuestionPayload({ created: false }),
  ];

  for (const payload of payloads) {
    for (const [key, val] of Object.entries(payload)) {
      if (typeof val === "string") {
        const valLower = val.toLowerCase();
        for (const token of sensitiveTokens) {
          assert.notEqual(valLower, token, `Payload property ${key} must not equal sensitive token '${token}'`);
        }
        // Ensure no payload string is a URL, domain, or keyword
        assert.ok(!valLower.startsWith("http://") && !valLower.startsWith("https://"), `Payload property ${key} must not be a URL`);
        assert.ok(!valLower.includes(".com") && !valLower.includes(".example"), `Payload property ${key} must not be a domain`);
      }
    }
  }
});

/**
 * F17-AC-16 — local telemetry never carries personal data.
 *
 * §6.7 fixes the property list of every `local:*` event and says nothing may
 * name a person, quote review or post text, or give a coordinate or keyword.
 * These tests pin the allow-list, prove the sanitiser drops everything else,
 * and check the browser fixtures' own names, text and coordinates cannot ride
 * along in a payload a real run would emit.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  LOCAL_EVENT_NAMES,
  LOCAL_EVENT_PROP_KEYS,
  sanitizeLocalEventProps,
  setLocalEventTracker,
  trackLocalEvent,
} from "./telemetry.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(HERE, "../../../../tests/fixtures/f17/api");

function readFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, name), "utf8"));
}

// The exact §6.7 payloads. A change here is a spec change, not a refactor.
const EXPECTED = {
  "local:business_saved": ["role"],
  "local:profile_lookup": ["found"],
  "local:listings_search": ["count", "cached"],
  "local:reviews_collect": ["depth", "other_sources", "reused"],
  "local:updates_collect": ["reused"],
  "local:questions_collect": ["reused"],
  "local:serp_search": ["type", "cached", "own_ranked"],
  "local:grid_run": ["size", "reused", "points_found"],
};

const FORBIDDEN_KEYS = [
  "name",
  "title",
  "business_name",
  "text",
  "review_text",
  "comment",
  "author",
  "address",
  "keyword",
  "query",
  "lat",
  "lng",
  "latitude",
  "longitude",
  "cid",
  "place_id",
  "placeId",
];

test("every local event declares exactly the §6.7 properties", () => {
  assert.deepEqual(
    [...LOCAL_EVENT_NAMES].sort(),
    Object.keys(EXPECTED).sort(),
    "the runtime name list and the expected set must match"
  );
  for (const name of LOCAL_EVENT_NAMES) {
    assert.deepEqual(
      [...LOCAL_EVENT_PROP_KEYS[name]],
      [...EXPECTED[name]],
      `properties for ${name}`
    );
  }
});

test("no event may carry a name, text, coordinate or keyword property", () => {
  for (const name of LOCAL_EVENT_NAMES) {
    for (const key of LOCAL_EVENT_PROP_KEYS[name]) {
      assert.equal(
        FORBIDDEN_KEYS.includes(key),
        false,
        `${name} declares forbidden property "${key}"`
      );
    }
  }
});

test("the sanitiser drops undeclared properties and nested values", () => {
  const clean = sanitizeLocalEventProps("local:grid_run", {
    size: 3,
    reused: false,
    points_found: 7,
    keyword: "streetwear store",
    title: "Offcult Store",
    latitude: 19.076,
    longitude: 72.8777,
    centre: { latitude: 19.076, longitude: 72.8777 },
    topResult: { title: "Bonkers Corner" },
  });
  assert.deepEqual(clean, { size: 3, reused: false, points_found: 7 });
  const serialised = JSON.stringify(clean);
  for (const leaked of [
    "streetwear store",
    "Offcult Store",
    "Bonkers Corner",
    "19.076",
    "72.8777",
  ]) {
    assert.equal(serialised.includes(leaked), false, `leaked "${leaked}"`);
  }
});

test("trackLocalEvent hands the tracker only allow-listed scalars", () => {
  const seen = [];
  setLocalEventTracker((name, props) => {
    seen.push({ name, props });
  });
  try {
    trackLocalEvent("local:serp_search", {
      type: "maps",
      cached: true,
      own_ranked: true,
      keyword: "streetwear store",
      latitude: 19.076,
    });
    trackLocalEvent("local:updates_collect", { reused: false, text: "Great shop" });
  } finally {
    setLocalEventTracker(null);
  }

  assert.deepEqual(seen[0], {
    name: "local:serp_search",
    props: { type: "maps", cached: true, own_ranked: true },
  });
  assert.deepEqual(seen[1], {
    name: "local:updates_collect",
    props: { reused: false },
  });
});

test("a tracker failure never reaches the caller", () => {
  setLocalEventTracker(() => {
    throw new Error("analytics is down");
  });
  try {
    assert.doesNotThrow(() =>
      trackLocalEvent("local:profile_lookup", { found: true })
    );
  } finally {
    setLocalEventTracker(null);
  }
});

test("the browser fixtures' names, text and coordinates never reach a payload", () => {
  const b6 = readFixture("b6-fixtures.json");
  const b7 = readFixture("b7-fixtures.json");

  const grid = b6.completed;
  const serp = b7.serpResult;

  const seen = [];
  setLocalEventTracker((_name, props) => {
    seen.push(props);
  });
  try {
    // The two payloads a completed grid run and a local search emit.
    trackLocalEvent("local:grid_run", {
      size: 3,
      reused: false,
      points_found: grid.summary.pointsFound,
      keyword: grid.keyword,
      latitude: grid.center.latitude,
      longitude: grid.center.longitude,
      top_title: grid.points[0]?.topResult?.title ?? null,
    });
    trackLocalEvent("local:serp_search", {
      type: "maps",
      cached: false,
      own_ranked: serp.ownRank != null,
      keyword: grid.keyword,
      title: serp.results[0]?.title ?? null,
      latitude: serp.results[0]?.latitude ?? null,
      longitude: serp.results[0]?.longitude ?? null,
    });
  } finally {
    setLocalEventTracker(null);
  }

  const serialised = JSON.stringify(seen);
  const leaks = [
    grid.keyword,
    grid.points[0]?.topResult?.title ?? "",
    serp.results[0]?.title ?? "",
    String(grid.center.latitude),
    String(grid.center.longitude),
    String(serp.results[0]?.latitude ?? ""),
    String(serp.results[0]?.longitude ?? ""),
  ].filter((value) => value.length > 0);

  assert.ok(leaks.length > 0, "the fixtures must yield something to leak");
  for (const leak of leaks) {
    assert.equal(serialised.includes(leak), false, `payload leaked "${leak}"`);
  }
});

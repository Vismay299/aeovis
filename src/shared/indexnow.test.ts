import test from "node:test";
import assert from "node:assert/strict";
import {
  KEY_FILE_STATUSES,
  KEY_FILE_LABELS,
  isUnusedHost,
  isProblemStatus,
  keyFileReady,
  splitUrls,
  pluralUrls,
  SUBMISSION_SOURCES,
  SUBMISSION_SOURCE_LABELS,
  ENGINE_LABELS,
  MAX_URLS_PER_SUBMISSION,
} from "./indexnow.ts";

test("KEY_FILE_STATUSES covers all 7 expected statuses", () => {
  assert.deepEqual([...KEY_FILE_STATUSES], [
    "found",
    "missing",
    "wrong_content",
    "redirects",
    "moved",
    "unreachable",
    "unknown",
  ]);
  for (const s of KEY_FILE_STATUSES) {
    assert.ok(typeof KEY_FILE_LABELS[s] === "string" && KEY_FILE_LABELS[s].length > 0);
  }
});

test("isUnusedHost identifies moved and unreachable", () => {
  assert.equal(isUnusedHost("moved"), true);
  assert.equal(isUnusedHost("unreachable"), true);
  assert.equal(isUnusedHost("found"), false);
  assert.equal(isUnusedHost("missing"), false);
  assert.equal(isUnusedHost("wrong_content"), false);
  assert.equal(isUnusedHost("redirects"), false);
  assert.equal(isUnusedHost("unknown"), false);
});

test("isProblemStatus identifies missing, wrong_content, and redirects", () => {
  assert.equal(isProblemStatus("missing"), true);
  assert.equal(isProblemStatus("wrong_content"), true);
  assert.equal(isProblemStatus("redirects"), true);
  assert.equal(isProblemStatus("moved"), false);
  assert.equal(isProblemStatus("found"), false);
  assert.equal(isProblemStatus("unreachable"), false);
  assert.equal(isProblemStatus("unknown"), false);
});

test("keyFileReady evaluates host combinations correctly", () => {
  // found + moved -> ready
  assert.equal(
    keyFileReady([
      { host: "example.com", status: "found" },
      { host: "www.example.com", status: "moved" },
    ]),
    true
  );

  // missing + unreachable -> not ready
  assert.equal(
    keyFileReady([
      { host: "example.com", status: "missing" },
      { host: "www.example.com", status: "unreachable" },
    ]),
    false
  );

  // all unused -> not ready
  assert.equal(
    keyFileReady([
      { host: "example.com", status: "moved" },
      { host: "www.example.com", status: "unreachable" },
    ]),
    false
  );

  // empty -> not ready
  assert.equal(keyFileReady([]), false);

  // found + found -> ready
  assert.equal(
    keyFileReady([
      { host: "example.com", status: "found" },
      { host: "www.example.com", status: "found" },
    ]),
    true
  );

  // found + redirects -> not ready (redirects is used and not found)
  assert.equal(
    keyFileReady([
      { host: "example.com", status: "found" },
      { host: "www.example.com", status: "redirects" },
    ]),
    false
  );
});

test("splitUrls trims, splits by newline and drops empty lines", () => {
  const text = "  https://example.com/1 \n\n https://example.com/2  \n \n";
  assert.deepEqual(splitUrls(text), [
    "https://example.com/1",
    "https://example.com/2",
  ]);
  assert.deepEqual(splitUrls(""), []);
});

test("pluralUrls formats count correctly", () => {
  assert.equal(pluralUrls(0), "0 URLs");
  assert.equal(pluralUrls(1), "1 URL");
  assert.equal(pluralUrls(2), "2 URLs");
  assert.equal(pluralUrls(15), "15 URLs");
});

test("submission constants and labels are frozen/valid", () => {
  assert.deepEqual([...SUBMISSION_SOURCES], ["settings", "audit", "content", "tool"]);
  assert.equal(SUBMISSION_SOURCE_LABELS.settings, "Settings");
  assert.equal(SUBMISSION_SOURCE_LABELS.audit, "Site audit");
  assert.equal(SUBMISSION_SOURCE_LABELS.content, "Content Studio");
  assert.equal(SUBMISSION_SOURCE_LABELS.tool, "Assistant");
  assert.equal(MAX_URLS_PER_SUBMISSION, 10000);
  assert.equal(ENGINE_LABELS.bing, "Bing");
  assert.equal(ENGINE_LABELS.yandex, "Yandex");
  assert.equal(ENGINE_LABELS.yep, "Yep");
});

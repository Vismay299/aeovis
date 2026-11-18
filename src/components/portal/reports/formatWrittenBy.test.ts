// F23 Phase 4 — formatWrittenBy cases (§6.6 "Written by" column).
import test from "node:test";
import assert from "node:assert/strict";
import { formatWrittenBy } from "./formatWrittenBy.ts";

test("an assistant report the reader wrote reads as their own", () => {
  assert.equal(
    formatWrittenBy({ createdBy: "assistant", createdByYou: true }),
    "Assistant · you",
  );
});

test("an assistant report someone else wrote reads as a teammate's", () => {
  assert.equal(
    formatWrittenBy({ createdBy: "assistant", createdByYou: false }),
    "Assistant · a teammate",
  );
});

test("an app-written report reads as the Perceev app", () => {
  assert.equal(
    formatWrittenBy({ createdBy: "app", createdByYou: false }),
    "Perceev app",
  );
  assert.equal(
    formatWrittenBy({ createdBy: "app", createdByYou: true }),
    "Perceev app",
  );
});

test("an unknown writer falls back to the Perceev app", () => {
  assert.equal(
    formatWrittenBy({ createdBy: "cron", createdByYou: false }),
    "Perceev app",
  );
});

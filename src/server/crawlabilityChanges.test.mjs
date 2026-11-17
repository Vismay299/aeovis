/**
 * R4.3.1 — tests for crawlability change detection (crawlabilityChanges.js).
 *
 * The change detector compares two bot arrays and returns only those whose
 * STATUS actually changed (open↔partial↔blocked). Reason text changes are
 * intentionally ignored — they are informational, not the access verdict.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { detectBotChanges, buildAuditDiff } from "./crawlabilityChanges.js";

// ---------------------------------------------------------------------------
// detectBotChanges
// ---------------------------------------------------------------------------

test("detectBotChanges returns empty array when both inputs are empty", () => {
  assert.deepEqual(detectBotChanges([], []), []);
});

test("detectBotChanges returns empty array when nothing changed", () => {
  const bots = [
    { name: "GPTBot", status: "open", operator: "OpenAI", purpose: "training" },
    { name: "ClaudeBot", status: "blocked", operator: "Anthropic", purpose: "training" },
  ];
  assert.deepEqual(detectBotChanges(bots, bots), []);
});

test("detectBotChanges detects open→blocked transition", () => {
  const previous = [{ name: "GPTBot", status: "open", operator: "OpenAI", purpose: "training" }];
  const current = [{ name: "GPTBot", status: "blocked", operator: "OpenAI", purpose: "training" }];
  const changes = detectBotChanges(previous, current);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].name, "GPTBot");
  assert.equal(changes[0].previous, "open");
  assert.equal(changes[0].current, "blocked");
});

test("detectBotChanges detects blocked→open transition", () => {
  const previous = [{ name: "ClaudeBot", status: "blocked", operator: "Anthropic", purpose: "training" }];
  const current = [{ name: "ClaudeBot", status: "open", operator: "Anthropic", purpose: "training" }];
  const changes = detectBotChanges(previous, current);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].previous, "blocked");
  assert.equal(changes[0].current, "open");
});

test("detectBotChanges detects open→partial transition", () => {
  const previous = [{ name: "Googlebot", status: "open", operator: "Google", purpose: "search" }];
  const current = [{ name: "Googlebot", status: "partial", operator: "Google", purpose: "search" }];
  const changes = detectBotChanges(previous, current);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].previous, "open");
  assert.equal(changes[0].current, "partial");
});

test("detectBotChanges ignores reason text changes when status is the same", () => {
  const previous = [{
    name: "GPTBot", status: "open", operator: "OpenAI", purpose: "training",
    reason: "The \"GPTBot\" group carries no disallow rules — fully open.",
  }];
  const current = [{
    name: "GPTBot", status: "open", operator: "OpenAI", purpose: "training",
    reason: "The \"GPTBot\" group carries no disallow rules — fully open (updated).",
  }];
  assert.deepEqual(detectBotChanges(previous, current), []);
});

test("detectBotChanges handles case-insensitive bot name matching", () => {
  const previous = [{ name: "gptbot", status: "open", operator: "OpenAI", purpose: "training" }];
  const current = [{ name: "GPTBot", status: "blocked", operator: "OpenAI", purpose: "training" }];
  const changes = detectBotChanges(previous, current);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].name, "GPTBot");
});

test("detectBotChanges detects multiple simultaneous changes", () => {
  const previous = [
    { name: "GPTBot", status: "open", operator: "OpenAI", purpose: "training" },
    { name: "ClaudeBot", status: "open", operator: "Anthropic", purpose: "training" },
    { name: "Googlebot", status: "open", operator: "Google", purpose: "search" },
  ];
  const current = [
    { name: "GPTBot", status: "blocked", operator: "OpenAI", purpose: "training" },
    { name: "ClaudeBot", status: "open", operator: "Anthropic", purpose: "training" },
    { name: "Googlebot", status: "partial", operator: "Google", purpose: "search" },
  ];
  const changes = detectBotChanges(previous, current);
  assert.equal(changes.length, 2);
  const names = changes.map((c) => c.name).sort();
  assert.deepEqual(names, ["GPTBot", "Googlebot"]);
});

test("detectBotChanges ignores bots only in current (new bots)", () => {
  const previous = [{ name: "GPTBot", status: "open", operator: "OpenAI", purpose: "training" }];
  const current = [
    { name: "GPTBot", status: "open", operator: "OpenAI", purpose: "training" },
    { name: "NewBot", status: "blocked", operator: "NewCorp", purpose: "agent" },
  ];
  assert.deepEqual(detectBotChanges(previous, current), []);
});

test("detectBotChanges returns empty for null/undefined inputs", () => {
  assert.deepEqual(detectBotChanges(null, []), []);
  assert.deepEqual(detectBotChanges([], null), []);
  assert.deepEqual(detectBotChanges(undefined, undefined), []);
});

test("detectBotChanges handles bots only in previous (removed bots)", () => {
  const previous = [
    { name: "GPTBot", status: "open", operator: "OpenAI", purpose: "training" },
    { name: "OldBot", status: "blocked", operator: "OldCorp", purpose: "agent" },
  ];
  const current = [{ name: "GPTBot", status: "open", operator: "OpenAI", purpose: "training" }];
  // OldBot is gone — not a status change, just an absence
  assert.deepEqual(detectBotChanges(previous, current), []);
});

// ---------------------------------------------------------------------------
// buildAuditDiff
// ---------------------------------------------------------------------------

test("buildAuditDiff returns null for first audit (no previous)", () => {
  const bots = [{ name: "GPTBot", status: "open" }];
  assert.equal(buildAuditDiff(null, bots), null);
});

test("buildAuditDiff returns null when previous audit has no bots", () => {
  const previousAudit = { bots: [] };
  const bots = [{ name: "GPTBot", status: "open" }];
  assert.equal(buildAuditDiff(previousAudit, bots), null);
});

test("buildAuditDiff returns null when nothing changed", () => {
  const bots = [{ name: "GPTBot", status: "open", operator: "OpenAI", purpose: "training" }];
  const previousAudit = { bots };
  assert.equal(buildAuditDiff(previousAudit, bots), null);
});

test("buildAuditDiff returns a diff object when a bot changed status", () => {
  const previousAudit = {
    bots: [{ name: "GPTBot", status: "open", operator: "OpenAI", purpose: "training" }],
  };
  const currentBots = [{ name: "GPTBot", status: "blocked", operator: "OpenAI", purpose: "training" }];
  const diff = buildAuditDiff(previousAudit, currentBots);
  assert.ok(diff);
  assert.ok(Array.isArray(diff.changes));
  assert.equal(diff.changes.length, 1);
  assert.equal(diff.changes[0].name, "GPTBot");
  assert.equal(diff.changes[0].previous, "open");
  assert.equal(diff.changes[0].current, "blocked");
  assert.ok(typeof diff.summary === "string");
  assert.ok(diff.summary.includes("GPTBot"));
  assert.ok(diff.summary.includes("blocked"));
  assert.ok(typeof diff.detected_at === "string");
});

test("buildAuditDiff summary mentions 'open' for blocked→open transitions", () => {
  const previousAudit = {
    bots: [{ name: "ClaudeBot", status: "blocked", operator: "Anthropic", purpose: "training" }],
  };
  const currentBots = [{ name: "ClaudeBot", status: "open", operator: "Anthropic", purpose: "training" }];
  const diff = buildAuditDiff(previousAudit, currentBots);
  assert.ok(diff);
  assert.ok(diff.summary.includes("open"));
});

test("buildAuditDiff summary mentions 'partial' for open→partial transitions", () => {
  const previousAudit = {
    bots: [{ name: "Googlebot", status: "open", operator: "Google", purpose: "search" }],
  };
  const currentBots = [{ name: "Googlebot", status: "partial", operator: "Google", purpose: "search" }];
  const diff = buildAuditDiff(previousAudit, currentBots);
  assert.ok(diff);
  assert.ok(diff.summary.includes("partial"));
});

test("buildAuditDiff handles multiple changes in one summary", () => {
  const previousAudit = {
    bots: [
      { name: "GPTBot", status: "open", operator: "OpenAI", purpose: "training" },
      { name: "ClaudeBot", status: "open", operator: "Anthropic", purpose: "training" },
    ],
  };
  const currentBots = [
    { name: "GPTBot", status: "blocked", operator: "OpenAI", purpose: "training" },
    { name: "ClaudeBot", status: "blocked", operator: "Anthropic", purpose: "training" },
  ];
  const diff = buildAuditDiff(previousAudit, currentBots);
  assert.ok(diff);
  assert.equal(diff.changes.length, 2);
  // Both should be mentioned in the summary
  assert.ok(diff.summary.includes("GPTBot"));
  assert.ok(diff.summary.includes("ClaudeBot"));
});

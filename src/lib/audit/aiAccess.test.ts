import test from "node:test";
import assert from "node:assert/strict";
import { parseAuditRobots } from "./robotsFile.ts";
import { aiAccessRows, blockedAiBots } from "./aiAccess.ts";

test("R15-02: training bot block does not affect search or agent bots", () => {
  const robots = `
User-agent: GPTBot
Disallow: /

User-agent: OAI-SearchBot
Allow: /

User-agent: ChatGPT-User
Allow: /
  `;

  const parsed = parseAuditRobots(robots);
  const blocked = blockedAiBots(parsed, "/");

  // Training is blocked
  assert.ok(blocked.training.includes("GPTBot"));

  // Search is open
  assert.ok(!blocked.search.includes("OAI-SearchBot"));

  // Agent is open
  assert.ok(!blocked.agent.includes("ChatGPT-User"));

  // Check rows
  const rows = aiAccessRows(parsed, "/");
  const gptRow = rows.find((r) => r.name === "GPTBot");
  assert.equal(gptRow?.status, "blocked");

  const searchRow = rows.find((r) => r.name === "OAI-SearchBot");
  assert.equal(searchRow?.status, "open");
});

test("User-agent: * Disallow: / blocks every bot", () => {
  const robots = `User-agent: *\nDisallow: /`;
  const parsed = parseAuditRobots(robots);
  const blocked = blockedAiBots(parsed, "/page");

  assert.ok(blocked.search.length > 0);
  assert.ok(blocked.agent.length > 0);
  assert.ok(blocked.training.length > 0);

  const rows = aiAccessRows(parsed, "/page");
  for (const row of rows) {
    assert.equal(row.status, "blocked", `${row.name} should be blocked`);
  }
});

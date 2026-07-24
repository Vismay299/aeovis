import test from "node:test";
import assert from "node:assert/strict";
import { parseRobotsTxt, pathMatches, evaluateBot, auditDomain } from "./robots.js";
import { AI_BOTS, getBotByName } from "./bots.js";

/**
 * P5 Crawlability coverage: the pure robots.txt parser + evaluator + auditor
 * behind the crawlability route/view. No fetch, no DB, no Next.js — plain
 * functions exercised directly with real-world-shaped fixtures.
 */

// ---------------------------------------------------------------------------
// pathMatches — wildcard (*) and end-anchor ($) semantics
// ---------------------------------------------------------------------------

test("pathMatches — bare '/' matches every path (prefix match)", () => {
  assert.equal(pathMatches("/", "/"), true);
  assert.equal(pathMatches("/", "/anything/at/all"), true);
});

test("pathMatches — plain path is a prefix match, not a full-path match", () => {
  assert.equal(pathMatches("/fish", "/fish"), true);
  assert.equal(pathMatches("/fish", "/fish.html"), true);
  assert.equal(pathMatches("/fish", "/fish/salmon.html"), true);
  assert.equal(pathMatches("/fish", "/desert/fish"), false); // not a prefix
  assert.equal(pathMatches("/fish", "/Fish.html"), false); // paths are case-sensitive
});

test("pathMatches — '*' matches any run of characters, including none", () => {
  assert.equal(pathMatches("/fish*", "/fish"), true);
  assert.equal(pathMatches("/fish*", "/fish.html"), true);
  assert.equal(pathMatches("/fish*", "/fishheads/yummy.html"), true);
  assert.equal(pathMatches("/fish*", "/fish/salmon.html"), true);
});

test("pathMatches — trailing '$' anchors the end of the path", () => {
  assert.equal(pathMatches("/*.php$", "/filename.php"), true);
  assert.equal(pathMatches("/*.php$", "/filename.php?parameters"), false);
  assert.equal(pathMatches("/*.php$", "/windows.PHP"), false); // case-sensitive
  assert.equal(pathMatches("/page$", "/page"), true);
  assert.equal(pathMatches("/page$", "/page2"), false);
  assert.equal(pathMatches("/page$", "/page/"), false);
});

test("pathMatches — an empty pattern (bare 'Disallow:') never matches", () => {
  assert.equal(pathMatches("", "/"), false);
  assert.equal(pathMatches("", "/anything"), false);
});

// ---------------------------------------------------------------------------
// parseRobotsTxt — grouping, comments, case-insensitive directives
// ---------------------------------------------------------------------------

test("parseRobotsTxt — empty/missing text is flagged 'empty', not 'malformed'", () => {
  for (const input of ["", "   \n  \t ", null, undefined]) {
    const parsed = parseRobotsTxt(input);
    assert.equal(parsed.empty, true);
    assert.equal(parsed.malformed, false);
    assert.deepEqual(parsed.groups, []);
  }
});

test("parseRobotsTxt — non-robots content (e.g. an HTML error page) is flagged 'malformed'", () => {
  const html = "<!DOCTYPE html>\n<html><head><title>404 Not Found</title></head><body>Not Found</body></html>";
  const parsed = parseRobotsTxt(html);
  assert.equal(parsed.malformed, true);
  assert.equal(parsed.empty, false);
  assert.deepEqual(parsed.groups, []);
});

test("parseRobotsTxt — a file with only a Sitemap line is recognized, not malformed", () => {
  const parsed = parseRobotsTxt("Sitemap: https://example.com/sitemap.xml");
  assert.equal(parsed.malformed, false);
  assert.deepEqual(parsed.sitemaps, ["https://example.com/sitemap.xml"]);
  assert.deepEqual(parsed.groups, []); // no User-agent group, but not malformed
});

test("parseRobotsTxt — directive names are case-insensitive; agent values are lowercased", () => {
  const parsed = parseRobotsTxt("USER-AGENT: GPTBot\nDISALLOW: /admin/\nALLOW: /admin/public/");
  assert.equal(parsed.groups.length, 1);
  assert.deepEqual(parsed.groups[0].agents, ["gptbot"]);
  // Rule *paths* are preserved verbatim (case-sensitive matching downstream).
  assert.deepEqual(parsed.groups[0].rules, [
    { type: "disallow", path: "/admin/" },
    { type: "allow", path: "/admin/public/" },
  ]);
});

test("parseRobotsTxt — inline '#' comments and blank lines are ignored without breaking groups", () => {
  const text = [
    "# top-level comment",
    "User-agent: *  # applies to everyone",
    "Disallow: /admin/   # keep bots out",
    "",
    "# a second group follows",
    "User-agent: GPTBot",
    "Disallow: /",
  ].join("\n");
  const parsed = parseRobotsTxt(text);
  assert.equal(parsed.groups.length, 2);
  assert.deepEqual(parsed.groups[0].agents, ["*"]);
  assert.deepEqual(parsed.groups[0].rules, [{ type: "disallow", path: "/admin/" }]);
  assert.deepEqual(parsed.groups[1].agents, ["gptbot"]);
  assert.deepEqual(parsed.groups[1].rules, [{ type: "disallow", path: "/" }]);
});

test("parseRobotsTxt — consecutive User-agent lines (no rule between) share one group", () => {
  const text = "User-agent: GPTBot\nUser-agent: ClaudeBot\nDisallow: /no-ai/\n";
  const parsed = parseRobotsTxt(text);
  assert.equal(parsed.groups.length, 1);
  assert.deepEqual(parsed.groups[0].agents, ["gptbot", "claudebot"]);
  assert.deepEqual(parsed.groups[0].rules, [{ type: "disallow", path: "/no-ai/" }]);
});

test("parseRobotsTxt — a User-agent line seen AFTER a rule always starts a new group, blank line or not", () => {
  const text = "User-agent: GPTBot\nDisallow: /a/\nUser-agent: ClaudeBot\nDisallow: /b/\n";
  const parsed = parseRobotsTxt(text);
  assert.equal(parsed.groups.length, 2);
  assert.deepEqual(parsed.groups[0].agents, ["gptbot"]);
  assert.deepEqual(parsed.groups[1].agents, ["claudebot"]);
});

test("parseRobotsTxt — split/duplicated blocks for the same single agent are merged", () => {
  const text = "User-agent: GPTBot\nDisallow: /a/\n\nUser-agent: GPTBot\nDisallow: /b/\n";
  const parsed = parseRobotsTxt(text);
  assert.equal(parsed.groups.length, 1);
  assert.deepEqual(parsed.groups[0].rules, [
    { type: "disallow", path: "/a/" },
    { type: "disallow", path: "/b/" },
  ]);
});

test("parseRobotsTxt — a rule line before any User-agent line is ignored, not a crash", () => {
  const parsed = parseRobotsTxt("Disallow: /orphan/\nUser-agent: *\nDisallow: /admin/\n");
  assert.equal(parsed.groups.length, 1);
  assert.deepEqual(parsed.groups[0].rules, [{ type: "disallow", path: "/admin/" }]);
});

// ---------------------------------------------------------------------------
// evaluateBot — status + precedence semantics
// ---------------------------------------------------------------------------

test("evaluateBot — empty robots.txt is fully open for anyone", () => {
  const parsed = parseRobotsTxt("");
  const result = evaluateBot(parsed, "GPTBot", "/");
  assert.equal(result.status, "open");
  assert.equal(result.matchedGroup, null);
  assert.match(result.reason, /No robots\.txt/i);
  assert.equal(result.unknown, undefined);
});

test("evaluateBot — malformed robots.txt fails safe to open, flagged unknown", () => {
  const parsed = parseRobotsTxt("this is not a robots file at all, just prose.");
  const result = evaluateBot(parsed, "GPTBot", "/");
  assert.equal(result.status, "open");
  assert.equal(result.unknown, true);
  assert.match(result.reason, /could not be parsed/i);
});

test("evaluateBot — permissive file (explicit empty Disallow) is open for every bot", () => {
  const parsed = parseRobotsTxt("User-agent: *\nDisallow:\n");
  for (const bot of ["GPTBot", "ClaudeBot", "PerplexityBot"]) {
    const result = evaluateBot(parsed, bot, "/");
    assert.equal(result.status, "open", `${bot} should be open`);
    assert.equal(result.matchedGroup, "*");
  }
});

test("evaluateBot — a fixture that blocks GPTBot specifically leaves everyone else open", () => {
  const text = "User-agent: GPTBot\nDisallow: /\n\nUser-agent: *\nAllow: /\n";
  const parsed = parseRobotsTxt(text);

  const gptbot = evaluateBot(parsed, "GPTBot", "/");
  assert.equal(gptbot.status, "blocked");
  assert.equal(gptbot.matchedGroup, "gptbot");
  assert.match(gptbot.reason, /disallows \//);

  const claude = evaluateBot(parsed, "ClaudeBot", "/");
  assert.equal(claude.status, "open");
  assert.equal(claude.matchedGroup, "*");

  // A bot not even named plus not in the file still falls back to '*'.
  const unnamed = evaluateBot(parsed, "SomeFutureBot", "/");
  assert.equal(unnamed.status, "open");
});

test("evaluateBot — sitewide '*' disallow with a specific bot's own Allow override", () => {
  const text = "User-agent: *\nDisallow: /\n\nUser-agent: GPTBot\nAllow: /\n";
  const parsed = parseRobotsTxt(text);

  const gptbot = evaluateBot(parsed, "GPTBot", "/");
  assert.equal(gptbot.status, "open"); // GPTBot's own group fully overrides the wildcard block
  assert.equal(gptbot.matchedGroup, "gptbot");

  const claude = evaluateBot(parsed, "ClaudeBot", "/");
  assert.equal(claude.status, "blocked"); // falls back to the wildcard sitewide block
  assert.equal(claude.matchedGroup, "*");
});

test("evaluateBot — partial: path allowed, but the group restricts other paths", () => {
  const text = "User-agent: *\nDisallow: /private/\nAllow: /\n";
  const parsed = parseRobotsTxt(text);

  const root = evaluateBot(parsed, "PerplexityBot", "/");
  assert.equal(root.status, "partial");
  assert.match(root.reason, /restricts other paths/i);

  const otherPath = evaluateBot(parsed, "PerplexityBot", "/about");
  assert.equal(otherPath.status, "partial"); // /about itself is fine, /private/ is still a real restriction

  const privatePath = evaluateBot(parsed, "PerplexityBot", "/private/secret");
  assert.equal(privatePath.status, "blocked"); // longest match (/private/, len 9) beats Allow '/' (len 1)
});

test("evaluateBot — longest match wins regardless of directive order", () => {
  // Allow declared BEFORE the more specific Disallow — order must not matter.
  const text = "User-agent: *\nAllow: /\nDisallow: /blog/drafts/\n";
  const parsed = parseRobotsTxt(text);
  assert.equal(evaluateBot(parsed, "GPTBot", "/blog/drafts/secret").status, "blocked");
  assert.equal(evaluateBot(parsed, "GPTBot", "/blog/published").status, "partial");
});

test("evaluateBot — same-length Allow/Disallow tie goes to Allow", () => {
  const text = "User-agent: *\nDisallow: /x\nAllow: /x\n";
  const parsed = parseRobotsTxt(text);
  const result = evaluateBot(parsed, "GPTBot", "/x");
  assert.notEqual(result.status, "blocked");
});

test("evaluateBot — REP prefix matching: a named group can match multiple bots by product-token prefix", () => {
  const text = "User-agent: Claude\nDisallow: /\n";
  const parsed = parseRobotsTxt(text);
  // All of these bots' names start with "claude" case-insensitively.
  assert.equal(evaluateBot(parsed, "ClaudeBot", "/").status, "blocked");
  assert.equal(evaluateBot(parsed, "Claude-User", "/").status, "blocked");
  assert.equal(evaluateBot(parsed, "Claude-SearchBot", "/").status, "blocked");
  // GPTBot's name does not start with "claude" — unaffected, no wildcard group present -> open.
  assert.equal(evaluateBot(parsed, "GPTBot", "/").status, "open");
});

test("evaluateBot — more specific named group beats a shorter matching token", () => {
  const text = ["User-agent: Claude", "Disallow: /", "", "User-agent: ClaudeBot", "Allow: /"].join("\n");
  const parsed = parseRobotsTxt(text);
  const result = evaluateBot(parsed, "ClaudeBot", "/");
  assert.equal(result.status, "open"); // "claudebot" (len 9) is more specific than "claude" (len 6)
  assert.equal(result.matchedGroup, "claudebot");
  // Claude-User only matches the shorter "claude" token, so the sitewide block still applies.
  assert.equal(evaluateBot(parsed, "Claude-User", "/").status, "blocked");
});

test("evaluateBot — a combined 'User-agent: *' + named block shares its rules with both", () => {
  const text = "User-agent: *\nUser-agent: GPTBot\nDisallow: /\n";
  const parsed = parseRobotsTxt(text);
  assert.equal(evaluateBot(parsed, "GPTBot", "/").status, "blocked");
  assert.equal(evaluateBot(parsed, "ClaudeBot", "/").status, "blocked"); // via the '*' half of the same group
});

test("evaluateBot — no group at all (e.g. Sitemap-only file) defaults to open", () => {
  const parsed = parseRobotsTxt("Sitemap: https://example.com/sitemap.xml\n");
  const result = evaluateBot(parsed, "GPTBot", "/");
  assert.equal(result.status, "open");
  assert.equal(result.matchedGroup, null);
});

// ---------------------------------------------------------------------------
// auditDomain — per-bot rollup + summary counts
// ---------------------------------------------------------------------------

test("auditDomain — summary counts partition the full bot list exactly", () => {
  const text = "User-agent: GPTBot\nDisallow: /\n\nUser-agent: *\nDisallow: /private/\nAllow: /\n";
  const customBots = [
    { name: "GPTBot", operator: "OpenAI", platform: "GPT training", purpose: "training" },
    { name: "ClaudeBot", operator: "Anthropic", platform: "Claude training", purpose: "training" },
    { name: "PerplexityBot", operator: "Perplexity", platform: "Search", purpose: "search" },
  ];
  const audit = auditDomain(text, customBots, "/");
  assert.equal(audit.summary.total, 3);
  assert.equal(audit.summary.blocked, 1); // GPTBot
  assert.equal(audit.summary.partial, 2); // ClaudeBot, PerplexityBot via '*' group
  assert.equal(audit.summary.open, 0);
  assert.equal(audit.summary.blocked + audit.summary.partial + audit.summary.open, audit.summary.total);

  const gptRow = audit.results.find((r) => r.name === "GPTBot");
  assert.equal(gptRow.status, "blocked");
  assert.equal(gptRow.operator, "OpenAI"); // bot metadata carried through
});

test("auditDomain — empty robots.txt: every bot in the real registry reads open", () => {
  const audit = auditDomain("", AI_BOTS, "/");
  assert.equal(audit.summary.total, AI_BOTS.length);
  assert.equal(audit.summary.open, AI_BOTS.length);
  assert.equal(audit.summary.blocked, 0);
  assert.equal(audit.summary.partial, 0);
  assert.equal(audit.empty, true);
});

test("auditDomain — malformed robots.txt: fails safe to open across the whole real registry, flagged unknown", () => {
  const audit = auditDomain("<html>not a robots file</html>", AI_BOTS, "/");
  assert.equal(audit.malformed, true);
  assert.equal(audit.summary.open, AI_BOTS.length);
  assert.ok(audit.results.every((r) => r.unknown === true));
});

test("auditDomain — real registry sanity: GPTBot and ClaudeBot resolve to distinct outcomes when only one is named", () => {
  const text = "User-agent: GPTBot\nDisallow: /\n";
  const audit = auditDomain(text, AI_BOTS, "/");
  const gptbot = audit.results.find((r) => r.name === getBotByName("GPTBot").name);
  const claudebot = audit.results.find((r) => r.name === getBotByName("ClaudeBot").name);
  assert.equal(gptbot.status, "blocked");
  assert.equal(claudebot.status, "open"); // no '*' group in this file -> default allow
  assert.equal(audit.summary.blocked, 1);
});

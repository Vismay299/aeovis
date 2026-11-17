/**
 * robots.txt parser + evaluator — P5 Crawlability (plan.md).
 *
 * Pure, dependency-free, deterministic. No fetch, no DOM, no Next.js —
 * exercised directly by robots.test.mjs and called by the crawlability route
 * with whatever text it fetched.
 *
 * Implements the Robots Exclusion Protocol as specified by RFC 9309 / Google's
 * public robots.txt spec, the two points that matter most for this feature:
 *
 *   1. Grouping — one or more consecutive `User-agent` lines form a group;
 *      the group's rules run until the next line that isn't part of that
 *      same block. A `User-agent` line seen AFTER a rule line always starts a
 *      new group, whether or not a blank line separates them (blank lines
 *      are cosmetic — real files often omit them and this still groups
 *      correctly). Multiple groups that name the exact same agent token are
 *      merged (their rule lists are unioned) rather than the later one
 *      shadowing the earlier one, per RFC 9309 §2.2.1.
 *
 *   2. Precedence — for a given path, the matching Allow/Disallow rule with
 *      the LONGEST pattern wins, regardless of directive order; a same-length
 *      tie goes to Allow (the less restrictive rule), matching Google's
 *      documented behavior.
 */

const KNOWN_DIRECTIVES = new Set([
  "user-agent",
  "allow",
  "disallow",
  "sitemap",
  "crawl-delay",
  "host",
  "clean-param",
  "noindex",
]);

/**
 * Parses raw robots.txt text into user-agent groups.
 *
 * @param {string} text raw file contents
 * @returns {{
 *   groups: Array<{ agents: string[], rules: Array<{ type: "allow"|"disallow", path: string }> }>,
 *   sitemaps: string[],
 *   empty: boolean,
 *   malformed: boolean,
 * }}
 *   empty     — true when the input has no content at all (missing file / zero-byte
 *               response). Treated as fully open — there is nothing to restrict anything.
 *   malformed — true when the input is non-empty but contains not a single
 *               recognizable robots.txt directive (e.g. an HTML error page served
 *               back with a 200). Also treated as fully open (fail-safe), but
 *               callers can surface the distinction as an "unverified" flag.
 */
export function parseRobotsTxt(text) {
  const raw = typeof text === "string" ? text : "";

  if (raw.trim() === "") {
    return { groups: [], sitemaps: [], empty: true, malformed: false };
  }

  const lines = raw.split(/\r\n|\r|\n/);
  const groups = [];
  const sitemaps = [];

  let currentAgents = null; // agents collected for the group being built (before its first rule)
  let currentGroup = null; // the group object once at least one User-agent has been seen
  let sawRuleSinceLastAgent = false;
  let recognizedAnyLine = false;

  const startNewGroup = (agent) => {
    currentGroup = { agents: [agent], rules: [] };
    groups.push(currentGroup);
    currentAgents = currentGroup.agents;
    sawRuleSinceLastAgent = false;
  };

  for (const rawLine of lines) {
    // Strip comments — '#' to end of line, unless there's genuinely no directive on the line.
    const withoutComment = rawLine.split("#")[0];
    const line = withoutComment.trim();
    if (!line) continue;

    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue; // not a directive line — ignore rather than crash

    const key = line.slice(0, colonIdx).trim().toLowerCase();
    const value = line.slice(colonIdx + 1).trim();

    if (!KNOWN_DIRECTIVES.has(key)) continue; // unknown directive — ignore, don't fail the whole parse
    recognizedAnyLine = true;

    if (key === "user-agent") {
      const agent = value.toLowerCase();
      if (!agent) continue;

      if (!currentGroup || sawRuleSinceLastAgent) {
        // Either the very first group, or we've already seen a rule since the
        // last User-agent line — that closes the previous group per RFC 9309.
        startNewGroup(agent);
      } else {
        // Consecutive User-agent line, same block — but merge into an
        // existing group with the identical agent set already open only if
        // it's literally the same token list build-up; simplest correct
        // behavior is just to add to the currently-building group.
        currentAgents.push(agent);
      }
      continue;
    }

    if (key === "allow" || key === "disallow") {
      if (!currentGroup) continue; // a rule with no preceding User-agent — ignore (invalid file)
      currentGroup.rules.push({ type: key, path: value });
      sawRuleSinceLastAgent = true;
      continue;
    }

    if (key === "sitemap") {
      if (value) sitemaps.push(value);
      continue;
      // Sitemap is a non-group directive and intentionally does not touch
      // currentGroup/sawRuleSinceLastAgent — it can legally appear anywhere,
      // including mid-group, without splitting the group per RFC 9309.
    }

    // crawl-delay / host / clean-param / noindex: recognized so the file
    // isn't flagged malformed, but otherwise irrelevant to this feature.
  }

  // Merge groups that share an identical, single agent token (split/duplicated
  // blocks for the same bot) so their rules combine instead of the second
  // shadowing the first.
  const merged = mergeDuplicateAgentGroups(groups);

  return {
    groups: merged,
    sitemaps,
    empty: false,
    malformed: !recognizedAnyLine,
  };
}

/**
 * Unions rule lists across groups that were declared with the exact same
 * single agent token in more than one place in the file. Groups that list
 * multiple agents are left as-is (already correctly scoped to that combo).
 */
function mergeDuplicateAgentGroups(groups) {
  const bySingleAgent = new Map(); // agent -> merged group
  const result = [];

  for (const group of groups) {
    if (group.agents.length === 1) {
      const agent = group.agents[0];
      const existing = bySingleAgent.get(agent);
      if (existing) {
        existing.rules.push(...group.rules);
        continue;
      }
      const copy = { agents: [agent], rules: [...group.rules] };
      bySingleAgent.set(agent, copy);
      result.push(copy);
    } else {
      result.push(group);
    }
  }
  return result;
}

/**
 * Converts a robots.txt path pattern (which may use `*` as a multi-char
 * wildcard and a trailing `$` as an end-of-string anchor) into a RegExp.
 * Matching is always a PREFIX match unless the pattern ends in `$`, per the
 * extended (Google/Bing) robots.txt spec.
 */
function patternToRegex(pattern) {
  const endsWithAnchor = pattern.endsWith("$");
  const body = endsWithAnchor ? pattern.slice(0, -1) : pattern;

  const escaped = body
    .split("*")
    .map((segment) => segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");

  return new RegExp("^" + escaped + (endsWithAnchor ? "$" : ""));
}

/** Whether `path` is matched by a robots.txt rule pattern. Empty pattern (bare `Disallow:`) never matches anything. */
export function pathMatches(pattern, path) {
  if (!pattern) return false;
  try {
    return patternToRegex(pattern).test(path);
  } catch {
    return false; // a pathological pattern should never crash the audit
  }
}

/**
 * Applies robots.txt precedence across a flat rule list for one path:
 * longest matching pattern wins; a same-length tie favors Allow.
 */
function decidePath(rules, path) {
  let best = null; // { type, path, length }
  for (const rule of rules) {
    if (!rule.path) continue; // bare "Disallow:" / "Allow:" — no restriction, ignore
    if (!pathMatches(rule.path, path)) continue;

    const length = rule.path.length;
    if (
      !best ||
      length > best.length ||
      (length === best.length && rule.type === "allow" && best.type === "disallow")
    ) {
      best = { type: rule.type, path: rule.path, length };
    }
  }
  if (!best) return { allowed: true, rule: null };
  return { allowed: best.type === "allow", rule: best };
}

/** True if the rule list carries at least one real (non-empty-path) Disallow anywhere. */
function hasAnyRestriction(rules) {
  return rules.some((r) => r.type === "disallow" && !!r.path);
}

/**
 * Finds every group whose agent token is a case-insensitive prefix of
 * `botLower` (the REP matching rule — a robots.txt author writing
 * `User-agent: Claude` intentionally matches `ClaudeBot`, `Claude-User`,
 * etc.), then keeps only the group(s) achieving the LONGEST such token
 * (most-specific match wins; ties merge, covering split/duplicate blocks).
 * Falls back to `User-agent: *` groups when no named group matches at all.
 */
function findMatchingGroups(parsed, botLower) {
  let bestLength = -1;
  const named = [];

  for (const group of parsed.groups) {
    for (const token of group.agents) {
      if (token === "*") continue;
      if (token && botLower.startsWith(token)) {
        if (token.length > bestLength) bestLength = token.length;
        named.push({ group, token });
      }
    }
  }

  if (bestLength >= 0) {
    const winners = named.filter((m) => m.token.length === bestLength);
    return {
      groups: winners.map((w) => w.group),
      matchedVia: winners[0].token,
      usedWildcard: false,
    };
  }

  const wildcardGroups = parsed.groups.filter((g) => g.agents.includes("*"));
  if (wildcardGroups.length) {
    return { groups: wildcardGroups, matchedVia: "*", usedWildcard: true };
  }

  return { groups: [], matchedVia: null, usedWildcard: false };
}

/**
 * Evaluates one bot's access for one path against a parsed robots.txt.
 *
 * @param {ReturnType<typeof parseRobotsTxt>} parsed
 * @param {string} botName the crawler's product token, e.g. "GPTBot"
 * @param {string} [path="/"] the path being tested
 * @returns {{ status: "open"|"partial"|"blocked", matchedGroup: string|null, reason: string, unknown?: boolean }}
 *
 * Semantics:
 *   - blocked — the tested path itself is disallowed.
 *   - open    — the tested path is allowed AND the matched group carries no
 *               disallow rules anywhere (truly unrestricted access).
 *   - partial — the tested path is allowed, but the matched group DOES
 *               disallow something else (the bot doesn't have the run of the
 *               whole site even though this path is fine).
 *   A malformed or empty robots.txt always yields "open" (fail-safe); a
 *   malformed file additionally sets `unknown: true` so the caller can flag
 *   the result as unverified rather than a confirmed clean bill of health.
 */
export function evaluateBot(parsed, botName, path = "/") {
  const testPath = path && typeof path === "string" ? path : "/";
  const botLower = String(botName || "").trim().toLowerCase();

  const safeParsed = parsed && Array.isArray(parsed.groups) ? parsed : { groups: [], empty: true, malformed: false };

  if (safeParsed.empty) {
    return { status: "open", matchedGroup: null, reason: "No robots.txt found — nothing restricts crawlers by default." };
  }
  if (safeParsed.malformed) {
    return {
      status: "open",
      matchedGroup: null,
      reason: "robots.txt could not be parsed (no recognizable directives) — defaulting to open, unverified.",
      unknown: true,
    };
  }

  const { groups: matchedGroups, matchedVia, usedWildcard } = findMatchingGroups(safeParsed, botLower);

  if (matchedGroups.length === 0) {
    return {
      status: "open",
      matchedGroup: null,
      reason: "No matching User-agent group (named or wildcard) — no restrictions apply.",
    };
  }

  const rules = matchedGroups.flatMap((g) => g.rules);
  const { allowed, rule } = decidePath(rules, testPath);
  const groupLabel = matchedVia === "*" ? "*" : matchedVia;

  if (!allowed) {
    return {
      status: "blocked",
      matchedGroup: groupLabel,
      reason: `${usedWildcard ? "The wildcard (*) group" : `The "${groupLabel}" group`} disallows ${testPath} (Disallow: ${rule.path}).`,
    };
  }

  if (!hasAnyRestriction(rules)) {
    return {
      status: "open",
      matchedGroup: groupLabel,
      reason: usedWildcard
        ? "Matched the wildcard (*) group, which carries no disallow rules."
        : `The "${groupLabel}" group carries no disallow rules — fully open.`,
    };
  }

  return {
    status: "partial",
    matchedGroup: groupLabel,
    reason: `${testPath} is allowed, but ${usedWildcard ? "the wildcard (*) group" : `the "${groupLabel}" group`} restricts other paths on this site.`,
  };
}

/**
 * Audits a whole bot list against one robots.txt in one pass.
 *
 * @param {string} robotsText raw robots.txt contents (may be "", null, malformed, etc.)
 * @param {Array<{name:string,operator:string,platform:string,purpose:string}>} bots
 * @param {string} [path="/"]
 * @returns {{
 *   parsed: ReturnType<typeof parseRobotsTxt>,
 *   path: string,
 *   results: Array<{name:string,operator:string,platform:string,purpose:string,status:string,matchedGroup:string|null,reason:string,unknown?:boolean}>,
 *   summary: { open: number, partial: number, blocked: number, total: number },
 *   malformed: boolean,
 *   empty: boolean,
 * }}
 */
export function auditDomain(robotsText, bots, path = "/") {
  const parsed = parseRobotsTxt(robotsText);
  const botList = Array.isArray(bots) ? bots : [];

  const results = botList.map((bot) => {
    const evaluation = evaluateBot(parsed, bot.name, path);
    return { ...bot, ...evaluation };
  });

  const summary = results.reduce(
    (acc, r) => {
      if (acc[r.status] != null) acc[r.status] += 1;
      acc.total += 1;
      return acc;
    },
    { open: 0, partial: 0, blocked: 0, total: 0 }
  );

  return { parsed, path, results, summary, malformed: parsed.malformed, empty: parsed.empty };
}

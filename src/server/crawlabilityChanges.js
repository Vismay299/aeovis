/**
 * R4.3.1 — detect changes between two crawlability audit snapshots.
 *
 * "Your site started blocking GPTBot on Tuesday" becomes an event — the first
 * detector in the product.
 *
 * A change event records exactly which bots changed status and in which
 * direction, so a human or an alert can read the diff without replaying the
 * whole audit. The diff is a compact, per-bot list:
 *
 *   { name, operator, purpose, previous, current }
 *
 * Only bots whose STATUS actually changed are included. A bot whose `reason`
 * text changed but its status is still "open" is NOT a change event — the
 * reason is informational detail, not the access verdict.
 *
 * DESIGN DECISIONS:
 *
 *   1. The diff is computed BEFORE saving, so the saved row carries it as
 *      part of the history. A consumer reading history does not need to
 *      re-diff adjacent rows — the diff is already there.
 *
 *   2. Only status transitions matter (open↔partial↔blocked). A `reason`
 *      string may change because a site reworded its robots.txt comment or
 *      because a new group was added above the existing one. Surfacing that
 *      as a "change" would be noisy and unactionable.
 *
 *   3. This module is pure — no DB, no network, no fetch. It takes two
 *      bot arrays and returns a diff. The DB layer (db/crawlability.js)
 *      persists the result.
 */

/**
 * A single bot status transition.
 *
 * @typedef {Object} BotChange
 * @property {string}  name      — the crawler's product token
 * @property {string}  operator  — the company running it
 * @property {string}  purpose   — "training" | "search" | "agent"
 * @property {string}  previous  — old status ("open" | "partial" | "blocked")
 * @property {string}  current   — new status ("open" | "partial" | "blocked")
 */

/**
 * Compare two arrays of bot evaluation results and return the list of
 * bots whose status changed.
 *
 * Both arrays must have the same structure as the `bots` array produced
 * by `auditDomain()` from robots.js — each entry has at minimum
 * `{ name, status }`.
 *
 * @param {Array<{ name: string, status: string, operator?: string, purpose?: string }>} previousBots
 * @param {Array<{ name: string, status: string, operator?: string, purpose?: string }>} currentBots
 * @returns {BotChange[]} bots whose status transitioned (empty array = no change)
 */
export function detectBotChanges(previousBots, currentBots) {
  if (!Array.isArray(previousBots) || !Array.isArray(currentBots)) return [];

  // Build a lookup from previous bots: name → { status, operator, purpose }
  const prevMap = new Map();
  for (const bot of previousBots) {
    if (bot && typeof bot.name === "string") {
      prevMap.set(bot.name.toLowerCase(), {
        status: bot.status,
        operator: bot.operator || "unknown",
        purpose: bot.purpose || "unknown",
      });
    }
  }

  const changes = [];

  for (const bot of currentBots) {
    if (!bot || typeof bot.name !== "string") continue;
    const key = bot.name.toLowerCase();
    const prev = prevMap.get(key);
    if (!prev) continue; // new bot not in previous audit — not a status change

    const currentStatus = bot.status;
    if (prev.status !== currentStatus) {
      changes.push({
        name: bot.name,
        operator: bot.operator || prev.operator,
        purpose: bot.purpose || prev.purpose,
        previous: prev.status,
        current: currentStatus,
      });
    }
  }

  return changes;
}

/**
 * Build the summary of changes between two audits, suitable for storage
 * in the `diff` column of crawlability_audits.
 *
 * @param {Object|null} previousAudit — the previous audit row (null if first audit)
 * @param {Array} currentBots — the bots array from the current audit
 * @returns {{ changes: BotChange[], summary: string, detected_at: string }|null}
 *          null when there is no previous audit or no changes
 */
export function buildAuditDiff(previousAudit, currentBots) {
  if (!previousAudit || !Array.isArray(previousAudit.bots) || previousAudit.bots.length === 0) {
    return null; // first audit — nothing to diff against
  }

  const changes = detectBotChanges(previousAudit.bots, currentBots);
  if (changes.length === 0) return null;

  // Build a human-readable summary
  const blocked = changes.filter((c) => c.current === "blocked");
  const opened = changes.filter((c) => c.current === "open" && c.previous === "blocked");
  const partial = changes.filter((c) => c.current === "partial" && c.previous !== "partial");

  const parts = [];
  if (blocked.length > 0) {
    const names = blocked.map((c) => c.name).join(", ");
    parts.push(`${names} ${blocked.length === 1 ? "is" : "are"} now blocked`);
  }
  if (opened.length > 0) {
    const names = opened.map((c) => c.name).join(", ");
    parts.push(`${names} ${opened.length === 1 ? "is" : "are"} now open`);
  }
  if (partial.length > 0) {
    const names = partial.map((c) => c.name).join(", ");
    parts.push(`${names} ${partial.length === 1 ? "has" : "have"} partial restrictions`);
  }

  return {
    changes,
    summary: parts.join("; ") || `${changes.length} bot(s) changed status`,
    detected_at: new Date().toISOString(),
  };
}

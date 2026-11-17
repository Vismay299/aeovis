/**
 * R2.8.16 — the one contract that keeps "we could not read your workspace" and
 * "your workspace is empty" from rendering the same thing.
 *
 * These two functions are the two ends of the same wire and live together on
 * purpose: the server builds the refusal envelope, the client reads it, and
 * neither may be changed without the other being in view. Both are pure, so the
 * suite drives them directly instead of inferring them from source.
 *
 * WHAT WENT WRONG. listRecentScans (src/server/db.js) refuses rather than guessing
 * — ScansUnavailableError/`db_not_configured` when there is no client (R2.8.15),
 * `db_read_failed` when the database answered with an error. GET /api/history
 * caught that refusal and answered
 *
 *     200 { scans: [], runs: [], activeJobs: [], counts: {} }
 *
 * which is byte-for-byte what a brand-new operator's genuinely empty workspace
 * looks like. HomeDashboard then decided on `scans.length === 0` and rendered
 * the clean first-run page. An operator with a year of history saw an empty
 * product and no error; the refusal existed only in the server log.
 *
 * THE DISCRIMINATOR IS `store`, NEVER A LENGTH.
 *
 *   store: "ok"          the store answered. `scans` is an array and `[]` is a
 *                        real, measured "nothing here yet".
 *   store: "unreachable" the store was not read. Every collection is `null`,
 *                        `counts` is `null`, and the status is 503 — an
 *                        unmeasured value must not be shaped like a measured
 *                        zero anywhere downstream.
 */

/** The HTTP status a refusal answers with. Not 200, and not 404 either. */
export const HISTORY_UNREACHABLE_STATUS = 503;

/**
 * The refusal envelope for GET /api/history.
 *
 * `reason` is the refusing error's own `code` passed straight through, so no new
 * vocabulary is minted here: it is `db_not_configured` or `db_read_failed` from
 * ScansUnavailableError, and `"unknown"` only when the thrown value carried no
 * code at all. The upstream message is NOT included — it is logged for the
 * operator and never sent to a client, the same rule as
 * /api/scans/[brand]/latest.
 *
 * @param {unknown} error the value GET's catch received
 * @returns {{status: number, body: object}}
 */
export function historyStoreUnreachable(error) {
  const code = error && typeof error.code === "string" ? error.code : "";
  return {
    status: HISTORY_UNREACHABLE_STATUS,
    body: {
      store: "unreachable",
      reason: code || "unknown",
      detail:
        "Workspace history could not be read, so this is not a workspace with " +
        "nothing in it — it is a refusal to look. Nothing here was measured.",
      scans: null,
      runs: null,
      activeJobs: null,
      counts: null,
    },
  };
}

/**
 * The client half. Exactly one input renders the workspace: an HTTP-ok response
 * whose body says `store: "ok"`. Everything else is an outage and carries
 * `data: null`, so no later branch can count it.
 *
 * Pass `null` for a request that never completed (a thrown fetch): that is not a
 * store that answered with nothing, it is a question that was never asked.
 *
 * @param {{ok: boolean, status: number, body: any}|null} res
 * @returns {{data: object|null, outage: {reason: string}|null}}
 */
export function historyLoadState(res) {
  if (!res) return { data: null, outage: { reason: "request_failed" } };
  if (res.ok && res.body && res.body.store === "ok") {
    return { data: res.body, outage: null };
  }
  const reason =
    (res.body && typeof res.body.reason === "string" && res.body.reason) ||
    `http_${res.status}`;
  return { data: null, outage: { reason } };
}

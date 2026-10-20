/**
 * R05 — the four cases this pass cannot run, registered as BLOCKED rather than
 * omitted.
 *
 * WHY THEY ARE HERE AT ALL. A case that is not registered is indistinguishable
 * from a case that passed, and this repair's whole subject is a number that
 * looked green while the measurement behind it did not exist. So each blocked
 * case is registered with the level it needs and the reason it cannot run
 * offline, and a green run of r05-*.test.mjs cannot be read as "all 24 passed".
 *
 * WHAT WOULD UNBLOCK THEM, stated so the next pass does not have to re-derive it:
 *   R05-19, R05-20 need a disposable PostgreSQL with the real migrations applied
 *     (idempotent re-run of a daily rollup; a legacy row without raw evidence).
 *     A stubbed/ in-memory store would not establish either — the point of both
 *     cases is what a second WRITE does to durable rows.
 *   R05-22, R05-23 need the actual Next app in a browser (a report page rendering
 *     counts next to a withheld headline, and a measured zero rendering
 *     differently from an unavailable value). Server-rendered markup or a
 *     component test is not a substitute: the cases are about what is visible.
 * No database work, no browser work and no provider calls are in scope for this
 * pass, so these stay blocked and the repair stays open.
 */
import test from "node:test";

const BLOCKED_REASON =
  "BLOCKED — needs a disposable PostgreSQL with the real migrations applied; " +
  "an in-memory or stubbed store cannot establish what a second durable WRITE does. " +
  "Out of scope for this pass (no database work).";

const BROWSER_REASON =
  "BLOCKED — needs the real Next app running in a browser to observe what is visible. " +
  "Out of scope for this pass (no browser work).";

test("R05-19 — re-running the same daily rollup writes idempotent counts, value and version", { skip: BLOCKED_REASON }, () => {});

test("R05-20 — a historical row without raw evidence backfills as legacy/unknown, never a modern qualified score", { skip: BLOCKED_REASON }, () => {});

test("R05-22 — an insufficient but high raw ratio shows counts, a quality label and a withheld headline together", { skip: BROWSER_REASON }, () => {});

test("R05-23 — a measured zero and an unknown are distinct on screen and in machine data", { skip: BROWSER_REASON }, () => {});

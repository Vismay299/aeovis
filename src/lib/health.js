/**
 * /api/health's payload, built as a pure function (R0.1.7, finding S20).
 *
 * There was no way to answer "is this deployment wired up?" without reading
 * source. This is that answer, and it is deliberately CHEAP: vendor entries
 * report whether a credential is CONFIGURED, never the result of a live call,
 * so hitting /api/health cannot itself spend vendor budget. Whether a
 * configured key actually works is `npm run check:secrets` (R0.1.6), which is
 * run on purpose, not on every health poll.
 *
 * Standing rule 1 applies throughout: "not configured" and "we did not look"
 * must not render the same, and a missing tick is null, never `now`.
 */

/**
 * The vendor list is NOT this file's. It lives in src/lib/vendorRegistry.js and
 * is the same frozen array scripts/check-secrets.mjs imports — one list, not two
 * that have to be kept in step by hand (R0.1.16, finding S30). This file used to
 * hold its own copy under a comment claiming both surfaces shared it; they did
 * not, and a tenth vendor added to either would have been invisible on the other.
 *
 * Re-exported because /api/health's tests and callers have always read VENDORS
 * from here. What this file still owns is the CHEAP reading of that list —
 * credential presence — while check:secrets owns the live authenticated call per
 * vendor. That difference is real and deliberate; two lists were never what made
 * it possible.
 */
import { VENDORS, credentialStatus } from "./vendorRegistry.js";

export { VENDORS };

/**
 * Configured-ness per vendor, in the shape /api/health returns.
 *
 * The per-vendor verdict comes from credentialStatus() in the registry, which
 * check:secrets also calls, so the two surfaces cannot come to different answers
 * about the same environment. This function only adds `required` and keys the
 * result by vendor. Pure: it never warns or logs, so /api/health stays free of
 * side effects.
 */
export function vendorFlags(env = {}) {
  const out = {};
  for (const vendor of VENDORS) {
    const { configured, missing, deprecated } = credentialStatus(vendor, env);
    out[vendor.key] = { configured, required: vendor.required, missing, deprecated };
  }
  return out;
}

/**
 * Assemble the response.
 *
 * @param {object} args
 * @param {{ok: boolean, error?: string|null, latency_ms?: number|null}} args.db result of the reachability probe
 * @param {object} args.env process.env (or a stub)
 * @param {Array<{name: string, last_tick_at: string}>} args.ticks system_heartbeats rows
 * @param {string} args.now ISO timestamp
 * @param {number} [args.staleTickMs] a tick older than this is reported stale
 */
export function buildHealthPayload({ db, env = {}, ticks = [], now, staleTickMs = 2 * 60 * 60 * 1000 }) {
  const vendors = vendorFlags(env);
  const nowMs = Date.parse(now);

  const cron = {};
  for (const row of ticks || []) {
    if (!row?.name) continue;
    const at = row.last_tick_at || null;
    const atMs = at ? Date.parse(at) : NaN;
    cron[row.name] = {
      last_tick_at: at,
      // Never coerce an unknown age to 0 — that would read as "just ticked".
      age_ms: Number.isFinite(atMs) && Number.isFinite(nowMs) ? nowMs - atMs : null,
      stale: Number.isFinite(atMs) && Number.isFinite(nowMs) ? nowMs - atMs > staleTickMs : null,
    };
  }
  // A ticker that has NEVER fired must be visible as such, not simply absent.
  for (const name of ["scan-worker", "content-worker"]) {
    if (!cron[name]) cron[name] = { last_tick_at: null, age_ms: null, stale: null };
  }

  const missingRequired = Object.entries(vendors)
    .filter(([, v]) => v.required && !v.configured)
    .map(([key]) => key);

  // "degraded", not "ok", whenever something a scan needs is absent. An
  // endpoint that says ok while the LLM is unconfigured is the health-check
  // equivalent of a 100% share of voice.
  const status = !db?.ok ? "down" : missingRequired.length ? "degraded" : "ok";

  return {
    status,
    checked_at: now,
    db: {
      ok: !!db?.ok,
      latency_ms: db?.latency_ms ?? null,
      error: db?.error ?? null,
    },
    vendors,
    missing_required: missingRequired,
    cron,
  };
}

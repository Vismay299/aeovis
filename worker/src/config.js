/**
 * Fleet configuration, read once at boot.
 *
 * Deliberately its own file with no imports from the web app: the whole point
 * of this workspace (R1.2.1) is that the fleet runs on a container host that
 * has never heard of Next. Anything shared with `src/` gets COPIED here rather
 * than imported, and the guard test enforces that.
 */

/** Parse a comma list of engine names. */
function parseList(raw) {
  return String(raw || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function intFromEnv(raw, fallback, { min, max }) {
  const n = Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * Resolve the fleet's configuration.
 *
 * `strict` decides what a missing credential means. Booting the real fleet
 * without Supabase is a fatal misconfiguration — it would poll nothing forever
 * and look healthy doing it — so `start()` demands it. `--selftest` does not,
 * because proving the workspace starts standalone must not require a database.
 */
export function resolveConfig(env = process.env, { strict = true } = {}) {
  const supabaseUrl = env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL || null;
  const supabaseKey =
    env.SUPABASE_SERVICE_ROLE_KEY || env.NEXT_PUBLIC_SUPABASE_ANON_KEY || null;

  const missing = [];
  if (!supabaseUrl) missing.push("SUPABASE_URL");
  if (!supabaseKey) missing.push("SUPABASE_SERVICE_ROLE_KEY");

  if (strict && missing.length) {
    throw new Error(
      `The fleet cannot start without ${missing.join(" and ")}. ` +
        `A worker with no queue to read would poll nothing forever and report itself healthy.`
    );
  }

  // Hoisted because heartbeatMs is clamped against it below.
  const leaseMs = intFromEnv(env.FLEET_LEASE_MS, 300_000, { min: 30_000, max: 3_600_000 });

  return {
    supabaseUrl,
    supabaseKey,
    /** Which real surfaces this container drives. */
    engines: parseList(env.FLEET_ENGINES || "perplexity"),
    /** Probe batch size per claim. */
    batchSize: intFromEnv(env.FLEET_BATCH_SIZE, 5, { min: 1, max: 50 }),
    /** How long a claimed batch stays leased before it can be reaped. */
    leaseMs,
    /** Gap between polls when the queue came back empty. */
    idlePollMs: intFromEnv(env.FLEET_IDLE_POLL_MS, 10_000, { min: 1_000, max: 300_000 }),
    /**
     * How often an in-flight scan_runs row says it is still alive (R1.2.3).
     *
     * CLAMPED TO HALF THE LEASE, and that is a correctness bound rather than a
     * preference: a run whose heartbeat has stopped moving is how R3.3.2's
     * sweep decides a container died, so a heartbeat slower than the lease
     * would have the fleet declared dead in the middle of a probe it is still
     * running. FLEET_LEASE_MS can be set as low as 30s, so a fixed ceiling here
     * could not make that promise -- the clamp can.
     */
    heartbeatMs: Math.min(
      intFromEnv(env.FLEET_HEARTBEAT_MS, 30_000, { min: 5_000, max: 600_000 }),
      Math.floor(leaseMs / 2)
    ),
    /** Identity written onto every claim and heartbeat. */
    workerId: env.FLEET_WORKER_ID || `worker-${process.pid}`,
    /** Set by --selftest; the loop exits after one pass instead of running forever. */
    once: false,
    missing,
  };
}

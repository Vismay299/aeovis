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
 * Every vendor this app can talk to, and the env var that configures it.
 * Add a vendor here and both /api/health and check:secrets learn about it.
 */
export const VENDORS = Object.freeze([
  { key: "supabase", env: ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY"], required: true },
  { key: "llm", env: ["OPENROUTER_API_KEY"], required: true },
  { key: "brightdata", env: ["BRIGHTDATA_API_KEY"], required: true },
  { key: "firecrawl", env: ["FIRECRAWL_API_KEY"], required: false },
  { key: "perplexity", env: ["PERPLEXITY_API_KEY"], required: false },
  { key: "openai", env: ["OPENAI_API_KEY"], required: false },
  { key: "gemini", env: ["GEMINI_API_KEY"], required: false },
  { key: "gsc", env: ["GSC_SERVICE_ACCOUNT_KEY"], required: false },
  { key: "cron", env: ["CRON_SECRET"], required: true },
]);

const present = (env, name) => String(env[name] || "").trim().length > 0;

/**
 * Configured-ness per vendor. `configured` is true only when EVERY env var
 * the vendor needs is non-empty; `missing` names the ones that are not, so an
 * operator gets the fix rather than just a red flag.
 */
export function vendorFlags(env = {}) {
  const out = {};
  for (const vendor of VENDORS) {
    const missing = vendor.env.filter((name) => !present(env, name));
    out[vendor.key] = {
      configured: missing.length === 0,
      required: vendor.required,
      missing,
    };
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

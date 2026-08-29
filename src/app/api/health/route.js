import { NextResponse } from "next/server";
import { supabase } from "@/lib/db";
import { getCronTicks } from "@/lib/db/analytics";
import { buildHealthPayload } from "@/lib/health";

// Reads live state; must never be prerendered at build time.
export const dynamic = "force-dynamic";

/**
 * Deployment health (R0.1.7, finding S20).
 *
 * Three questions, cheaply: is the database reachable, which vendors are
 * CONFIGURED (not whether their keys work — that is `npm run check:secrets`,
 * run deliberately, so polling health cannot spend vendor budget), and when
 * did each cron last actually fire.
 *
 * Public and unauthenticated on purpose: it exposes no customer data, no
 * credential values and no vendor responses — only booleans, a timestamp per
 * ticker, and the NAMES of missing env vars. It stays outside the operator
 * perimeter so an uptime monitor can reach it. If a field is ever added that
 * reveals more than that, it belongs behind the perimeter instead.
 *
 * The payload shape lives in src/lib/health.js so it is unit-testable without
 * a server; this route is just I/O.
 */
export async function GET() {
  const now = new Date().toISOString();

  let db = { ok: false, latency_ms: null, error: "Supabase is not configured." };
  if (supabase) {
    const startedAt = Date.now();
    try {
      // The cheapest possible reachability probe: a bounded count, no rows.
      const { error } = await supabase
        .from("scan_jobs")
        .select("id", { count: "exact", head: true })
        .limit(1);
      db = error
        ? { ok: false, latency_ms: Date.now() - startedAt, error: error.message }
        : { ok: true, latency_ms: Date.now() - startedAt, error: null };
    } catch (err) {
      db = { ok: false, latency_ms: Date.now() - startedAt, error: err.message };
    }
  }

  let ticks = [];
  try {
    ticks = await getCronTicks();
  } catch (err) {
    // A tick read failing is itself health information — surface it rather
    // than reporting "never ticked", which would look identical to a dead cron.
    ticks = [];
    db.error = db.error || `cron tick read failed: ${err.message}`;
  }

  const payload = buildHealthPayload({ db, env: process.env, ticks, now });

  // 200 for ok/degraded, 503 when the database is unreachable — an uptime
  // monitor should page on "down", not on "Firecrawl is unconfigured".
  return NextResponse.json(payload, { status: payload.status === "down" ? 503 : 200 });
}

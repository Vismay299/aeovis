import { NextResponse } from "next/server";
import { findCustomerBrand, getCustomerContext } from "@/shared/supabase/customer";
import { isFeatureEnabled } from "@/server/features/flags.ts";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

// T9 — daily history for the Overview data cards. Rows exist only on days a
// scan ran, so the response is a dense calendar where a day without a row is
// null (not measured), never 0.
const HISTORY_DAYS = 90;
// Pages stay below PostgREST's max_rows (1000), so a short page really is the
// last one. 90 days x 5 engine rows fits in one page; the cap bounds the read.
const HISTORY_PAGE = 500;
const HISTORY_MAX_PAGES = 4;
const DAY_MS = 86_400_000;
const SOV_STATES = new Set(["measured", "measured_zero", "not_assessed", "failed"]);

const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

function countOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

async function readMetricHistory(client, brandKey, from) {
  const rows = [];
  for (let page = 0; page < HISTORY_MAX_PAGES; page += 1) {
    const start = page * HISTORY_PAGE;
    const { data, error } = await client.from("brand_metrics_daily")
      .select("date, engine, sov_state, prompts_mentioned")
      .eq("brand", brandKey)
      .gte("date", from)
      .order("date", { ascending: true })
      .order("engine", { ascending: true })
      .range(start, start + HISTORY_PAGE - 1);
    if (error) return { data: null, error };
    rows.push(...(data || []));
    if (!data || data.length < HISTORY_PAGE) break;
  }
  return { data: rows, error: null };
}

/**
 * `dailyMentions`: one entry per calendar day, oldest first. `mentioned` is
 * the blended 'all' row's distinct-question count; `byEngine` holds each
 * engine's own count (they overlap, so they do not add up to `mentioned`).
 * `engines`: one row per engine, one day per calendar day, `state` the stored
 * `sov_state`, or null when that engine has no row that day.
 */
function shapeHistory(rows, today) {
  // Row dates are written in IST (rollup.toDateOnly), which can be a day
  // ahead of UTC, so the window ends at the later of the two.
  const latest = rows.reduce((max, row) => {
    const date = String(row.date).slice(0, 10);
    return date > max ? date : max;
  }, today);
  const end = Date.parse(`${latest}T00:00:00Z`);
  const dates = Array.from({ length: HISTORY_DAYS }, (_, i) => isoDay(end - (HISTORY_DAYS - 1 - i) * DAY_MS));
  const inWindow = new Set(dates);

  const blended = new Map();
  const perEngine = new Map();
  for (const row of rows) {
    const date = String(row.date).slice(0, 10);
    const engine = row.engine ? String(row.engine) : null;
    if (!engine || !inWindow.has(date)) continue;
    if (engine === "all") {
      blended.set(date, countOrNull(row.prompts_mentioned));
      continue;
    }
    if (!perEngine.has(engine)) perEngine.set(engine, new Map());
    perEngine.get(engine).set(date, {
      mentioned: countOrNull(row.prompts_mentioned),
      state: SOV_STATES.has(row.sov_state) ? row.sov_state : null,
    });
  }

  const engineKeys = [...perEngine.keys()].sort();
  const dailyMentions = dates.map((date) => ({
    date,
    mentioned: blended.has(date) ? blended.get(date) : null,
    byEngine: Object.fromEntries(
      engineKeys.map((engine) => [engine, perEngine.get(engine).get(date)?.mentioned ?? null]),
    ),
  }));
  const engines = engineKeys.map((engine) => ({
    engine,
    days: dates.map((date) => ({ date, state: perEngine.get(engine).get(date)?.state ?? null })),
  }));
  return { dailyMentions, engines };
}

function fail(status, error) {
  return NextResponse.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
}

export async function GET(request) {
  const context = await getCustomerContext();
  if (context.error === "auth_not_configured") return fail(503, "Customer login is not configured on this deployment.");
  if (!context.user) return fail(401, "Please sign in to view your workspace.");
  if (context.error) {
    console.error("[customer] membership lookup failed:", context.cause);
    return fail(503, "Your workspace access could not be loaded. Please try again.");
  }

  const { searchParams } = new URL(request.url);
  const brand = findCustomerBrand(context.brands, searchParams.get("brand_key") || context.brands[0]?.brandKey);
  if (!brand) return fail(404, "That brand is not assigned to your account.");

  try {
    const client = context.client;
    const today = isoDay(Date.now());
    const historyFrom = isoDay(Date.parse(`${today}T00:00:00Z`) - HISTORY_DAYS * DAY_MS);
    const [scansResult, jobsResult, metricsResult, contentResult, historyResult] = await Promise.all([
      client.from("scans")
        .select("id, brand, url, scanned_at, created_at, visibility_pct, prompts_tracked, prompts_mentioned, platform")
        .eq("brand_key", brand.brandKey)
        .order("scanned_at", { ascending: false, nullsFirst: false })
        .limit(100),
      client.from("scan_jobs")
        .select("id, brand, url, status, progress_pct, created_at")
        .eq("brand_key", brand.brandKey)
        .order("created_at", { ascending: false })
        .limit(100),
      client.from("brand_metrics_daily")
        .select("date, engine, visibility_pct, sov_pct, citation_share_pct, prompts_total, prompts_answered, prompts_mentioned")
        .eq("brand", brand.brandKey)
        .order("date", { ascending: false })
        .limit(30),
      client.from("content_items")
        .select("id, brand, title, status, updated_at, created_at")
        .eq("brand", brand.brandKey)
        .order("updated_at", { ascending: false })
        .limit(100),
      readMetricHistory(client, brand.brandKey, historyFrom),
    ]);

    const failed = [scansResult, jobsResult, metricsResult, contentResult, historyResult].find((result) => result.error);
    if (failed) throw failed.error;

    const scans = (scansResult.data || []).slice(0, 10);
    const jobs = (jobsResult.data || []).slice(0, 10);
    const contentItems = (contentResult.data || []).slice(0, 10);
    const { dailyMentions, engines } = shapeHistory(historyResult.data || [], today);

    return NextResponse.json({
      brand: { brand_key: brand.brandKey, display_name: brand.display_name, website: brand.website },
      latest_scan: scans[0] || null,
      scans,
      scan_jobs: jobs,
      metrics: metricsResult.data || [],
      content_items: contentItems,
      dailyMentions,
      engines,
      features: {
        prompt_explorer: await isFeatureEnabled("prompt_explorer", brand.brandKey),
      },
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error(`[customer] overview query failed for ${brand.brandKey}:`, error);
    return fail(500, "Could not load your workspace data.");
  }
}

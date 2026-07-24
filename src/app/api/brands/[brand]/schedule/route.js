import { NextResponse } from "next/server";
import { getScanSchedule, upsertScanSchedule } from "@/lib/db/analytics";
import { validateScheduleBody, applyInsertDefaults, applyNextRunAt } from "@/lib/brandAnalyticsApi";

// Schedule state changes on every PUT and the worker's own writes
// (last_run_at/next_run_at) — never statically cache either verb.
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

/**
 * Default schedule shape returned when a brand has no scan_schedules row yet
 * (plan.md P0.4), so the UI always has something to render. Note this
 * intentionally differs from the DB column defaults for `enabled` (DB
 * default is `true`; product default here is `false` — opt-in scheduling).
 * See brandAnalyticsApi.js's `applyInsertDefaults` for how the PUT handler
 * keeps a brand-new row's `enabled` consistent with this same default.
 */
function defaultSchedule(brandKey) {
  return {
    brand: brandKey,
    cadence: "72h",
    enabled: false,
    prompt_target: 30,
    geo: "in",
    next_run_at: null,
  };
}

function requireBrandKey(params) {
  const { brand } = params || {};
  if (!brand) return { brandKey: null, error: "Brand is required." };
  const brandKey = decodeURIComponent(brand);
  if (!brandKey.trim()) return { brandKey: null, error: "Brand is required." };
  return { brandKey, error: null };
}

/**
 * GET /api/brands/[brand]/schedule — plan.md §4 P0.4.
 *
 * Brand-keying contract: the `[brand]` path param is ALREADY a
 * resolveBrandKey() output (see src/lib/scoring/brandKey.js); used verbatim
 * (decoded) as the scan_schedules.brand lookup key, never re-resolved here.
 *
 * Response 200: { schedule } — the stored row, or defaultSchedule(brandKey)
 * when none exists yet.
 */
export async function GET(request, { params }) {
  try {
    const { brandKey, error: brandError } = requireBrandKey(params);
    if (brandError) {
      return NextResponse.json({ error: brandError }, { status: 400 });
    }

    let schedule;
    try {
      schedule = await getScanSchedule(brandKey);
    } catch (dbError) {
      console.error(`Error fetching schedule for "${brandKey}":`, dbError);
      return NextResponse.json({ error: "Failed to load schedule." }, { status: 500 });
    }

    return NextResponse.json(
      { schedule: schedule || defaultSchedule(brandKey) },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    console.error("Error in GET /api/brands/[brand]/schedule:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

/**
 * PUT /api/brands/[brand]/schedule — plan.md §4 P0.4.
 *
 * Body (all optional): { cadence?, enabled?, engines?, geo?, prompt_target? }
 *   cadence       — one of "72h" | "daily" | "weekly" | "off"
 *   enabled       — boolean
 *   prompt_target — integer in [10, 100]
 *   geo           — non-empty string (normalized: trimmed + lowercased)
 *   engines       — non-empty string, or array of non-empty strings (joined
 *                   with "," — scan_schedules.engines is a single text column)
 * Unspecified fields are left untouched (upsertScanSchedule's upsert is
 * column-scoped — see db/analytics.test.mjs).
 *
 * `next_run_at` is derived, not accepted from the client: recomputed as
 * now + cadence whenever `cadence` changes or the schedule is being enabled;
 * "off" always clears it to null. `last_run_at` is never touched here — only
 * the scan worker/scheduler tick owns that field.
 *
 * Response 200: { schedule } — the saved row (post-upsert).
 * Errors: 400 on a missing brand, invalid JSON, or a validation failure
 * (message names the offending field); 500 on a DB failure.
 */
export async function PUT(request, { params }) {
  try {
    const { brandKey, error: brandError } = requireBrandKey(params);
    if (brandError) {
      return NextResponse.json({ error: brandError }, { status: 400 });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
    }

    const { error: validationError, updates } = validateScheduleBody(body);
    if (validationError) {
      return NextResponse.json({ error: validationError }, { status: 400 });
    }

    let existing;
    try {
      existing = await getScanSchedule(brandKey);
    } catch (dbError) {
      console.error(`Error fetching schedule for "${brandKey}":`, dbError);
      return NextResponse.json({ error: "Failed to load schedule." }, { status: 500 });
    }

    const withDefaults = applyInsertDefaults(updates, existing);
    const finalUpdates = applyNextRunAt(withDefaults, existing);

    let saved;
    try {
      saved = await upsertScanSchedule(brandKey, finalUpdates);
    } catch (dbError) {
      console.error(`Error saving schedule for "${brandKey}":`, dbError);
      return NextResponse.json({ error: "Failed to save schedule." }, { status: 500 });
    }

    return NextResponse.json({ schedule: saved }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Error in PUT /api/brands/[brand]/schedule:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

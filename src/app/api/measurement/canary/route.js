import { NextResponse } from "next/server";
import { dispatchCanaries } from "@/server/ops/providerCanary";
import { getSupabaseAdmin } from "@/shared/supabase/admin";
import { createProbeDispatchStore } from "@/server/db/probeDispatch";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
const OFFERED = ["aio", "chatgpt", "gemini", "perplexity"];

// Protected by the operator perimeter. Every POST still needs a deliberately
// named immutable slot and SQL-enforced request/spend ceilings.
export async function POST(request, _context, deps = {}) {
  const origin = request.headers.get("origin");
  if ((origin && origin !== new URL(request.url).origin) || request.headers.get("sec-fetch-site") === "cross-site")
    return NextResponse.json({ error: "Cross-site canary dispatch refused" }, { status: 403 });
  const body = await request.json().catch(() => null);
  const engines = body?.engines;
  if (!body || !/^qa-[a-z0-9-]{4,70}$/.test(body.slot || "") ||
    !Array.isArray(engines) || engines.length === 0 || engines.length > OFFERED.length || new Set(engines).size !== engines.length ||
    engines.some(name => !OFFERED.includes(name)) ||
    !Number.isInteger(body.max_requests) || body.max_requests < 1 || body.max_requests > 12 ||
    !Number.isFinite(body.max_spend_usd) || body.max_spend_usd <= 0 || body.max_spend_usd > 10 ||
    !Number.isFinite(body.reserve_usd) || body.reserve_usd <= 0 || body.reserve_usd > body.max_spend_usd)
    return NextResponse.json({ error: "Provide offered engines, a QA slot and bounded positive request/spend limits" }, { status: 400 });
  const client = (deps.getSupabaseAdmin || getSupabaseAdmin)();
  if (!client) return NextResponse.json({ error: "Canary storage unavailable" }, { status: 503 });
  try {
    const results = await (deps.dispatchCanaries || dispatchCanaries)({ engines, slot: body.slot,
      maxRequests: body.max_requests, maxSpendUsd: body.max_spend_usd, reserveUsd: body.reserve_usd,
      store: createProbeDispatchStore(client) });
    return NextResponse.json({ results, readiness_is_time_limited: true }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Canary dispatch was not completed; inspect durable attempts before retrying the same slot" }, { status: 503 });
  }
}

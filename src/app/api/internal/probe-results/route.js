import { NextResponse } from "next/server";
import { supabase } from "@/server/db";
import { upsertPromptResults } from "@/server/db/analytics";
import { resolveNodeEnv } from "@/server/operatorPerimeter";
import { checkIngestAuth, INGEST_AUTH } from "../_lib/ingestAuth";
import {
  toPromptResultRow,
  validateIngestBody,
} from "../_lib/probeResultContract";

/**
 * POST /api/internal/probe-results — the probe fleet's ingest (R1.2.4).
 *
 * The fleet in `worker/` runs on a container host that has never heard of Next
 * and holds no Supabase service key of its own for this table; it reports its
 * measurements here. Three properties, which are also this task's acceptance
 * criteria:
 *
 *   1. AUTHENTICATED, FAIL CLOSED. Every request without the fleet's token is
 *      401, including when `PROBE_INGEST_TOKEN` is absent from the environment
 *      entirely — see `../_lib/ingestAuth.js` for why this gate is stricter
 *      than `src/server/cronAuth.js` rather than a reuse of it.
 *   2. CONTRACT-VALIDATED, 422, NEVER REPAIRED. `docs/contracts/probe-result.md`
 *      §5: "It must not repair, default, or coerce. A rejected probe result is
 *      not written and the task is left for retry." The validator is
 *      `../_lib/probeResultContract.js`.
 *   3. IDEMPOTENT. The upsert conflict key is `(job_id, engine, query)` — the
 *      UNIQUE constraint migration 005 already declares on `prompt_results` for
 *      exactly this reason (D5) — so a retried batch produces one row per
 *      measurement, not two.
 *
 * "internal" IS A DIRECTORY NAME, NOT A CONTROL. The gate above is what makes
 * this route internal. The operator perimeter (`src/middleware.js`) also stands
 * in front of it, because `/api/internal/probe-results` is not on its public
 * allowlist and not in its SELF_GATED list — which means in production a caller
 * needs OPERATOR_TOKEN *and* the ingest token to reach this handler. That is
 * defence in depth and it is deliberately NOT loosened here; wiring the fleet
 * through it (either by adding this path to SELF_GATED or by giving the fleet
 * both credentials) is a deployment decision that belongs with the fleet's own
 * configuration, and is reported rather than taken unilaterally by this task.
 *
 * WHAT THIS ROUTE DOES NOT DO. It does not spend a cent — no vendor is called,
 * no model is invoked, nothing is fetched. It writes to one table. Nothing from
 * the request body reaches a URL, a redirect, or hand-written SQL: the only
 * consumer is a parameterised PostgREST upsert.
 */

// Side effects (it writes rows). Without this Next prerenders the route during
// `next build` and can execute the handler — the same reason both worker routes
// carry it.
export const dynamic = "force-dynamic";

/** Boxed so the shared gate can flip it; one misconfiguration warning per process. */
const warnedAuth = { value: false };

/**
 * A bound on one batch. `FLEET_BATCH_SIZE` is capped at 50 in
 * `worker/src/config.js`, so 200 is four times the largest legitimate batch and
 * still refuses an unbounded body outright instead of parsing it.
 */
const MAX_RESULTS_PER_BATCH = 200;

/** 422, with every violation rather than the first. */
function unprocessable(violations) {
  return NextResponse.json(
    {
      detail:
        "Rejected against Probe Result Contract v2 (docs/contracts/probe-result.md §3). " +
        "Nothing was written; the task is left for retry. This route does not repair, default " +
        "or coerce a body (§5).",
      violations,
    },
    { status: 422 }
  );
}

export async function POST(request) {
  // ------------------------------------------------------------------ 1. auth
  const auth = checkIngestAuth(request, { warned: warnedAuth });
  if (!auth.authorized) {
    // One opaque body for every refusal reason. Telling an anonymous caller
    // that no token is configured is a free hint about the deployment; the
    // operator's copy is the log line the gate already emitted, which names the
    // variable and never its value.
    return NextResponse.json({ detail: "Unauthorized." }, { status: 401 });
  }

  // ------------------------------------------------------------------ 2. body
  let body;
  try {
    body = await request.json();
  } catch {
    // 422 rather than 400 because R1.2.4's criterion is "a malformed body
    // returns 422", and a body that is not JSON is the most malformed a body
    // gets. The parse error itself is not echoed: it quotes the payload.
    return unprocessable(
      [{ index: null, field: "/", code: "body_not_json", detail: "the request body is not valid JSON" }]
    );
  }

  if (body && Array.isArray(body.results) && body.results.length > MAX_RESULTS_PER_BATCH) {
    return unprocessable([
      {
        index: null,
        field: "results",
        code: "batch_too_large",
        detail: `at most ${MAX_RESULTS_PER_BATCH} results per request; the fleet's own ` +
          `FLEET_BATCH_SIZE is capped at 50`,
      },
    ]);
  }

  const { ok, violations } = validateIngestBody(body);
  if (!ok) return unprocessable(violations);

  const envelope = { job_id: String(body.job_id).trim(), brand: String(body.brand).trim() };
  const rows = body.results.map((result) => toPromptResultRow(envelope, result));

  // -------------------------------------------------------------- 3. the write
  //
  // `upsertPromptResults` is DB-authoritative and fail-loud: with Supabase
  // configured it throws on any error rather than degrading into the in-memory
  // map. Its memory path exists only for the fully Supabase-less dev/test path,
  // and a memory write is NOT a durable one — so in production, no database
  // means 503, never a 200 over a Map that the next request never sees.
  const live = Boolean(supabase);
  if (!live && resolveNodeEnv(process.env) === "production") {
    console.error(
      "[probe-ingest] REFUSING a batch: no Supabase client is configured, so the only place " +
        "these rows could go is a per-instance in-memory Map. Accepting them would report a " +
        "successful ingest for measurements nothing can read back."
    );
    return NextResponse.json(
      {
        detail:
          "No database is configured for this deployment; probe results cannot be stored. " +
          "Nothing was written.",
        storage: "unavailable",
      },
      { status: 503 }
    );
  }

  let written;
  try {
    written = await upsertPromptResults(rows);
  } catch (error) {
    // The error envelope is preserved rather than flattened into a 200 with a
    // zero count. A caller that cannot tell "stored" from "refused by the
    // database" retries nothing and loses the batch.
    console.error("[probe-ingest] prompt_results upsert failed:", error?.message || error);
    return NextResponse.json(
      {
        detail: "The probe results could not be stored. Nothing was written; retry the batch.",
        error: String(error?.message || error),
        storage: live ? "database" : "process_memory",
      },
      { status: 502 }
    );
  }

  const storedCount = Array.isArray(written) ? written.length : 0;
  if (storedCount !== rows.length) {
    // A short write is not a success. Standing rule 1: a code path that
    // silently did less than it was asked must say so.
    console.error(
      `[probe-ingest] partial write: submitted ${rows.length} row(s), the store returned ` +
        `${storedCount}.`
    );
    return NextResponse.json(
      {
        detail:
          `Submitted ${rows.length} result(s) but the store confirmed ${storedCount}. The batch ` +
          "is NOT known to be stored; retry it.",
        submitted: rows.length,
        stored: storedCount,
        storage: live ? "database" : "process_memory",
      },
      { status: 502 }
    );
  }

  if (!live) {
    console.warn(
      "[probe-ingest] stored in PROCESS MEMORY, not a database: no Supabase client is " +
        "configured. These rows are visible to this process only and vanish with it."
    );
  }

  return NextResponse.json({
    // "How many rows exist now", which after a retry is the same number as the
    // first time — that is what idempotent means here.
    stored: storedCount,
    job_id: envelope.job_id,
    brand: envelope.brand,
    conflict_key: "job_id,engine,query",
    /**
     * WHERE it went, said out loud. A 200 from the memory path and a 200 from
     * the database are not the same event, and a fleet that cannot tell them
     * apart would report a successful run over rows nothing can read back.
     */
    storage: live ? "database" : "process_memory",
    auth_reason: INGEST_AUTH.OK,
  });
}

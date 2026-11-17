#!/usr/bin/env node
// Authorized local QA canaries: production adapters and durable SQL claims;
// production application databases are never constructed or written.
import pg from "pg";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
if (
  process.argv.slice(2).join(" ") !==
  "--slot repairs-2026-10-20-v1 --max-requests 5 --reserve-usd 0.20 --max-spend-usd 1.00"
)
  throw Error(
    "Use the pre-registered slot, five requests and $1 estimated reservation ceiling",
  );
if (
  process.env.PGHOST !== "127.0.0.1" ||
  process.env.PGDATABASE !== "aeovis_live_qa" ||
  process.env.DATABASE_URL
)
  throw Error("Dedicated loopback live QA ledger required");
for (const key of [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "DATABASE_URL",
])
  delete process.env[key];
const { dispatchCanaries } = await import("../ops/provider-canary.mjs");
const { createProbeDispatchStore, readProviderReadiness } = await import(
  "../../src/server/db/probeDispatch.js"
);
const { createMeasurementEvidenceStore } = await import(
  "../../src/server/db/measurementEvidence.js"
);
const { resolveEnabledEngines } = await import(
  "../../src/shared/scoring/enginePipeline.js"
);
const { getLlmBaseUrl } = await import("../../src/shared/llmConfig.js");
const pool = new pg.Pool();
const q = (s, v = []) => pool.query(s, v);
const directory = "/tmp/aeovis-provider-live-repairs";
await mkdir(directory, { recursive: true, mode: 0o700 });
let networkCalls = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const target = new URL(typeof url === "string" ? url : url.url);
  if (
    ![new URL(getLlmBaseUrl()).hostname, "api.brightdata.com"].includes(
      target.hostname,
    )
  )
    throw Error("Unexpected network destination refused");
  if (networkCalls >= 5) throw Error("Live network request ceiling reached");
  networkCalls++;
  return originalFetch(url, init);
};
async function rpc(name, args) {
  const entries = Object.entries(args);
  const r = await q(
    `select ${name}(${entries.map(([k], i) => `${k}=>$${i + 1}`).join(",")}) result`,
    entries.map(([, v]) =>
      v && typeof v === "object" ? JSON.stringify(v) : v,
    ),
  );
  return { data: r.rows[0].result, error: null };
}
const store = createProbeDispatchStore({ rpc });
store.evidence = createMeasurementEvidenceStore({
  from: () => ({
    upsert: async (row) => {
      const entries = Object.entries(row);
      await q(
        `insert into measurement_evidence(${entries.map(([k]) => k).join(",")}) values(${entries.map((_, i) => `$${i + 1}`).join(",")}) on conflict(observation_id,attempt_token,capture_index) do update set ${entries
          .filter(
            ([k]) =>
              !["observation_id", "attempt_token", "capture_index"].includes(k),
          )
          .map(([k]) => `${k}=excluded.${k}`)
          .join(",")}`,
        entries.map(([, v]) => v),
      );
      return { error: null };
    },
  }),
  storage: {
    from: () => ({
      upload: async (key, body) => {
        const target = path.join(directory, key);
        await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        await writeFile(target, body, { mode: 0o600 });
        return { error: null };
      },
    }),
  },
});
store.canaries = async () => {
  const rows = (
    await q(
      "select * from probe_observations where purpose='canary' order by created_at desc",
    )
  ).rows;
  return Object.fromEntries(
    rows.map((r) => [
      r.engine,
      {
        config_version: r.config_version,
        observed_at: r.observed_at,
        outcome: ["answered", "valid_no_aio"].includes(r.state)
          ? "valid"
          : r.state,
        failure: r.result?.provider_failure,
        provider_request_id: r.result?.provider_request_id,
      },
    ]),
  );
};
store.circuits = async () =>
  (await q("select * from provider_dispatch_circuits")).rows;
try {
  const outcomes = await dispatchCanaries({
    engines: ["aio", "chatgpt", "gemini", "perplexity"],
    slot: "repairs-2026-10-20-v1",
    maxRequests: 5,
    maxSpendUsd: 1,
    reserveUsd: 0.2,
    store,
    registry: resolveEnabledEngines({
      engines: "aio,chatgpt,gemini,perplexity",
      allowFallback: false,
    }),
  });
  const rows = (
    await q(
      "select * from probe_observations where purpose='canary' order by engine",
    )
  ).rows;
  const readiness = await readProviderReadiness({ store });
  const manifest = {
    suite: "bounded-live-durable-provider-canaries",
    executed_at: new Date().toISOString(),
    workspace: "Perceev authorized QA",
    ledger: "dedicated-loopback-live-qa",
    slot: "repairs-2026-10-20-v1",
    ceilings: {
      network_requests: 5,
      reservations_usd: 1,
      reserve_per_observation_usd: 0.2,
      provider_retries: false,
    },
    network_requests: networkCalls,
    billing_note:
      "Reservations are estimates. Provider-reported charges and unknown costs are preserved; this is not a guaranteed invoice cap.",
    storage_note:
      "Sanitized captures stored in a private local QA directory; hosted Storage remains separate acceptance.",
    outcomes,
    observations: rows.map((r) => ({
      id: r.id,
      engine: r.engine,
      state: r.state,
      observed_at: r.observed_at,
      reason: r.reason,
      attempt_count: r.attempt_count,
      total_cost: r.total_cost,
      unknown_cost_calls: r.unknown_cost_calls,
      provenance: r.result?.provenance,
      evidence_state: r.result?.evidence_state,
      captures: r.result?.evidence_captures,
      provider_failure: r.result?.provider_failure,
    })),
    readiness: Object.fromEntries(
      Object.entries(readiness.engines).map(([name, r]) => [
        name,
        {
          readiness: r.readiness,
          reason: r.reason,
          provider: r.provider,
          operator_action: r.operator_action,
        },
      ]),
    ),
  };
  await writeFile(
    "docs/audits/2026-10-16/repair-provider-live-evidence.json",
    JSON.stringify(manifest, null, 2) + "\n",
  );
  console.log(
    JSON.stringify(
      {
        outcomes,
        network_requests: networkCalls,
        readiness: manifest.readiness,
      },
      null,
      2,
    ),
  );
} finally {
  globalThis.fetch = originalFetch;
  await pool.end();
}

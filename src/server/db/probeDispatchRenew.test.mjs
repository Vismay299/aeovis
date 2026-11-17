import test from "node:test";
import assert from "node:assert/strict";
import { createProbeDispatchStore, PROBE_LEASE_SECONDS } from "./probeDispatch.js";

test("probe dispatch forwards a requested lease length and renew RPC arguments", async () => {
  const calls = [];
  const store = createProbeDispatchStore({ rpc: async (name, args) => { calls.push({ name, args }); return { data: true, error: null }; } });
  await store.claim("obs-1", { reserve: 0.01, leaseSeconds: 180 });
  await store.renew("obs-1", "00000000-0000-4000-8000-000000000001", 180);
  assert.deepEqual(calls, [
    { name: "claim_probe_dispatch", args: { p_id: "obs-1", p_reserve: 0.01, p_scan_cap: null, p_day_cap: null, p_lease_seconds: 180 } },
    { name: "renew_probe_dispatch", args: { p_id: "obs-1", p_token: "00000000-0000-4000-8000-000000000001", p_seconds: 180 } },
  ]);
  await store.claim("obs-2", { reserve: 0.01 });
  assert.equal(calls[2].args.p_lease_seconds, PROBE_LEASE_SECONDS);
});
import test from "node:test";
import assert from "node:assert/strict";
import { runMockScan, MOCK_ENGINES } from "./mockScan.js";

test("mock scan completes real checkpoint/scoring lifecycle on four engines without any network or durable writes", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; throw new Error("Simulation attempted network I/O"); });
  const result = await runMockScan();
  assert.equal(calls, 0);
  assert.equal(result.simulation, true);
  assert.equal(result.status, "complete");
  assert.equal(result.prompt_count, 30);
  assert.equal(result.answer_count, 120);
  assert.deepEqual(Object.keys(result.scan.engines).sort(), [...MOCK_ENGINES].sort());
  for (const engine of Object.values(result.scan.engines)) {
    assert.equal(engine.coverage_pct, 100);
    assert.equal(engine.share_of_ai_pct, 33.3);
    assert.equal(engine.error_rate_pct, 0);
  }
  const again = await runMockScan();
  assert.equal(again.answer_count, 120, "each simulation has isolated persistence");
});

test("workspace simulations use their brand and domain without mixing the Italica fixture",async(t)=>{
  t.mock.method(globalThis,"fetch",async()=>{throw new Error("Simulation attempted network I/O");});
  const result=await runMockScan({brand:"Trace",url:"https://tracyourstory.xyz/"});
  assert.equal(result.answer_count,120);
  assert.ok(result.results.some(row=>row.raw.text.includes("Trace")));
  assert.ok(result.results.every(row=>!row.query.includes("tile")));
  for(const row of result.results) for(const ref of row.raw.references) assert.equal(ref.domain,"tracyourstory.xyz");
  for(const engine of Object.values(result.scan.engines)) assert.equal(engine.share_of_ai_pct,33.3);
});

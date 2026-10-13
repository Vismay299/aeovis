import test from "node:test";
import assert from "node:assert/strict";
import { resolveBrief } from "./contentWorker.js";
import { HEALTHCARE_CXO_BRIEF } from "./briefs/healthcareCxo.js";
import { runDraft } from "./steps/draft.js";

const input = { brand_name: "Italica", url: "https://italicatiles.com/", brief: "Verified fact: manufactures vitrified tiles. Never claim a warranty." };
test("a tiles brand receives a neutral brief and run facts reach the actual draft skill prompt", async () => {
  let persisted;
  const brief = await resolveBrief("workspace-a", input, { getBrandBrief: async()=>null, upsertBrandBrief: async (_brand, value)=>{persisted=value;} });
  assert.equal(brief.one_liner, "Italica");
  assert.equal(brief.vertical, undefined);
  assert.equal(brief.request_facts, input.brief);
  assert.equal(persisted.request_facts, undefined, "a single run must not overwrite durable brand facts");
  let prompt;
  await assert.rejects(()=>runDraft({ brand:"workspace-a", playbook:"geo_article", brief, input, stats:{} }, {llm:async(text)=>{prompt=text;return null;}}), /invalid output/);
  assert.ok(prompt.includes(input.brief));
  assert.ok(!prompt.includes("Healthcare services provider"));
  assert.ok(prompt.includes("passage-optimized"), "generation still uses the real markdown skill");
});
test("run facts augment a stored brief without mutating the stored brand voice", async()=>{
  const stored={one_liner:"Tile manufacturer",tone_rules:["Concise"]};
  const brief=await resolveBrief("workspace-a",input,{getBrandBrief:async()=>({brief:stored})});
  assert.deepEqual(brief.tone_rules,["Concise"]);
  assert.equal(brief.request_facts,input.brief);
  assert.equal(stored.request_facts,undefined);
});
test("healthcare brief remains available only when explicitly selected",async()=>{
  const brief=await resolveBrief("Hospital",{brand_profile:"healthcare-cxo"},{getBrandBrief:async()=>null,upsertBrandBrief:async()=>{}});
  assert.equal(brief.vertical,"healthcare");
});


test("only the exact legacy auto-seeded healthcare brief is repaired for an unrelated brand",async()=>{
  const legacy={...HEALTHCARE_CXO_BRIEF,one_liner:`workspace-a — ${HEALTHCARE_CXO_BRIEF.one_liner}`};
  const deps={getBrandBrief:async()=>({brief:legacy}),upsertBrandBrief:async()=>{}};
  const repaired=await resolveBrief("workspace-a",input,deps);
  assert.equal(repaired.one_liner,"Italica");
  assert.equal(repaired.vertical,undefined);
  const customized={...legacy,personas:["Hospital buyer"]};
  const preserved=await resolveBrief("workspace-a",input,{...deps,getBrandBrief:async()=>({brief:customized})});
  assert.deepEqual(preserved.personas,["Hospital buyer"]);
});

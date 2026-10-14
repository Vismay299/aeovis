import test from "node:test";
import assert from "node:assert/strict";
import { extractCompetitors, matchCompetitorsBack } from "./competitorExtract.js";

function buildNonBrandedWithAio() {
  return [
    {
      is_branded_query: false,
      aio_present: true,
      visible: false,
      aio_text: "Kajaria and Somany are top tile brands.",
      aio_citations: [],
      aio_references: [],
    },
    {
      is_branded_query: false,
      aio_present: true,
      visible: false,
      aio_text: "Kajaria remains popular for bathrooms.",
      aio_citations: [],
      aio_references: [],
    },
    {
      is_branded_query: false,
      aio_present: true,
      visible: true,
      aio_text: "Generic advice about floor tiles only.",
      aio_citations: [],
      aio_references: [{ href: "https://somanyceramics.com/page", domain: "somanyceramics.com" }],
    },
  ];
}

test("extractCompetitors - one batched llmJson call, merges user + discovered, scores against the AIO pool", async () => {
  const results = [
    ...buildNonBrandedWithAio(),
    {
      // branded query — must be excluded from both the text sent to the LLM and the scoring pool
      is_branded_query: true,
      aio_present: true,
      visible: true,
      aio_text: "Italica vs Kajaria comparison",
      aio_citations: [],
      aio_references: [],
    },
  ];

  let callCount = 0;
  const llmJson = async () => {
    callCount++;
    return [
      { name: "Kajaria", domain: "kajaria.com" },
      { name: "Somany", domain: "somanyceramics.com" },
    ];
  };

  const competitors = await extractCompetitors({
    results,
    brand: "Italica",
    brandUrl: "https://italicatiles.com",
    userCompetitors: ["Orient Bell"],
    max: 10,
    deps: { llmJson },
  });

  assert.equal(callCount, 1, "competitor extraction must be a single batched LLM call");

  const names = competitors.map((c) => c.name);
  assert.ok(names.includes("Kajaria"));
  assert.ok(names.includes("Somany"));
  assert.ok(names.includes("Orient Bell"), "user competitor kept even with zero signal");

  const kajaria = competitors.find((c) => c.name === "Kajaria");
  assert.equal(kajaria.source, "discovered");
  assert.equal(kajaria.mentions, 2);
  assert.equal(kajaria.prompts, 2);
  assert.equal(kajaria.visibilityScore, 66.7);
  assert.equal(kajaria.userAbsent, true);

  const somany = competitors.find((c) => c.name === "Somany");
  assert.equal(somany.mentions, 1);
  assert.equal(somany.citations, 1);
  assert.equal(somany.visibilityScore, 66.7);

  const orientBell = competitors.find((c) => c.name === "Orient Bell");
  assert.equal(orientBell.source, "user");
  assert.equal(orientBell.visibilityScore, 0);
  assert.equal(orientBell.userAbsent, false);
});

test("matchCompetitorsBack - denominator is nonBrandedWithAio only, tolerates missing domain", () => {
  const nonBrandedWithAio = buildNonBrandedWithAio();

  const scored = matchCompetitorsBack(
    nonBrandedWithAio,
    [
      { name: "Kajaria", domain: "", source: "discovered" }, // no domain supplied
      { name: "Somany", domain: "somanyceramics.com", source: "discovered" },
      { name: "Orient Bell", domain: "", source: "user" },
    ],
    "Italica"
  );

  const kajaria = scored.find((c) => c.name === "Kajaria");
  assert.equal(kajaria.mentions, 2);
  assert.equal(kajaria.prompts, 2);
  assert.equal(kajaria.userAbsent, true);

  const somany = scored.find((c) => c.name === "Somany");
  assert.equal(somany.citations, 1, "citation match works even without an exact domain field on the row");

  const orientBell = scored.find((c) => c.name === "Orient Bell");
  assert.ok(orientBell, "user competitor kept at zero signal");
  assert.equal(orientBell.prompts, 0);
});

test("rival discovery samples every measured engine and allows software alternatives", async () => {
  let prompt = "";
  const results = ["aio", "chatgpt", "gemini", "perplexity"].flatMap((engine) => Array.from({ length: 30 }, (_, index) => ({
    engine, is_branded_query: false, aio_present: true,
    aio_text: `${engine} evidence ${index}: Rival${engine} is a software alternative. ` + "x".repeat(16000),
    aio_references: [],
  })));
  results.push({ engine: "chatgpt", is_branded_query: false, aio_present: true, error: "failed capture", aio_text: "UNTRUSTED FAILED EVIDENCE" });
  await extractCompetitors({ results, brand: "Trace", brandUrl: "https://trace.example", deps: { llmJson: async (value) => { prompt = value; return []; } } });
  for (const engine of ["aio", "chatgpt", "gemini", "perplexity"]) {
    assert.ok(prompt.includes(`[${engine}]`));
    assert.ok(prompt.includes(`${engine} evidence 0`));
    assert.ok(prompt.includes(`${engine} evidence 29`));
  }
  assert.match(prompt, /A software brand can have software competitors/);
  assert.doesNotMatch(prompt, /Exclude tools, marketplaces-as-tools|UNTRUSTED FAILED EVIDENCE/);
  const evidence = prompt.split("---\n")[1].split("\n---")[0];
  assert.ok(evidence.length <= 12000);
});

test("the discovery cap keeps the most observed rivals and every explicitly configured rival", async () => {
  const results = Array.from({ length: 3 }, (_, index) => ({
    aio_present: true, is_branded_query: false, aio_text: `CommonBrand${index === 0 ? " and RareBrand" : ""} provide services.`, aio_references: [],
  }));
  const rivals = await extractCompetitors({ results, brand: "OurBrand", brandUrl: "https://ours.example", userCompetitors: ["UserChoice"], max: 1,
    deps: { llmJson: async () => [{ name: "RareBrand" }, { name: "CommonBrand" }] },
  });
  assert.deepEqual(rivals.map((c) => c.name), ["CommonBrand", "UserChoice"]);
});

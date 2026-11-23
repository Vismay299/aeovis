/** Prompt Explorer: past side-by-side runs across three models. */
import { BRAND, DOMAIN, RIVALS, daysAgo } from "./brand.js";

const MODELS = [
  { model: "chatgpt", label: "ChatGPT", route: "dataforseo", modelName: "gpt-5" },
  { model: "gemini", label: "Gemini", route: "openrouter", modelName: "gemini-2.5-pro" },
  { model: "perplexity", label: "Perplexity", route: "openrouter", modelName: "sonar-pro" },
];

const RUNS = [
  { id: "5a1e0c2b-1111-4a1a-8a1a-000000000001", prompt: "best software for NABH accreditation reporting", days: 1, named: [true, true, false] },
  { id: "5a1e0c2b-1111-4a1a-8a1a-000000000002", prompt: "how do Indian hospitals track readmission rates", days: 4, named: [true, false, true] },
  { id: "5a1e0c2b-1111-4a1a-8a1a-000000000003", prompt: "NorthPeak vs Brightwave for a 200-bed hospital", days: 9, named: [true, true, true] },
  { id: "5a1e0c2b-1111-4a1a-8a1a-000000000004", prompt: "hospital length of stay dashboard tools", days: 16, named: [false, false, true] },
];

function answer(run, m, i) {
  const named = run.named[i];
  const rival = RIVALS[i % RIVALS.length];
  const text = named
    ? `For "${run.prompt}", the options hospitals mention most are ${BRAND}, ${rival.name} and ${RIVALS[(i + 1) % 4].name}.\n\n**${BRAND}** focuses on clinical analytics on top of an existing HIMS, with ready NABH quality indicator reports and readmission dashboards.\n\n**${rival.name}** is a broader suite and suits hospitals replacing their HIMS at the same time.`
    : `For "${run.prompt}", hospitals usually compare ${rival.name} and ${RIVALS[(i + 1) % 4].name}.\n\n**${rival.name}** is the most established; **${RIVALS[(i + 1) % 4].name}** is popular with multi-site chains.`;
  const citations = [
    ...(named ? [{ url: `https://${DOMAIN}/nabh-reporting`, domain: DOMAIN, title: `${BRAND} — NABH reporting`, matchedBrand: true }] : []),
    { url: `https://${rival.domain}/platform`, domain: rival.domain, title: `${rival.name} platform`, matchedBrand: false },
    { url: "https://www.nabh.co/standards", domain: "nabh.co", title: "NABH standards, 5th edition", matchedBrand: false },
    { url: "https://www.expresshealthcare.in/analytics", domain: "expresshealthcare.in", title: "Hospital analytics buyers' guide", matchedBrand: false },
  ];
  return {
    status: "success", ...m, text, truncated: false, citations,
    fanOutQueries: [`${run.prompt} India`, "hospital analytics software comparison"], fanOutReported: m.model !== "perplexity",
    brandMentioned: named, workspaceBrandMentioned: named, outputTokens: 380 + i * 40, webSearch: true, countryHint: "IN",
    costUsd: [0.06, 0.07, 0.03][i], costState: "measured", reusedFrom: null,
    observationId: `${run.id}-${m.model}`, observedAt: daysAgo(run.days, 10, 1),
  };
}

export function exploreList() {
  return {
    runs: RUNS.map((r) => ({ runId: r.id, prompt: r.prompt, models: MODELS.map((m) => m.model), status: "completed", createdAt: daysAgo(r.days, 10), questionId: null })),
    nextCursor: null,
  };
}

export function exploreRun(id) {
  const run = RUNS.find((r) => r.id === id);
  if (!run) return undefined;
  return {
    runId: run.id, status: "completed", pollAfterSeconds: null, prompt: run.prompt, highlightBrand: BRAND,
    webSearch: true, country: "IN", createdAt: daysAgo(run.days, 10), finishedAt: daysAgo(run.days, 10, 1),
    approvedMaxUsd: 0.24, cost: { knownUsd: 0.16, unknownModels: 0 }, questionId: null,
    results: MODELS.map((m, i) => answer(run, m, i)),
  };
}

#!/usr/bin/env node
/**
 * Builds the sample workspace's scan reports (src/shared/sample/fixtures/data/scans.json).
 *
 * Runs the product's own scan worker and scoring (runScanChunk, as the portal's
 * "mock scan" does) over an in-memory backend, on simulated answers about the
 * fictional brand Brightwave. No provider, database or network is touched.
 * The numbers in the sample reports are therefore computed by the same code a
 * real scan uses, never typed by hand.
 *
 *   node scripts/sample/build-sample-reports.mjs
 */
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { makeMemoryScanBackend } from "../../src/server/demo/memoryScanBackend.js";
import { runScanChunk } from "../../src/server/workers/scanWorker.js";
import { ENGINE_LABELS } from "../../src/shared/engines/deployedEngines.js";
import { SAMPLE_RESULT } from "../../src/shared/mockData.js";

const ENGINES = ["aio", "chatgpt", "gemini", "perplexity"];
const BRAND = "Brightwave";
const URL_ = "https://brightwave.io/";
const RIVALS = [
  { name: "NorthPeak", domain: "northpeak.com" },
  { name: "Lumen IQ", domain: "lumeniq.ai" },
  { name: "Vantage Health", domain: "vantagehealth.in" },
  { name: "Coreset", domain: "coreset.io" },
];
const SOURCES = ["nabh.co", "healthtechindia.com", "expresshealthcare.in", "g2.com", "capterra.com", "brightwave.io", "northpeak.com", "lumeniq.ai"];

const prompts = [...new Set(SAMPLE_RESULT.results.map((row) => row.prompt))];
const topicOf = new Map(SAMPLE_RESULT.results.map((row) => [row.prompt, row.topic || "Hospital analytics"]));

/**
 * Who an engine names for question `q`. `contention` (questions out of 30)
 * rises over the scan history, so later scans name Brightwave on more
 * questions as its content ships. On a question in contention three of the
 * four engines name it; elsewhere none do.
 */
function decide(q, e, contention) {
  const inContention = (q * 11) % 30 < contention;
  const named = inContention && (q + e) % 4 !== 0;
  // NorthPeak leads, Lumen IQ follows, the other two trail.
  const ladder = [0, 0, 0, 0, 1, 1, 1, 2, 2, 3];
  const first = ladder[(q * 3 + e) % ladder.length];
  const rival = RIVALS[first];
  const second = RIVALS[ladder[(q * 7 + e * 5 + 4) % ladder.length] === first ? (first + 1) % RIVALS.length : ladder[(q * 7 + e * 5 + 4) % ladder.length]];
  return { named, rival, second };
}

async function buildReport({ id, strength, scannedAt }) {
  const backend = makeMemoryScanBackend();
  const queries = prompts.map((text) => ({ text, topic: topicOf.get(text), source: "category_seed", intent_tier: "high", enabled: true }));
  const job = await backend.deps.createScanJob({ brand: BRAND, url: URL_, industry: "healthcare", competitors: RIVALS.map((r) => r.name).join(", ") });
  // The workspace's question set is approved, as a real customer's is before
  // a scan counts; without it the headline is (rightly) withheld.
  job.panel_snapshot = {
    artifact_key: "default", state: "approved", version: 1,
    payload: {
      persona: "a hospital administrator shortlisting analytics vendors",
      context: { country: "in", device: "desktop", session_policy: "fresh_anonymous" },
      prompts: queries.map((q) => ({ text: q.text, origin: "manual", weight: 1, purpose: "recommendation", topic: q.topic })),
    },
  };
  const engines = ENGINES.map((name, e) => ({
    name, label: ENGINE_LABELS[name], concurrency: 4,
    probe: async (query) => {
      const q = prompts.indexOf(query.text);
      const { named, rival, second } = decide(q, e, strength);
      const brands = named ? `${BRAND}, ${rival.name} and ${second.name}` : `${rival.name} and ${second.name}`;
      const text = named
        ? `For "${query.text}", hospitals most often shortlist ${brands}. ${BRAND} is noted for readmission and length-of-stay dashboards built for NABH reporting; ${rival.name} is the larger suite.`
        : `For "${query.text}", hospitals most often shortlist ${brands}. ${rival.name} is the most established option; ${second.name} is popular with multi-site chains.`;
      const refDomains = named ? ["brightwave.io", SOURCES[(q + e) % 5], rival.domain] : [SOURCES[(q + e) % 5], rival.domain];
      const references = refDomains.map((domain, i) => ({ href: `https://${domain}/${i === 0 ? "" : "guides/hospital-analytics"}`, domain, title: `${domain} — ${topicOf.get(query.text)}`, source: domain }));
      return {
        engine: name, prompt: query.text, topic: query.topic, source: "category_seed", intent_tier: query.intent_tier,
        is_branded_query: false, answer_present: true, aio_present: true, text,
        references, citations: references.map((r) => r.href),
        brand_mentioned_in_text: named, brand_cited: named && (q + e) % 2 === 0, visible: named,
        competitors_found_in_text: [rival.name, second.name], competitors_cited: [rival.name],
        brands: [], error: null, cost: 0, cost_source: "simulation", cost_state: "measured", citations_state: "verified",
      };
    },
  }));
  const deps = {
    ...backend.deps, client: null, promptTarget: 30,
    getScanSchedule: async () => null,
    insertScanScheduleIfNotExists: async () => ({ brand: "brightwave.io", inserted: true }),
    getPromptsForBrand: async () => queries,
    upsertPrompts: async () => ({}), buildBrandedQueries: () => [],
    generateUnbrandedPrompts: async () => { throw new Error("The sample build cannot call a provider"); },
    resolveEnabledEngines: () => engines,
    getScansByDomain: async () => [], getResultBrandsForScan: async () => [],
    extractCompetitors: async () => RIVALS.map((r) => ({ name: r.name, source: "discovered" })),
  };
  for (let chunk = 0; chunk < 8 && job.status !== "complete" && job.status !== "failed"; chunk++) await runScanChunk(job.id, deps);
  if (job.status !== "complete") throw new Error(job.error_message || "sample build did not finish");
  const raw = job.run_record;
  const scan = {
    id, brand: BRAND, url: URL_, scanned_at: scannedAt, created_at: scannedAt,
    visibility_pct: raw.visibility_pct, prompts_tracked: raw.prompts_tracked, prompts_mentioned: raw.prompts_mentioned,
    platform: raw.platform, engines: raw.engines || null, planned_questions: raw.planned_questions || null,
    engine_scores: raw.engine_scores || null, competitors: raw.competitors || [], summary_stats: raw.summary_stats ?? null,
    share_of_voice_pct: raw.share_of_voice_pct ?? null, win_rate_pct: raw.win_rate_pct ?? null,
    brand_citation_share_pct: raw.brand_citation_share_pct ?? null, cost: null,
  };
  // Only the raw fields the report reads, so the fixture stays small.
  const keep = ["engine", "prompt", "topic", "references", "competitors_found_in_text", "competitors_cited", "brand_mentioned_in_text", "brand_cited", "visible", "error", "measurement_method"];
  const results = backend.promptResults.map((row, i) => ({
    id: `${id}-r${i}`, query: row.query, engine: row.engine, answer_text: row.answer_text, answered: row.answered,
    mentioned: row.mentioned, brand_cited: row.brand_cited, position: row.position ?? null, sentiment: row.sentiment ?? null,
    raw: row.raw ? Object.fromEntries(keep.filter((k) => k in row.raw).map((k) => [k, row.raw[k]])) : null,
    created_at: scannedAt, cost: null,
  }));
  // Audit-only id lists the report never reads; dropped to keep the fixture small.
  const strip = (o) => {
    if (Array.isArray(o)) return o.map(strip);
    if (!o || typeof o !== "object") return o;
    return Object.fromEntries(Object.entries(o).filter(([k]) => k !== "eligible_prompt_ids").map(([k, v]) => [k, strip(v)]));
  };
  return { questionIdByQuery: {}, scan: strip(scan), results };
}

// Six weekly scans, oldest first, visibility climbing as content ships.
const plan = [8, 9, 9, 11, 12, 13];
const reports = [];
for (let i = 0; i < plan.length; i++) {
  const weeksAgo = plan.length - 1 - i;
  // Stored as an offset; the fixtures turn it into a date relative to today.
  reports.push({ weeksAgo, ...(await buildReport({ id: `sample-scan-${i + 1}`, strength: plan[i], scannedAt: `@weeksAgo:${weeksAgo}` })) });
}
const out = path.resolve(import.meta.dirname, "../../src/shared/sample/fixtures/data/scans.json");
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(reports));
for (const r of reports) console.log(r.scan.id, "visibility", r.scan.visibility_pct, "named", r.scan.prompts_mentioned, "/", r.scan.prompts_tracked, "rows", r.results.length);

#!/usr/bin/env node
// Reproducible local acceptance run. Provider calls require --live. Persistence
// is ALWAYS isolated in memory; no production/customer database is written.
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
const live = process.argv.includes("--live");
const content = process.argv.includes("--content");
const value = (key, fallback) => { const at = process.argv.indexOf(key); return at < 0 ? fallback : process.argv[at + 1]; };
const brand = value("--brand", "Italica");
const url = value("--url", "https://italicatiles.com/");
const output = value("--output", "/tmp/aeo-local-acceptance.json");
// Clear before dynamic imports evaluate db.js. Credentials must never make a
// local acceptance run accidentally use a remote persistence backend.
for (const key of ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "DATABASE_URL"]) delete process.env[key];
const { runMockScan } = await import("../src/lib/demo/mockScan.js");
let result;
const acceptanceErrors = [];
if (!live) {
  result = await runMockScan();
} else {
  const { makeMemoryScanBackend } = await import("../src/lib/demo/memoryScanBackend.js");
  const { runScanChunk } = await import("../src/lib/workers/scanWorker.js");
  const { resolveEnabledEngines } = await import("../src/lib/scoring/enginePipeline.js");
  const engines = resolveEnabledEngines({ engines: "aio,chatgpt,gemini,perplexity" });
  if (engines.length !== 4) throw new Error("Configure all four providers before running live acceptance");
  const backend = makeMemoryScanBackend();
  const job = await backend.deps.createScanJob({ brand, url, industry: "tiles", competitors: "Kajaria, Somany, Simpolo" });
  const deps = {
    ...backend.deps, client: null, promptTarget: 30,
    getScanSchedule: async () => null,
    insertScanScheduleIfNotExists: async () => ({ brand: "local-acceptance", inserted: true }),
    getPromptsForBrand: async () => [], upsertPrompts: async () => ({}),
    resolveEnabledEngines: () => engines,
    getScansByDomain: async () => [], getResultBrandsForScan: async () => [],
  };
  for (let chunk = 0; chunk < 20 && !["complete", "failed"].includes(job.status); chunk++) {
    await runScanChunk(job.id, deps);
    console.log(`Scan chunk ${chunk + 1}: ${job.status} ${job.progress_pct}%`);
  }
  if (job.status !== "complete") throw new Error(job.error_message || "Live scan did not finish");
  result = { simulation: false, status: job.status, scan: job.run_record, results: backend.promptResults, chunks: backend.scanRuns.length };
  for (const engine of engines) {
    const slice = result.scan.engines?.[engine.name];
    if (!slice || slice.coverage_pct < 90 && engine.name !== "aio" || slice.error_rate_pct > 0) acceptanceErrors.push(`Live ${engine.name} has incomplete coverage/errors: ${JSON.stringify(slice)}`);
  }
  if (content) {
    const { createContentJob } = await import("../src/lib/db/content.js");
    const { startContentJob } = await import("../src/lib/content/contentWorker.js");
    const { normalizeAgent } = await import("../src/lib/content/agents/model.js");
    const agent = normalizeAgent({ name: "Tiles comparison writer", format: "comparison", channel: "website", length_hint: "600-800 words", pipeline: ["coordinate", "research", "benchmark", "draft", "review"] }, "local-acceptance").agent;
    const contentJob = await createContentJob({ brand: "local-acceptance", playbook: "geo_article", agent_snapshot: agent, input: { query: "best tile brands in India", brand_name: brand, url, brief: "Italica is a tile manufacturer in India. Use only sourced product facts. Do not invent prices, warranties or certifications." } });
    let item;
    for (let chunk = 0; chunk < 10 && !item; chunk++) {
      item = await startContentJob(contentJob.id, { getScansForBrand: async () => [result.scan], selfContinue: () => false });
      const current = global.memoryContentJobs.get(contentJob.id);
      console.log(`Content chunk ${chunk + 1}: ${current?.status} ${current?.progress_pct}%`);
      if (current?.status === "failed") throw new Error(current.error_message || "Content worker failed");
    }
    if (!item || item.status !== "awaiting_approval" || !item.body_md) throw new Error("Content pipeline failed to produce a reviewable draft");
    result.content = item;
    console.log(`Content: ${item.status}, ${item.body_md.length} characters`);
  }
}
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(result, null, 2));
if (acceptanceErrors.length) throw new Error(acceptanceErrors.join("\n"));
console.log(`PASS: ${live ? "live" : "mock"} local acceptance. ${result.results.length} answers. Output: ${output}`);

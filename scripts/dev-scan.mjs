#!/usr/bin/env node
/**
 * Dev-only scan runner. Local dev has no Vercel cron, so a chunked scan needs
 * something to advance it past the first chunk. This POSTs a scan, then polls
 * the status endpoint — whose built-in poll-rescue re-kicks a chunk in-process
 * whenever the job's heartbeat goes stale (this is the SAME mechanism the
 * production client relies on, and it does NOT depend on the self-continue
 * fetch, which can't resolve the right localhost port under autoPort).
 *
 * Polling at a slow cadence (default 15s) is deliberately safe: the first stale
 * poll fires a single fire-and-forget rescue, the resumed chunk stamps its
 * heartbeat within a second or two (isJobAlive → true), and every subsequent
 * poll sees a live job and does nothing — so no two chunks ever run at once.
 *
 * Usage:
 *   node scripts/dev-scan.mjs --port 56666 --brand "Italica" \
 *        --url https://italicatiles.com --competitors "Orientbell,Simpolo"
 */
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const port = arg("port", "3000");
const brand = arg("brand");
const url = arg("url", "");
const competitors = arg("competitors", "");
const intervalMs = Number(arg("interval", "15")) * 1000;
const maxMs = Number(arg("timeout", "1500")) * 1000;
const base = `http://localhost:${port}`;

if (!brand) {
  console.error('Missing --brand. Example: --brand "Italica" --url https://italicatiles.com');
  process.exit(1);
}

const post = await fetch(`${base}/api/scan`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ brand, url, industry: "", competitors }),
});
if (!post.ok) {
  console.error(`POST /api/scan → ${post.status}: ${await post.text()}`);
  process.exit(1);
}
const { job_id } = await post.json();
console.log(`${new Date().toISOString()}  job ${job_id}  brand="${brand}"  competitors="${competitors || "(none)"}"`);

const started = Date.now();
let last = "";
while (Date.now() - started < maxMs) {
  await new Promise((r) => setTimeout(r, intervalMs));
  let s;
  try {
    s = await (await fetch(`${base}/api/scan/${job_id}/status`, { cache: "no-store" })).json();
  } catch (e) {
    console.log(`  poll error (retrying): ${e.message}`);
    continue;
  }
  const line = `${s.status} ${s.progress_pct}%`;
  if (line !== last) { console.log(`${new Date().toISOString()}  ${line}`); last = line; }
  if (s.status === "complete") { console.log(`COMPLETE result_id=${s.result_id}`); process.exit(0); }
  if (s.status === "failed") { console.log(`FAILED: ${s.error_message}`); process.exit(1); }
}
console.log(`TIMEOUT after ${Math.round(maxMs / 60000)}m`);
process.exit(2);
